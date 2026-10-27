import { useBoundApi } from '../lib/useBoundApi';
import { useEffect, useRef, useState } from 'react';
import type {
  AuthResponse,
  GoogleAuthResponse,
  PublicConfigDTO,
  RegisterPendingResponse,
  WorkspaceDTO,
} from '@flow/shared';
import { api, scopedStorageKey } from '../lib/api';
import { desktopGoogleSignIn, loadGoogleIdentity, publicConfig } from '../lib/google';
import { isDesktop } from '../lib/host';
import { MAC_DOWNLOAD_URL } from './OpenInApp';
import { openServerConnections } from './ServerConnections';
import { useRuntime } from '../state';

type Mode =
  | 'signin'
  | 'register'
  | 'forgot'
  | 'signup-sent'
  | 'reset-sent'
  | 'complete'
  | 'reset'
  | 'link-sent'
  | 'signin-link';

const inputCls = 'mb-2 w-full rounded border border-hairline2 px-3 py-2 text-sm';
const submitCls =
  'w-full rounded bg-accent py-2 text-sm font-semibold text-white hover:bg-accent-deep disabled:opacity-50';

/**
 * "Continue with Google" (phase16 §5). Sign-in and register are the same act
 * with Google, so this is one button shared by both panels. It renders nothing
 * until /v1/config says Google is configured — with GOOGLE_CLIENT_ID unset the
 * deployment shows no Google affordance at all.
 */
export function GoogleButton(props: {
  onSignedIn: (r: GoogleAuthResponse) => void;
  showDivider: boolean;
}) {
  return isDesktop() ? <DesktopGoogleButton {...props} /> : <BrowserGoogleButton {...props} />;
}

/** The desktop shell cannot host Google's sign-in (see `desktopGoogleSignIn`):
 * one plain button that sends the person to the system browser and waits. */
function DesktopGoogleButton({
  onSignedIn,
  showDivider,
}: {
  onSignedIn: (r: GoogleAuthResponse) => void;
  showDivider: boolean;
}) {
  const runtime = useRuntime();
  const [config, setConfig] = useState<PublicConfigDTO | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => {
    let alive = true;
    void publicConfig(runtime).then((cfg) => { if (alive) setConfig(cfg); });
    return () => { alive = false; operation.current?.abort(); };
  }, [runtime]);
  if (!config?.google) return null;
  const start = () => {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setWaiting(true);
    setError(null);
    desktopGoogleSignIn(runtime, controller.signal).then(onSignedIn, (err: unknown) => {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Google sign-in failed');
    }).finally(() => { if (operation.current === controller) setWaiting(false); });
  };
  return (
    <div data-testid="auth-google">
      {showDivider && (
        <div className="my-3 flex items-center gap-2 text-xs text-faint">
          <span className="h-px flex-1 bg-hairline2" />
          or
          <span className="h-px flex-1 bg-hairline2" />
        </div>
      )}
      <button
        type="button"
        data-testid="auth-google-desktop"
        className="mb-2 w-full rounded border border-hairline2 py-2 text-sm font-semibold text-ink hover:bg-base disabled:opacity-50"
        disabled={waiting}
        onClick={start}
      >
        {waiting ? 'Waiting for your browser…' : 'Continue with Google'}
      </button>
      {waiting && (
        <button type="button" className="mb-2 w-full text-xs text-muted hover:text-ink" onClick={() => operation.current?.abort()}>
          Cancel
        </button>
      )}
      {error && <p className="mt-2 text-center text-sm text-red-600">{error}</p>}
    </div>
  );
}

function BrowserGoogleButton({
  onSignedIn,
  showDivider,
}: {
  onSignedIn: (r: GoogleAuthResponse) => void;
  showDivider: boolean;
}) {
  const { api } = useBoundApi();
  const slot = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<PublicConfigDTO | null>(null);

  useEffect(() => {
    let alive = true;
    void publicConfig().then((cfg) => { if (alive) setConfig(cfg); });
    return () => { alive = false; };
  }, []);

  const clientId = config?.google ? config.googleClientId : null;

  // Split from the config fetch on purpose: this effect only runs once
  // `clientId` is set, which means the render that mounted `slot` has already
  // committed — so GIS always has a live element to draw into.
  useEffect(() => {
    if (!clientId) return;
    let alive = true;
    void (async () => {
      let gsi;
      try {
        gsi = await loadGoogleIdentity();
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'could not load Google');
        return;
      }
      if (!alive || !slot.current) return;
      // Idempotent: StrictMode runs this effect twice in development, and GIS
      // appends rather than replaces — without this you get two stacked buttons.
      slot.current.replaceChildren();
      gsi.accounts.id.initialize({
        client_id: clientId,
        callback: ({ credential }) => {
          void (async () => {
            try {
              onSignedIn(await api<GoogleAuthResponse>('POST', '/v1/auth/google', { idToken: credential }));
            } catch (err) {
              if (alive) setError(err instanceof Error ? err.message : 'Google sign-in failed');
            }
          })();
        },
      });
      gsi.accounts.id.renderButton(slot.current, {
        type: 'standard',
        theme: 'outline',
        size: 'large',
        text: 'continue_with',
        width: 288, // matches the 18rem card body
      });
    })();
    return () => { alive = false; };
  }, [clientId, onSignedIn]);

  if (!clientId) return null;
  return (
    <div data-testid="auth-google">
      {showDivider && (
        <div className="my-3 flex items-center gap-2 text-xs text-faint">
          <span className="h-px flex-1 bg-hairline2" />
          or
          <span className="h-px flex-1 bg-hairline2" />
        </div>
      )}
      <div ref={slot} className="mb-2 flex justify-center" />
      {error && <p className="mt-2 text-center text-sm text-red-600">{error}</p>}
    </div>
  );
}

export default function AuthScreen({
  onSignedIn,
  signupToken,
  resetToken,
  signinToken,
  joinWorkspace,
  startOnRegister,
}: {
  onSignedIn: (r: AuthResponse & { autoJoined?: WorkspaceDTO[] }) => void;
  signupToken?: string | null;
  resetToken?: string | null;
  signinToken?: string | null;
  /** Workspace name behind a join link, when JoinScreen is wrapping us — so
   * the card says what the visitor is signing in *for* (issue #85). */
  joinWorkspace?: string | null;
  /** Open on Register rather than Sign In (the marketing site's Sign up). */
  startOnRegister?: boolean;
}) {
  const { api, scopedStorageKey } = useBoundApi();
  // A pending workspace invite means the visitor most likely has no account
  // yet — default them to Register (email-first) rather than Sign In. Explicit
  // email-link tokens still win (they target a specific existing flow).
  const invited =
    !!joinWorkspace
    || (typeof localStorage !== 'undefined' && !!localStorage.getItem(scopedStorageKey('pendingInvite')));
  const [mode, setMode] = useState<Mode>(
    signinToken ? 'signin-link'
      : signupToken ? 'complete'
      : resetToken ? 'reset'
      : invited || startOnRegister ? 'register'
      : 'signin',
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Navigate between forms, clearing any stale error/info so (e.g.) a failed
  // login message doesn't linger on the Register view.
  const nav = (m: Mode) => {
    setError(null);
    setInfo(null);
    setMode(m);
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const submitAuth = (e: React.FormEvent) =>
    void run(async () => {
      e.preventDefault();
      if (mode === 'signin') {
        onSignedIn(await api<AuthResponse>('POST', '/v1/auth/login', { email, password }));
      } else {
        // Email-first: the account (name + password) is created from the
        // emailed link, never from this form.
        await api<RegisterPendingResponse>('POST', '/v1/auth/register', { email });
        setMode('signup-sent');
      }
    });

  const resendSignup = () =>
    void run(async () => {
      await api('POST', '/v1/auth/register', { email });
      setInfo('Email sent.');
    });

  const submitComplete = (e: React.FormEvent) =>
    void run(async () => {
      e.preventDefault();
      onSignedIn(
        await api<AuthResponse>('POST', '/v1/auth/register/complete', {
          token: signupToken,
          displayName,
          password,
        }),
      );
    });

  const submitForgot = (e: React.FormEvent) =>
    void run(async () => {
      e.preventDefault();
      await api('POST', '/v1/auth/password/forgot', { email });
      setMode('reset-sent');
    });

  const submitReset = (e: React.FormEvent) =>
    void run(async () => {
      e.preventDefault();
      onSignedIn(await api<AuthResponse>('POST', '/v1/auth/password/reset', { token: resetToken, password }));
    });

  const sendSigninLink = () =>
    void run(async () => {
      await api('POST', '/v1/auth/signin-link', { email });
      setMode('link-sent');
    });

  // A ?signin= link redeems automatically on mount, then signs the user in.
  useEffect(() => {
    if (!signinToken) return;
    void run(async () => {
      onSignedIn(await api<AuthResponse>('POST', '/v1/auth/signin-link/consume', { token: signinToken }));
    });
    // onSignedIn is stable (useCallback); signinToken never changes after mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signinToken]);

  const backToSignIn = (
    <button type="button" className="mt-3 w-full text-center text-sm text-muted hover:text-ink" onClick={() => nav('signin')}>
      Back to sign in
    </button>
  );

  let body: React.ReactNode;
  if (mode === 'signup-sent') {
    body = (
      <div data-testid="auth-signup-sent">
        <h2 className="mb-2 text-center text-lg font-semibold text-ink">Check your email</h2>
        <p className="mb-3 text-center text-sm text-muted">
          We sent a link to <span className="font-semibold text-ink">{email}</span>. Click it to finish creating your
          account.
        </p>
        {info && <p className="mb-2 text-center text-sm text-accent-soft">{info}</p>}
        {error && <p className="mb-2 text-center text-sm text-red-600">{error}</p>}
        <button type="button" data-testid="auth-resend" className={submitCls} disabled={busy || !email} onClick={resendSignup}>
          Resend email
        </button>
        {backToSignIn}
      </div>
    );
  } else if (mode === 'complete') {
    body = (
      <form onSubmit={submitComplete} data-testid="auth-complete">
        <h2 className="mb-1 text-center text-lg font-semibold text-ink">Finish your account</h2>
        <p className="mb-3 text-center text-sm text-muted">Your email is confirmed — choose a name and password.</p>
        <input
          data-testid="auth-displayName"
          className={inputCls}
          placeholder="Display name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        <input
          data-testid="auth-password"
          className="mb-3 w-full rounded border border-hairline2 px-3 py-2 text-sm"
          placeholder="Password (min 8 characters)"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && (
          <p className="mb-2 text-sm text-red-600">
            {error}{' '}
            <button type="button" className="underline" onClick={() => nav('register')}>
              Register again
            </button>
          </p>
        )}
        <button data-testid="auth-submit" className={submitCls} disabled={busy || !displayName || password.length < 8}>
          Create account
        </button>
      </form>
    );
  } else if (mode === 'reset-sent') {
    body = (
      <div data-testid="auth-reset-sent">
        <h2 className="mb-2 text-center text-lg font-semibold text-ink">Check your email</h2>
        <p className="mb-3 text-center text-sm text-muted">
          If <span className="font-semibold text-ink">{email}</span> has an account, we sent it a password-reset link.
        </p>
        {backToSignIn}
      </div>
    );
  } else if (mode === 'forgot') {
    body = (
      <form onSubmit={submitForgot} data-testid="auth-forgot">
        <h2 className="mb-2 text-center text-lg font-semibold text-ink">Reset your password</h2>
        <input
          data-testid="auth-email"
          className={inputCls}
          placeholder="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
        <button data-testid="auth-submit" className={submitCls} disabled={busy || !email}>
          Send reset link
        </button>
        {backToSignIn}
      </form>
    );
  } else if (mode === 'reset') {
    body = (
      <form onSubmit={submitReset} data-testid="auth-reset">
        <h2 className="mb-2 text-center text-lg font-semibold text-ink">Choose a new password</h2>
        <input
          data-testid="auth-password"
          className="mb-3 w-full rounded border border-hairline2 px-3 py-2 text-sm"
          placeholder="New password (min 8 characters)"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && (
          <p className="mb-2 text-sm text-red-600">
            {error}{' '}
            <button type="button" className="underline" onClick={() => nav('forgot')}>
              Request a new link
            </button>
          </p>
        )}
        <button data-testid="auth-submit" className={submitCls} disabled={busy || password.length < 8}>
          Set password &amp; sign in
        </button>
      </form>
    );
  } else if (mode === 'link-sent') {
    body = (
      <div data-testid="auth-link-sent">
        <h2 className="mb-2 text-center text-lg font-semibold text-ink">Check your email</h2>
        <p className="mb-3 text-center text-sm text-muted">
          If <span className="font-semibold text-ink">{email}</span> has an account, we sent it a sign-in link. Click it
          to sign in — no password needed.
        </p>
        {backToSignIn}
      </div>
    );
  } else if (mode === 'signin-link') {
    body = (
      <div data-testid="auth-signin-link">
        <h2 className="mb-2 text-center text-lg font-semibold text-ink">
          {error ? 'Sign-in link problem' : 'Signing you in…'}
        </h2>
        {error ? (
          <>
            <p className="mb-3 text-center text-sm text-red-600">{error}</p>
            {backToSignIn}
          </>
        ) : (
          <p className="text-center text-sm text-muted">One moment while we verify your link.</p>
        )}
      </div>
    );
  } else {
    const isRegister = mode === 'register';
    body = (
      <form onSubmit={submitAuth}>
        <div className="mb-4 flex justify-center gap-2 text-sm" data-testid="auth-mode">
          <button
            type="button"
            className={!isRegister ? 'font-semibold text-accent-soft' : 'text-muted'}
            onClick={() => nav('signin')}
          >
            Sign In
          </button>
          <span className="text-faint">·</span>
          <button
            type="button"
            className={isRegister ? 'font-semibold text-accent-soft' : 'text-muted'}
            onClick={() => nav('register')}
          >
            Register
          </button>
        </div>
        {isRegister && (
          <p className="mb-3 text-center text-sm text-muted">
            Enter your email and we&apos;ll send you a link to set up your account.
          </p>
        )}
        <input
          data-testid="auth-email"
          className={inputCls}
          placeholder="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        {!isRegister && (
          <>
            <input
              data-testid="auth-password"
              className="mb-1 w-full rounded border border-hairline2 px-3 py-2 text-sm"
              placeholder="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              data-testid="auth-forgot-link"
              className="mb-2 text-xs text-muted hover:text-ink"
              onClick={() => nav('forgot')}
            >
              Forgot password?
            </button>
          </>
        )}
        {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
        <button
          data-testid="auth-submit"
          className={submitCls}
          disabled={busy || !email || (!isRegister && !password)}
        >
          {isRegister ? 'Send me a link' : 'Sign In'}
        </button>
        {isRegister ? (
          <GoogleButton onSignedIn={onSignedIn} showDivider />
        ) : (
          <>
            <div className="my-3 flex items-center gap-2 text-xs text-faint">
              <span className="h-px flex-1 bg-hairline2" />
              or
              <span className="h-px flex-1 bg-hairline2" />
            </div>
            <GoogleButton onSignedIn={onSignedIn} showDivider={false} />
            <button
              type="button"
              data-testid="auth-signin-link-btn"
              className="w-full rounded border border-hairline2 py-2 text-sm font-semibold text-ink hover:bg-base disabled:opacity-50"
              disabled={busy || !email}
              onClick={sendSigninLink}
            >
              Email me a sign-in link
            </button>
          </>
        )}
      </form>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-base">
      <div className="w-80 rounded-xl border border-hairline bg-white p-6 shadow-sm">
        <h1 className="mb-1 text-center text-2xl font-bold text-ink">Flow</h1>
        {invited && (
          <p data-testid="invite-banner" className="mb-3 rounded-lg bg-accent/10 px-3 py-2 text-center text-sm text-accent-deep">
            {joinWorkspace ? (
              <>
                You&rsquo;ve been invited to join{' '}
                <span data-testid="join-workspace-name" className="font-semibold">{joinWorkspace}</span> — create an
                account or sign in.
              </>
            ) : (
              <>You&rsquo;ve been invited to a workspace — create an account or sign in to join.</>
            )}
          </p>
        )}
        {body}
      </div>
      {/* The sign-in screen has no sidebar, so without this a signed-out
          connection could not reach any other server at all (#565, mirroring
          what #562 did for the iOS AuthView). */}
      <button
        type="button"
        data-testid="auth-connections"
        className="text-sm text-muted hover:text-ink"
        onClick={openServerConnections}
      >
        Workspaces &amp; servers…
      </button>
      {!isDesktop() && <a
        data-testid="download-mac-app"
        href={MAC_DOWNLOAD_URL}
        className="text-sm font-semibold text-accent-soft hover:underline"
      >
        Download the Mac app ↓
      </a>}
    </div>
  );
}
