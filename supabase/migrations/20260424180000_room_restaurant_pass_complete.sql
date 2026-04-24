-- Track who finished the restaurant swipe pass so all clients agree without relying on broadcast-only signals.
create table if not exists public.room_restaurant_pass_complete (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  participant_key text not null,
  created_at timestamptz not null default now(),
  unique (room_id, participant_key)
);

create index if not exists room_restaurant_pass_complete_room_id_idx
  on public.room_restaurant_pass_complete (room_id);

alter table public.room_restaurant_pass_complete enable row level security;

drop policy if exists "Restaurant pass complete readable" on public.room_restaurant_pass_complete;
create policy "Restaurant pass complete readable"
  on public.room_restaurant_pass_complete for select using (true);

drop policy if exists "Restaurant pass complete insertable" on public.room_restaurant_pass_complete;
create policy "Restaurant pass complete insertable"
  on public.room_restaurant_pass_complete for insert with check (auth.uid() is not null);

drop policy if exists "Restaurant pass complete deletable" on public.room_restaurant_pass_complete;
create policy "Restaurant pass complete deletable"
  on public.room_restaurant_pass_complete for delete using (auth.uid() is not null);

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'room_restaurant_pass_complete'
  ) then
    alter publication supabase_realtime add table public.room_restaurant_pass_complete;
  end if;
end
$$;
