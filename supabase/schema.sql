create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  country_code text not null default 'US',
  city text not null default 'Denver',
  avatar_url text,
  hidden_restaurants jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  host_name text not null,
  country_code text not null,
  city text not null,
  flow_stage text not null default 'lobby' check (flow_stage in ('lobby', 'categories', 'restaurants')),
  created_at timestamptz not null default now()
);

create table if not exists public.room_members (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  name text not null,
  joined_at timestamptz not null default now(),
  unique (room_id, user_id)
);

create table if not exists public.room_category_votes (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  member_name text not null,
  category_id text not null,
  decision text not null check (decision in ('like', 'skip')),
  created_at timestamptz not null default now()
);

create table if not exists public.room_restaurant_votes (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  member_name text not null,
  restaurant_id text not null,
  decision text not null check (decision in ('like', 'skip')),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.room_category_votes enable row level security;
alter table public.room_restaurant_votes enable row level security;

drop policy if exists "Profiles are readable" on public.profiles;
create policy "Profiles are readable" on public.profiles for select using (auth.uid() = id);

drop policy if exists "Profiles are writable" on public.profiles;
create policy "Profiles are writable" on public.profiles for insert with check (auth.uid() = id);

drop policy if exists "Profiles are updatable" on public.profiles;
create policy "Profiles are updatable" on public.profiles for update using (auth.uid() = id);

drop policy if exists "Rooms are readable" on public.rooms;
create policy "Rooms are readable" on public.rooms for select using (true);

drop policy if exists "Rooms are writable" on public.rooms;
create policy "Rooms are writable" on public.rooms for insert with check (auth.uid() is not null);

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

drop policy if exists "Members are readable" on public.room_members;
create policy "Members are readable" on public.room_members for select using (true);

drop policy if exists "Members are writable" on public.room_members;
create policy "Members are writable" on public.room_members for insert with check (auth.uid() is not null);

drop policy if exists "Category votes are readable" on public.room_category_votes;
create policy "Category votes are readable" on public.room_category_votes for select using (true);

drop policy if exists "Category votes are writable" on public.room_category_votes;
create policy "Category votes are writable" on public.room_category_votes for insert with check (auth.uid() is not null);

drop policy if exists "Restaurant votes are readable" on public.room_restaurant_votes;
create policy "Restaurant votes are readable" on public.room_restaurant_votes for select using (true);

drop policy if exists "Restaurant votes are writable" on public.room_restaurant_votes;
create policy "Restaurant votes are writable" on public.room_restaurant_votes for insert with check (auth.uid() is not null);

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

drop policy if exists "Avatar images are public" on storage.objects;
create policy "Avatar images are public"
on storage.objects for select
using (bucket_id = 'avatars');

drop policy if exists "Users can upload avatar images" on storage.objects;
create policy "Users can upload avatar images"
on storage.objects for insert
with check (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "Users can update avatar images" on storage.objects;
create policy "Users can update avatar images"
on storage.objects for update
using (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);
