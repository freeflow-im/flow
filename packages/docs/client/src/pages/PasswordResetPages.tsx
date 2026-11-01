// "Forgot your password?" (asks for the email and sends the link) and the page the link opens (sets a new
// password and signs the user in).
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { HomeIcon } from '../components/Logo.tsx';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.forgotPassword(email);
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={(e) => void submit(e)}>
        <div className="auth-brand">
          <HomeIcon size={36} />
          <span>MCP Docs</span>
        </div>
        <h1>Reset your password</h1>
        {sent ? (
          <>
            <div className="form-ok">If an account exists for {email.trim()}, a reset link is on its way. It works once and expires in an hour.</div>
            <div className="auth-switch">
              <Link to="/login">Back to sign in</Link>
            </div>
          </>
        ) : (
          <>
            <p className="auth-text">Enter your email and we'll send you a link to set a new password.</p>
            <label className="field">
              <span>Email</span>
              <input id="forgot-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </label>
            {error && <div className="form-error">{error}</div>}
            <button type="submit" className="btn primary wide" disabled={busy}>
              {busy ? 'Sending…' : 'Send password reset link'}
            </button>
            <div className="auth-switch">
              Remembered it? <Link to="/login">Sign in</Link>
            </div>
          </>
        )}
      </form>
    </div>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const { setUser } = useAuth();
  const [email, setEmail] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Check the link before showing the form, so a stale link says so right away.
  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setError('This reset link is invalid or has expired. Request a new one.');
      return;
    }
    api
      .checkResetToken(token)
      .then((r) => !cancelled && setEmail(r.email))
      .catch((err: unknown) => !cancelled && setError(err instanceof ApiError ? err.message : 'This reset link could not be checked. Try again.'));
    return () => {
      cancelled = true;
    };
  }, [token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) return setError('Passwords do not match.');
    setBusy(true);
    try {
      const { user } = await api.resetPassword(token, password);
      setUser(user);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
      setBusy(false);
    }
  };

  const invalid = !email && error;
  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={(e) => void submit(e)}>
        <div className="auth-brand">
          <HomeIcon size={36} />
          <span>MCP Docs</span>
        </div>
        <h1>Choose a new password</h1>
        {invalid ? (
          <>
            <div className="form-error">{error}</div>
            <div className="auth-switch">
              <Link to="/forgot">Request a new link</Link>
            </div>
          </>
        ) : !email ? (
          <div className="auth-text">Checking your link…</div>
        ) : (
          <>
            <p className="auth-text">Signed in as {email} once you set a new password.</p>
            <label className="field">
              <span>New password</span>
              <input id="reset-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required autoFocus />
            </label>
            <label className="field">
              <span>Confirm new password</span>
              <input id="reset-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            </label>
            <div className="field-hint">At least 8 characters. Other devices are signed out.</div>
            {error && <div className="form-error">{error}</div>}
            <button type="submit" className="btn primary wide" disabled={busy}>
              {busy ? 'Please wait…' : 'Set new password'}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
