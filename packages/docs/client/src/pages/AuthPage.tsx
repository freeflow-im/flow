import { useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { HomeIcon } from '../components/Logo.tsx';
import { PlaceSwitch } from '../components/PlaceSwitch.tsx';

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  // A failed Google sign-in comes back to /login?error=...
  const [error, setError] = useState<string | null>(params.get('error'));
  const [busy, setBusy] = useState(false);
  // After sign-up: the address we told to check its inbox. After a sign-in refused for an unverified
  // address: offer to send the link again.
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [unverified, setUnverified] = useState(false);
  const [resent, setResent] = useState(false);
  const isLogin = mode === 'login';
  const from = (location.state as { from?: string } | null)?.from;
  const googleHref = `/api/auth/google/start${from && from !== '/login' ? `?next=${encodeURIComponent(from)}` : ''}`;

  const submit = async () => {
    setError(null);
    if (!isLogin && password !== confirm) return setError('Passwords do not match.');
    setUnverified(false);
    setBusy(true);
    try {
      if (isLogin) {
        await auth.login(email, password);
        navigate(from && from !== '/login' ? from : '/', { replace: true });
      } else {
        await auth.register(email, password);
        setPendingEmail(email.trim().toLowerCase());
        setBusy(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setUnverified(e instanceof ApiError && e.code === 'unverified');
      setBusy(false);
    }
  };

  const resend = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.resendVerification(pendingEmail ?? email);
      setResent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (pendingEmail) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <Link to="/" className="auth-brand">
            <HomeIcon size={36} />
            <span>MCP Docs</span>
          </Link>
          <h1>Check your email</h1>
          <p className="auth-text">
            We sent a link to <strong>{pendingEmail}</strong>. Open it to verify your address and sign in. It expires in 24 hours.
          </p>
          {resent && <div className="form-ok">Sent again. Give it a minute, and check your spam folder.</div>}
          {error && <div className="form-error">{error}</div>}
          <div className="auth-switch">
            Didn't get it?{' '}
            <button type="button" className="link-button" onClick={() => void resend()} disabled={busy}>
              Send it again
            </button>
            <span className="auth-sep">·</span>
            <Link to="/login">Back to sign in</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <form
        className="auth-card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="auth-brand">
          {/* Back to the front page. */}
          <Link to="/" className="auth-brand-home">
            <HomeIcon size={36} />
            <span>MCP Docs</span>
          </Link>
          <PlaceSwitch />
        </div>
        <h1>{isLogin ? 'Sign in' : 'Create your account'}</h1>
        {auth.googleLogin && (
          <>
            <a className="btn google wide" href={googleHref}>
              <GoogleMark />
              Continue with Google
            </a>
            <div className="auth-or">
              <span>or</span>
            </div>
          </>
        )}
        <label className="field">
          <span>Email</span>
          <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            autoComplete={isLogin ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={isLogin ? undefined : 8}
            required
          />
        </label>
        {!isLogin && (
          <label className="field">
            <span>Confirm password</span>
            <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </label>
        )}
        {!isLogin && <div className="field-hint">At least 8 characters.</div>}
        {error && <div className="form-error">{error}</div>}
        {unverified && !resent && (
          <div className="auth-switch">
            <button type="button" className="link-button" onClick={() => void resend()} disabled={busy}>
              Send the verification email again
            </button>
          </div>
        )}
        {resent && <div className="form-ok">Verification email sent. Open the link in it to sign in.</div>}
        <button type="submit" className="btn primary wide" disabled={busy}>
          {busy ? 'Please wait…' : isLogin ? 'Sign in' : 'Create account'}
        </button>
        <div className="auth-switch">
          {isLogin ? (
            <>
              New here? <Link to="/register">Create an account</Link>
              <span className="auth-sep">·</span>
              <Link to="/forgot">Forgot your password?</Link>
            </>
          ) : (
            <>
              Already have an account? <Link to="/login">Sign in</Link>
            </>
          )}
        </div>
      </form>
    </div>
  );
}

/** The Google "G", for the sign-in button. */
function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.5 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.6 5.9c4.5-4.1 7-10.2 7-17.6z" />
      <path fill="#FBBC05" d="M10.5 28.7A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.7l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.8l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.3 0-11.6-4-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z" />
    </svg>
  );
}
