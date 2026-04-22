-- Let any real room member advance flow_stage (handles legacy room_members.user_id IS NULL).
-- SECURITY DEFINER update bypasses rooms RLS after we verify membership inside the function.

create or replace function public.set_room_flow_stage(p_room_id uuid, p_flow_stage text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  is_member boolean;
begin
  if p_flow_stage is null or p_flow_stage not in ('lobby', 'categories', 'restaurants') then
    raise exception 'invalid flow_stage';
  end if;

  select exists (
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
  into is_member;

  if not coalesce(is_member, false) then
    raise exception 'not a room member';
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
