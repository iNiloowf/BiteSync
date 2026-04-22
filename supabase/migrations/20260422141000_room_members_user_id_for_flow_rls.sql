-- Repair run if 20260422140000 failed with "column m.user_id does not exist" (legacy room_members).
alter table public.room_members
  add column if not exists user_id uuid references auth.users(id) on delete cascade;

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
