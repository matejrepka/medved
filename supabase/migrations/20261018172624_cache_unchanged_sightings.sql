-- Apply after docs/migration-011-public-snapshots-buckets.sql.
begin;

-- Technical scrape timestamps alone do not change a sighting. Returning NULL
-- skips the physical UPDATE and its row-level notification triggers entirely.
create or replace function public.skip_unchanged_sighting_import()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if (to_jsonb(new) - array['scraped_at', 'updated_at']) =
     (to_jsonb(old) - array['scraped_at', 'updated_at']) then
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists skip_unchanged_sighting_import on public.tumedved_logs;
create trigger skip_unchanged_sighting_import before update on public.tumedved_logs
for each row execute function public.skip_unchanged_sighting_import();

-- An empty INSERT/UPDATE/DELETE statement must not invalidate the snapshot.
-- Transition tables contain only rows actually written, including after an
-- INSERT ... ON CONFLICT that the BEFORE trigger skipped as unchanged.
create or replace function public.invalidate_public_snapshot()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if TG_OP = 'TRUNCATE' then
    update public.public_snapshots set revision = revision + 1 where id = 'overview';
  elsif exists (select 1 from snapshot_changed_rows) then
    update public.public_snapshots set revision = revision + 1 where id = 'overview';
  end if;
  return null;
end;
$$;

do $$
declare table_name text;
begin
  foreach table_name in array array['tumedved_logs', 'bear_reports', 'news_logs',
    'news_warning_locations', 'news_incidents', 'incident_news_links',
    'sighting_buckets', 'sighting_bucket_members'] loop
    execute format('drop trigger if exists public_snapshot_changed on public.%I', table_name);
    execute format('drop trigger if exists public_snapshot_inserted on public.%I', table_name);
    execute format('drop trigger if exists public_snapshot_updated on public.%I', table_name);
    execute format('drop trigger if exists public_snapshot_deleted on public.%I', table_name);
    execute format('drop trigger if exists public_snapshot_truncated on public.%I', table_name);
    execute format('create trigger public_snapshot_inserted after insert on public.%I
      referencing new table as snapshot_changed_rows for each statement
      execute function public.invalidate_public_snapshot()', table_name);
    execute format('create trigger public_snapshot_updated after update on public.%I
      referencing new table as snapshot_changed_rows for each statement
      execute function public.invalidate_public_snapshot()', table_name);
    execute format('create trigger public_snapshot_deleted after delete on public.%I
      referencing old table as snapshot_changed_rows for each statement
      execute function public.invalidate_public_snapshot()', table_name);
    execute format('create trigger public_snapshot_truncated after truncate on public.%I
      for each statement execute function public.invalidate_public_snapshot()', table_name);
  end loop;
end;
$$;

revoke all on function public.skip_unchanged_sighting_import() from public, anon, authenticated;
grant execute on function public.skip_unchanged_sighting_import() to service_role;

commit;
