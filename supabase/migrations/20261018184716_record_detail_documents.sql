begin;

create table if not exists public.public_record_snapshots (
  record_key text primary key,
  payload jsonb not null
);
alter table public.public_record_snapshots enable row level security;
revoke all on public.public_record_snapshots from public, anon, authenticated;
grant all on public.public_record_snapshots to service_role;

create or replace function public.publish_public_snapshot(p_revision bigint, p_day date, p_payload jsonb)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if jsonb_typeof(p_payload->'stats'->'report') is distinct from 'object'
    or jsonb_typeof(p_payload->'overview') is distinct from 'object'
    or jsonb_typeof(p_payload->'locations') is distinct from 'object'
    or jsonb_typeof(p_payload->'records') is distinct from 'object' then
    raise exception 'Invalid public snapshot; publisher must include record documents';
  end if;
  -- The revision row lock serializes publishers. Records and all other public
  -- documents become visible together in the same transaction.
  update public.public_snapshots
    set built_revision = p_revision, built_day = p_day, payload = p_payload - 'records', updated_at = now()
    where id = 'overview' and revision = p_revision;
  if not found then return false; end if;

  delete from public.public_record_snapshots;
  insert into public.public_record_snapshots(record_key, payload)
    select key, value from jsonb_each(p_payload->'records');
  return true;
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
    when 'record' then (select r.payload from public.public_record_snapshots r where r.record_key = p_slug)
    else null end
  from public.public_snapshots
  where id = 'overview' and built_revision = revision;
$$;

revoke all on function public.publish_public_snapshot(bigint, date, jsonb) from public, anon, authenticated;
revoke all on function public.read_public_snapshot(text, text) from public, anon, authenticated;
grant execute on function public.publish_public_snapshot(bigint, date, jsonb) to service_role;
grant execute on function public.read_public_snapshot(text, text) to service_role;

commit;
