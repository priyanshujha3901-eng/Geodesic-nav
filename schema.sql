-- =========================================================
-- Geodesic — Supabase schema (Phase 1 + Phase 2)
-- Run this entire file once in: Supabase Dashboard > SQL Editor > New query
-- =========================================================

create extension if not exists postgis;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------
-- TABLES
-- ---------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  is_anonymous boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.routes (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references auth.users(id) on delete cascade,
  origin geography(Point, 4326) not null,
  destination geography(Point, 4326) not null,
  path geography(LineString, 4326),
  distance_meters numeric,
  duration_seconds numeric,
  mode text not null default 'car' check (mode in ('car', 'bike', 'walk', 'bus')),
  city text not null default 'Delhi',
  created_at timestamptz not null default now()
);

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references auth.users(id) on delete cascade,
  route_id uuid references public.routes(id) on delete set null,
  status text not null default 'active' check (status in ('active', 'ended')),
  max_members int not null default 2 check (max_members between 2 and 10),
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  last_activity_at timestamptz not null default now()
);

create table public.group_members (
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('creator', 'member')),
  status text not null default 'active' check (status in ('active', 'left')),
  route_id uuid references public.routes(id) on delete set null,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  primary key (group_id, user_id)
);

create table public.group_invites (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  invite_code text not null unique default substr(replace(gen_random_uuid()::text, '-', ''), 1, 8),
  created_by uuid not null references auth.users(id) on delete cascade,
  invitee_user_id uuid references auth.users(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'expired')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  expires_at timestamptz not null default (now() + interval '24 hours')
);

create table public.user_locations (
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  location geography(Point, 4326) not null,
  latitude double precision not null,
  longitude double precision not null,
  speed_mps numeric,
  heading numeric,
  updated_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create table public.group_route_mismatches (
  group_id uuid primary key references public.groups(id) on delete cascade,
  user_a_route_id uuid references public.routes(id),
  user_b_route_id uuid references public.routes(id),
  detected_at timestamptz not null default now(),
  resolved boolean not null default false
);

create table public.cameras (
  id uuid primary key default gen_random_uuid(),
  location geography(Point, 4326) not null,
  latitude double precision not null,
  longitude double precision not null,
  road_name text,
  city text not null default 'Delhi',
  state text not null default 'Delhi',
  camera_type text not null default 'unknown' check (camera_type in ('speed', 'red_light', 'average_speed', 'unknown')),
  source text not null check (source in ('delhi_police', 'osm', 'ogd')),
  confidence text not null default 'medium' check (confidence in ('high', 'medium', 'low')),
  attribution text,
  source_reference text,
  last_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------
-- INDEXES
-- ---------------------------------------------------------

create index routes_created_by_idx on public.routes(created_by);
create index groups_status_idx on public.groups(status);
create index group_members_user_idx on public.group_members(user_id);
create index group_invites_group_idx on public.group_invites(group_id);
create index user_locations_group_idx on public.user_locations(group_id);
create index cameras_location_idx on public.cameras using gist (location);
create index cameras_city_idx on public.cameras(city);
create index cameras_type_idx on public.cameras(camera_type);

-- ---------------------------------------------------------
-- TRIGGERS: new-user profile, updated_at bookkeeping, route-mismatch detection
-- ---------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, is_anonymous)
  values (new.id, coalesce(new.is_anonymous, false));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_profiles_updated_at before update on public.profiles
  for each row execute procedure public.set_updated_at();

create trigger set_cameras_updated_at before update on public.cameras
  for each row execute procedure public.set_updated_at();

-- Fires whenever a member's route_id changes. Compares against the other
-- active member's route and records (or resolves) a mismatch.
create or replace function public.check_route_mismatch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  other_member record;
begin
  select * into other_member
  from public.group_members
  where group_id = new.group_id
    and user_id <> new.user_id
    and status = 'active'
  limit 1;

  if other_member.user_id is null or new.route_id is null or other_member.route_id is null then
    return new;
  end if;

  if other_member.route_id <> new.route_id then
    insert into public.group_route_mismatches (group_id, user_a_route_id, user_b_route_id, detected_at, resolved)
    values (new.group_id, other_member.route_id, new.route_id, now(), false)
    on conflict (group_id) do update set
      user_a_route_id = excluded.user_a_route_id,
      user_b_route_id = excluded.user_b_route_id,
      detected_at = now(),
      resolved = false;
  else
    update public.group_route_mismatches set resolved = true where group_id = new.group_id;
  end if;

  return new;
end;
$$;

create trigger group_members_route_mismatch
  after insert or update of route_id on public.group_members
  for each row execute procedure public.check_route_mismatch();

-- ---------------------------------------------------------
-- RLS
-- ---------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.routes enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.group_invites enable row level security;
alter table public.user_locations enable row level security;
alter table public.group_route_mismatches enable row level security;
alter table public.cameras enable row level security;

-- profiles
create policy "Users view their own profile"
  on public.profiles for select using (auth.uid() = id);

create policy "Group members can view each other's profile"
  on public.profiles for select using (
    exists (
      select 1 from public.group_members gm1
      join public.group_members gm2 on gm1.group_id = gm2.group_id
      where gm1.user_id = auth.uid() and gm1.status = 'active'
        and gm2.user_id = profiles.id and gm2.status = 'active'
    )
  );

create policy "Users update their own profile"
  on public.profiles for update using (auth.uid() = id);

-- routes
create policy "Users manage their own routes"
  on public.routes for all
  using (auth.uid() = created_by)
  with check (auth.uid() = created_by);

create policy "Group members can view each other's routes"
  on public.routes for select using (
    exists (
      select 1 from public.group_members gm1
      join public.group_members gm2 on gm1.group_id = gm2.group_id
      where gm1.user_id = auth.uid() and gm1.status = 'active'
        and gm2.status = 'active' and gm2.route_id = routes.id
    )
  );

-- groups (no direct insert/update policy — see RPC functions below)
create policy "Members can view their group"
  on public.groups for select using (
    exists (select 1 from public.group_members gm where gm.group_id = groups.id and gm.user_id = auth.uid() and gm.status = 'active')
  );

-- group_members (no direct insert/update policy — see RPC functions below)
create policy "Members can view fellow group members"
  on public.group_members for select using (
    exists (select 1 from public.group_members gm where gm.group_id = group_members.group_id and gm.user_id = auth.uid() and gm.status = 'active')
  );

-- group_invites (no direct insert/update policy — see RPC functions below)
create policy "Members and the invitee can view an invite"
  on public.group_invites for select using (
    exists (select 1 from public.group_members gm where gm.group_id = group_invites.group_id and gm.user_id = auth.uid() and gm.status = 'active')
    or invitee_user_id = auth.uid()
  );

-- user_locations
create policy "Members can view locations in their active groups"
  on public.user_locations for select using (
    exists (select 1 from public.group_members gm where gm.group_id = user_locations.group_id and gm.user_id = auth.uid() and gm.status = 'active')
  );

create policy "Members write their own location"
  on public.user_locations for insert with check (
    user_id = auth.uid()
    and exists (select 1 from public.group_members gm where gm.group_id = user_locations.group_id and gm.user_id = auth.uid() and gm.status = 'active')
  );

create policy "Members update their own location"
  on public.user_locations for update using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.group_members gm where gm.group_id = user_locations.group_id and gm.user_id = auth.uid() and gm.status = 'active')
  );

create policy "Members delete their own location"
  on public.user_locations for delete using (user_id = auth.uid());

-- group_route_mismatches (read-only to clients, written by trigger only)
create policy "Members can view their group's mismatch state"
  on public.group_route_mismatches for select using (
    exists (select 1 from public.group_members gm where gm.group_id = group_route_mismatches.group_id and gm.user_id = auth.uid() and gm.status = 'active')
  );

-- cameras — public read, no client writes at all (service_role bypasses RLS for imports)
create policy "Anyone can read cameras"
  on public.cameras for select using (true);

-- ---------------------------------------------------------
-- RPC FUNCTIONS (all security definer — these are the only way to
-- create/join/leave/end groups, matching the flows in the spec)
-- ---------------------------------------------------------

create or replace function public.create_group(p_route_id uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_is_anonymous boolean;
  v_group_id uuid;
begin
  select is_anonymous into v_is_anonymous from public.profiles where id = auth.uid();
  if v_is_anonymous is distinct from false then
    raise exception 'Sign in to use Group Travel.';
  end if;

  if p_route_id is not null and not exists (
    select 1 from public.routes where id = p_route_id and created_by = auth.uid()
  ) then
    raise exception 'Route not found.';
  end if;

  insert into public.groups (creator_id, route_id) values (auth.uid(), p_route_id)
  returning id into v_group_id;

  insert into public.group_members (group_id, user_id, role, status, route_id)
  values (v_group_id, auth.uid(), 'creator', 'active', p_route_id);

  return v_group_id;
end;
$$;

create or replace function public.create_invite(p_group_id uuid)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_code text;
begin
  if not exists (
    select 1 from public.group_members
    where group_id = p_group_id and user_id = auth.uid() and status = 'active'
  ) then
    raise exception 'You are not a member of this group.';
  end if;

  insert into public.group_invites (group_id, created_by) values (p_group_id, auth.uid())
  returning invite_code into v_code;

  return v_code;
end;
$$;

create or replace function public.accept_invite(p_code text, p_route_id uuid default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_invite record;
  v_is_anonymous boolean;
  v_member_count int;
  v_max int;
begin
  select is_anonymous into v_is_anonymous from public.profiles where id = auth.uid();
  if v_is_anonymous is distinct from false then
    raise exception 'Sign in to accept a Group Travel invite.';
  end if;

  select * into v_invite from public.group_invites
  where invite_code = p_code and status = 'pending' and expires_at > now();

  if v_invite.id is null then
    raise exception 'This invite is invalid or has expired.';
  end if;

  select count(*), (select max_members from public.groups where id = v_invite.group_id)
  into v_member_count, v_max
  from public.group_members
  where group_id = v_invite.group_id and status = 'active';

  if v_member_count >= v_max then
    raise exception 'This group is full.';
  end if;

  insert into public.group_members (group_id, user_id, role, status, route_id)
  values (v_invite.group_id, auth.uid(), 'member', 'active', p_route_id)
  on conflict (group_id, user_id) do update set status = 'active', route_id = excluded.route_id, left_at = null;

  update public.group_invites
  set status = 'accepted', invitee_user_id = auth.uid(), responded_at = now()
  where id = v_invite.id;

  update public.groups set last_activity_at = now() where id = v_invite.group_id;

  return v_invite.group_id;
end;
$$;

create or replace function public.decline_invite(p_code text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  update public.group_invites
  set status = 'declined', invitee_user_id = auth.uid(), responded_at = now()
  where invite_code = p_code and status = 'pending';
end;
$$;

create or replace function public.leave_group(p_group_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  update public.group_members set status = 'left', left_at = now()
  where group_id = p_group_id and user_id = auth.uid();

  delete from public.user_locations where group_id = p_group_id and user_id = auth.uid();

  if not exists (select 1 from public.group_members where group_id = p_group_id and status = 'active') then
    update public.groups set status = 'ended', ended_at = now() where id = p_group_id;
  end if;
end;
$$;

create or replace function public.end_group(p_group_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not exists (select 1 from public.groups where id = p_group_id and creator_id = auth.uid()) then
    raise exception 'Only the group creator can end the group.';
  end if;

  update public.groups set status = 'ended', ended_at = now() where id = p_group_id;
  update public.group_members set status = 'left', left_at = now() where group_id = p_group_id;
  delete from public.user_locations where group_id = p_group_id;
end;
$$;

create or replace function public.update_my_route_in_group(p_group_id uuid, p_route_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if p_route_id is not null and not exists (
    select 1
    from public.routes r
    where r.id = p_route_id
      and r.user_id = auth.uid()
  ) then
    raise exception 'Route not found or not owned by current user.';
  end if;

  update public.group_members
  set route_id = p_route_id
  where group_id = p_group_id and user_id = auth.uid() and status = 'active';
end;
$$;

grant execute on function public.create_group(uuid) to anon, authenticated;
grant execute on function public.accept_invite(text, uuid) to anon, authenticated;
grant execute on function public.create_invite(uuid) to authenticated;
grant execute on function public.decline_invite(text) to authenticated;
grant execute on function public.leave_group(uuid) to authenticated;
grant execute on function public.end_group(uuid) to authenticated;
grant execute on function public.update_my_route_in_group(uuid, uuid) to authenticated;

-- ---------------------------------------------------------
-- REALTIME — add tables clients need to subscribe to
-- ---------------------------------------------------------

alter publication supabase_realtime add table public.user_locations;
alter publication supabase_realtime add table public.group_route_mismatches;
alter publication supabase_realtime add table public.group_invites;
