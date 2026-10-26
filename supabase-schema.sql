-- Lieblingsbilder encrypted cloud sync. Paste into the Supabase SQL Editor and Run. Safe to run twice.
-- Runs in the app's own Supabase project; every object carries the lb_ prefix (bucket "lb").
-- The app encrypts on the device. This database only ever holds ciphertext:
--   lb_photos.meta   encrypted file name, date taken, folder, caption, size, dimensions
--   bucket lb        one encrypted image and one encrypted thumbnail per photo
--   lb_keys          the cloud key, wrapped with the user's encryption password
--   lb_rooms         shared spaces: a sealed name, the hash of the invite token
--   lb_room_members  who is in a room, each with the room key wrapped by their own cloud key

-- Rooms: shared spaces. A room has one random room key that only its members hold; it travels in
-- the invite link's fragment (never to the server). The server checks the invite token's hash
-- before it adds a member. Each member keeps the room key wrapped with their own cloud key, so a
-- second device of the same person finds the room again after the encryption password.
create extension if not exists pgcrypto;
create table if not exists public.lb_rooms (
  id text primary key,
  created_by uuid not null default auth.uid() references auth.users (id) on delete cascade,
  info text not null default '',          -- sealed with the room key: name, invite token
  invite_hash text not null,              -- sha256 of the invite token
  created_at bigint not null
);
create table if not exists public.lb_room_members (
  room_id text not null references public.lb_rooms (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  wrapped text not null default '',       -- the room key, sealed with this member's cloud key
  joined_at bigint not null,
  primary key (room_id, user_id)
);
create or replace function public.lb_is_member(rid text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.lb_room_members where room_id = rid and user_id = auth.uid());
$$;
-- joining: the token proves the invite link; the wrapped key is this member's own copy
create or replace function public.lb_join_room(rid text, token text, wrapped_key text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return false; end if;
  if not exists (select 1 from public.lb_rooms where id = rid and invite_hash = encode(digest(token, 'sha256'), 'hex')) then return false; end if;
  insert into public.lb_room_members (room_id, user_id, wrapped, joined_at) values (rid, auth.uid(), wrapped_key, (extract(epoch from clock_timestamp()) * 1000)::bigint)
    on conflict (room_id, user_id) do update set wrapped = excluded.wrapped;
  return true;
end $$;
revoke all on function public.lb_join_room(text, text, text) from public;
grant execute on function public.lb_join_room(text, text, text) to authenticated;
grant execute on function public.lb_is_member(text) to authenticated;

create table if not exists public.lb_photos (
  id text not null,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  room_id text references public.lb_rooms (id) on delete cascade,      -- null: the person's own space
  meta text not null default '',
  updated_at bigint not null,
  deleted boolean not null default false,
  synced_at bigint not null default 0,
  primary key (user_id, id)
);
alter table public.lb_photos add column if not exists room_id text references public.lb_rooms (id) on delete cascade;
create index if not exists lb_photos_user_synced on public.lb_photos (user_id, synced_at);
create index if not exists lb_photos_room_synced on public.lb_photos (room_id, synced_at);

-- the server stamps every write; devices ask for "everything stamped after my last visit"
create sequence if not exists public.lb_stamp;
do $$
declare m bigint;
begin
  select coalesce(max(synced_at), 0) into m from public.lb_photos;
  if (select last_value from public.lb_stamp) < greatest(m, (extract(epoch from clock_timestamp()) * 1000)::bigint) then
    perform setval('public.lb_stamp', greatest(m, (extract(epoch from clock_timestamp()) * 1000)::bigint) + 1000, false);
  end if;
end $$;

create or replace function public.lb_touch() returns trigger
language plpgsql set search_path = public as $$
begin
  new.synced_at := nextval('public.lb_stamp');      -- a sequence: it never steps back, unlike a clock
  return new;
end $$;
drop trigger if exists lb_photos_touch on public.lb_photos;
create trigger lb_photos_touch before insert or update on public.lb_photos
  for each row execute function public.lb_touch();

create table if not exists public.lb_keys (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  salt text not null,
  iter integer not null,
  wrapped text not null,
  created_at bigint not null
);

alter table public.lb_photos enable row level security;
alter table public.lb_keys enable row level security;
alter table public.lb_rooms enable row level security;
alter table public.lb_room_members enable row level security;

-- explicit privileges: visitors who are not signed in get nothing; signed-in users get table
-- access, which row level security then narrows to their own rows
revoke all on public.lb_photos from anon;
revoke all on public.lb_keys from anon;
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.lb_photos to authenticated;
grant select, insert, update on public.lb_keys to authenticated;
revoke all on public.lb_rooms from anon;
revoke all on public.lb_room_members from anon;
grant select, insert, update, delete on public.lb_rooms to authenticated;
grant select, insert, update, delete on public.lb_room_members to authenticated;

drop policy if exists "lb select" on public.lb_photos;
drop policy if exists "lb insert" on public.lb_photos;
drop policy if exists "lb update" on public.lb_photos;
drop policy if exists "lb delete" on public.lb_photos;
-- own photos, and every photo of a room one is a member of; only the uploader changes or deletes
create policy "lb select" on public.lb_photos for select to authenticated using (user_id = auth.uid() or (room_id is not null and public.lb_is_member(room_id)));
create policy "lb insert" on public.lb_photos for insert to authenticated with check (user_id = auth.uid() and (room_id is null or public.lb_is_member(room_id)));
create policy "lb update" on public.lb_photos for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "lb delete" on public.lb_photos for delete to authenticated using (user_id = auth.uid());

drop policy if exists "lb room select" on public.lb_rooms;
drop policy if exists "lb room insert" on public.lb_rooms;
drop policy if exists "lb room delete" on public.lb_rooms;
create policy "lb room select" on public.lb_rooms for select to authenticated using (created_by = auth.uid() or public.lb_is_member(id));
create policy "lb room insert" on public.lb_rooms for insert to authenticated with check (created_by = auth.uid());
create policy "lb room delete" on public.lb_rooms for delete to authenticated using (created_by = auth.uid());
drop policy if exists "lb room update" on public.lb_rooms;
create policy "lb room update" on public.lb_rooms for update to authenticated using (public.lb_is_member(id)) with check (public.lb_is_member(id));      -- members may rename (the sealed info only)
drop policy if exists "lb member select" on public.lb_room_members;
drop policy if exists "lb member insert" on public.lb_room_members;
drop policy if exists "lb member update" on public.lb_room_members;
drop policy if exists "lb member delete" on public.lb_room_members;
create policy "lb member select" on public.lb_room_members for select to authenticated using (user_id = auth.uid() or public.lb_is_member(room_id));
-- the creator adds themself; everyone else joins through lb_join_room (which checks the invite token)
create policy "lb member insert" on public.lb_room_members for insert to authenticated with check (user_id = auth.uid() and exists (select 1 from public.lb_rooms r where r.id = room_id and r.created_by = auth.uid()));
create policy "lb member update" on public.lb_room_members for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "lb member delete" on public.lb_room_members for delete to authenticated using (user_id = auth.uid());

drop policy if exists "lb key select" on public.lb_keys;
drop policy if exists "lb key insert" on public.lb_keys;
drop policy if exists "lb key update" on public.lb_keys;
create policy "lb key select" on public.lb_keys for select to authenticated using (user_id = auth.uid());
create policy "lb key insert" on public.lb_keys for insert to authenticated with check (user_id = auth.uid());
create policy "lb key update" on public.lb_keys for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- private bucket; own files live under <user id>/<photo id>.<tag> and <user id>/<photo id>.<tag>.t,
-- a room's files under room/<room id>/<photo id>.<tag> (and .t), reachable by its members
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('lb', 'lb', false, 52428800, array['application/octet-stream'])
  on conflict (id) do nothing;

drop policy if exists "lb obj select" on storage.objects;
drop policy if exists "lb obj insert" on storage.objects;
drop policy if exists "lb obj update" on storage.objects;
drop policy if exists "lb obj delete" on storage.objects;
create or replace function public.lb_obj_ok(name text) returns boolean
language sql stable security definer set search_path = public as $$
  select (storage.foldername(name))[1] = auth.uid()::text
      or ((storage.foldername(name))[1] = 'room' and public.lb_is_member((storage.foldername(name))[2]));
$$;
grant execute on function public.lb_obj_ok(text) to authenticated;
create policy "lb obj select" on storage.objects for select to authenticated
  using (bucket_id = 'lb' and public.lb_obj_ok(name));
create policy "lb obj insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'lb' and public.lb_obj_ok(name));
create policy "lb obj update" on storage.objects for update to authenticated
  using (bucket_id = 'lb' and public.lb_obj_ok(name));
create policy "lb obj delete" on storage.objects for delete to authenticated
  using (bucket_id = 'lb' and public.lb_obj_ok(name));

-- tell the Data API about the new tables right away
notify pgrst, 'reload schema';
