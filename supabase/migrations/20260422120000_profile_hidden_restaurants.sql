alter table public.profiles
  add column if not exists hidden_restaurants jsonb not null default '[]'::jsonb;

comment on column public.profiles.hidden_restaurants is 'Array of {id, name} places the user hid from restaurant suggestions.';
