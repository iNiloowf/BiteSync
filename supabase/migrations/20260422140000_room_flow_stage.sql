-- Persist room phase so joiners follow the host even when Realtime broadcast is missed.
-- Older databases may lack room_members.user_id; the RLS policy below requires it.
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

drop policy if exists "Room members can update room flow" on public.rooms;
create policy "Room members can update room flow"
  on public.rooms for update
  using (
    exists (
      select 1
      from public.room_members m
      where m.room_id = rooms.id
        and (
          m.user_id = auth.uid()
          or (
            m.user_id is null
            and exists (
              select 1
              from public.profiles p
              where p.id = auth.uid()
                and lower(trim(p.full_name)) = lower(trim(m.name))
            )
          )
        )
    )
    or exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and lower(trim(p.full_name)) = lower(trim(rooms.host_name))
    )
  )
  with check (
    exists (
      select 1
      from public.room_members m
      where m.room_id = rooms.id
        and (
          m.user_id = auth.uid()
          or (
            m.user_id is null
            and exists (
              select 1
              from public.profiles p
              where p.id = auth.uid()
                and lower(trim(p.full_name)) = lower(trim(m.name))
            )
          )
        )
    )
    or exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and lower(trim(p.full_name)) = lower(trim(rooms.host_name))
    )
  );

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
