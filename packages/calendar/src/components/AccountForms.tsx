// Connecting a calendar account (Google by signing in with Google; iCloud and Fastmail by their presets, any other CalDAV
// server by its address) and changing one (name, password, server, a Google account's Reconnect, removing it), as Mail's
// AccountForms do for mail.
import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ExternalLink, Loader2, Trash2 } from 'lucide-react';
import { CalendarApiError, calendarApi, connectGoogle, type CalendarAccount, type CalendarInfo } from '../api';
import { keys, useAddAccount } from '../hooks/calendar';
import { cn } from '../lib/utils';
import type { ConnectKind } from './ConnectCalendar';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Input, Label } from './ui/input';

const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
const PRESETS: Record<'icloud' | 'fastmail', { name: string; url: string; appPasswordUrl: string; placeholder: string }> = {
  icloud: { name: 'iCloud', url: 'https://caldav.icloud.com/', appPasswordUrl: 'https://account.apple.com/account/manage', placeholder: 'you@icloud.com' },
  fastmail: { name: 'Fastmail', url: 'https://caldav.fastmail.com/', appPasswordUrl: 'https://app.fastmail.com/settings/security/apps', placeholder: 'you@fastmail.com' },
};

/** What to tell the person when the calendar server says no. */
export function accountErrorText(e: unknown): { title: string; detail: string } {
  if (e instanceof CalendarApiError && e.code === 'auth_failed')
    return { title: 'The calendar server did not accept that name and password.', detail: 'Check the password. iCloud and Fastmail need an app password here rather than your usual one.' };
  if (e instanceof CalendarApiError && e.code === 'connect_failed') return { title: 'Could not reach a calendar at that address.', detail: e.message };
  return { title: 'That did not work.', detail: e instanceof Error ? e.message : String(e) };
}

function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const { title, detail } = accountErrorText(error);
  return (
    <div role="alert" className="flex gap-2 rounded-lg border border-danger/30 bg-danger/5 p-3 text-[14px] text-ink">
      <AlertCircle className="mt-0.5 size-4 shrink-0 text-danger" />
      <div><div className="font-semibold text-danger">{title}</div><div className="mt-0.5 text-muted">{detail}</div></div>
    </div>
  );
}

const Field = ({ label, children, hint, htmlFor }: { label: string; children: ReactNode; hint?: ReactNode; htmlFor: string }) => (
  <div className="flex flex-col gap-1.5">
    <Label htmlFor={htmlFor}>{label}</Label>
    {children}
    {hint && <div className="text-xs leading-relaxed text-muted">{hint}</div>}
  </div>
);

function PasswordHint({ name, url }: { name: string | null; url: string | null }) {
  return (
    <>
      {name ? `${name} needs an app password: ` : 'Many providers need an app password: '}a separate password made for one app in your account’s security settings. It is stored
      encrypted and used only to reach your calendars.
      {url && <> <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline">Make one for {name} <ExternalLink className="size-3" /></a></>}
    </>
  );
}

export function AddAccountDialog({ kind: initialKind, defaultName, onClose, onAdded }: { kind: ConnectKind; defaultName?: string; onClose(): void; onAdded(a: CalendarAccount): void }) {
  const [kind, setKind] = useState<ConnectKind>(initialKind);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState(defaultName ?? '');
  const [password, setPassword] = useState('');
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const preset = kind === 'icloud' || kind === 'fastmail' ? PRESETS[kind] : null;
  const [leaving, setLeaving] = useState<string | null>(null);
  const signInWithGoogle = async () => {
    setLeaving('');
    try {
      await connectGoogle(isEmail(email) ? email.trim() : undefined);
    } catch (e) {
      setLeaving(e instanceof Error ? e.message : String(e));
    }
  };
  const add = useAddAccount(onAdded);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!isEmail(email) || !password) return;
    setNote(null);
    if (kind === 'other' && !url.trim()) {
      // An address with a preset needs no URL (the server knows it); any other needs one.
      const p = await calendarApi.provider(email.trim()).catch(() => null);
      if (p && 'google' in p) { setKind('google'); return; }
      if (!p) { setNote('Enter the server address of your calendar.'); document.getElementById('cal-url')?.focus(); return; }
    }
    add.mutate({ email: email.trim(), displayName: displayName.trim(), password, server: preset ? { url: preset.url } : url.trim() ? { url: url.trim(), ...(username.trim() ? { username: username.trim() } : {}) } : undefined });
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !add.isPending && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a calendar account</DialogTitle>
          <DialogDescription>Connect the calendars you already have. Your events stay with your provider.</DialogDescription>
        </DialogHeader>
        <div role="tablist" aria-label="Provider" className="flex rounded-lg bg-track p-0.5 text-[14px]">
          {(['icloud', 'fastmail', 'other'] as const).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)} className={cn('flex-1 whitespace-nowrap rounded-md px-2 py-1.5', kind === k ? 'bg-white font-medium shadow-sm' : 'text-muted')}>{k === 'other' ? 'Other CalDAV' : PRESETS[k].name}</button>
          ))}
          <button type="button" role="tab" aria-selected={kind === 'google'} onClick={() => setKind('google')} className={cn('flex-1 whitespace-nowrap rounded-md px-2 py-1.5', kind === 'google' ? 'bg-white font-medium shadow-sm' : 'text-muted')}>Google</button>
        </div>
        {kind === 'google' ? (
          <div className="flex flex-col gap-4">
            <p className="text-[14px] leading-relaxed text-muted">Sign in with Google and allow FreeFlow to see and change your calendars. You come back here when it is done; there is no password to type.</p>
            {leaving && <p role="alert" className="rounded-lg border border-warn-border bg-warn-bg px-3 py-2 text-[14px]">{leaving}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
              <Button type="button" onClick={() => void signInWithGoogle()} disabled={leaving === ''}>{leaving === '' && <Loader2 className="animate-spin" />}Sign in with Google</Button>
            </DialogFooter>
          </div>
        ) : (
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <Field label={kind === 'icloud' ? 'Apple Account email' : 'Email address'} htmlFor="cal-email" hint="Events you create are organized by this address.">
            <Input id="cal-email" type="email" autoFocus autoComplete="email" placeholder={preset?.placeholder ?? 'you@example.com'} value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          {kind === 'other' && (
            <>
              <Field label="Server address" htmlFor="cal-url" hint="The CalDAV address: for Nextcloud https://cloud.example.com/remote.php/dav, for others often just the server's name.">
                <Input id="cal-url" inputMode="url" placeholder="https://dav.example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
              </Field>
              <Field label="User name" htmlFor="cal-user">
                <Input id="cal-user" autoComplete="username" placeholder={email || 'Your email address'} value={username} onChange={(e) => setUsername(e.target.value)} />
              </Field>
            </>
          )}
          <Field label="Your name" htmlFor="cal-name"><Input id="cal-name" autoComplete="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Ann Lee" /></Field>
          <Field label="Password" htmlFor="cal-password" hint={<PasswordHint name={preset?.name ?? null} url={preset?.appPasswordUrl ?? null} />}>
            <Input id="cal-password" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={add.error instanceof CalendarApiError && add.error.code === 'auth_failed'} />
          </Field>
          {note && <p role="alert" className="rounded-lg border border-warn-border bg-warn-bg px-3 py-2 text-[14px]">{note}</p>}
          <ErrorBox error={add.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={add.isPending}>Cancel</Button>
            <Button type="submit" disabled={!isEmail(email) || !password || add.isPending}>{add.isPending && <Loader2 className="animate-spin" />}{add.isPending ? 'Connecting…' : 'Connect'}</Button>
          </DialogFooter>
        </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function AccountSettingsDialog({ accounts, initialId, focusPassword, onClose, onAdd }: { accounts: CalendarAccount[]; initialId: string | null; focusPassword?: boolean; onClose(): void; onAdd(): void }) {
  const [id, setId] = useState(initialId ?? accounts[0]?.id ?? null);
  const account = accounts.find((a) => a.id === id) ?? null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Calendar accounts</DialogTitle>
          <DialogDescription>The accounts connected to FreeFlow Calendar. Only you can see them.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-1.5">
          {accounts.map((a) => (
            <button key={a.id} type="button" onClick={() => setId(a.id)} className={cn('rounded-full border px-3 py-1 text-[14px]', a.id === id ? 'border-primary bg-selected-blue font-semibold text-primary-deep' : 'border-border hover:bg-hover')}>
              {a.email}{a.status !== 'ok' && <span className="ml-1 text-danger">!</span>}
            </button>
          ))}
          <button type="button" onClick={onAdd} className="rounded-full border border-dashed border-border px-3 py-1 text-[14px] text-muted hover:bg-hover">Add account</button>
        </div>
        {account ? <AccountEditor key={account.id} account={account} focusPassword={!!focusPassword && account.id === initialId} onRemoved={() => setId(accounts.find((a) => a.id !== account.id)?.id ?? null)} /> : <p className="text-sm text-muted">No accounts yet.</p>}
      </DialogContent>
    </Dialog>
  );
}

function AccountEditor({ account, focusPassword, onRemoved }: { account: CalendarAccount; focusPassword: boolean; onRemoved(): void }) {
  const qc = useQueryClient();
  const [displayName, setDisplayName] = useState(account.displayName);
  const [password, setPassword] = useState('');
  const [url, setUrl] = useState(account.server?.url ?? '');
  const [username, setUsername] = useState(account.server?.username ?? '');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [saved, setSaved] = useState(false);
  const serverChanged = url.trim() !== (account.server?.url ?? '') || username.trim() !== (account.server?.username ?? '');
  const dirty = displayName.trim() !== account.displayName || !!password || serverChanged;
  const save = useMutation({
    mutationFn: () => calendarApi.updateAccount(account.id, { ...(displayName.trim() !== account.displayName ? { displayName: displayName.trim() } : {}), ...(password ? { password } : {}), ...(serverChanged ? { server: { url: url.trim(), username: username.trim() } } : {}) }),
    onSuccess: (a) => {
      qc.setQueryData<CalendarAccount[]>(keys.accounts, (old) => (old ?? []).map((x) => (x.id === a.id ? a : x)));
      void qc.invalidateQueries({ queryKey: ['calendar'] });
      setPassword('');
      setSaved(true);
    },
  });
  const remove = useMutation({
    mutationFn: () => calendarApi.removeAccount(account.id),
    onSuccess: () => {
      qc.setQueryData<CalendarAccount[]>(keys.accounts, (old) => (old ?? []).filter((x) => x.id !== account.id));
      qc.setQueryData<CalendarInfo[]>(keys.calendars, (old) => (old ?? []).filter((c) => c.accountId !== account.id));
      void qc.invalidateQueries({ queryKey: ['calendar'] });
      onRemoved();
    },
  });
  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); setSaved(false); if (dirty) save.mutate(); }}>
      {account.status !== 'ok' && (
        <div className="rounded-lg border border-warn-border bg-warn-bg p-3 text-[14px]">
          <b>{account.status === 'auth_failed' ? (account.kind === 'google' ? 'Google stopped giving FreeFlow access to this calendar.' : 'The calendar server stopped accepting the password.') : 'The calendar server could not be reached.'}</b>
          {account.statusMessage && <div className="mt-0.5 text-muted">{account.statusMessage}</div>}
        </div>
      )}
      <Field label="Email address" htmlFor="edit-email"><Input id="edit-email" value={account.email} disabled /></Field>
      <Field label="Your name" htmlFor="edit-name"><Input id="edit-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></Field>
      {account.kind === 'google' ? (
        <div className="flex flex-wrap items-center gap-3 text-[14px] text-muted">
          <span className="min-w-0 flex-1">Connected by signing in with Google. If Google stops giving FreeFlow access, sign in again.</span>
          <Button type="button" variant={account.status === 'auth_failed' ? 'default' : 'outline'} size="sm" onClick={() => void connectGoogle(account.email)}>Reconnect</Button>
        </div>
      ) : (<>
      <Field label={account.status === 'auth_failed' ? 'Password (enter it again)' : 'New password'} htmlFor="edit-password" hint={<PasswordHint name={null} url={null} />}>
        <Input id="edit-password" type="password" autoComplete="off" autoFocus={focusPassword} placeholder={account.status === 'auth_failed' ? '' : 'Leave empty to keep the current one'} value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Server address" htmlFor="edit-url"><Input id="edit-url" value={url} onChange={(e) => setUrl(e.target.value)} /></Field>
        <Field label="User name" htmlFor="edit-user"><Input id="edit-user" value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
      </div>
      </>)}
      <ErrorBox error={save.error ?? remove.error} />
      {saved && !dirty && <div className="text-[14px] text-[#1e8e3e]">Saved.</div>}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
        {confirmRemove ? (
          <div className="flex flex-wrap items-center gap-2 text-[14px]">
            <span>Remove {account.email} from FreeFlow? Your calendars stay on the server.</span>
            <Button type="button" size="sm" variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>Remove</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setConfirmRemove(false)}>Cancel</Button>
          </div>
        ) : (
          <Button type="button" variant="ghost" className="text-danger hover:bg-danger/5" onClick={() => setConfirmRemove(true)}><Trash2 /> Remove account</Button>
        )}
        <Button type="submit" className="sm:ml-auto" disabled={!dirty || save.isPending}>{save.isPending && <Loader2 className="animate-spin" />}{save.isPending ? 'Checking…' : 'Save'}</Button>
      </div>
    </form>
  );
}
