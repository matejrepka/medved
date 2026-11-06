begin;

create or replace function public.replace_news_warning_locations(p_news_id text, p_locations jsonb)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if jsonb_typeof(p_locations) is distinct from 'array' then
    raise exception 'Warning locations must be an array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_locations) > 12 then
    raise exception 'A warning can have at most 12 locations' using errcode = '22023';
  end if;

  -- Serialize replacements for one article, including an initially empty list.
  perform 1 from public.news_logs where id = p_news_id for update;
  if not found then
    raise exception 'News record not found' using errcode = 'P0002';
  end if;

  delete from public.news_warning_locations where news_id = p_news_id;
  insert into public.news_warning_locations(news_id, position, place, lat, lng)
    select p_news_id, (entry.ordinality - 1)::smallint,
      trim(entry.location ->> 'place'),
      nullif(entry.location ->> 'lat', '')::double precision,
      nullif(entry.location ->> 'lng', '')::double precision
    from jsonb_array_elements(p_locations) with ordinality as entry(location, ordinality);
  return true;
end;
$$;

revoke all on function public.replace_news_warning_locations(text, jsonb) from public, anon, authenticated;
grant execute on function public.replace_news_warning_locations(text, jsonb) to service_role;

commit;
