-- Lieblingsbilder encrypted cloud sync. Paste into the Supabase SQL Editor and Run. Safe to run twice.
-- Runs in the app's own Supabase project; every object carries the lb_ prefix (bucket "lb").
-- The app encrypts on the device. This database only ever holds ciphertext:
--   lb_photos.meta   encrypted file name, date taken, folder, caption, size, dimensions
--   bucket lb        one encrypted image and one encrypted thumbnail per photo
--   lb_keys          the cloud key, wrapped with the user's encryption password
--   lb_folders       the folders (compartments): a sealed name and the wrapped folder key

-- Folders are compartments: each has its own key, which travels wrapped by the cloud key (or, for
-- a protected folder, by its own passphrase). The server sees ids and stamps, never a name.
create table if not exists public.lb_folders (
  id text not null,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  info text not null default '',          -- sealed with the folder key: the name
  wrap text not null default '',          -- the folder key, sealed with the cloud key ('' for a protected folder)
  pwrap text not null default '',         -- the folder key, sealed with a key derived from the folder's own passphrase
  psalt text not null default '',
  piter integer not null default 0,
  updated_at bigint not null,
  deleted boolean not null default false,
  synced_at bigint not null default 0,
  primary key (user_id, id)
);
create index if not exists lb_folders_user_synced on public.lb_folders (user_id, synced_at);

create table if not exists public.lb_photos (
  id text not null,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  folder_id text,                     -- null: no folder; else the folder whose key seals the entry
  meta text not null default '',
  updated_at bigint not null,
  deleted boolean not null default false,
  synced_at bigint not null default 0,
  primary key (user_id, id)
);
create index if not exists lb_photos_user_synced on public.lb_photos (user_id, synced_at);

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

-- the trigger runs as the signed-in user, so the sequence must be usable by that role
grant usage, select on sequence public.lb_stamp to authenticated;
create or replace function public.lb_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.synced_at := nextval('public.lb_stamp');      -- a sequence: it never steps back, unlike a clock
  return new;
end $$;
drop trigger if exists lb_photos_touch on public.lb_photos;
create trigger lb_photos_touch before insert or update on public.lb_photos
  for each row execute function public.lb_touch();
drop trigger if exists lb_folders_touch on public.lb_folders;
create trigger lb_folders_touch before insert or update on public.lb_folders
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
alter table public.lb_folders enable row level security;

-- explicit privileges: visitors who are not signed in get nothing; signed-in users get table
-- access, which row level security then narrows to their own rows
revoke all on public.lb_photos from anon;
revoke all on public.lb_keys from anon;
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.lb_photos to authenticated;
grant select, insert, update on public.lb_keys to authenticated;
revoke all on public.lb_folders from anon;
grant select, insert, update, delete on public.lb_folders to authenticated;

drop policy if exists "lb select" on public.lb_photos;
drop policy if exists "lb insert" on public.lb_photos;
drop policy if exists "lb update" on public.lb_photos;
drop policy if exists "lb delete" on public.lb_photos;
create policy "lb select" on public.lb_photos for select to authenticated using (user_id = auth.uid());
create policy "lb insert" on public.lb_photos for insert to authenticated with check (user_id = auth.uid());
create policy "lb update" on public.lb_photos for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "lb delete" on public.lb_photos for delete to authenticated using (user_id = auth.uid());

drop policy if exists "lb folder select" on public.lb_folders;
drop policy if exists "lb folder insert" on public.lb_folders;
drop policy if exists "lb folder update" on public.lb_folders;
drop policy if exists "lb folder delete" on public.lb_folders;
create policy "lb folder select" on public.lb_folders for select to authenticated using (user_id = auth.uid());
create policy "lb folder insert" on public.lb_folders for insert to authenticated with check (user_id = auth.uid());
create policy "lb folder update" on public.lb_folders for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "lb folder delete" on public.lb_folders for delete to authenticated using (user_id = auth.uid());

drop policy if exists "lb key select" on public.lb_keys;
drop policy if exists "lb key insert" on public.lb_keys;
drop policy if exists "lb key update" on public.lb_keys;
create policy "lb key select" on public.lb_keys for select to authenticated using (user_id = auth.uid());
create policy "lb key insert" on public.lb_keys for insert to authenticated with check (user_id = auth.uid());
create policy "lb key update" on public.lb_keys for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- private bucket; files live under <user id>/<photo id>.<tag> and <user id>/<photo id>.<tag>.t
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('lb', 'lb', false, 52428800, array['application/octet-stream'])
  on conflict (id) do nothing;

drop policy if exists "lb obj select" on storage.objects;
drop policy if exists "lb obj insert" on storage.objects;
drop policy if exists "lb obj update" on storage.objects;
drop policy if exists "lb obj delete" on storage.objects;
create policy "lb obj select" on storage.objects for select to authenticated
  using (bucket_id = 'lb' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "lb obj insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'lb' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "lb obj update" on storage.objects for update to authenticated
  using (bucket_id = 'lb' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "lb obj delete" on storage.objects for delete to authenticated
  using (bucket_id = 'lb' and (storage.foldername(name))[1] = auth.uid()::text);

-- tell the Data API about the new tables right away
notify pgrst, 'reload schema';
