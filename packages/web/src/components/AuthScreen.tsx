import { useBoundApi } from '../lib/useBoundApi';
import { useEffect, useRef, useState } from 'react';
import type {
  AccountSetupInfoDTO,
  AuthResponse,
  GoogleAuthResponse,
  PublicConfigDTO,
  EmailCodeNewAccount,
  WorkspaceDTO,
} from '@flow/shared';
import { api, scopedStorageKey } from '../lib/api';
import { desktopGoogleSignIn, loadGoogleIdentity, publicConfig } from '../lib/google';
import { isDesktop } from '../lib/host';
import { MAC_DOWNLOAD_URL } from './OpenInApp';
import { openServerConnections } from './ServerConnections';
import { useRuntime } from '../state';
import { SuiteMark } from '@flow/suite-bar';

type Mode =
  | 'signin'
  | 'register'
  | 'code'
  | 'password'
  | 'forgot'
  | 'signup-sent'
  | 'reset-sent'
  | 'complete'
  | 'reset'
  | 'link-sent'
  | 'signin-link'
  | 'setup';


/**
 * "Continue with Google" (phase16 §5). Sign-in and register are the same act
 * with Google, so this is one button shared by both panels. It renders nothing
 * until /v1/config says Google is configured — with GOOGLE_CLIENT_ID unset the
 * deployment shows no Google affordance at all.
 */
export function GoogleButton(props: {
  onSignedIn: (r: GoogleAuthResponse) => void;
  showDivider: boolean;
  /** Google's own button's width in px (at most 400); 288 fits the old card. */
  width?: number;
  /** Where the "or" line goes when `showDivider`: above the button (default) or below it (Google first). */
  dividerBelow?: boolean;
}) {
  if (inMcpDocsApp()) return <McpDocsGoogleButton showDivider={props.showDivider} />;
  return isDesktop() ? <DesktopGoogleButton {...props} /> : <BrowserGoogleButton {...props} />;
}

/** A Web tab of the MCP Docs desktop app, which marks its user agent (packages/docs/desktop/main.js, UA_MARK). */
const inMcpDocsApp = () => typeof navigator !== 'undefined' && navigator.userAgent.includes('MCPDocs/');

/**
 * In MCP Docs' Web tab Google cannot sign in either: the app opens this address in the system browser with a key of
 * its own and waits there for the sign-in (packages/edge/src/routes/handoff.ts), so this is a plain link to it.
 */
function McpDocsGoogleButton({ showDivider }: { showDivider: boolean }) {
  const [started, setStarted] = useState(false);
  return (
    <div data-testid="auth-google">
      {showDivider && (
        <div className="my-3 flex items-center gap-2 text-xs text-faint">
          <span className="h-px flex-1 bg-hairline2" />
          or
          <span className="h-px flex-1 bg-hairline2" />
        </div>
      )}
      <a
        href="/api/auth/google/start"
        data-testid="auth-google-mcpdocs"
        className="mb-2 block w-full rounded border border-hairline2 py-2 text-center text-sm font-semibold text-ink hover:bg-base"
        onClick={() => setStarted(true)}
      >
        Continue with Google
      </a>
      {started && <p className="mt-2 text-center text-sm text-muted">Finish signing in in your browser, then come back here.</p>}
    </div>
  );
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
  width = 288,
  dividerBelow = false,
}: {
  onSignedIn: (r: GoogleAuthResponse) => void;
  showDivider: boolean;
  width?: number;
  dividerBelow?: boolean;
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
        width,
      });
    })();
    return () => { alive = false; };
  }, [clientId, onSignedIn, width]);

  if (!clientId) return null;
  const divider = (
    <div className="my-3 flex items-center gap-2 text-xs text-faint">
      <span className="h-px flex-1 bg-hairline2" />
      or
      <span className="h-px flex-1 bg-hairline2" />
    </div>
  );
  return (
    <div data-testid="auth-google">
      {showDivider && !dividerBelow && divider}
      <div ref={slot} className="mb-2 flex justify-center" />
      {error && <p className="mt-2 text-center text-sm text-red-600">{error}</p>}
      {showDivider && dividerBelow && divider}
    </div>
  );
}

/** The password rules shown as they are met (docs/specs/onboarding.md §1): long, not only letters, not the email. */
export function passwordRules(password: string, email: string): { label: string; ok: boolean }[] {
  const local = email.split('@')[0]?.toLowerCase() ?? '';
  return [
    { label: 'At least 12 characters', ok: password.length >= 12 },
    { label: 'Includes a number or symbol', ok: /[^A-Za-z]/.test(password) },
    { label: 'Doesn’t contain your email', ok: password.length > 0 && !(local.length >= 3 && password.toLowerCase().includes(local)) },
  ];
}

const fieldCls = 'h-12 w-full rounded-[10px] border border-[#D0D5DD] bg-white px-3.5 text-[16px] text-ink focus:border-accent focus:outline-none';
const labelCls = 'text-sm font-semibold text-ink';
const primaryCls = 'flex h-[50px] w-full items-center justify-center rounded-[10px] bg-[#2563EB] text-[16px] font-semibold text-white hover:bg-[#1D4ED8] disabled:bg-[#B2CCFF]';
const linkCls = 'p-0 text-sm font-medium text-[#1D4ED8] hover:underline disabled:opacity-50';
const ledeCls = 'm-0 text-[16px] leading-normal text-[#475467]';

function Heading({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="m-0 text-[32px] leading-tight font-bold tracking-[-0.02em] text-ink">{title}</h1>
      {children}
    </div>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? <p role="alert" className="m-0 text-sm text-red-600">{error}</p> : null;
}

/** The left half: what FreeFlow is, in three lines (the "Sign up or log in" design). Narrow screens show the mark only. */
function BrandPanel() {
  const point = (icon: React.ReactNode, lead: string, rest: string) => (
    <li className="flex items-start gap-3">
      <span className="inline-flex h-8 w-8 flex-none items-center justify-center rounded-[9px] bg-white">{icon}</span>
      <span className="text-[16px] leading-normal text-[#344054]"><b className="text-ink">{lead}</b> {rest}</span>
    </li>
  );
  const svg = (stroke: string, d: React.ReactNode) => (
    <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{d}</svg>
  );
  return (
    <section className="flex min-w-0 flex-col gap-10 bg-[#EAF0FF] px-6 py-8 sm:px-14 sm:py-12 lg:flex-[1_1_520px]">
      <div className="flex items-center gap-2.5 text-lg font-bold text-ink">
        <SuiteMark size={28} title={null} />
        FreeFlow
      </div>
      <div className="my-auto hidden max-w-[520px] flex-col gap-7 lg:flex">
        <h2 className="m-0 text-4xl leading-tight font-bold tracking-[-0.02em] text-ink">
          Stop stitching five tools together.<br />
          <span className="text-[#1D4ED8]">Get work done with your AI in one unified workspace.</span>
        </h2>
        <ul className="m-0 flex list-none flex-col gap-4 p-0">
          {point(svg('#1D4ED8', <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></>), 'Mail, calendar, files, chat and meetings', 'in one place, with email addresses for your agents.')}
          {point(svg('#5B21B6', <path d="M8.5 9.5v1M15.5 9.5v1M8 14.5c1.1 1.5 2.4 2.2 4 2.2s2.9-.7 4-2.2" />), 'Your own Chief of Staff', 'from day one, right beside you in every app.')}
          {point(svg('#344054', <path d="m5 8 4 4-4 4M12 16h7" />), 'Agents as real teammates,', 'hosted here or connected from Claude or ChatGPT.')}
        </ul>
      </div>
    </section>
  );
}

export default function AuthScreen({
  onSignedIn,
  signupToken,
  resetToken,
  signinToken,
  setupToken,
  onSetupDismissed,
  joinWorkspace,
  startOnRegister,
}: {
  onSignedIn: (r: AuthResponse & { autoJoined?: WorkspaceDTO[] }) => void;
  signupToken?: string | null;
  resetToken?: string | null;
  signinToken?: string | null;
  /** An admin-created member's setup link (?setup=): the Set your password page. */
  setupToken?: string | null;
  /** Leaving the setup page for the ordinary sign-in (a dead link, or "Back to sign in"). */
  onSetupDismissed?: () => void;
  /** Workspace name behind a join link, when JoinScreen is wrapping us — so
   * the card says what the visitor is signing in *for* (issue #85). */
  joinWorkspace?: string | null;
  /** Open on Create an account rather than Log in (the Welcome page's "Set up your workspace"). */
  startOnRegister?: boolean;
}) {
  const { api, scopedStorageKey } = useBoundApi();
  // A pending workspace invite means the visitor most likely has no account
  // yet — default them to Create an account rather than Log in. Explicit
  // email-link tokens still win (they target a specific existing flow).
  const invited =
    !!joinWorkspace
    || (typeof localStorage !== 'undefined' && !!localStorage.getItem(scopedStorageKey('pendingInvite')));
  const [mode, setMode] = useState<Mode>(
    setupToken ? 'setup'
      : signinToken ? 'signin-link'
      : signupToken ? 'complete'
      : resetToken ? 'reset'
      : invited || startOnRegister ? 'register'
      : 'signin',
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [code, setCode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  // The sign-up token a code answered for a new address (docs/specs/onboarding.md §1); a ?signup= link's otherwise.
  const [newToken, setNewToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Navigate between forms, clearing any stale error/info so (e.g.) a failed
  // login message doesn't linger on another view.
  const nav = (m: Mode) => {
    setError(null);
    setInfo(null);
    setMode(m);
  };

  // The address follows the screen on /login and /signup: Log in and Create an account each have their own.
  useEffect(() => {
    const path = window.location.pathname;
    if (path !== '/login' && path !== '/signup') return;
    const want = mode === 'register' || mode === 'code' || mode === 'password' ? '/signup' : mode === 'signin' ? '/login' : path;
    if (want !== path) window.history.replaceState(null, '', want);
  }, [mode]);

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

  const submitLogin = (e: React.FormEvent) =>
    void run(async () => {
      e.preventDefault();
      onSignedIn(await api<AuthResponse>('POST', '/v1/auth/login', { email, password }));
    });

  // One code for both: it signs in an account, or starts a sign-up for a new address (POST /v1/auth/code).
  const sendCode = (e?: React.FormEvent) =>
    void run(async () => {
      e?.preventDefault();
      await api('POST', '/v1/auth/code', { email: email.trim() });
      setCode('');
      setMode('code');
    });
  const resendCode = () =>
    void run(async () => {
      await api('POST', '/v1/auth/code', { email: email.trim() });
      setInfo('If a new code can be sent, it is on its way. Codes can be resent every 30 seconds.');
    });
  const submitCode = (e: React.FormEvent) =>
    void run(async () => {
      e.preventDefault();
      const res = await api<AuthResponse | EmailCodeNewAccount>('POST', '/v1/auth/code/verify', { email: email.trim(), code });
      if ('signupToken' in res) {
        setNewToken(res.signupToken);
        setPassword('');
        setMode('password');
      } else onSignedIn(res);
    });

  const rules = passwordRules(password, email);
  const passwordOk = rules.every((r) => r.ok);
  const submitNewAccount = (e: React.FormEvent) =>
    void run(async () => {
      e.preventDefault();
      onSignedIn(await api<AuthResponse>('POST', '/v1/auth/register/complete', { token: newToken ?? signupToken, displayName: displayName.trim(), password }));
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

  // The setup page shows the address first; the link is only spent by the submit.
  const [setupInfo, setSetupInfo] = useState<AccountSetupInfoDTO | null>(null);
  useEffect(() => {
    if (!setupToken) return;
    void run(async () => {
      setSetupInfo(await api<AccountSetupInfoDTO>('GET', `/v1/auth/setup?token=${encodeURIComponent(setupToken)}`));
    });
    // setupToken never changes after mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupToken]);
  const [confirm, setConfirm] = useState('');
  const submitSetup = (e: React.FormEvent) =>
    void run(async () => {
      e.preventDefault();
      if (password !== confirm) throw new Error('The passwords do not match.');
      onSignedIn(await api<AuthResponse>('POST', '/v1/auth/setup', { token: setupToken, password }));
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
    <button type="button" className={`${linkCls} self-start`} onClick={() => nav('signin')}>
      Back to log in
    </button>
  );
  const emailField = (autoFocus = false) => (
    <div className="flex flex-col gap-2">
      <label htmlFor="auth-email" className={labelCls}>Email</label>
      <input id="auth-email" data-testid="auth-email" className={fieldCls} type="email" autoComplete="email" placeholder="you@example.com"
        autoFocus={autoFocus} value={email} onChange={(e) => setEmail(e.target.value)} />
    </div>
  );
  const passwordField = (id: string, label: string, autoComplete: string, describedBy?: string) => (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className={labelCls}>{label}</label>
      <div className="flex items-center rounded-[10px] border border-[#D0D5DD] bg-white pr-1.5 focus-within:border-accent">
        <input id={id} data-testid="auth-password" className="h-12 min-w-0 flex-1 rounded-[10px] border-0 bg-transparent px-3.5 text-[16px] text-ink focus:outline-none"
          type={showPassword ? 'text' : 'password'} autoComplete={autoComplete} aria-describedby={describedBy} value={password} onChange={(e) => setPassword(e.target.value)} />
        <button type="button" aria-pressed={showPassword} onClick={() => setShowPassword((v) => !v)} className="h-9 rounded-lg px-2.5 text-sm font-semibold text-[#1D4ED8]">
          {showPassword ? 'Hide' : 'Show'}
        </button>
      </div>
    </div>
  );

  let body: React.ReactNode;
  if (mode === 'code') {
    body = (
      <form onSubmit={submitCode} className="flex flex-col gap-6" data-testid="auth-code-form">
        <Heading title="Check your email">
          <p className={ledeCls}>We sent a 6-digit code to <b className="text-ink">{email.trim()}</b>. It expires in 10 minutes.</p>
        </Heading>
        <div className="flex flex-col gap-2">
          <label htmlFor="auth-code" className={labelCls}>Code</label>
          <input id="auth-code" data-testid="auth-code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="••••••" autoFocus
            className="h-14 w-full rounded-[10px] border border-[#D0D5DD] bg-white px-4 font-mono text-[26px] tracking-[0.5em] text-ink focus:border-accent focus:outline-none"
            value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
        </div>
        {info && <p className="m-0 text-sm text-[#475467]">{info}</p>}
        <ErrorLine error={error} />
        <button data-testid="auth-submit" className={primaryCls} disabled={busy || code.length !== 6}>Verify and continue</button>
        <div className="flex flex-wrap items-center gap-4">
          <button type="button" className={linkCls} onClick={() => { setCode(''); nav('signin'); }}>Use a different email</button>
          <button type="button" className={linkCls} disabled={busy} onClick={resendCode} data-testid="auth-resend">Resend code</button>
        </div>
      </form>
    );
  } else if (mode === 'password' || mode === 'complete') {
    // A new account's name and password: after a code (`password`), or from an emailed sign-up link (`complete`).
    const shownEmail = mode === 'password' ? email.trim() : '';
    body = (
      <form onSubmit={submitNewAccount} className="flex flex-col gap-6" data-testid="auth-complete">
        <Heading title="Set your password">
          <p className={ledeCls}>{shownEmail ? <>You’ll use it with <b className="text-ink">{shownEmail}</b> to log in.</> : 'Your email is confirmed. Choose a name and a password.'}</p>
        </Heading>
        {shownEmail && <input type="email" autoComplete="username" value={shownEmail} readOnly hidden />}
        <div className="flex flex-col gap-2">
          <label htmlFor="auth-name" className={labelCls}>Your name</label>
          <input id="auth-name" data-testid="auth-displayName" className={fieldCls} autoComplete="name" autoFocus maxLength={80} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </div>
        <div className="flex flex-col gap-2">
          {passwordField('auth-new-password', 'Password', 'new-password', 'pw-rules')}
          <ul id="pw-rules" className="m-0 mt-1 flex list-none flex-col gap-1.5 p-0 text-sm">
            {rules.map((r) => (
              <li key={r.label} className={`flex items-center gap-2 ${r.ok ? 'text-[#067647]' : 'text-[#475467]'}`}>
                <span aria-hidden="true" className={`inline-flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full text-[11px] font-bold text-white ${r.ok ? 'bg-[#079455]' : 'bg-[#D0D5DD]'}`}>{r.ok ? '✓' : ''}</span>
                {r.label}<span className="sr-only">{r.ok ? ' (met)' : ' (not met)'}</span>
              </li>
            ))}
          </ul>
        </div>
        <ErrorLine error={error} />
        <button data-testid="auth-submit" className={primaryCls} disabled={busy || !displayName.trim() || !passwordOk}>Create account</button>
        {mode === 'password' ? (
          <button type="button" className={`${linkCls} self-start`} onClick={() => nav('code')}>Back</button>
        ) : error ? (
          <button type="button" className={`${linkCls} self-start`} onClick={() => nav('register')}>Start again</button>
        ) : null}
      </form>
    );
  } else if (mode === 'signup-sent' || mode === 'link-sent' || mode === 'reset-sent') {
    body = (
      <div className="flex flex-col gap-6" data-testid={`auth-${mode}`}>
        <Heading title="Check your email">
          <p className={ledeCls}>
            {mode === 'reset-sent' ? <>If <b className="text-ink">{email}</b> has an account, we sent it a link to choose a new password.</>
              : mode === 'link-sent' ? <>If <b className="text-ink">{email}</b> has an account, we sent it a sign-in link.</>
              : <>We sent a link to <b className="text-ink">{email}</b>. Click it to finish creating your account.</>}
          </p>
        </Heading>
        {backToSignIn}
      </div>
    );
  } else if (mode === 'forgot') {
    body = (
      <form onSubmit={submitForgot} className="flex flex-col gap-6" data-testid="auth-forgot">
        <Heading title="Reset your password">
          <p className={ledeCls}>We’ll email you a link to choose a new one. Or log in with a code instead.</p>
        </Heading>
        {emailField(true)}
        <ErrorLine error={error} />
        <button data-testid="auth-submit" className={primaryCls} disabled={busy || !email}>Send reset link</button>
        <div className="flex flex-wrap items-center gap-4">
          <button type="button" className={linkCls} disabled={busy || !email} onClick={() => sendCode()}>Email me a code instead</button>
          {backToSignIn}
        </div>
      </form>
    );
  } else if (mode === 'reset') {
    body = (
      <form onSubmit={submitReset} className="flex flex-col gap-6" data-testid="auth-reset">
        <Heading title="Choose a new password" />
        {passwordField('auth-reset-password', 'New password (at least 8 characters)', 'new-password')}
        {error && (
          <p role="alert" className="m-0 text-sm text-red-600">
            {error}{' '}
            <button type="button" className="underline" onClick={() => nav('forgot')}>Request a new link</button>
          </p>
        )}
        <button data-testid="auth-submit" className={primaryCls} disabled={busy || password.length < 8}>Set password &amp; log in</button>
      </form>
    );
  } else if (mode === 'setup') {
    const leave = () => {
      onSetupDismissed?.();
      nav('signin');
    };
    body = setupInfo ? (
      <form onSubmit={submitSetup} className="flex flex-col gap-6" data-testid="auth-setup">
        <Heading title="Set your password">
          <p className={ledeCls}>Welcome{setupInfo.displayName ? `, ${setupInfo.displayName}` : ''}. You will log in to FreeFlow as</p>
        </Heading>
        <p className="m-0 rounded-[10px] bg-black/5 px-3 py-2 text-center text-sm font-semibold text-ink" data-testid="auth-setup-email">{setupInfo.email}</p>
        {/* For password managers: the account this password belongs to. */}
        <input type="email" autoComplete="username" value={setupInfo.email} readOnly hidden />
        {passwordField('auth-setup-password', 'Password (at least 8 characters)', 'new-password')}
        <div className="flex flex-col gap-2">
          <label htmlFor="auth-confirm" className={labelCls}>Confirm password</label>
          <input id="auth-confirm" data-testid="auth-password-confirm" className={fieldCls} type={showPassword ? 'text' : 'password'} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        <ErrorLine error={error} />
        <button data-testid="auth-submit" className={primaryCls} disabled={busy || password.length < 8 || !confirm}>Set password &amp; log in</button>
      </form>
    ) : (
      <div className="flex flex-col gap-4" data-testid="auth-setup">
        <Heading title={error ? 'Setup link problem' : 'Checking your link…'} />
        {error && (
          <>
            <p className="m-0 text-sm text-red-600" data-testid="auth-setup-error">{error}</p>
            <button type="button" className={`${linkCls} self-start`} onClick={leave}>Back to log in</button>
          </>
        )}
      </div>
    );
  } else if (mode === 'signin-link') {
    body = (
      <div className="flex flex-col gap-4" data-testid="auth-signin-link">
        <Heading title={error ? 'Sign-in link problem' : 'Signing you in…'} />
        {error ? (
          <>
            <p className="m-0 text-sm text-red-600">{error}</p>
            {backToSignIn}
          </>
        ) : (
          <p className={ledeCls}>One moment while we check your link.</p>
        )}
      </div>
    );
  } else if (mode === 'register') {
    // Create an account: Google, or an email and its code, then a name and a password.
    body = (
      <form onSubmit={sendCode} className="flex flex-col gap-6" data-testid="auth-register">
        <Heading title="Create your account">
          <p className={ledeCls}>We’ll email you a code to confirm it’s you. Any email works, personal or work.</p>
        </Heading>
        <GoogleButton onSignedIn={onSignedIn} showDivider dividerBelow width={400} />
        {emailField(true)}
        <ErrorLine error={error} />
        <button data-testid="auth-submit" className={primaryCls} disabled={busy || !email.trim()}>Continue with email</button>
        <p className="m-0 text-sm text-[#475467]">
          {invited ? 'Joining a team? Use the email your invite was sent to. ' : ''}Already have an account?{' '}
          <button type="button" className={linkCls} onClick={() => nav('signin')} data-testid="auth-to-login">Log in</button>
        </p>
      </form>
    );
  } else {
    // Log in: email and password first; Google, a code, or a new account beside it.
    body = (
      <form onSubmit={submitLogin} className="flex flex-col gap-6" data-testid="auth-login">
        <Heading title="Log in">
          <p className={ledeCls}>Welcome back. If you already have a workspace, we’ll take you straight to it.</p>
        </Heading>
        {emailField(true)}
        <div className="flex flex-col gap-1.5">
          {passwordField('auth-login-password', 'Password', 'current-password')}
          <button type="button" data-testid="auth-forgot-link" className={`${linkCls} self-start`} onClick={() => nav('forgot')}>Forgot password?</button>
        </div>
        <ErrorLine error={error} />
        <button data-testid="auth-submit" className={primaryCls} disabled={busy || !email || !password}>Log in</button>
        <button type="button" data-testid="auth-code-btn" className={`${linkCls} -mt-2 self-center`} disabled={busy || !email.trim()} onClick={() => sendCode()}>
          Email me a code instead
        </button>
        <GoogleButton onSignedIn={onSignedIn} showDivider width={400} />
        <p className="m-0 text-sm text-[#475467]">
          New to FreeFlow?{' '}
          <button type="button" className={linkCls} onClick={() => nav('register')} data-testid="auth-to-register">Create an account</button>
        </p>
      </form>
    );
  }

  return (
    <div className="flex min-h-full flex-col bg-[#F6F7F9] font-sans text-ink lg:flex-row" data-testid="auth-screen">
      <BrandPanel />
      <main className="flex min-w-0 flex-1 items-center justify-center px-5 py-10 sm:px-10 lg:flex-[1_1_520px]">
        <div className="flex w-full max-w-[420px] flex-col gap-6">
          {invited && (
            <p data-testid="invite-banner" className="m-0 rounded-[10px] bg-accent/10 px-3 py-2 text-sm text-accent-deep">
              {joinWorkspace ? (
                <>
                  You&rsquo;ve been invited to join{' '}
                  <span data-testid="join-workspace-name" className="font-semibold">{joinWorkspace}</span>. Create an account or log in.
                </>
              ) : (
                <>You&rsquo;ve been invited to a workspace. Create an account or log in to join.</>
              )}
            </p>
          )}
          {body}
          <p className="m-0 text-[13px] leading-normal text-[#475467]">
            By continuing, you agree to FreeFlow’s <a href="/privacy" className="text-[#1D4ED8] hover:underline">Privacy Policy</a>.
          </p>
          <div className="flex flex-wrap items-center gap-4 border-t border-[#E4E7EC] pt-4">
            {/* The sign-in screen has no sidebar, so without this a signed-out
                connection could not reach any other server at all (#565, mirroring
                what #562 did for the iOS AuthView). */}
            <button type="button" data-testid="auth-connections" className="text-sm text-[#475467] hover:text-ink" onClick={openServerConnections}>
              Workspaces &amp; servers…
            </button>
            {!isDesktop() && (
              <a data-testid="download-mac-app" href={MAC_DOWNLOAD_URL} className="text-sm font-semibold text-[#1D4ED8] hover:underline">
                Download the Mac app ↓
              </a>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
