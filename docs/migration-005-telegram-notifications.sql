-- Migration 005: durable Telegram notifications and audited mobile moderation.
-- Run once in the Supabase SQL editor before enabling the Telegram integration.

create table if not exists public.telegram_notification_outbox (
  id bigserial primary key,
  event_type text not null check (event_type in (
    'pending_public_report',
    'imported_news',
    'scraper_warning',
    'admin_warning'
  )),
  aggregate_type text not null check (aggregate_type in (
    'bear_report',
    'news_log',
    'tumedved_log'
  )),
  aggregate_id text not null,
  dedupe_key text not null unique,
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'sent', 'dead')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  sent_at timestamptz,
  telegram_message_id bigint,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists telegram_outbox_delivery_idx
  on public.telegram_notification_outbox (status, available_at, id);

create table if not exists public.content_moderation_audit (
  id bigserial primary key,
  entity_type text not null check (entity_type in ('bear_report', 'news_log')),
  entity_id text not null,
  action text not null check (action in ('approved', 'rejected')),
  old_status text not null,
  new_status text not null,
  actor_type text not null default 'telegram',
  actor_chat_id text,
  actor_user jsonb not null default '{}'::jsonb,
  callback_query_id text unique,
  outbox_id bigint references public.telegram_notification_outbox(id),
  created_at timestamptz not null default now()
);

create index if not exists content_moderation_audit_entity_idx
  on public.content_moderation_audit (entity_type, entity_id, created_at desc);

create or replace function public.telegram_sighting_source_identities(
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

-- Identity registry makes source novelty independent of whichever canonical row
-- currently represents a deduplicated warning. Backfill prevents notifications
-- for historical sources on the first refresh after this migration.
create table if not exists public.telegram_sighting_source_seen (
  source_identity text primary key,
  first_tumedved_id text not null,
  created_at timestamptz not null default now()
);

insert into public.telegram_sighting_source_seen (source_identity, first_tumedved_id)
select distinct identity, sighting.id
from public.tumedved_logs sighting
cross join lateral unnest(public.telegram_sighting_source_identities(
  sighting.payload, sighting.id::text, sighting.url, sighting.source
)) as identities(identity)
on conflict (source_identity) do nothing;

create or replace function public.enqueue_telegram_content_notification()
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
  new_identities text[];
  claimed_identities text[] := '{}'::text[];
  identity text;
  claimed_identity text;
begin
  if tg_table_name = 'bear_reports' then
    aggregate_name := 'bear_report';
    -- Public submissions are inserted pending. The only existing insert path
    -- for an already approved bear_report is the admin-created warning route.
    if new.status = 'approved' then
      event_name := 'admin_warning';
    elsif new.status = 'pending' then
      event_name := 'pending_public_report';
    end if;
    event_payload := jsonb_build_object(
      'location', new.location,
      'description', new.description,
      'reported_date', new.reported_date,
      'created_at', new.created_at
    );
  elsif tg_table_name = 'news_logs' then
    aggregate_name := 'news_log';
    if new.payload ->> 'manual' = 'true' then
      if new.category = 'warning' then event_name := 'admin_warning'; end if;
    else
      event_name := 'imported_news';
    end if;
    event_payload := jsonb_build_object(
      'source', new.source,
      'title', new.title,
      'link', new.link,
      'google_news_url', new.google_news_url,
      'article_url', new.article_url,
      'snippet', new.snippet,
      'published_at', new.published_at,
      'place', new.place,
      'category', new.category,
      'created_at', new.scraped_at
    );
  elsif tg_table_name = 'tumedved_logs' then
    aggregate_name := 'tumedved_log';
    if new.payload ->> 'manual' = 'true' then
      if tg_op = 'INSERT' then event_name := 'admin_warning'; end if;
    else
      new_identities := public.telegram_sighting_source_identities(
        new.payload, new.id::text, new.url, new.source
      );
      foreach identity in array new_identities loop
        claimed_identity := null;
        insert into public.telegram_sighting_source_seen (
          source_identity, first_tumedved_id
        ) values (
          identity, new.id::text
        ) on conflict (source_identity) do nothing
        returning source_identity into claimed_identity;
        if claimed_identity is not null then
          claimed_identities := array_append(claimed_identities, claimed_identity);
        end if;
      end loop;
      if cardinality(claimed_identities) > 0 then
        event_name := 'scraper_warning';
        dedupe_name := event_name || ':' || aggregate_name || ':' || new.id::text ||
          ':sources:' || md5(array_to_string(claimed_identities, E'\n'));
      end if;
    end if;
    event_payload := jsonb_build_object(
      'source', new.source,
      'location', new.location,
      'note', new.note,
      'reported_at', new.reported_at,
      'url', new.url,
      'scraped_at', new.scraped_at,
      'source_identities', to_jsonb(new_identities),
      'new_source_identities', to_jsonb(claimed_identities),
      'payload', jsonb_build_object('sourceLinks', new.payload -> 'sourceLinks')
    );
  end if;

  if event_name is not null then
    insert into public.telegram_notification_outbox (
      event_type, aggregate_type, aggregate_id, dedupe_key, payload
    ) values (
      event_name,
      aggregate_name,
      new.id::text,
      coalesce(dedupe_name, event_name || ':' || aggregate_name || ':' || new.id::text),
      event_payload
    ) on conflict (dedupe_key) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists bear_reports_telegram_notification on public.bear_reports;
create trigger bear_reports_telegram_notification
after insert on public.bear_reports
for each row execute function public.enqueue_telegram_content_notification();

drop trigger if exists news_logs_telegram_notification on public.news_logs;
create trigger news_logs_telegram_notification
after insert on public.news_logs
for each row execute function public.enqueue_telegram_content_notification();

drop trigger if exists tumedved_logs_telegram_notification on public.tumedved_logs;
create trigger tumedved_logs_telegram_notification
after insert or update of payload, url, source on public.tumedved_logs
for each row execute function public.enqueue_telegram_content_notification();

create or replace function public.claim_telegram_notification_outbox(p_limit integer default 10)
returns setof public.telegram_notification_outbox
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with candidates as (
    select id
    from public.telegram_notification_outbox
    where (
      status = 'pending' and available_at <= now()
    ) or (
      status = 'processing' and locked_at < now() - interval '5 minutes'
    )
    order by id
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 50))
  )
  update public.telegram_notification_outbox o
  set status = 'processing',
      attempts = o.attempts + 1,
      locked_at = now(),
      updated_at = now()
  from candidates
  where o.id = candidates.id
  returning o.*;
end;
$$;

create or replace function public.telegram_moderate_outbox_item(
  p_outbox_id bigint,
  p_action text,
  p_chat_id text,
  p_actor_user jsonb,
  p_callback_query_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  notification public.telegram_notification_outbox%rowtype;
  current_status text;
begin
  if p_action not in ('approved', 'rejected') then
    raise exception 'Unsupported moderation action';
  end if;

  select * into notification
  from public.telegram_notification_outbox
  where id = p_outbox_id
  for update;

  if not found or notification.event_type not in ('pending_public_report', 'imported_news') then
    raise exception 'Notification is not moderatable';
  end if;

  if notification.aggregate_type = 'bear_report' then
    select status into current_status
    from public.bear_reports
    where id = notification.aggregate_id::bigint
    for update;

    if current_status is null then raise exception 'Content not found'; end if;
    if current_status <> 'pending' then
      return jsonb_build_object('changed', false, 'status', current_status);
    end if;

    update public.bear_reports
    set status = p_action, reviewed_at = now()
    where id = notification.aggregate_id::bigint;
  elsif notification.aggregate_type = 'news_log' then
    select status into current_status
    from public.news_logs
    where id = notification.aggregate_id
    for update;

    if current_status is null then raise exception 'Content not found'; end if;
    if current_status <> 'pending' then
      return jsonb_build_object('changed', false, 'status', current_status);
    end if;

    if p_action = 'approved' and exists (
      select 1 from public.news_logs
      where id = notification.aggregate_id
        and category = 'warning'
        and (
          nullif(btrim(place), '') is null or
          not has_coords or
          lat is null or
          lng is null
        )
    ) then
      return jsonb_build_object(
        'changed', false,
        'status', 'pending',
        'outcome', 'needs_admin_review'
      );
    end if;

    update public.news_logs
    set status = p_action, updated_at = now()
    where id = notification.aggregate_id;
  else
    raise exception 'Unsupported content type';
  end if;

  insert into public.content_moderation_audit (
    entity_type, entity_id, action, old_status, new_status,
    actor_type, actor_chat_id, actor_user, callback_query_id, outbox_id
  ) values (
    notification.aggregate_type, notification.aggregate_id, p_action,
    current_status, p_action, 'telegram', p_chat_id,
    coalesce(p_actor_user, '{}'::jsonb), p_callback_query_id, notification.id
  ) on conflict (callback_query_id) do nothing;

  return jsonb_build_object('changed', true, 'status', p_action);
end;
$$;

-- The sightings store records its aggregate run as "sightings". Older schema
-- versions accepted only "tumedved" and "news", which made successful refresh
-- logging fail after the multi-source scraper was introduced.
alter table public.scrape_runs drop constraint if exists scrape_runs_source_check;
alter table public.scrape_runs
  add constraint scrape_runs_source_check
  check (source in ('tumedved', 'sightings', 'news'));

alter table public.telegram_notification_outbox enable row level security;
alter table public.content_moderation_audit enable row level security;
alter table public.telegram_sighting_source_seen enable row level security;

revoke all on function public.enqueue_telegram_content_notification() from public, anon, authenticated;
revoke all on function public.telegram_sighting_source_identities(jsonb, text, text, text) from public, anon, authenticated;
revoke all on function public.claim_telegram_notification_outbox(integer) from public, anon, authenticated;
revoke all on function public.telegram_moderate_outbox_item(bigint, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.claim_telegram_notification_outbox(integer) to service_role;
grant execute on function public.telegram_moderate_outbox_item(bigint, text, text, jsonb, text) to service_role;
