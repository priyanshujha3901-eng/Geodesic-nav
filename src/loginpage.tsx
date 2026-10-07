import { useState, type FormEvent } from 'react';
import { useAuth } from './context/AuthContext';

export default function LoginPage() {
  const { signInWithEmail } = useAuth();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const { error } = await signInWithEmail(email.trim());
    if (error) setError(error);
    else setSent(true);
  };

  if (sent) {
    return (
      <div className="auth-page">
        <h1>Check your email</h1>
        <p>We sent a sign-in link to {email}. Open it on this device to continue.</p>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <h1>Sign in</h1>
      <p>Enter your email to get a magic sign-in link. No password needed.</p>
      <form onSubmit={handleSubmit}>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
        />
        <button type="submit">Send magic link</button>
      </form>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
