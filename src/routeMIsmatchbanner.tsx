import { useAuth } from './context/AuthContext';
import type { useGroupTravel, ActiveGroup } from './hooks/useGroupTravel';

interface Props {
  group: ReturnType<typeof useGroupTravel>;
  myRouteId: string | null;
}

export function RouteMismatchBanner({ group, myRouteId }: Props) {
  const { user } = useAuth();
  if (!group.mismatch || !group.activeGroup || !user) return null;

  const theirRouteId =
    group.mismatch.user_a_route_id === myRouteId
      ? group.mismatch.user_b_route_id
      : group.mismatch.user_a_route_id;

  return (
    <div className="mismatch-banner">
      <p>You and your friend are on different routes.</p>
      <button
        onClick={() => group.switchToRoute((group.activeGroup as ActiveGroup).id, theirRouteId)}
      >
        Switch to their route?
      </button>
    </div>
  );
}
