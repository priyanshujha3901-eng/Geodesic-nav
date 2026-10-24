-- =====================================================================
-- Geodesic community reports — additive migration. Run ONCE in the Supabase SQL Editor,
-- after schema.sql and migration_username_auth.sql. It creates new objects only
-- (it does not touch cameras, profiles, groups or any existing table).
--
-- Rules enforced on the SERVER (the app cannot choose its own status or vote totals):
--   * status / confirms / denies are set only by the functions below
--   * one answer per user per report, only within 300 m of the report, never on your own report
--   * max 10 new reports per user per hour; same category within 40 m merges into the existing report
--   * soft removal only (status = 'removed'); nothing is ever deleted; every change is logged in report_events
--   * expiry is evaluated when reports are read (expires_at), per category
-- Guests (anonymous sessions) may report for now. To require a real account later,
-- uncomment the marked lines in create_report and vote_report.
-- =====================================================================

create table if not exists public.map_reports (
  id                uuid primary key default gen_random_uuid(),
  category          text not null check (category in ('speed_camera','road_closure','accident_breakdown','congestion','other')),
  description       text check (description is null or char_length(description) <= 80),
  location          geography(Point, 4326) not null,
  latitude          double precision not null,
  longitude         double precision not null,
  position_source   text not null default 'gps' check (position_source in ('gps','adjusted','manual')),
  accuracy_m        real,
  status            text not null default 'unconfirmed'
                      check (status in ('unconfirmed','community_confirmed','dimmed','removed')),
  confirms          integer not null default 0,   -- independent "still there" answers (creator excluded)
  denies            integer not null default 0,   -- independent "not there" answers
  created_by        uuid references auth.users(id) on delete set null,
  client_request_id uuid,
  created_at        timestamptz not null default now(),
  last_confirmed_at timestamptz not null default now(),
  expires_at        timestamptz,                  -- null = does not expire (speed cameras)
  removed_at        timestamptz
);

create unique index if not exists map_reports_request_uniq
  on public.map_reports (created_by, client_request_id) where client_request_id is not null;
create index if not exists map_reports_latlng_idx   on public.map_reports (latitude, longitude);
create index if not exists map_reports_location_idx on public.map_reports using gist (location);
create index if not exists map_reports_category_idx on public.map_reports (category);
create index if not exists map_reports_creator_idx  on public.map_reports (created_by, created_at desc);

create table if not exists public.report_votes (
  report_id  uuid not null references public.map_reports(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  vote       text not null check (vote in ('confirm','deny')),
  created_at timestamptz not null default now(),
  primary key (report_id, user_id)
);

create table if not exists public.report_dismissals (   -- "Hide for me" (personal, no effect on others)
  report_id  uuid not null references public.map_reports(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (report_id, user_id)
);

create table if not exists public.report_events (        -- audit history, never deleted by the app
  id         bigserial primary key,
  report_id  uuid not null references public.map_reports(id) on delete cascade,
  user_id    uuid,
  event      text not null,
  detail     jsonb,
  created_at timestamptz not null default now()
);
create index if not exists report_events_report_idx on public.report_events (report_id, created_at);

-- No direct client access: RLS on, no policies, privileges revoked. Everything goes through the functions below.
alter table public.map_reports       enable row level security;
alter table public.report_votes      enable row level security;
alter table public.report_dismissals enable row level security;
alter table public.report_events     enable row level security;
revoke all on public.map_reports, public.report_votes, public.report_dismissals, public.report_events from anon, authenticated;

-- How long each category stays visible; every "still there" answer restarts the clock.
create or replace function public.report_ttl(p_category text)
returns interval language sql immutable as $$
  select case p_category
    when 'speed_camera'       then null
    when 'accident_breakdown' then interval '2 hours'
    when 'congestion'         then interval '45 minutes'
    when 'road_closure'       then interval '24 hours'
    when 'other'              then interval '3 hours'
    else interval '3 hours'
  end;
$$;

-- Internal: recompute status from the independent vote counts.
create or replace function public._report_recompute(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  r public.map_reports%rowtype;
  v_new text;
begin
  select * into r from public.map_reports where id = p_id for update;
  if not found or r.status = 'removed' then return; end if;

  if r.category = 'speed_camera' then
    if    r.denies >= 10 and r.denies > 2 * r.confirms then v_new := 'removed';
    elsif r.denies >= 2  and r.denies > r.confirms     then v_new := 'dimmed';
    elsif r.confirms >= 2 and r.confirms > r.denies    then v_new := 'community_confirmed';
    else v_new := 'unconfirmed';
    end if;
  else  -- temporary reports clear faster
    if    r.denies >= 3 and r.denies > r.confirms      then v_new := 'removed';
    elsif r.denies >= 2 and r.denies > r.confirms      then v_new := 'dimmed';
    elsif r.confirms >= 2 and r.confirms > r.denies    then v_new := 'community_confirmed';
    else v_new := 'unconfirmed';
    end if;
  end if;

  if v_new <> r.status then
    update public.map_reports
       set status = v_new,
           removed_at = case when v_new = 'removed' then now() else removed_at end
     where id = p_id;
    insert into public.report_events (report_id, user_id, event, detail)
    values (p_id, null, 'status_changed',
            jsonb_build_object('from', r.status, 'to', v_new, 'confirms', r.confirms, 'denies', r.denies));
  end if;
end;
$$;

-- Create a report. Idempotent per (user, p_request_id) so a retry after a timeout cannot double-save.
create or replace function public.create_report(
  p_category        text,
  p_lat             double precision,
  p_lng             double precision,
  p_description     text default null,
  p_request_id      uuid default null,
  p_position_source text default 'gps',
  p_accuracy_m      real default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_point geography;
  v_desc  text;
  v_src   text;
  v_ex    public.map_reports%rowtype;
  v_id    uuid;
  v_ttl   interval;
begin
  if v_uid is null then raise exception 'Not signed in.'; end if;
  -- To require a real account later, uncomment:
  -- if coalesce((select is_anonymous from public.profiles where id = v_uid), true) then raise exception 'Sign in to report.'; end if;

  if p_category is null or p_category not in ('speed_camera','road_closure','accident_breakdown','congestion','other') then
    raise exception 'Unknown report type.';
  end if;
  if p_lat is null or p_lng is null or p_lat not between 6 and 38 or p_lng not between 68 and 98 then
    raise exception 'That location is outside the supported area.';
  end if;

  v_desc := null;
  if p_category = 'other' and p_description is not null then
    v_desc := btrim(regexp_replace(regexp_replace(p_description, '[[:cntrl:]]', ' ', 'g'), '\s+', ' ', 'g'));
    if char_length(v_desc) > 80 then raise exception 'Description is too long (80 characters max).'; end if;
    if v_desc = '' then v_desc := null; end if;
  end if;
  v_src := case when p_position_source in ('gps','adjusted','manual') then p_position_source else 'gps' end;

  -- retry of an earlier request
  if p_request_id is not null then
    select * into v_ex from public.map_reports where created_by = v_uid and client_request_id = p_request_id;
    if found then
      return jsonb_build_object('id', v_ex.id, 'merged', false, 'replay', true, 'status', v_ex.status);
    end if;
  end if;

  if (select count(*) from public.map_reports where created_by = v_uid and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'Too many reports. Please try again later.';
  end if;

  v_point := st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography;

  -- same thing already reported within 40 m: don't create a duplicate (this does NOT count as a vote)
  select * into v_ex
    from public.map_reports
   where category = p_category and status <> 'removed'
     and (expires_at is null or expires_at > now())
     and st_dwithin(location, v_point, 40)
   order by st_distance(location, v_point)
   limit 1;
  if found then
    insert into public.report_events (report_id, user_id, event) values (v_ex.id, v_uid, 'duplicate_report_merged');
    return jsonb_build_object('id', v_ex.id, 'merged', true, 'status', v_ex.status);
  end if;

  v_ttl := public.report_ttl(p_category);
  begin
    insert into public.map_reports
      (category, description, location, latitude, longitude, position_source, accuracy_m,
       created_by, client_request_id, expires_at)
    values
      (p_category, v_desc, v_point, p_lat, p_lng, v_src, p_accuracy_m,
       v_uid, p_request_id, case when v_ttl is null then null else now() + v_ttl end)
    returning id into v_id;
  exception when unique_violation then
    select id into v_id from public.map_reports where created_by = v_uid and client_request_id = p_request_id;
    return jsonb_build_object('id', v_id, 'merged', false, 'replay', true, 'status', 'unconfirmed');
  end;

  insert into public.report_events (report_id, user_id, event, detail)
  values (v_id, v_uid, 'created', jsonb_build_object('category', p_category, 'source', v_src, 'accuracy_m', p_accuracy_m));

  return jsonb_build_object('id', v_id, 'merged', false, 'status', 'unconfirmed');
end;
$$;

-- Answer "still there" / "not there".
create or replace function public.vote_report(
  p_report_id uuid, p_vote text, p_lat double precision, p_lng double precision
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  r     public.map_reports%rowtype;
  v_ttl interval;
begin
  if v_uid is null then raise exception 'Not signed in.'; end if;
  -- To require a real account later, uncomment:
  -- if coalesce((select is_anonymous from public.profiles where id = v_uid), true) then raise exception 'Sign in to answer.'; end if;
  if p_vote is null or p_vote not in ('confirm','deny') then raise exception 'Invalid answer.'; end if;

  select * into r from public.map_reports
   where id = p_report_id and status <> 'removed' and (expires_at is null or expires_at > now())
   for update;
  if not found then raise exception 'This report is no longer active.'; end if;
  if r.created_by = v_uid then raise exception 'You cannot answer your own report.'; end if;
  if p_lat is null or p_lng is null then raise exception 'Turn on location to answer.'; end if;
  if st_distance(r.location, st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography) > 300 then
    raise exception 'Get within 300 m of this report to answer.';
  end if;
  if exists (select 1 from public.report_votes where report_id = p_report_id and user_id = v_uid) then
    raise exception 'You already answered this report.';
  end if;

  insert into public.report_votes (report_id, user_id, vote) values (p_report_id, v_uid, p_vote);
  v_ttl := public.report_ttl(r.category);

  if p_vote = 'confirm' then
    update public.map_reports
       set confirms = confirms + 1,
           last_confirmed_at = now(),
           expires_at = case when v_ttl is null then expires_at else now() + v_ttl end
     where id = p_report_id;
  else
    update public.map_reports set denies = denies + 1 where id = p_report_id;
  end if;

  insert into public.report_events (report_id, user_id, event, detail)
  values (p_report_id, v_uid, 'vote', jsonb_build_object('vote', p_vote));

  perform public._report_recompute(p_report_id);
  return jsonb_build_object('ok', true);
end;
$$;

-- "Hide for me": personal, does not change anything for other users.
create or replace function public.dismiss_report(p_report_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Not signed in.'; end if;
  if not exists (select 1 from public.map_reports where id = p_report_id) then raise exception 'Report not found.'; end if;
  insert into public.report_dismissals (report_id, user_id) values (p_report_id, v_uid) on conflict do nothing;
  insert into public.report_events (report_id, user_id, event) values (p_report_id, v_uid, 'dismissed');
end;
$$;

-- Reports inside a bounding box (optionally only some categories). Capped at 1000 rows.
create or replace function public.get_reports_in_bbox(
  p_min_lat double precision, p_min_lng double precision,
  p_max_lat double precision, p_max_lng double precision,
  p_categories text[] default null,
  p_limit integer default 1000
) returns table (
  id uuid, category text, description text, latitude double precision, longitude double precision,
  status text, confirms integer, denies integer, position_source text,
  created_at timestamptz, last_confirmed_at timestamptz, is_mine boolean, my_vote text
)
language sql stable security definer set search_path = public as $$
  select r.id, r.category, r.description, r.latitude, r.longitude,
         r.status, r.confirms, r.denies, r.position_source,
         r.created_at, r.last_confirmed_at,
         coalesce(r.created_by = auth.uid(), false) as is_mine,
         v.vote as my_vote
    from public.map_reports r
    left join public.report_votes v on v.report_id = r.id and v.user_id = auth.uid()
   where r.status <> 'removed'
     and (r.expires_at is null or r.expires_at > now())
     and r.latitude  between least(p_min_lat, p_max_lat) and greatest(p_min_lat, p_max_lat)
     and r.longitude between least(p_min_lng, p_max_lng) and greatest(p_min_lng, p_max_lng)
     and (p_categories is null or r.category = any(p_categories))
     and not exists (select 1 from public.report_dismissals d where d.report_id = r.id and d.user_id = auth.uid())
   order by r.created_at desc
   limit least(greatest(coalesce(p_limit, 1000), 1), 1000);
$$;

-- The signed-in user's own active reports (so they stay visible to the reporter wherever they are).
create or replace function public.get_my_reports()
returns table (
  id uuid, category text, description text, latitude double precision, longitude double precision,
  status text, confirms integer, denies integer, position_source text,
  created_at timestamptz, last_confirmed_at timestamptz, is_mine boolean, my_vote text
)
language sql stable security definer set search_path = public as $$
  select r.id, r.category, r.description, r.latitude, r.longitude,
         r.status, r.confirms, r.denies, r.position_source,
         r.created_at, r.last_confirmed_at, true as is_mine, null::text as my_vote
    from public.map_reports r
   where r.created_by = auth.uid()
     and r.status <> 'removed'
     and (r.expires_at is null or r.expires_at > now())
   order by r.created_at desc
   limit 50;
$$;

-- Only signed-in sessions (guests included) may call the public functions.
revoke all on function public.create_report(text, double precision, double precision, text, uuid, text, real) from public, anon;
revoke all on function public.vote_report(uuid, text, double precision, double precision)                      from public, anon;
revoke all on function public.dismiss_report(uuid)                                                             from public, anon;
revoke all on function public.get_reports_in_bbox(double precision, double precision, double precision, double precision, text[], integer) from public, anon;
revoke all on function public.get_my_reports()                                                                 from public, anon;
revoke all on function public._report_recompute(uuid)                                                          from public, anon, authenticated;
grant execute on function public.create_report(text, double precision, double precision, text, uuid, text, real) to authenticated;
grant execute on function public.vote_report(uuid, text, double precision, double precision)                      to authenticated;
grant execute on function public.dismiss_report(uuid)                                                             to authenticated;
grant execute on function public.get_reports_in_bbox(double precision, double precision, double precision, double precision, text[], integer) to authenticated;
grant execute on function public.get_my_reports()                                                                 to authenticated;
