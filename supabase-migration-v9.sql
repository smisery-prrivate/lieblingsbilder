-- Lieblingsbilder v9: rooms (shared spaces) are gone, folders are compartments with their own keys.
-- Run once in the SQL editor of a project that was set up before v9; then run supabase-schema.sql
-- again (it is safe to run at any time and does the rest).
drop policy if exists "lb select" on public.lb_photos;          -- the policies depend on the column: they go first
drop policy if exists "lb insert" on public.lb_photos;
drop policy if exists "lb update" on public.lb_photos;
drop policy if exists "lb delete" on public.lb_photos;
drop policy if exists "lb obj select" on storage.objects;
drop policy if exists "lb obj insert" on storage.objects;
drop policy if exists "lb obj update" on storage.objects;
drop policy if exists "lb obj delete" on storage.objects;
alter table public.lb_photos drop column if exists room_id;
alter table public.lb_photos add column if not exists folder_id text;
drop function if exists public.lb_obj_ok(text);
drop function if exists public.lb_join_room(text, text, text);
drop table if exists public.lb_room_members;
drop table if exists public.lb_rooms;
drop function if exists public.lb_is_member(text);
grant usage, select on sequence public.lb_stamp to authenticated;      -- the fix for "permission denied for sequence lb_stamp"
-- then run supabase-schema.sql
