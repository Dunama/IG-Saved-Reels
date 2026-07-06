-- IG Saved Reels: saved_reels table + RLS
-- Run in Supabase SQL Editor (or supabase db push).

create extension if not exists pgcrypto;

create table if not exists public.saved_reels (
  id            uuid primary key default gen_random_uuid(),
  reel_url      text not null unique,
  thumbnail_url text,
  caption       text,
  scraped_at    timestamptz not null default now(),
  user_id       uuid not null default auth.uid()
                references auth.users (id) on delete cascade
);

-- user_id defaults to auth.uid() so the client never sends it —
-- it can't be spoofed and the upsert payload stays minimal.

-- ENABLE (not FORCE) row level security. Table owner and service_role
-- bypass RLS, which avoids the 42501 you hit on weAre Wear where
-- FORCE RLS blocked privileged access with no service-role policy.
alter table public.saved_reels enable row level security;

create policy "users select own reels"
  on public.saved_reels for select
  to authenticated
  using (auth.uid() = user_id);

create policy "users insert own reels"
  on public.saved_reels for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "users update own reels"
  on public.saved_reels for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "users delete own reels"
  on public.saved_reels for delete
  to authenticated
  using (auth.uid() = user_id);

create index if not exists saved_reels_user_scraped_idx
  on public.saved_reels (user_id, scraped_at desc);
