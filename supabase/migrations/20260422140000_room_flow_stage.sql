-- Persist room phase so joiners follow the host even when Realtime broadcast is missed.
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
      select 1 from public.room_members m
      where m.room_id = rooms.id and m.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.room_members m
      where m.room_id = rooms.id and m.user_id = auth.uid()
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
