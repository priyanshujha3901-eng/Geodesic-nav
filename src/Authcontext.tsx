import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from './lib/supabase';

interface Profile {
  id: string;
  display_name: string | null;
  is_anonymous: boolean;
}

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  isGuest: boolean;
  loading: boolean;
  signInWithEmail: (email: string) => Promise<{ error: string | null }>;
  signInWithGoogle: () => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  // On first load with no session at all, drop the visitor straight into
  // guest mode — this is what makes "open the app, no account needed" work.
  useEffect(() => {
    let mounted = true;

    const init = async () => {
      const { data } = await supabase.auth.getSession();

      if (!data.session) {
        const { data: anon, error } = await supabase.auth.signInAnonymously();
        if (error && !/anonymous sign-ins are disabled/i.test(error.message)) {
          console.error('Anonymous sign-in failed:', error.message);
        }
        if (mounted) setSession(anon.session ?? null);
      } else if (mounted) {
        setSession(data.session);
      }
      if (mounted) setLoading(false);
    };

    init();

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!session?.user) {
      setProfile(null);
      return;
    }
    supabase
      .from('profiles')
      .select('id, display_name, is_anonymous')
      .eq('id', session.user.id)
      .single()
      .then(({ data }) => setProfile(data as Profile | null));
  }, [session?.user?.id]);

  // IMPORTANT: if the current session is anonymous, we must upgrade it with
  // updateUser({ email }) — NOT a fresh signInWithOtp(). signInWithOtp would
  // sign into (or create) a totally different, unrelated user record and
  // abandon the anonymous one. updateUser() converts the SAME user from
  // anonymous to permanent once they click the confirmation link.
  const signInWithEmail = async (email: string) => {
    if (session?.user && profile?.is_anonymous) {
      const { error } = await supabase.auth.updateUser(
        { email },
        { emailRedirectTo: window.location.origin }
      );
      return { error: error?.message ?? null };
    }

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    return { error: error?.message ?? null };
  };

  const signInWithGoogle = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/dashboard`,
      },
    });
    return { error: error?.message ?? null };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    // If anonymous guest access is enabled, restore it; otherwise, leave the
    // user signed out and let the login screen handle a real sign-in route.
    const { error } = await supabase.auth.signInAnonymously();
    if (error && !/anonymous sign-ins are disabled/i.test(error.message)) {
      console.error('Anonymous sign-in failed:', error.message);
    }
  };

  const value: AuthContextValue = {
    session,
    user: session?.user ?? null,
    profile,
    isGuest: profile?.is_anonymous ?? true,
    loading,
    signInWithEmail,
    signInWithGoogle,
    signOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
