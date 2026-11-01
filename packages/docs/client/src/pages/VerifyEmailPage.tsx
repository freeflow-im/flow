// The page the verification email opens: redeems the token, which signs the user in.
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { HomeIcon } from '../components/Logo.tsx';

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const { setUser } = useAuth();
  const [error, setError] = useState<string | null>(null);

  // Fire once per page load. React StrictMode runs effects twice in development, and a token works once:
  // a second post would fail after the first had already signed the user in.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!token) {
      setError('This verification link is invalid or has expired. Sign in to request a new one.');
      return;
    }
    void (async () => {
      try {
        setUser((await api.verifyEmail(token)).user);
        navigate('/', { replace: true });
      } catch (e) {
        // A used token with a live session (the link opened twice) still means the user is verified.
        const me = await api.me().catch(() => null);
        if (me?.user) {
          setUser(me.user);
          navigate('/', { replace: true });
          return;
        }
        setError(e instanceof ApiError ? e.message : 'Something went wrong. Try the link again.');
      }
    })();
  }, [token, navigate, setUser]);

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <HomeIcon size={36} />
          <span>MCP Docs</span>
        </div>
        <h1>{error ? 'Link not valid' : 'Verifying your email…'}</h1>
        {error ? (
          <>
            <div className="form-error">{error}</div>
            <div className="auth-switch">
              <Link to="/login">Go to sign in</Link>
            </div>
          </>
        ) : (
          <p className="auth-text">One moment.</p>
        )}
      </div>
    </div>
  );
}
