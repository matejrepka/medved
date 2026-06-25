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

alter table public.tumedved_logs enable row level security;
alter table public.news_logs enable row level security;
alter table public.scrape_runs enable row level security;
alter table public.website_logs enable row level security;
