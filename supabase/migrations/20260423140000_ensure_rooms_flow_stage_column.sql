-- Use when PostgREST says flow_stage is missing from schema cache, or Postgres says column does not exist.
-- After running: Supabase Dashboard → Project Settings → API → Reload schema (so the API sees the new column).

alter table public.room_members
  add column if not exists user_id uuid references auth.users(id) on delete cascade;

alter table public.rooms
  add column if not exists flow_stage text not null default 'lobby';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'rooms_flow_stage_check'
  ) then
    alter table public.rooms
      add constraint rooms_flow_stage_check
      check (flow_stage in ('lobby', 'categories', 'restaurants'));
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'rooms'
  ) then
    alter publication supabase_realtime add table public.rooms;
  end if;
end
$$;
