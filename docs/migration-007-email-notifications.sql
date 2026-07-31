-- Migration 007: confirmed email subscriptions and durable warning delivery.
-- Run once in the Supabase SQL editor before enabling SMTP in production.

alter table public.email_subscriptions
  add column if not exists confirmed_at timestamptz,
  add column if not exists confirmation_nonce text,
  add column if not exists confirmation_sent_at timestamptz,
  add column if not exists unsubscribed_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

-- Legacy rows were collected while the terms said delivery was not active.
-- They must submit the form and confirm before any warning is sent.
update public.email_subscriptions
set active = false,
    updated_at = now()
where confirmed_at is null;

create table if not exists public.email_notification_outbox (
  id bigserial primary key,
  subscription_id bigint not null references public.email_subscriptions(id) on delete cascade,
  event_type text not null check (event_type in ('scraper_warning', 'admin_warning', 'approved_report')),
  aggregate_type text not null check (aggregate_type in ('tumedved_log', 'bear_report')),
  aggregate_id text not null,
  dedupe_key text not null,
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'sent', 'cancelled', 'dead')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  sent_at timestamptz,
  smtp_message_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (subscription_id, dedupe_key)
);

create index if not exists email_outbox_delivery_idx
  on public.email_notification_outbox (status, available_at, id);

create index if not exists email_outbox_subscription_idx
  on public.email_notification_outbox (subscription_id, status);

create or replace function public.email_normalize_text(p_value text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select regexp_replace(
    translate(lower(coalesce(p_value, '')), 'áäčďéíĺľňóôŕšťúýž', 'aacdeillnoorstuyz'),
    '[^a-z0-9]+', ' ', 'g'
  );
$$;

create or replace function public.email_subscription_matches_warning(
  p_notify_type text,
  p_area_name text,
  p_payload jsonb
)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_notify_type = 'all' then true
    when p_notify_type <> 'area' or nullif(btrim(p_area_name), '') is null then false
    else position(
      public.email_normalize_text(p_area_name)
      in public.email_normalize_text(concat_ws(' ',
        p_payload ->> 'location',
        p_payload ->> 'note',
        p_payload ->> 'description'
      ))
    ) > 0
  end;
$$;

create or replace function public.email_sighting_source_identities(
  p_payload jsonb,
  p_id text,
  p_url text,
  p_source text
)
returns text[]
language sql
immutable
set search_path = public, pg_temp
as $$
  with links as (
    select value as link
    from jsonb_array_elements(
      case
        when jsonb_typeof(p_payload -> 'sourceLinks') = 'array'
          then p_payload -> 'sourceLinks'
        else '[]'::jsonb
      end
    )
  ), identities as (
    select distinct
      coalesce(nullif(link ->> 'key', ''), nullif(p_source, ''), 'unknown') ||
      case
        when nullif(link ->> 'sourceId', '') is not null
          then '|id:' || (link ->> 'sourceId')
        when nullif(link ->> 'url', '') is not null
          then '|url:' || (link ->> 'url')
        else '|id:' || p_id
      end as identity
    from links
  )
  select case
    when count(*) > 0 then array_agg(identity order by identity)
    else array[coalesce(nullif(p_source, ''), 'unknown') ||
      case when nullif(p_url, '') is not null then '|url:' || p_url else '|id:' || p_id end]
  end
  from identities;
$$;

-- Backfill first, so the initial refresh after deployment cannot enqueue the
-- complete historical data set.
create table if not exists public.email_sighting_source_seen (
  source_identity text primary key,
  first_tumedved_id text not null,
  created_at timestamptz not null default now()
);

insert into public.email_sighting_source_seen (source_identity, first_tumedved_id)
select distinct identity, sighting.id
from public.tumedved_logs sighting
cross join lateral unnest(public.email_sighting_source_identities(
  sighting.payload, sighting.id::text, sighting.url, sighting.source
)) as identities(identity)
on conflict (source_identity) do nothing;

create or replace function public.enqueue_email_warning_notification()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  event_name text;
  aggregate_name text;
  event_payload jsonb;
  dedupe_name text;
  identities text[];
  claimed_identities text[] := '{}'::text[];
  identity text;
  claimed_identity text;
begin
  if tg_table_name = 'bear_reports' then
    if new.status is distinct from 'approved' then return new; end if;
    if tg_op = 'UPDATE' and old.status is not distinct from new.status then return new; end if;
    event_name := case when tg_op = 'INSERT' then 'admin_warning' else 'approved_report' end;
    aggregate_name := 'bear_report';
    dedupe_name := 'approved_report:bear_report:' || new.id::text;
    event_payload := jsonb_build_object(
      'location', new.location,
      'description', new.description,
      'reported_date', new.reported_date,
      'created_at', new.created_at,
      'source', 'Schválené komunitné hlásenie'
    );
  elsif tg_table_name = 'tumedved_logs' then
    if new.status is distinct from 'approved' then return new; end if;
    aggregate_name := 'tumedved_log';
    event_payload := jsonb_build_object(
      'source', new.source,
      'location', new.location,
      'note', new.note,
      'reported_at', new.reported_at,
      'url', new.url,
      'scraped_at', new.scraped_at
    );

    if new.payload ->> 'manual' = 'true' then
      if tg_op = 'UPDATE' and old.status is not distinct from new.status then return new; end if;
      event_name := 'admin_warning';
      dedupe_name := 'admin_warning:tumedved_log:' || new.id::text;
    else
      identities := public.email_sighting_source_identities(
        new.payload, new.id::text, new.url, new.source
      );
      foreach identity in array identities loop
        claimed_identity := null;
        insert into public.email_sighting_source_seen (source_identity, first_tumedved_id)
        values (identity, new.id::text)
        on conflict (source_identity) do nothing
        returning source_identity into claimed_identity;
        if claimed_identity is not null then
          claimed_identities := array_append(claimed_identities, claimed_identity);
        end if;
      end loop;
      if cardinality(claimed_identities) = 0 then return new; end if;
      event_name := 'scraper_warning';
      dedupe_name := event_name || ':' || aggregate_name || ':' || new.id::text ||
        ':sources:' || md5(array_to_string(claimed_identities, E'\n'));
    end if;
  else
    return new;
  end if;

  insert into public.email_notification_outbox (
    subscription_id, event_type, aggregate_type, aggregate_id, dedupe_key, payload
  )
  select
    subscription.id, event_name, aggregate_name, new.id::text, dedupe_name, event_payload
  from public.email_subscriptions subscription
  where subscription.active = true
    and subscription.confirmed_at is not null
    and public.email_subscription_matches_warning(
      subscription.notify_type, subscription.area_name, event_payload
    )
  on conflict (subscription_id, dedupe_key) do nothing;

  return new;
end;
$$;

drop trigger if exists bear_reports_email_notification on public.bear_reports;
create trigger bear_reports_email_notification
after insert or update of status on public.bear_reports
for each row execute function public.enqueue_email_warning_notification();

drop trigger if exists tumedved_logs_email_notification on public.tumedved_logs;
create trigger tumedved_logs_email_notification
after insert or update of payload, url, source, status on public.tumedved_logs
for each row execute function public.enqueue_email_warning_notification();

create or replace function public.claim_email_notification_outbox(p_limit integer default 10)
returns setof public.email_notification_outbox
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.email_notification_outbox outbox
  set status = 'cancelled',
      locked_at = null,
      updated_at = now(),
      last_error = 'Subscription inactive before delivery'
  where outbox.status in ('pending', 'processing')
    and not exists (
      select 1 from public.email_subscriptions subscription
      where subscription.id = outbox.subscription_id
        and subscription.active = true
        and subscription.confirmed_at is not null
    );

  return query
  with candidates as (
    select outbox.id
    from public.email_notification_outbox outbox
    join public.email_subscriptions subscription on subscription.id = outbox.subscription_id
    where subscription.active = true
      and subscription.confirmed_at is not null
      and (
        (outbox.status = 'pending' and outbox.available_at <= now()) or
        (outbox.status = 'processing' and outbox.locked_at < now() - interval '5 minutes')
      )
    order by outbox.id
    for update of outbox skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 50))
  )
  update public.email_notification_outbox outbox
  set status = 'processing',
      attempts = outbox.attempts + 1,
      locked_at = now(),
      updated_at = now()
  from candidates
  where outbox.id = candidates.id
  returning outbox.*;
end;
$$;

alter table public.email_notification_outbox enable row level security;
alter table public.email_sighting_source_seen enable row level security;

revoke all on function public.enqueue_email_warning_notification() from public, anon, authenticated;
revoke all on function public.claim_email_notification_outbox(integer) from public, anon, authenticated;
grant execute on function public.claim_email_notification_outbox(integer) to service_role;
