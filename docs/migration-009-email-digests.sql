-- Migration 009: scheduled email digests containing both warnings and news.
-- Run once after migration 007. Existing pending warning rows are preserved and
-- will be included in the first digest; historical news is deliberately not queued.

alter table public.email_notification_outbox
  drop constraint if exists email_notification_outbox_event_type_check;

alter table public.email_notification_outbox
  add constraint email_notification_outbox_event_type_check
  check (event_type in (
    'scraper_warning', 'admin_warning', 'approved_report',
    'news_warning', 'news_article'
  ));

alter table public.email_notification_outbox
  drop constraint if exists email_notification_outbox_aggregate_type_check;

alter table public.email_notification_outbox
  add constraint email_notification_outbox_aggregate_type_check
  check (aggregate_type in ('tumedved_log', 'bear_report', 'news_log'));

-- Area subscriptions match any useful location/context text. Subscriptions for
-- all areas receive every approved warning and news article.
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
        p_payload ->> 'place',
        p_payload ->> 'title',
        p_payload ->> 'note',
        p_payload ->> 'description',
        p_payload ->> 'snippet',
        p_payload ->> 'summary'
      ))
    ) > 0
  end;
$$;

create or replace function public.enqueue_email_news_notification()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  event_name text;
  event_payload jsonb;
  dedupe_name text;
begin
  if new.status is distinct from 'approved' then return new; end if;
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then return new; end if;

  event_name := case when new.category = 'warning' then 'news_warning' else 'news_article' end;
  dedupe_name := event_name || ':news_log:' || new.id::text;
  event_payload := jsonb_build_object(
    'category', new.category,
    'source', new.source,
    'title', new.title,
    'snippet', new.snippet,
    'summary', coalesce(new.payload ->> 'aiSummary', new.payload ->> 'sourceSummary'),
    'published_at', new.published_at,
    'place', new.place,
    'article_url', new.article_url,
    'link', coalesce(new.link, new.google_news_url),
    'created_at', new.scraped_at
  );

  insert into public.email_notification_outbox (
    subscription_id, event_type, aggregate_type, aggregate_id, dedupe_key, payload
  )
  select
    subscription.id, event_name, 'news_log', new.id::text, dedupe_name, event_payload
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

drop trigger if exists news_logs_email_notification on public.news_logs;
create trigger news_logs_email_notification
after insert or update of status on public.news_logs
for each row execute function public.enqueue_email_news_notification();

-- p_limit is the number of subscribers, not the number of individual items.
-- Every currently deliverable row for each selected subscriber is claimed so
-- application code can send exactly one complete digest per subscriber.
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
  with subscriber_candidates as (
    select outbox.subscription_id, min(outbox.id) as first_id
    from public.email_notification_outbox outbox
    join public.email_subscriptions subscription on subscription.id = outbox.subscription_id
    where subscription.active = true
      and subscription.confirmed_at is not null
      and (
        (outbox.status = 'pending' and outbox.available_at <= now()) or
        (outbox.status = 'processing' and outbox.locked_at < now() - interval '5 minutes')
      )
    group by outbox.subscription_id
    order by min(outbox.id)
    limit greatest(1, least(coalesce(p_limit, 10), 50))
  ), candidates as (
    select outbox.id
    from public.email_notification_outbox outbox
    join subscriber_candidates selected
      on selected.subscription_id = outbox.subscription_id
    where (
      (outbox.status = 'pending' and outbox.available_at <= now()) or
      (outbox.status = 'processing' and outbox.locked_at < now() - interval '5 minutes')
    )
    order by selected.first_id, outbox.id
    for update of outbox skip locked
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

revoke all on function public.enqueue_email_news_notification() from public, anon, authenticated;
revoke all on function public.claim_email_notification_outbox(integer) from public, anon, authenticated;
grant execute on function public.claim_email_notification_outbox(integer) to service_role;
