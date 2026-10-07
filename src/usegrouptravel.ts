import { useCallback, useEffect, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './lib/supabase';

export interface MemberLocation {
  user_id: string;
  latitude: number;
  longitude: number;
  speed_mps: number | null;
  heading: number | null;
  updated_at: string;
}

export interface ActiveGroup {
  id: string;
  creator_id: string;
  status: string;
  route_id: string | null;
}

interface MismatchRow {
  resolved: boolean;
  user_a_route_id: string;
  user_b_route_id: string;
}

// Handles everything in the group-travel flow: creating a group, inviting,
// accepting/declining, live location via Realtime, route-mismatch
// notifications, and leaving/ending. All mutations go through the
// security-definer RPC functions defined in schema.sql — this hook never
// writes directly to groups/group_members/group_invites.
export function useGroupTravel(userId: string | null) {
  const [activeGroup, setActiveGroup] = useState<ActiveGroup | null>(null);
  const [memberLocations, setMemberLocations] = useState<Record<string, MemberLocation>>({});
  const [mismatch, setMismatch] = useState<MismatchRow | null>(null);

  const watchIdRef = useRef<number | null>(null);
  const lastWriteRef = useRef(0);

  const loadActiveGroup = useCallback(async () => {
    if (!userId) {
      setActiveGroup(null);
      return;
    }
    const { data, error } = await supabase
      .from('group_members')
      .select('group_id, groups!inner(id, creator_id, status, route_id)')
      .eq('user_id', userId)
      .eq('status', 'active')
      .eq('groups.status', 'active')
      .maybeSingle();

    if (error) {
      console.error('Failed to load active group:', error.message);
      setActiveGroup(null);
      return;
    }
    setActiveGroup((data?.groups as unknown as ActiveGroup) ?? null);
  }, [userId]);

  useEffect(() => {
    loadActiveGroup();
  }, [loadActiveGroup]);

  // Subscribe to live member locations + route-mismatch notices.
  useEffect(() => {
    if (!activeGroup) {
      setMemberLocations({});
      setMismatch(null);
      return;
    }

    supabase
      .from('user_locations')
      .select('user_id, latitude, longitude, speed_mps, heading, updated_at')
      .eq('group_id', activeGroup.id)
      .then(({ data }) => {
        const map: Record<string, MemberLocation> = {};
        (data as MemberLocation[] | null)?.forEach((row) => {
          map[row.user_id] = row;
        });
        setMemberLocations(map);
      });

    const locationChannel: RealtimeChannel = supabase
      .channel(`locations-${activeGroup.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'user_locations', filter: `group_id=eq.${activeGroup.id}` },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            setMemberLocations((prev) => {
              const next = { ...prev };
              delete next[(payload.old as { user_id: string }).user_id];
              return next;
            });
          } else {
            const row = payload.new as MemberLocation;
            setMemberLocations((prev) => ({ ...prev, [row.user_id]: row }));
          }
        }
      )
      .subscribe();

    const mismatchChannel: RealtimeChannel = supabase
      .channel(`mismatch-${activeGroup.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'group_route_mismatches', filter: `group_id=eq.${activeGroup.id}` },
        (payload) => {
          const row = payload.new as MismatchRow | null;
          setMismatch(row && !row.resolved ? row : null);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(locationChannel);
      supabase.removeChannel(mismatchChannel);
    };
  }, [activeGroup?.id]);

  // Share this device's own location while a group is active. Throttled to
  // roughly one write every 2.5s regardless of how often watchPosition fires.
  useEffect(() => {
    if (!activeGroup || !userId || !navigator.geolocation) return;

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const now = Date.now();
        if (now - lastWriteRef.current < 2500) return;
        lastWriteRef.current = now;

        supabase
          .from('user_locations')
          .upsert({
            group_id: activeGroup.id,
            user_id: userId,
            location: `SRID=4326;POINT(${pos.coords.longitude} ${pos.coords.latitude})`,
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            speed_mps: pos.coords.speed,
            heading: pos.coords.heading,
            updated_at: new Date().toISOString(),
          })
          .then(({ error }) => {
            if (error) console.error('Failed to share location:', error.message);
          });
      },
      (err) => console.error('Geolocation error:', err.message),
      { enableHighAccuracy: true, maximumAge: 2000 }
    );

    return () => {
      if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
    };
  }, [activeGroup?.id, userId]);

  const createGroup = useCallback(
    async (routeId: string | null) => {
      const { data, error } = await supabase.rpc('create_group', { p_route_id: routeId });
      if (error) throw new Error(error.message);
      await loadActiveGroup();
      return data as string;
    },
    [loadActiveGroup]
  );

  const createInvite = useCallback(async (groupId: string) => {
    const { data, error } = await supabase.rpc('create_invite', { p_group_id: groupId });
    if (error) throw new Error(error.message);
    return data as string;
  }, []);

  const acceptInvite = useCallback(
    async (code: string, routeId: string | null) => {
      const { data, error } = await supabase.rpc('accept_invite', { p_code: code, p_route_id: routeId });
      if (error) throw new Error(error.message);
      await loadActiveGroup();
      return data as string;
    },
    [loadActiveGroup]
  );

  const declineInvite = useCallback(async (code: string) => {
    const { error } = await supabase.rpc('decline_invite', { p_code: code });
    if (error) throw new Error(error.message);
  }, []);

  const leaveGroup = useCallback(async (groupId: string) => {
    const { error } = await supabase.rpc('leave_group', { p_group_id: groupId });
    if (error) throw new Error(error.message);
    setActiveGroup(null);
  }, []);

  const endGroup = useCallback(async (groupId: string) => {
    const { error } = await supabase.rpc('end_group', { p_group_id: groupId });
    if (error) throw new Error(error.message);
    setActiveGroup(null);
  }, []);

  const switchToRoute = useCallback(async (groupId: string, routeId: string) => {
    const { error } = await supabase.rpc('update_my_route_in_group', { p_group_id: groupId, p_route_id: routeId });
    if (error) throw new Error(error.message);
  }, []);

  return {
    activeGroup,
    memberLocations,
    mismatch,
    createGroup,
    createInvite,
    acceptInvite,
    declineInvite,
    leaveGroup,
    endGroup,
    switchToRoute,
    refresh: loadActiveGroup,
  };
}
