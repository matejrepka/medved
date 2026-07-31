-- Migration 006: durable real-world incidents for approved news coverage.
--
-- Conservative by design: the migration itself creates no incidents and attaches
-- no historic articles. Existing approved news remains public and ungrouped.
-- Future approvals use the server's high-confidence automatic matcher.
--
-- Supabase SQL Editor: run this entire file with no partial text selection.
-- PL/pgSQL function bodies must include both matching named delimiters below.
-- The migration is idempotent and can safely be run again after an interrupted
-- or partial attempt.

create table if not exists public.news_incidents (
  id uuid primary key default gen_random_uuid(),
  event_date date not null,
  event_date_precision text not null default 'day'
    check (event_date_precision in ('day', 'approximate')),
  locality text not null,
  lat double precision,
  lng double precision,
  title text not null,
  summary text,
  status text not null default 'active'
    check (status in ('active', 'resolved', 'archived')),
  -- This is deliberately not called "confirmed". Multiple media reports do
  -- not prove an event; only the presence of an official notice changes it.
  verification_status text not null default 'reported'
    check (verification_status in ('reported', 'official_notice')),
  primary_news_id text references public.news_logs(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists news_incidents_event_locality_idx
  on public.news_incidents (event_date desc, locality);

create table if not exists public.incident_news_links (
  incident_id uuid not null references public.news_incidents(id) on delete cascade,
  news_id text not null references public.news_logs(id) on delete cascade,
  source_type text not null default 'other'
    check (source_type in ('official_notice', 'local_original', 'national', 'syndication', 'other')),
  source_priority smallint not null
    check (source_priority in (10, 20, 30, 40, 50)),
  attached_at timestamptz not null default now(),
  attached_by text,
  primary key (incident_id, news_id),
  unique (news_id)
);

create index if not exists incident_news_links_primary_order_idx
  on public.incident_news_links (incident_id, source_priority, attached_at);

create table if not exists public.news_source_aliases (
  id bigserial primary key,
  news_id text not null references public.news_logs(id) on delete cascade,
  alias_type text not null check (alias_type in ('url', 'title')),
  alias_value text not null,
  normalized_value text not null,
  created_at timestamptz not null default now(),
  unique (news_id, alias_type, normalized_value)
);

-- The same canonical URL cannot silently represent two attached records.
create unique index if not exists news_source_aliases_url_unique_idx
  on public.news_source_aliases (normalized_value)
  where alias_type = 'url';

-- A warning article may describe several distinct sightings. The ordered child
-- rows remain attached to the independent news record; the first one is also
-- mirrored in news_logs.place/lat/lng for backward compatibility.
create table if not exists public.news_warning_locations (
  news_id text not null references public.news_logs(id) on delete cascade,
  position smallint not null check (position between 0 and 11),
  place text not null check (length(trim(place)) between 1 and 160),
  lat double precision,
  lng double precision,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (news_id, position),
  check ((lat is null and lng is null) or (lat is not null and lng is not null))
);

create unique index if not exists news_warning_locations_name_unique_idx
  on public.news_warning_locations (news_id, lower(trim(place)));

create index if not exists news_warning_locations_coordinates_idx
  on public.news_warning_locations (lat, lng)
  where lat is not null and lng is not null;

create table if not exists public.news_incident_audit (
  id bigserial primary key,
  news_id text references public.news_logs(id) on delete set null,
  incident_id uuid references public.news_incidents(id) on delete set null,
  action text not null check (action in (
    'approved_ungrouped',
    'rejected',
    'incident_created',
    'article_attached',
    'article_moved'
  )),
  actor text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists news_incident_audit_news_created_idx
  on public.news_incident_audit (news_id, created_at desc);

alter table public.news_incidents enable row level security;
alter table public.incident_news_links enable row level security;
alter table public.news_source_aliases enable row level security;
alter table public.news_warning_locations enable row level security;
alter table public.news_incident_audit enable row level security;

create or replace function public.refresh_news_incident_primary(p_incident_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $incident_primary$
declare
  v_primary_news_id text;
  v_has_official boolean;
begin
  if p_incident_id is null then
    return;
  end if;

  select l.news_id
    into v_primary_news_id
  from public.incident_news_links l
  join public.news_logs n on n.id = l.news_id
  where l.incident_id = p_incident_id
    and n.status = 'approved'
  order by l.source_priority asc,
           n.published_at asc nulls last,
           l.attached_at asc,
           l.news_id asc
  limit 1;

  select exists (
    select 1
    from public.incident_news_links l
    join public.news_logs n on n.id = l.news_id
    where l.incident_id = p_incident_id
      and l.source_type = 'official_notice'
      and n.status = 'approved'
  ) into v_has_official;

  update public.news_incidents
  set primary_news_id = v_primary_news_id,
      verification_status = case when v_has_official then 'official_notice' else 'reported' end,
      updated_at = now()
  where id = p_incident_id;
end;
$incident_primary$;

-- Remove the earlier single-location overload if a partial/older copy of this
-- migration was already executed. The replacement below accepts locations as
-- an additional final JSON argument.
drop function if exists public.moderate_news_with_incident(
  text, text, text, text, double precision, double precision, text, uuid,
  date, text, text, double precision, double precision, text, text, text, text, text
);

create or replace function public.moderate_news_with_incident(
  p_news_id text,
  p_status text,
  p_category text default 'article',
  p_place text default null,
  p_lat double precision default null,
  p_lng double precision default null,
  p_incident_action text default 'ungrouped',
  p_incident_id uuid default null,
  p_event_date date default null,
  p_event_date_precision text default 'day',
  p_incident_locality text default null,
  p_incident_lat double precision default null,
  p_incident_lng double precision default null,
  p_incident_title text default null,
  p_incident_summary text default null,
  p_incident_status text default 'active',
  p_source_type text default 'other',
  p_actor text default 'admin',
  p_warning_locations jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $incident_moderation$
declare
  v_news public.news_logs%rowtype;
  v_incident_id uuid;
  v_old_incident_id uuid;
  v_source_type text;
  v_source_priority smallint;
  v_action text;
  v_url text;
  v_normalized_url text;
  v_alias_news_id text;
begin
  if p_status not in ('approved', 'rejected') then
    raise exception 'Neplatný stav moderácie.';
  end if;
  if p_category not in ('article', 'warning') then
    raise exception 'Neplatná kategória správy.';
  end if;

  select * into v_news
  from public.news_logs
  where id = p_news_id
  for update;

  if not found then
    raise exception 'Správa sa nenašla.';
  end if;

  select incident_id into v_old_incident_id
  from public.incident_news_links
  where news_id = p_news_id;

  update public.news_logs
  set status = p_status,
      category = case when p_status = 'approved' then p_category else category end,
      place = case
        when p_status = 'approved' and p_category = 'warning' then nullif(trim(p_place), '')
        when p_status = 'approved' then null
        else place
      end,
      lat = case
        when p_status = 'approved' and p_category = 'warning' then p_lat
        when p_status = 'approved' then null
        else lat
      end,
      lng = case
        when p_status = 'approved' and p_category = 'warning' then p_lng
        when p_status = 'approved' then null
        else lng
      end,
      has_coords = case
        when p_status = 'approved' and p_category = 'warning' then p_lat is not null and p_lng is not null
        when p_status = 'approved' then false
        else has_coords
      end,
      updated_at = now()
  where id = p_news_id;

  if p_status = 'approved' then
    delete from public.news_warning_locations where news_id = p_news_id;

    if p_category = 'warning' then
      if jsonb_typeof(coalesce(p_warning_locations, '[]'::jsonb)) <> 'array' then
        raise exception 'Lokality varovania musia byť pole.';
      end if;
      if jsonb_array_length(coalesce(p_warning_locations, '[]'::jsonb)) > 12 then
        raise exception 'Jedno varovanie môže mať najviac 12 lokalít.';
      end if;

      insert into public.news_warning_locations (news_id, position, place, lat, lng)
      select
        p_news_id,
        (entry.ordinality - 1)::smallint,
        trim(entry.location ->> 'place'),
        nullif(entry.location ->> 'lat', '')::double precision,
        nullif(entry.location ->> 'lng', '')::double precision
      from jsonb_array_elements(coalesce(p_warning_locations, '[]'::jsonb))
        with ordinality as entry(location, ordinality)
      where entry.ordinality <= 12
        and nullif(trim(entry.location ->> 'place'), '') is not null;

      if not exists (
        select 1 from public.news_warning_locations where news_id = p_news_id
      ) and nullif(trim(p_place), '') is not null then
        insert into public.news_warning_locations (news_id, position, place, lat, lng)
        values (p_news_id, 0, trim(p_place), p_lat, p_lng);
      end if;
    end if;
  end if;

  if p_status = 'rejected' then
    delete from public.incident_news_links where news_id = p_news_id;
    perform public.refresh_news_incident_primary(v_old_incident_id);
    insert into public.news_incident_audit (news_id, incident_id, action, actor)
      values (p_news_id, v_old_incident_id, 'rejected', p_actor);
    return jsonb_build_object('status', p_status, 'incidentId', null);
  end if;

  if p_incident_action not in ('ungrouped', 'attach', 'create') then
    raise exception 'Neplatné rozhodnutie o udalosti.';
  end if;

  if p_incident_action = 'ungrouped' then
    delete from public.incident_news_links where news_id = p_news_id;
    perform public.refresh_news_incident_primary(v_old_incident_id);
    insert into public.news_incident_audit (news_id, incident_id, action, actor)
      values (p_news_id, null, 'approved_ungrouped', p_actor);
    return jsonb_build_object('status', p_status, 'incidentId', null);
  end if;

  if p_incident_action = 'create' then
    if p_event_date is null or nullif(trim(p_incident_locality), '') is null then
      raise exception 'Nová udalosť vyžaduje dátum udalosti a spoľahlivú lokalitu.';
    end if;
    if p_event_date_precision not in ('day', 'approximate') then
      raise exception 'Neplatná presnosť dátumu udalosti.';
    end if;
    if p_incident_status not in ('active', 'resolved', 'archived') then
      raise exception 'Neplatný stav udalosti.';
    end if;

    insert into public.news_incidents (
      event_date, event_date_precision, locality, lat, lng, title, summary, status
    ) values (
      p_event_date,
      p_event_date_precision,
      trim(p_incident_locality),
      p_incident_lat,
      p_incident_lng,
      coalesce(nullif(trim(p_incident_title), ''), v_news.title, 'Medvedia udalosť'),
      nullif(trim(p_incident_summary), ''),
      p_incident_status
    ) returning id into v_incident_id;

    v_action := 'incident_created';
  else
    if p_incident_id is null or not exists (
      select 1 from public.news_incidents where id = p_incident_id
    ) then
      raise exception 'Vybraná udalosť sa nenašla.';
    end if;
    v_incident_id := p_incident_id;
    v_action := case
      when v_old_incident_id is not null and v_old_incident_id <> v_incident_id then 'article_moved'
      else 'article_attached'
    end;
  end if;

  v_source_type := case
    when p_source_type in ('official_notice', 'local_original', 'national', 'syndication', 'other') then p_source_type
    else 'other'
  end;
  v_source_priority := case v_source_type
    when 'official_notice' then 10
    when 'local_original' then 20
    when 'national' then 30
    when 'syndication' then 40
    else 50
  end;

  v_url := coalesce(
    nullif(trim(v_news.article_url), ''),
    nullif(trim(v_news.google_news_url), ''),
    nullif(trim(v_news.link), '')
  );
  if v_url is not null then
    v_normalized_url := lower(regexp_replace(v_url, '/+$', ''));
    perform pg_advisory_xact_lock(hashtextextended(v_normalized_url, 0));
    select news_id into v_alias_news_id
    from public.news_source_aliases
    where alias_type = 'url' and normalized_value = v_normalized_url
    limit 1;
    if v_alias_news_id is not null and v_alias_news_id <> p_news_id then
      raise exception 'Rovnaká zdrojová URL už patrí k článku %. Skontrolujte duplicitný záznam v správe obsahu.', v_alias_news_id;
    end if;
  end if;

  insert into public.incident_news_links (
    incident_id, news_id, source_type, source_priority, attached_by
  ) values (
    v_incident_id, p_news_id, v_source_type, v_source_priority, p_actor
  )
  on conflict (news_id) do update
  set incident_id = excluded.incident_id,
      source_type = excluded.source_type,
      source_priority = excluded.source_priority,
      attached_at = now(),
      attached_by = excluded.attached_by;

  if nullif(trim(v_news.title), '') is not null then
    insert into public.news_source_aliases (news_id, alias_type, alias_value, normalized_value)
    values (
      p_news_id,
      'title',
      v_news.title,
      lower(regexp_replace(trim(v_news.title), '\\s+', ' ', 'g'))
    ) on conflict do nothing;
  end if;

  foreach v_url in array array[v_news.article_url, v_news.google_news_url, v_news.link]
  loop
    if nullif(trim(v_url), '') is not null then
      insert into public.news_source_aliases (news_id, alias_type, alias_value, normalized_value)
      values (
        p_news_id,
        'url',
        v_url,
        lower(regexp_replace(trim(v_url), '/+$', ''))
      ) on conflict do nothing;
    end if;
  end loop;

  perform public.refresh_news_incident_primary(v_incident_id);
  if v_old_incident_id is not null and v_old_incident_id <> v_incident_id then
    perform public.refresh_news_incident_primary(v_old_incident_id);
  end if;

  insert into public.news_incident_audit (news_id, incident_id, action, actor, details)
  values (
    p_news_id,
    v_incident_id,
    v_action,
    p_actor,
    jsonb_build_object('sourceType', v_source_type, 'previousIncidentId', v_old_incident_id)
  );

  return jsonb_build_object(
    'status', p_status,
    'incidentId', v_incident_id,
    'action', v_action,
    'sourceType', v_source_type
  );
end;
$incident_moderation$;

revoke all on function public.refresh_news_incident_primary(uuid) from public, anon, authenticated;
revoke all on function public.moderate_news_with_incident(
  text, text, text, text, double precision, double precision, text, uuid,
  date, text, text, double precision, double precision, text, text, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.refresh_news_incident_primary(uuid) to service_role;
grant execute on function public.moderate_news_with_incident(
  text, text, text, text, double precision, double precision, text, uuid,
  date, text, text, double precision, double precision, text, text, text, text, text, jsonb
) to service_role;
