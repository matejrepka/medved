-- Apply after migrations 001-010. Original records and existing news incident
-- links are retained. Only explicit offline plans create sighting bucket links.
begin;

create table if not exists public.public_snapshots (
  id text primary key check (id = 'overview'),
  revision bigint not null default 1,
  built_revision bigint,
  built_day date,
  payload jsonb,
  updated_at timestamptz
);
insert into public.public_snapshots(id) values ('overview') on conflict do nothing;

create table if not exists public.sighting_buckets (
  id uuid primary key default gen_random_uuid(),
  primary_key text not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.sighting_bucket_members (
  record_key text primary key,
  bucket_id uuid not null references public.sighting_buckets(id) on delete cascade,
  sighting_id text unique references public.tumedved_logs(id) on delete cascade,
  report_id bigint unique references public.bear_reports(id) on delete cascade,
  constraint bucket_member_identity check (
    (sighting_id is not null and report_id is null and record_key = 'sighting:' || sighting_id)
    or (report_id is not null and sighting_id is null and record_key = 'report:' || report_id::text)
  )
);
create index if not exists sighting_bucket_members_bucket_idx
  on public.sighting_bucket_members(bucket_id);

alter table public.public_snapshots enable row level security;
alter table public.sighting_buckets enable row level security;
alter table public.sighting_bucket_members enable row level security;
revoke all on public.public_snapshots, public.sighting_buckets, public.sighting_bucket_members
  from public, anon, authenticated;
grant all on public.public_snapshots, public.sighting_buckets, public.sighting_bucket_members to service_role;

create or replace function public.invalidate_public_snapshot()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  update public.public_snapshots set revision = revision + 1 where id = 'overview';
  return null;
end;
$$;

-- Statement triggers mark a revision only; they never build the large JSON.
do $$
declare table_name text;
begin
  foreach table_name in array array['tumedved_logs', 'bear_reports', 'news_logs',
    'news_warning_locations', 'news_incidents', 'incident_news_links',
    'sighting_buckets', 'sighting_bucket_members'] loop
    execute format('drop trigger if exists public_snapshot_changed on public.%I', table_name);
    execute format('create trigger public_snapshot_changed after insert or update or delete or truncate on public.%I
      for each statement execute function public.invalidate_public_snapshot()', table_name);
  end loop;
end;
$$;

create or replace function public.read_public_snapshot(p_kind text default 'overview', p_slug text default null)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select case p_kind
    when 'stats' then payload->'stats'
    when 'overview' then payload->'overview'
    when 'location' then payload->'locations'->p_slug
    when 'warnings' then payload->'warnings'
    when 'news' then payload->'news'
    else null end
  from public.public_snapshots
  where id = 'overview' and built_revision = revision;
$$;

create or replace function public.publish_public_snapshot(p_revision bigint, p_day date, p_payload jsonb)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if jsonb_typeof(p_payload->'stats'->'report') is distinct from 'object'
    or jsonb_typeof(p_payload->'overview') is distinct from 'object'
    or jsonb_typeof(p_payload->'locations') is distinct from 'object' then
    raise exception 'Invalid public snapshot';
  end if;
  -- A concurrent approval/rejection changes revision. Never publish a snapshot
  -- computed from an inconsistent or superseded set of public records.
  update public.public_snapshots
    set built_revision = p_revision, built_day = p_day, payload = p_payload, updated_at = now()
    where id = 'overview' and revision = p_revision;
  return found;
end;
$$;

create or replace function public.apply_sighting_bucket_plan(p_groups jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  bucket jsonb;
  bucket_id uuid;
  member_key text;
  primary_key text;
  applied integer := 0;
begin
  if jsonb_typeof(p_groups) is distinct from 'array' then raise exception 'Expected bucket array'; end if;
  -- Serialize manual plans. An invalid member/duplicate rolls back the entire
  -- transaction, including removals, and leaves every source row untouched.
  perform pg_catalog.pg_advisory_xact_lock(721164011);
  for bucket in select value from jsonb_array_elements(p_groups) loop
    if bucket->>'id' is not null then
      delete from public.sighting_bucket_members where sighting_bucket_members.bucket_id = (bucket->>'id')::uuid;
    end if;
  end loop;
  for bucket in select value from jsonb_array_elements(p_groups) loop
    bucket_id := coalesce((bucket->>'id')::uuid, gen_random_uuid());
    primary_key := bucket->>'primaryKey';
    if jsonb_typeof(bucket->'memberKeys') is distinct from 'array' then raise exception 'Expected memberKeys array'; end if;
    if jsonb_array_length(bucket->'memberKeys') = 0 then
      delete from public.sighting_buckets where id = bucket_id;
      continue;
    end if;
    if primary_key is null or not (bucket->'memberKeys' ? primary_key) then raise exception 'Primary must be a member'; end if;
    insert into public.sighting_buckets(id, primary_key) values (bucket_id, primary_key)
      on conflict (id) do update set primary_key = excluded.primary_key, updated_at = now();
    for member_key in select jsonb_array_elements_text(bucket->'memberKeys') loop
      if member_key like 'sighting:%' then
        if not exists(select 1 from public.tumedved_logs where id = substr(member_key, 10) and status = 'approved') then
          raise exception 'Missing approved sighting: %', member_key;
        end if;
        insert into public.sighting_bucket_members(record_key, bucket_id, sighting_id)
          values (member_key, bucket_id, substr(member_key, 10));
      elsif member_key ~ '^report:[1-9][0-9]*$' then
        if not exists(select 1 from public.bear_reports where id = substr(member_key, 8)::bigint and status = 'approved') then
          raise exception 'Missing approved report: %', member_key;
        end if;
        insert into public.sighting_bucket_members(record_key, bucket_id, report_id)
          values (member_key, bucket_id, substr(member_key, 8)::bigint);
      else
        raise exception 'Invalid record key: %', member_key;
      end if;
    end loop;
    applied := applied + 1;
  end loop;
  return jsonb_build_object('applied', applied);
end;
$$;

revoke all on function public.invalidate_public_snapshot() from public, anon, authenticated;
revoke all on function public.read_public_snapshot(text, text) from public, anon, authenticated;
revoke all on function public.publish_public_snapshot(bigint, date, jsonb) from public, anon, authenticated;
revoke all on function public.apply_sighting_bucket_plan(jsonb) from public, anon, authenticated;
grant execute on function public.invalidate_public_snapshot() to service_role;
grant execute on function public.read_public_snapshot(text, text) to service_role;
grant execute on function public.publish_public_snapshot(bigint, date, jsonb) to service_role;
grant execute on function public.apply_sighting_bucket_plan(jsonb) to service_role;

-- Email is paused. Stop creating newsletter work while keeping its history.
alter table public.bear_reports disable trigger bear_reports_email_notification;
alter table public.tumedved_logs disable trigger tumedved_logs_email_notification;
alter table public.news_logs disable trigger news_logs_email_notification;

commit;
