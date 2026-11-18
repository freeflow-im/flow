// Linking the mail and calendars a person already has (docs/specs/onboarding.md §1): the forms Mail's and Calendar's
// "Add an account" dialogs show, and setup's "Your email and calendar" step. Each app passes the calls (`api`), so this
// depends on no app; its look is Tailwind with the suite's tokens (each app's index.css reads this file with @source).
import { useState, type FormEvent, type ReactNode } from 'react';

// ---- shared parts ----------------------------------------------------------------------------------------------------

export type Security = 'tls' | 'starttls' | 'none';
export interface ServerSettings { host: string; port: number; security: Security; username?: string }

const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
const codeOf = (e: unknown) => (e as { code?: unknown } | null)?.code;

const inputCls = 'h-9 w-full min-w-0 rounded-lg border border-border bg-white px-3 py-1 text-sm text-ink outline-none transition-colors placeholder:text-muted focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/25 disabled:opacity-50 aria-invalid:border-danger';
const buttonCls = 'inline-flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-4 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50';
const primaryCls = `${buttonCls} bg-primary text-white hover:bg-primary-deep`;
const outlineCls = `${buttonCls} border border-border bg-white text-ink hover:bg-hover`;

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[14px] font-medium text-ink">{label}</label>
      {children}
      {hint && <div className="text-xs leading-relaxed text-muted">{hint}</div>}
    </div>
  );
}

function ErrorBox({ error }: { error: { title: string; detail: string } | null }) {
  if (!error) return null;
  return (
    <div role="alert" className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-[14px] text-ink">
      <div className="font-semibold text-danger">{error.title}</div>
      <div className="mt-0.5 text-muted">{error.detail}</div>
    </div>
  );
}

function Buttons({ onCancel, busy, children }: { onCancel?: () => void; busy?: boolean; children: ReactNode }) {
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {onCancel && <button type="button" className={outlineCls} onClick={onCancel} disabled={busy}>Cancel</button>}
      {children}
    </div>
  );
}

function AppPasswordHint({ name, url }: { name: string | null; url: string | null | undefined }) {
  return (
    <>
      {name ? `${name} may need an app password: ` : 'Many providers need an app password: '}a separate password made for one app in your account’s security settings,
      rather than the one you sign in with. It is stored encrypted and used only to reach your account.
      {url && (
        <>
          {' '}
          <a href={url} target="_blank" rel="noopener noreferrer" className="font-medium text-primary hover:underline">Make one for {name ?? 'it'} ↗</a>
        </>
      )}
    </>
  );
}

// ---- mail ------------------------------------------------------------------------------------------------------------

export interface MailProviderPreset { imap: ServerSettings; smtp: ServerSettings; name: string; appPasswordUrl?: string }
export interface NewMailAccount { email: string; displayName: string; password: string; imap: ServerSettings; smtp: ServerSettings }
export interface MailLinkApi<A> {
  /** The provider's servers for an address (GET /v1/mail/providers), or null when it is not known. */
  provider(email: string): Promise<MailProviderPreset | null>;
  /** Adds the account (POST /v1/mail/accounts), after the server signed in to it. */
  add(account: NewMailAccount): Promise<A>;
}

/** What to tell the person when the mail server says no. */
export function mailAccountErrorText(e: unknown): { title: string; detail: string } {
  if (codeOf(e) === 'auth_failed') {
    return {
      title: 'The mail server did not accept that email and password.',
      detail: 'Check the password. Many providers (Gmail, iCloud, Yahoo, Outlook with two-step sign-in) need an app password here rather than your usual one.',
    };
  }
  if (codeOf(e) === 'connect_failed') return { title: 'Could not reach the mail server.', detail: `Check the server names, ports and security under Advanced. ${e instanceof Error ? e.message : ''}` };
  return { title: 'That did not work.', detail: e instanceof Error ? e.message : String(e) };
}

const SECURITY: { value: Security; label: string }[] = [
  { value: 'tls', label: 'SSL/TLS' },
  { value: 'starttls', label: 'STARTTLS' },
  { value: 'none', label: 'None (local testing only)' },
];

function ServerFields({ id, title, value, onChange, email }: { id: string; title: string; value: ServerSettings; onChange(v: ServerSettings): void; email: string }) {
  return (
    <fieldset className="grid grid-cols-[1fr_88px] gap-2 sm:grid-cols-[1fr_88px_140px]">
      <legend className="mb-1.5 text-[12px] font-medium tracking-[.06em] text-muted uppercase">{title}</legend>
      <input id={`${id}-host`} className={inputCls} aria-label={`${title} server`} placeholder="Server" value={value.host} onChange={(e) => onChange({ ...value, host: e.target.value.trim() })} />
      <input id={`${id}-port`} className={inputCls} aria-label={`${title} port`} placeholder="Port" inputMode="numeric" value={String(value.port || '')} onChange={(e) => onChange({ ...value, port: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
      <select aria-label={`${title} security`} value={value.security} onChange={(e) => onChange({ ...value, security: e.target.value as Security })} className="col-span-2 h-9 rounded-lg border border-border bg-white px-2 text-sm text-ink sm:col-span-1">
        {SECURITY.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
      </select>
      <input
        className={`${inputCls} col-span-2 sm:col-span-3`}
        aria-label={`${title} user name`}
        placeholder={`User name (${email || 'your email address'})`}
        value={value.username ?? ''}
        onChange={(e) => {
          const username = e.target.value.trim();
          const { username: _, ...rest } = value;
          onChange(username ? { ...rest, username } : rest);
        }}
      />
    </fieldset>
  );
}

const guessServers = (email: string): { imap: ServerSettings; smtp: ServerSettings } => {
  const domain = email.split('@')[1] ?? '';
  return { imap: { host: domain ? `imap.${domain}` : '', port: 993, security: 'tls' }, smtp: { host: domain ? `smtp.${domain}` : '', port: 465, security: 'tls' } };
};

/**
 * Add a mail account: the address first (its provider's servers are looked up), then the name shown to people written
 * to and the password, with the servers under Advanced. Gmail, iCloud, Outlook, Yahoo, Fastmail or any IMAP server.
 */
export function MailAccountForm<A>({ api, defaultName, onAdded, onCancel, submitLabel = 'Connect' }: { api: MailLinkApi<A>; defaultName?: string; onAdded(account: A): void; onCancel?: () => void; submitLabel?: string }) {
  const [step, setStep] = useState<'email' | 'details'>('email');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState(defaultName ?? '');
  const [password, setPassword] = useState('');
  const [preset, setPreset] = useState<MailProviderPreset | null>(null);
  const [servers, setServers] = useState(guessServers(''));
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const lookup = async (e: FormEvent) => {
    e.preventDefault();
    if (!isEmail(email) || busy) return;
    setBusy(true);
    // No answer about the provider: the person fills the servers in.
    const p = await api.provider(email.trim()).catch(() => null);
    setPreset(p);
    setServers(p ? { imap: p.imap, smtp: p.smtp } : guessServers(email.trim()));
    setAdvanced(!p);
    setStep('details');
    setBusy(false);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      onAdded(await api.add({ email: email.trim(), displayName: displayName.trim() || email.trim(), password, imap: servers.imap, smtp: servers.smtp }));
    } catch (err) {
      if (codeOf(err) === 'connect_failed') setAdvanced(true);
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (step === 'email') {
    return (
      <form onSubmit={(e) => void lookup(e)} className="flex flex-col gap-4" data-testid="link-mail-form">
        <Field label="Email address" htmlFor="acct-email">
          <input id="acct-email" className={inputCls} type="email" autoFocus autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Buttons onCancel={onCancel}>
          <button type="submit" className={primaryCls} disabled={!isEmail(email) || busy}>{busy ? 'Looking it up…' : 'Next'}</button>
        </Buttons>
      </form>
    );
  }
  const authFailed = codeOf(error) === 'auth_failed';
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" data-testid="link-mail-form">
      <div className="flex items-center justify-between rounded-lg bg-panel px-3 py-2 text-[14px]">
        <span className="min-w-0 truncate">
          <span className="font-medium">{email}</span>
          {preset && <span className="text-muted"> · {preset.name}</span>}
        </span>
        <button type="button" className="ml-2 shrink-0 text-primary hover:underline" onClick={() => setStep('email')}>Change</button>
      </div>
      <Field label="Your name" htmlFor="acct-name" hint="Shown to the people you write to.">
        <input id="acct-name" className={inputCls} autoComplete="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Ann Lee" />
      </Field>
      <Field label="Password" htmlFor="acct-password" hint={<AppPasswordHint name={preset?.name ?? null} url={preset?.appPasswordUrl} />}>
        <input id="acct-password" className={inputCls} type="password" autoFocus autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={authFailed} />
      </Field>
      <div className="rounded-lg border border-hairline">
        <button type="button" onClick={() => setAdvanced(!advanced)} className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[14px] font-medium text-ink hover:bg-hover" aria-expanded={advanced}>
          <span aria-hidden="true" className="w-4 text-muted">{advanced ? '▾' : '▸'}</span>
          Advanced: mail servers
        </button>
        {advanced && (
          <div className="flex flex-col gap-4 border-t border-hairline px-3 pt-3 pb-4">
            <ServerFields id="imap" title="Incoming (IMAP)" value={servers.imap} onChange={(imap) => setServers((s) => ({ ...s, imap }))} email={email} />
            <ServerFields id="smtp" title="Outgoing (SMTP)" value={servers.smtp} onChange={(smtp) => setServers((s) => ({ ...s, smtp }))} email={email} />
          </div>
        )}
      </div>
      <ErrorBox error={error ? mailAccountErrorText(error) : null} />
      <Buttons onCancel={onCancel} busy={busy}>
        <button type="submit" className={primaryCls} disabled={!password || busy || !servers.imap.host || !servers.smtp.host}>{busy ? 'Checking…' : submitLabel}</button>
      </Buttons>
    </form>
  );
}

// ---- calendars -------------------------------------------------------------------------------------------------------

export type CalendarConnectKind = 'google' | 'icloud' | 'fastmail' | 'other';
export type CalendarProvider = { name: string; url: string; username: string; appPasswordUrl?: string } | { google: true; note: string } | null;
export interface NewCalendarAccount { email: string; displayName: string; password: string; server?: { url: string; username?: string } }
export interface CalendarLinkApi<A> {
  /** The provider for an address (GET /v1/calendar/providers): a CalDAV preset, Google, or null. */
  provider(email: string): Promise<CalendarProvider>;
  /** Adds a CalDAV account (POST /v1/calendar/accounts), after the server signed in to it. */
  add(account: NewCalendarAccount): Promise<A>;
  /** Sends the browser to Google's consent page, coming back to the app (GET /v1/calendar/google/start). */
  connectGoogle(email?: string): Promise<void>;
}

export const CALENDAR_PRESETS: Record<'icloud' | 'fastmail', { name: string; url: string; appPasswordUrl: string; placeholder: string }> = {
  icloud: { name: 'iCloud', url: 'https://caldav.icloud.com/', appPasswordUrl: 'https://account.apple.com/account/manage', placeholder: 'you@icloud.com' },
  fastmail: { name: 'Fastmail', url: 'https://caldav.fastmail.com/', appPasswordUrl: 'https://app.fastmail.com/settings/security/apps', placeholder: 'you@fastmail.com' },
};

/** What to tell the person when the calendar server says no. */
export function calendarAccountErrorText(e: unknown): { title: string; detail: string } {
  if (codeOf(e) === 'auth_failed') return { title: 'The calendar server did not accept that name and password.', detail: 'Check the password. iCloud and Fastmail need an app password here rather than your usual one.' };
  if (codeOf(e) === 'connect_failed') return { title: 'Could not reach the calendar server.', detail: e instanceof Error ? e.message : String(e) };
  return { title: 'That did not work.', detail: e instanceof Error ? e.message : String(e) };
}

/**
 * Add a calendar account: Google (by signing in with Google), iCloud and Fastmail (with an app password), or any other
 * CalDAV server by its address.
 */
export function CalendarAccountForm<A>({ api, initialKind = 'google', defaultName, onAdded, onCancel, googleAvailable = true }: {
  api: CalendarLinkApi<A>; initialKind?: CalendarConnectKind; defaultName?: string; onAdded(account: A): void; onCancel?: () => void;
  /** False hides the Google tab (a server with no Google client). */
  googleAvailable?: boolean;
}) {
  const [kind, setKind] = useState<CalendarConnectKind>(googleAvailable ? initialKind : initialKind === 'google' ? 'icloud' : initialKind);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState(defaultName ?? '');
  const [password, setPassword] = useState('');
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // Leaving for Google: '' while the page goes, else why it could not.
  const [leaving, setLeaving] = useState<string | null>(null);
  const preset = kind === 'icloud' || kind === 'fastmail' ? CALENDAR_PRESETS[kind] : null;

  const signInWithGoogle = async () => {
    setLeaving('');
    try {
      await api.connectGoogle(isEmail(email) ? email.trim() : undefined);
    } catch (e) {
      setLeaving(e instanceof Error ? e.message : String(e));
    }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!isEmail(email) || !password || busy) return;
    setNote(null);
    setError(null);
    if (kind === 'other' && !url.trim()) {
      // An address with a preset needs no URL (the server knows it); any other needs one.
      const p = await api.provider(email.trim()).catch(() => null);
      if (p && 'google' in p) { if (googleAvailable) setKind('google'); return; }
      if (!p) { setNote('Enter the server address of your calendar.'); document.getElementById('cal-url')?.focus(); return; }
    }
    setBusy(true);
    try {
      onAdded(await api.add({ email: email.trim(), displayName: displayName.trim(), password, ...(preset ? { server: { url: preset.url } } : url.trim() ? { server: { url: url.trim(), ...(username.trim() ? { username: username.trim() } : {}) } } : {}) }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const tab = (k: CalendarConnectKind, label: string) => (
    <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)}
      className={`flex-1 rounded-md px-2 py-1.5 whitespace-nowrap ${kind === k ? 'bg-white font-medium shadow-sm' : 'text-muted'}`}>{label}</button>
  );
  return (
    <div className="flex flex-col gap-4" data-testid="link-calendar-form">
      <div role="tablist" aria-label="Provider" className="flex rounded-lg bg-track p-0.5 text-[14px]">
        {googleAvailable && tab('google', 'Google')}
        {tab('icloud', 'iCloud')}
        {tab('fastmail', 'Fastmail')}
        {tab('other', 'Other CalDAV')}
      </div>
      {kind === 'google' ? (
        <div className="flex flex-col gap-4">
          <p className="m-0 text-[14px] leading-relaxed text-muted">Sign in with Google and allow FreeFlow to see and change your calendars. You come back here when it is done; there is no password to type.</p>
          {leaving && <p role="alert" className="m-0 rounded-lg border border-warn-border bg-warn-bg px-3 py-2 text-[14px]">{leaving}</p>}
          <Buttons onCancel={onCancel}>
            <button type="button" className={primaryCls} onClick={() => void signInWithGoogle()} disabled={leaving === ''}>{leaving === '' ? 'Opening Google…' : 'Sign in with Google'}</button>
          </Buttons>
        </div>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <Field label={kind === 'icloud' ? 'Apple Account email' : 'Email address'} htmlFor="cal-email" hint="Events you create are organized by this address.">
            <input id="cal-email" className={inputCls} type="email" autoFocus autoComplete="email" placeholder={preset?.placeholder ?? 'you@example.com'} value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          {kind === 'other' && (
            <>
              <Field label="Server address" htmlFor="cal-url" hint="The CalDAV address: for Nextcloud https://cloud.example.com/remote.php/dav, for others often just the server's name.">
                <input id="cal-url" className={inputCls} inputMode="url" placeholder="https://dav.example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
              </Field>
              <Field label="User name" htmlFor="cal-user">
                <input id="cal-user" className={inputCls} autoComplete="username" placeholder={email || 'Your email address'} value={username} onChange={(e) => setUsername(e.target.value)} />
              </Field>
            </>
          )}
          <Field label="Your name" htmlFor="cal-name">
            <input id="cal-name" className={inputCls} autoComplete="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Ann Lee" />
          </Field>
          <Field label="Password" htmlFor="cal-password" hint={<AppPasswordHint name={preset?.name ?? null} url={preset?.appPasswordUrl} />}>
            <input id="cal-password" className={inputCls} type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={codeOf(error) === 'auth_failed'} />
          </Field>
          {note && <p role="alert" className="m-0 rounded-lg border border-warn-border bg-warn-bg px-3 py-2 text-[14px]">{note}</p>}
          <ErrorBox error={error ? calendarAccountErrorText(error) : null} />
          <Buttons onCancel={onCancel} busy={busy}>
            <button type="submit" className={primaryCls} disabled={!isEmail(email) || !password || busy}>{busy ? 'Connecting…' : 'Connect'}</button>
          </Buttons>
        </form>
      )}
    </div>
  );
}
