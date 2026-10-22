begin;

create or replace function public.publish_public_snapshot(p_revision bigint, p_day date, p_payload jsonb)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  record_documents jsonb := p_payload->'records';
  overview_documents jsonb := p_payload - 'records';
begin
  if jsonb_typeof(overview_documents->'stats'->'report') is distinct from 'object'
    or jsonb_typeof(overview_documents->'overview') is distinct from 'object'
    or jsonb_typeof(overview_documents->'locations') is distinct from 'object'
    or jsonb_typeof(record_documents) is distinct from 'object' then
    raise exception 'Invalid public snapshot; publisher must include record documents';
  end if;
  update public.public_snapshots
    set built_revision = p_revision, built_day = p_day, payload = overview_documents, updated_at = now()
    where id = 'overview' and revision = p_revision;
  if not found then return false; end if;

  -- Extract the multi-megabyte record map once, rather than copying it for
  -- every existing row in the DELETE filter. Publication remains atomic.
  delete from public.public_record_snapshots where not (record_documents ? record_key);
  insert into public.public_record_snapshots(record_key, payload)
    select key, value from jsonb_each(record_documents)
    on conflict(record_key) do update set payload = excluded.payload
      where public_record_snapshots.payload is distinct from excluded.payload;
  return true;
end;
$$;

revoke all on function public.publish_public_snapshot(bigint, date, jsonb) from public, anon, authenticated;
grant execute on function public.publish_public_snapshot(bigint, date, jsonb) to service_role;

commit;
