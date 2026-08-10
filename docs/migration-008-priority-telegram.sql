-- Migration 008: immediate website-report delivery and priority-aware Telegram claims.
-- Run after migration 005. Safe to run more than once.

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
    order by
      case
        when event_type = 'pending_public_report' then 0
        when event_type = 'imported_news' and payload ->> 'category' = 'warning' then 1
        when event_type in ('scraper_warning', 'admin_warning') then 2
        else 3
      end,
      available_at,
      id
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

-- The website submit request knows the new bear_report ID. Claiming by that
-- aggregate bypasses any older news backlog and lets the request send its own
-- priority card immediately. SKIP LOCKED keeps this safe beside the worker.
create or replace function public.claim_telegram_notification_for_aggregate(
  p_aggregate_type text,
  p_aggregate_id text
)
returns setof public.telegram_notification_outbox
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with candidate as (
    select id
    from public.telegram_notification_outbox
    where aggregate_type = p_aggregate_type
      and aggregate_id = p_aggregate_id
      and (
        (status = 'pending' and available_at <= now()) or
        (status = 'processing' and locked_at < now() - interval '5 minutes')
      )
    order by id desc
    for update skip locked
    limit 1
  )
  update public.telegram_notification_outbox o
  set status = 'processing',
      attempts = o.attempts + 1,
      locked_at = now(),
      updated_at = now()
  from candidate
  where o.id = candidate.id
  returning o.*;
end;
$$;

revoke all on function public.claim_telegram_notification_for_aggregate(text, text)
  from public, anon, authenticated;
grant execute on function public.claim_telegram_notification_for_aggregate(text, text)
  to service_role;

revoke all on function public.claim_telegram_notification_outbox(integer)
  from public, anon, authenticated;
grant execute on function public.claim_telegram_notification_outbox(integer)
  to service_role;
