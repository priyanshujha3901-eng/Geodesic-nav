import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { useGroupTravel } from './hooks/useGroupTravel';

export default function InvitePage() {
  const { code } = useParams<{ code: string }>();
  const { isGuest, user } = useAuth();
  const navigate = useNavigate();
  const group = useGroupTravel(user?.id ?? null);
  const [status, setStatus] = useState<'idle' | 'working' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  if (isGuest) {
    return (
      <div className="auth-page">
        <h1>Group Travel invite</h1>
        <p>Sign in to accept this invite.</p>
        <button onClick={() => navigate('/login')}>Sign in</button>
      </div>
    );
  }

  const handleAccept = async () => {
    if (!code) return;
    setStatus('working');
    try {
      await group.acceptInvite(code, null);
      navigate('/');
    } catch (e) {
      setError((e as Error).message);
      setStatus('error');
    }
  };

  const handleDecline = async () => {
    if (!code) return;
    setStatus('working');
    try {
      await group.declineInvite(code);
      navigate('/');
    } catch (e) {
      setError((e as Error).message);
      setStatus('error');
    }
  };

  return (
    <div className="auth-page">
      <h1>Group Travel invite</h1>
      <p>You've been invited to share live location during a trip.</p>
      <div className="invite-actions">
        <button disabled={status === 'working'} onClick={handleAccept}>
          Accept
        </button>
        <button disabled={status === 'working'} onClick={handleDecline}>
          Decline
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
