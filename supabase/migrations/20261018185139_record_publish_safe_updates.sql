begin;

create or replace function public.publish_public_snapshot(p_revision bigint, p_day date, p_payload jsonb)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if jsonb_typeof(p_payload->'stats'->'report') is distinct from 'object'
    or jsonb_typeof(p_payload->'overview') is distinct from 'object'
    or jsonb_typeof(p_payload->'locations') is distinct from 'object'
    or jsonb_typeof(p_payload->'records') is distinct from 'object' then
    raise exception 'Invalid public snapshot; publisher must include record documents';
  end if;
  update public.public_snapshots
    set built_revision = p_revision, built_day = p_day, payload = p_payload - 'records', updated_at = now()
    where id = 'overview' and revision = p_revision;
  if not found then return false; end if;

  -- Compatible with pg-safeupdate. Retain unchanged documents and only remove
  -- records absent from the new approved snapshot, atomically with publication.
  delete from public.public_record_snapshots where not (p_payload->'records' ? record_key);
  insert into public.public_record_snapshots(record_key, payload)
    select key, value from jsonb_each(p_payload->'records')
    on conflict(record_key) do update set payload = excluded.payload
      where public_record_snapshots.payload is distinct from excluded.payload;
  return true;
end;
$$;

revoke all on function public.publish_public_snapshot(bigint, date, jsonb) from public, anon, authenticated;
grant execute on function public.publish_public_snapshot(bigint, date, jsonb) to service_role;

commit;
