-- Align older databases with schema.sql: per-user vote rows for category and restaurant swipes.
alter table public.room_category_votes
  add column if not exists user_id uuid references auth.users (id) on delete cascade;

alter table public.room_restaurant_votes
  add column if not exists user_id uuid references auth.users (id) on delete cascade;
