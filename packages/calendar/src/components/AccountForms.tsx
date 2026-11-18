// Connecting a calendar account (Google by signing in with Google; iCloud and Fastmail by their presets, any other CalDAV
// server by its address) and changing one (name, password, server, a Google account's Reconnect, removing it), as Mail's
// AccountForms do for mail.
import { useState, type ReactNode } from 'react';
import { CalendarAccountForm, type CalendarLinkApi } from '@flow/suite-bar/link-accounts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ExternalLink, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { CalendarApiError, GOOGLE_SYNC_SETTINGS, calendarApi, connectGoogle, type CalendarAccount, type CalendarInfo } from '../api';
import { keys, useAddAccount } from '../hooks/calendar';
import { cn } from '../lib/utils';
import type { ConnectKind } from './ConnectCalendar';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { Input, Label } from './ui/input';


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

export function AddAccountDialog({ kind, defaultName, onClose, onAdded }: { kind: ConnectKind; defaultName?: string; onClose(): void; onAdded(a: CalendarAccount): void }) {
  // The form is the suite's (suite-bar LinkAccounts.tsx), shared with Home's setup; Calendar keeps its lists fresh.
  const add = useAddAccount(onAdded);
  const api: CalendarLinkApi<CalendarAccount> = {
    provider: (email) => calendarApi.provider(email),
    add: async (body) => (await add.mutateAsync(body)).account,
    connectGoogle: (email) => connectGoogle(email),
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !add.isPending && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a calendar account</DialogTitle>
          <DialogDescription>Connect the calendars you already have. Your events stay with your provider.</DialogDescription>
        </DialogHeader>
        {/* useAddAccount calls onAdded itself once the account is in. */}
        <CalendarAccountForm api={api} initialKind={kind} defaultName={defaultName} onAdded={() => undefined} onCancel={onClose} />
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
  const [refreshed, setRefreshed] = useState<string | null>(null);
  const refresh = useMutation({
    mutationFn: () => calendarApi.refreshAccount(account.id),
    onSuccess: (r) => {
      qc.setQueryData<CalendarInfo[]>(keys.calendars, (old) => [...(old ?? []).filter((c) => c.accountId !== account.id), ...r.calendars]);
      void qc.invalidateQueries({ queryKey: ['calendar'] });
      setRefreshed(r.added || r.removed ? `${r.added} added, ${r.removed} removed.` : 'No new calendars.');
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
          <p className="w-full text-[13px] leading-relaxed">
            Google shares only the calendars ticked in its{' '}
            <a href={GOOGLE_SYNC_SETTINGS} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline">Sync settings <ExternalLink className="size-3" /></a>
            . Calendars shared with you (a work calendar, say) are off there until you tick them; Birthdays is never shared. Then use Refresh calendars below.
          </p>
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
      <div className="flex flex-wrap items-center gap-3 text-[14px]">
        <Button type="button" variant="outline" size="sm" onClick={() => { setRefreshed(null); refresh.mutate(); }} disabled={refresh.isPending}>
          {refresh.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Refresh calendars
        </Button>
        <span className="text-muted">{refreshed ?? 'Reads the list of calendars again (FreeFlow does every 15 minutes).'}</span>
      </div>
      <ErrorBox error={save.error ?? remove.error ?? refresh.error} />
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
