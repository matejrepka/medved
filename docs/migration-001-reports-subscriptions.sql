-- Migration 001: Add bear reports, news moderation status, and email subscriptions.
-- Run this in the Supabase SQL editor if your database only has the original
-- four tables (tumedved_logs, news_logs, scrape_runs, website_logs).
-- Safe to re-run: uses IF NOT EXISTS / IF EXISTS throughout.

-- 1. News moderation: add status column so new articles require admin approval.
--    Existing rows get 'approved' so they remain visible.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'news_logs'
      and column_name = 'status'
  ) then
    alter table public.news_logs
      add column status text not null default 'approved';

    alter table public.news_logs
      add constraint news_logs_status_check
      check (status in ('pending', 'approved', 'rejected'));
  end if;
end $$;

create index if not exists news_logs_status_idx
  on public.news_logs (status);

-- 2. User-submitted bear sighting reports (require admin approval).
create table if not exists public.bear_reports (
  id bigserial primary key,
  reporter_name text,
  reporter_email text,
  location text not null,
  description text,
  lat double precision,
  lng double precision,
  has_coords boolean not null default false,
  reported_date timestamptz,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create index if not exists bear_reports_status_idx
  on public.bear_reports (status);

create index if not exists bear_reports_created_at_idx
  on public.bear_reports (created_at desc);

-- 3. Email subscriptions for bear sighting notifications.
create table if not exists public.email_subscriptions (
  id bigserial primary key,
  email text not null,
  notify_type text not null default 'all'
    check (notify_type in ('all', 'area')),
  area_name text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists email_subscriptions_active_idx
  on public.email_subscriptions (active);

create unique index if not exists email_subscriptions_email_area_idx
  on public.email_subscriptions (email, coalesce(area_name, ''));

-- 4. Enable row-level security on new tables.
alter table public.bear_reports enable row level security;
alter table public.email_subscriptions enable row level security;
