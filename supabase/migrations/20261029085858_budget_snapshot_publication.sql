begin;

-- This private background RPC publishes several megabytes atomically. It must
-- not inherit the API's 8-second request budget or spill its record map to disk.
alter function public.publish_public_snapshot(bigint, date, jsonb)
  set statement_timeout = '30s';
alter function public.publish_public_snapshot(bigint, date, jsonb)
  set work_mem = '16MB';

-- PostgREST hoists the function timeout before executing the RPC statement.
notify pgrst, 'reload schema';

commit;
