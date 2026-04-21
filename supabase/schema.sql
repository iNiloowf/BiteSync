create extension if not exists pgcrypto;

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  host_name text not null,
  country_code text not null,
  city text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.room_members (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  name text not null,
  joined_at timestamptz not null default now()
);

create table if not exists public.room_category_votes (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  member_name text not null,
  category_id text not null,
  decision text not null check (decision in ('like', 'skip')),
  created_at timestamptz not null default now()
);

create table if not exists public.room_restaurant_votes (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  member_name text not null,
  restaurant_id text not null,
  decision text not null check (decision in ('like', 'skip')),
  created_at timestamptz not null default now()
);

alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.room_category_votes enable row level security;
alter table public.room_restaurant_votes enable row level security;

create policy "Public rooms are readable" on public.rooms for select using (true);
create policy "Public rooms are writable" on public.rooms for insert with check (true);

create policy "Public members are readable" on public.room_members for select using (true);
create policy "Public members are writable" on public.room_members for insert with check (true);

create policy "Public category votes are readable" on public.room_category_votes for select using (true);
create policy "Public category votes are writable" on public.room_category_votes for insert with check (true);

create policy "Public restaurant votes are readable" on public.room_restaurant_votes for select using (true);
create policy "Public restaurant votes are writable" on public.room_restaurant_votes for insert with check (true);
