import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import type { useGroupTravel, ActiveGroup } from './hooks/useGroupTravel';

interface Props {
  routeId: string | null;
  group: ReturnType<typeof useGroupTravel>;
}

export function GroupTravelPanel({ routeId, group }: Props) {
  const { isGuest, user } = useAuth();
  const navigate = useNavigate();
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isGuest) {
    return (
      <div className="group-panel">
        <p>Sign in for more features.</p>
        <button onClick={() => navigate('/login')}>Sign in</button>
      </div>
    );
  }

  const handleStart = async () => {
    setBusy(true);
    setError(null);
    try {
      const groupId = await group.createGroup(routeId);
      const code = await group.createInvite(groupId);
      setInviteLink(`${window.location.origin}/invite/${code}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleInviteAgain = async (active: ActiveGroup) => {
    setBusy(true);
    setError(null);
    try {
      const code = await group.createInvite(active.id);
      setInviteLink(`${window.location.origin}/invite/${code}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!group.activeGroup) {
    return (
      <div className="group-panel">
        <button disabled={busy} onClick={handleStart}>
          {busy ? 'Starting...' : '+ Group Travel'}
        </button>
        {error && <p className="error-text">{error}</p>}
      </div>
    );
  }

  const isCreator = group.activeGroup.creator_id === user?.id;
  const others = Object.values(group.memberLocations).filter((m) => m.user_id !== user?.id);

  return (
    <div className="group-panel">
      <p>
        Group Travel active · {others.length} other member{others.length === 1 ? '' : 's'} sharing location
      </p>

      {inviteLink && (
        <div className="invite-box">
          <input readOnly value={inviteLink} onFocus={(e) => e.target.select()} />
          <button onClick={() => navigator.clipboard.writeText(inviteLink)}>Copy</button>
        </div>
      )}
      {!inviteLink && others.length === 0 && (
        <button disabled={busy} onClick={() => handleInviteAgain(group.activeGroup as ActiveGroup)}>
          {busy ? 'Working...' : 'Get invite link'}
        </button>
      )}

      <div className="group-actions">
        <button onClick={() => group.leaveGroup((group.activeGroup as ActiveGroup).id)}>Leave group</button>
        {isCreator && (
          <button onClick={() => group.endGroup((group.activeGroup as ActiveGroup).id)}>End group</button>
        )}
      </div>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
