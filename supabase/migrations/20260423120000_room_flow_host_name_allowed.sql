-- If you already ran an older 20260422143000, run this to allow hosts via rooms.host_name (same as app isRoomHost).

create or replace function public.set_room_flow_stage(p_room_id uuid, p_flow_stage text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  is_allowed boolean;
begin
  if p_flow_stage is null or p_flow_stage not in ('lobby', 'categories', 'restaurants') then
    raise exception 'invalid flow_stage';
  end if;

  select
    exists (
      select 1
      from public.room_members m
      where m.room_id = p_room_id
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
      from public.rooms r
      where r.id = p_room_id
        and exists (
          select 1
          from public.profiles p
          where p.id = auth.uid()
            and lower(trim(p.full_name)) = lower(trim(r.host_name))
        )
    )
  into is_allowed;

  if not coalesce(is_allowed, false) then
    raise exception 'not allowed to update this room flow';
  end if;

  update public.rooms
  set flow_stage = p_flow_stage
  where id = p_room_id;
end;
$$;

revoke all on function public.set_room_flow_stage(uuid, text) from public;
grant execute on function public.set_room_flow_stage(uuid, text) to authenticated;

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
