-- PostgREST upsert uses ON CONFLICT DO UPDATE; without an UPDATE policy, repeat upserts can fail silently.
drop policy if exists "Restaurant pass complete updatable" on public.room_restaurant_pass_complete;
create policy "Restaurant pass complete updatable"
  on public.room_restaurant_pass_complete for update
  using (auth.uid() is not null)
  with check (auth.uid() is not null);
