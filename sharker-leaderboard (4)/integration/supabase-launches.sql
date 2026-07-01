-- Run this in the Supabase SQL editor (Database → SQL editor → New query).

create table if not exists public.launches (
  id            bigint generated always as identity primary key,
  platform_name text not null,
  owner_name    text,
  country       text,
  email         text,
  wallet        text,
  platform_url  text,
  launch_time   timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  status        text not null default 'Entered'
);

-- newest-first reads are the common query
create index if not exists launches_created_at_idx
  on public.launches (created_at desc);

-- Row Level Security ON. Writes happen server-side with the SERVICE ROLE key,
-- which bypasses RLS, so no insert policy is needed. This keeps random clients
-- from writing to your giveaway table.
alter table public.launches enable row level security;

-- OPTIONAL — only if you want the public board to read Supabase directly with the
-- ANON key. This view hides email + wallet so they can never leak publicly.
create or replace view public.launches_public as
  select id, platform_name, owner_name, country, platform_url, launch_time, created_at, status
  from public.launches
  order by created_at desc;
