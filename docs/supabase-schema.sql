-- Run this once in the Supabase SQL editor.
-- The app writes with SUPABASE_SERVICE_ROLE_KEY from the Node server only.

create table if not exists public.tumedved_logs (
  id text primary key,
  source text not null default 'tumedved.sk',
  location text,
  note text,
  lat double precision,
  lng double precision,
  has_coords boolean not null default false,
  reported_at timestamptz,
  url text,
  payload jsonb not null default '{}'::jsonb,
  scraped_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tumedved_logs_reported_at_idx
  on public.tumedved_logs (reported_at desc);

create index if not exists tumedved_logs_scraped_at_idx
  on public.tumedved_logs (scraped_at desc);

-- Hlásenia ručne upravené adminom — scraper ich pri ďalšom behu neprepíše.
alter table public.tumedved_logs
  add column if not exists manually_edited boolean not null default false;

create index if not exists tumedved_logs_manually_edited_idx
  on public.tumedved_logs (manually_edited);

create table if not exists public.news_logs (
  id text primary key,
  source text,
  title text,
  link text,
  google_news_url text,
  article_url text,
  snippet text,
  published_at timestamptz,
  place text,
  lat double precision,
  lng double precision,
  has_coords boolean not null default false,
  payload jsonb not null default '{}'::jsonb,
  scraped_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists news_logs_published_at_idx
  on public.news_logs (published_at desc);

create index if not exists news_logs_scraped_at_idx
  on public.news_logs (scraped_at desc);

create table if not exists public.scrape_runs (
  id bigserial primary key,
  source text not null check (source in ('tumedved', 'news')),
  status text not null check (status in ('success', 'error')),
  reason text,
  item_count integer,
  error_message text,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists scrape_runs_source_created_at_idx
  on public.scrape_runs (source, created_at desc);

create table if not exists public.website_logs (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  method text not null,
  path text not null,
  status_code integer,
  response_ms integer,
  user_agent text,
  referer text,
  ip_hash text
);

create index if not exists website_logs_created_at_idx
  on public.website_logs (created_at desc);

create index if not exists website_logs_path_created_at_idx
  on public.website_logs (path, created_at desc);

-- Status column for news moderation (existing rows default to 'approved').
alter table public.news_logs
  add column if not exists status text not null default 'approved'
  check (status in ('pending', 'approved', 'rejected'));

create index if not exists news_logs_status_idx
  on public.news_logs (status);

-- Category for approved news: 'warning' = bear warning shown on the map with a
-- distinct square marker, 'article' = general article shown only in the news
-- list (no map marker, no stored location). Existing rows default to 'article'.
alter table public.news_logs
  add column if not exists category text not null default 'article'
  check (category in ('warning', 'article'));

create index if not exists news_logs_category_idx
  on public.news_logs (category);

-- User-submitted bear sighting reports (require admin approval).
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

-- Email subscriptions for bear sighting notifications.
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

alter table public.tumedved_logs enable row level security;
alter table public.news_logs enable row level security;
alter table public.scrape_runs enable row level security;
alter table public.website_logs enable row level security;
alter table public.bear_reports enable row level security;
alter table public.email_subscriptions enable row level security;
