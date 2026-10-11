-- =========================================================
-- Migration: username/password auth + username-based group invites
-- Additive only — run this once in Supabase SQL Editor, AFTER schema.sql.
-- Does not touch existing tables/data beyond adding two nullable columns.
-- =========================================================

-- 1. New profile columns
alter table public.profiles
  add column if not exists username text,
  add column if not exists mobile_number text;

-- Case-insensitive unique usernames (NULLs are allowed and ignored by the index).
create unique index if not exists profiles_username_lower_idx
  on public.profiles (lower(username));

-- 2. Privacy guarantee: mobile_number is never directly selectable by ANYONE,
-- including its own owner, via a plain table query. The only way to read it
-- back is get_my_profile() below (security definer, scoped to auth.uid()).
-- NOTE: Supabase grants table-level SELECT by default, and a column-level
-- REVOKE does nothing while a table-level grant exists. So we revoke the
-- table-level grant and re-grant SELECT on every column EXCEPT mobile_number.
-- (Consequence: `select *` on profiles is no longer allowed from the client —
-- always list columns explicitly, as the app does.)
revoke select on public.profiles from authenticated, anon;
grant select (id, display_name, username, is_anonymous, created_at, updated_at)
  on public.profiles to authenticated;

-- 3. Read your own full profile (the only way to read mobile_number back)
create or replace function public.get_my_profile()
returns table (id uuid, username text, mobile_number text, is_anonymous boolean)
language sql security definer set search_path = public stable
as $$
  select p.id, p.username, p.mobile_number, p.is_anonymous
  from public.profiles p
  where p.id = auth.uid();
$$;

grant execute on function public.get_my_profile() to authenticated;

-- 4. Search other users by username — returns username only, never
-- mobile_number or any other field.
create or replace function public.search_profiles_by_username(p_query text)
returns table (id uuid, username text)
language sql security definer set search_path = public stable
as $$
  select p.id, p.username
  from public.profiles p
  where p.username ilike (p_query || '%')
    and p.id <> auth.uid()
    and p.username is not null
  order by p.username
  limit 20;
$$;

grant execute on function public.search_profiles_by_username(text) to authenticated;

-- 5. Targeted group invite by user id (from a search result). Separate from
-- the existing code-based create_invite()/accept_invite(code) link-sharing
-- functions, which still exist and still work if you want them later.
create or replace function public.invite_user_to_group(p_group_id uuid, p_invitee_id uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_is_anonymous boolean;
  v_invite_id uuid;
  v_max int;
  v_count int;
begin
  if p_invitee_id = auth.uid() then
    raise exception 'You cannot invite yourself.';
  end if;

  if not exists (
    select 1 from public.group_members
    where group_id = p_group_id and user_id = auth.uid() and status = 'active'
  ) then
    raise exception 'You are not a member of this group.';
  end if;

  if exists (
    select 1 from public.group_members
    where group_id = p_group_id and user_id = p_invitee_id and status = 'active'
  ) then
    raise exception 'That user is already in the group.';
  end if;

  if exists (
    select 1 from public.group_invites
    where group_id = p_group_id and invitee_user_id = p_invitee_id and status = 'pending'
  ) then
    raise exception 'That user already has a pending invite.';
  end if;

  select is_anonymous into v_is_anonymous from public.profiles where id = p_invitee_id;
  if v_is_anonymous is distinct from false then
    raise exception 'That user needs an account to be invited.';
  end if;

  select count(*), (select max_members from public.groups where id = p_group_id)
  into v_count, v_max
  from public.group_members
  where group_id = p_group_id and status = 'active';

  if v_count >= v_max then
    raise exception 'This group is full.';
  end if;

  insert into public.group_invites (group_id, created_by, invitee_user_id)
  values (p_group_id, auth.uid(), p_invitee_id)
  returning id into v_invite_id;

  return v_invite_id;
end;
$$;

grant execute on function public.invite_user_to_group(uuid, uuid) to authenticated;

-- 6. Accept/decline an invite by its row id — used by the "My Invitations"
-- screen, which lists invite rows rather than asking the user to enter a code.
create or replace function public.respond_to_invite(p_invite_id uuid, p_accept boolean, p_route_id uuid default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_invite record;
  v_is_anonymous boolean;
  v_count int;
  v_max int;
begin
  select * into v_invite
  from public.group_invites
  where id = p_invite_id and invitee_user_id = auth.uid() and status = 'pending';

  if v_invite.id is null then
    raise exception 'Invite not found.';
  end if;

  if not p_accept then
    update public.group_invites set status = 'declined', responded_at = now() where id = p_invite_id;
    return v_invite.group_id;
  end if;

  select is_anonymous into v_is_anonymous from public.profiles where id = auth.uid();
  if v_is_anonymous is distinct from false then
    raise exception 'Sign in to accept a Group Travel invite.';
  end if;

  select count(*), (select max_members from public.groups where id = v_invite.group_id)
  into v_count, v_max
  from public.group_members
  where group_id = v_invite.group_id and status = 'active';

  if v_count >= v_max then
    raise exception 'This group is full.';
  end if;

  insert into public.group_members (group_id, user_id, role, status, route_id)
  values (v_invite.group_id, auth.uid(), 'member', 'active', p_route_id)
  on conflict (group_id, user_id) do update set status = 'active', left_at = null, route_id = excluded.route_id;

  update public.group_invites set status = 'accepted', responded_at = now() where id = p_invite_id;
  update public.groups set last_activity_at = now() where id = v_invite.group_id;

  return v_invite.group_id;
end;
$$;

grant execute on function public.respond_to_invite(uuid, boolean, uuid) to authenticated;

-- 7. My pending invites, with the inviter's username attached (RLS alone
-- can't show this — the inviter isn't a group-mate of the invitee yet).
create or replace function public.get_my_invitations()
returns table (invite_id uuid, group_id uuid, inviter_username text, status text, created_at timestamptz)
language sql security definer set search_path = public stable
as $$
  select gi.id, gi.group_id, p.username, gi.status, gi.created_at
  from public.group_invites gi
  join public.profiles p on p.id = gi.created_by
  where gi.invitee_user_id = auth.uid() and gi.status = 'pending'
  order by gi.created_at desc;
$$;

grant execute on function public.get_my_invitations() to authenticated;

-- 8. A group's member list with usernames attached (for the "My groups" screen)
create or replace function public.get_group_member_usernames(p_group_id uuid)
returns table (user_id uuid, username text, role text)
language sql security definer set search_path = public stable
as $$
  select gm.user_id, p.username, gm.role
  from public.group_members gm
  join public.profiles p on p.id = gm.user_id
  where gm.group_id = p_group_id and gm.status = 'active'
    and exists (
      select 1 from public.group_members me
      where me.group_id = p_group_id and me.user_id = auth.uid() and me.status = 'active'
    );
$$;

grant execute on function public.get_group_member_usernames(uuid) to authenticated;
