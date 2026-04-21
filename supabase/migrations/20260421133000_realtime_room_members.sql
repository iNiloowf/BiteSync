-- Broadcast inserts/updates so clients refresh the member list without relying on polling alone.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'room_members'
  ) then
    alter publication supabase_realtime add table public.room_members;
  end if;
end
$$;
