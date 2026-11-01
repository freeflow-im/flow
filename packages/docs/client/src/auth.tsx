import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, type User } from './api.ts';
import { setLocalApp } from './brand.ts';

interface AuthState {
  user: User | null;
  loading: boolean;
  /** Whether the server offers "Continue with Google". */
  googleLogin: boolean;
  /** Set in the desktop app: the folder whose files are the library. There is no account to sign in or out of. */
  local: { dir: string } | null;
  login(email: string, password: string): Promise<void>;
  /** Creates the account; the user is signed in by the link in the verification email, not here. */
  register(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  /** Mark the user as signed in after a flow that set the session cookie elsewhere (password reset). */
  setUser(user: User | null): void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [googleLogin, setGoogleLogin] = useState(false);
  const [local, setLocal] = useState<{ dir: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Only a rejected session means signed out. A network failure usually means the dev server is restarting
    // (for example after an assistant app change), so retry instead of bouncing the user to the login page.
    void (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await api.me();
          if (!cancelled) {
            setUser(r.user);
            setGoogleLogin(!!r.googleLogin);
            setLocalApp(!!r.local);
            setLocal(r.local ?? null);
          }
          break;
        } catch (e) {
          if (cancelled) return;
          if (e instanceof ApiError || attempt >= 10) {
            setUser(null);
            break;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setUser((await api.login(email, password)).user);
  }, []);
  const register = useCallback(async (email: string, password: string) => {
    await api.register(email, password);
  }, []);
  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
  }, []);

  return <AuthContext.Provider value={{ user, loading, googleLogin, local, login, register, logout, setUser }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
