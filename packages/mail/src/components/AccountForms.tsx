// Connecting a mail account (email, then the provider's servers filled in, then name and password; Advanced for the
// servers themselves) and changing one (name, password, servers, removing it).
import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ChevronDown, ChevronRight, ExternalLink, Loader2, Trash2 } from 'lucide-react';
import { MailApiError, mailApi, type MailAccount, type ProviderPreset, type Security, type ServerSettings } from '../api';
import { isEmail } from '../lib/addresses';
import { keys } from '../hooks/mail';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Input, Label } from './ui/input';

/** What to tell the user when the mail server says no. */
export function accountErrorText(e: unknown): { title: string; detail: string } {
  if (e instanceof MailApiError && e.code === 'auth_failed')
    return {
      title: 'The mail server did not accept that email and password.',
      detail: 'Check the password. Many providers (Gmail, iCloud, Yahoo, Outlook with two-step sign-in) need an app password here rather than your usual one.',
    };
  if (e instanceof MailApiError && e.code === 'connect_failed')
    return { title: 'Could not reach the mail server.', detail: `Check the server names, ports and security under Advanced. ${e.message}` };
  return { title: 'That did not work.', detail: e instanceof Error ? e.message : String(e) };
}

function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const { title, detail } = accountErrorText(error);
  return (
    <div role="alert" className="flex gap-2 rounded-lg border border-danger/30 bg-danger/5 p-3 text-[13px] text-ink">
      <AlertCircle className="mt-0.5 size-4 shrink-0 text-danger" />
      <div>
        <div className="font-semibold text-danger">{title}</div>
        <div className="mt-0.5 text-muted">{detail}</div>
      </div>
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

const SECURITY: { value: Security; label: string }[] = [
  { value: 'tls', label: 'SSL/TLS' },
  { value: 'starttls', label: 'STARTTLS' },
  { value: 'none', label: 'None (local testing only)' },
];

function ServerFields({ id, title, value, onChange, email }: { id: string; title: string; value: ServerSettings; onChange(v: ServerSettings): void; email: string }) {
  return (
    <fieldset className="grid grid-cols-[1fr_88px] gap-2 sm:grid-cols-[1fr_88px_140px]">
      <legend className="mb-1.5 text-[11px] font-medium uppercase tracking-[.06em] text-muted">{title}</legend>
      <Input id={`${id}-host`} aria-label={`${title} server`} placeholder="Server" value={value.host} onChange={(e) => onChange({ ...value, host: e.target.value.trim() })} />
      <Input id={`${id}-port`} aria-label={`${title} port`} placeholder="Port" inputMode="numeric" value={String(value.port || '')} onChange={(e) => onChange({ ...value, port: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
      <select
        aria-label={`${title} security`}
        value={value.security}
        onChange={(e) => onChange({ ...value, security: e.target.value as Security })}
        className="col-span-2 h-9 rounded-lg border border-border bg-white px-2 text-sm text-ink sm:col-span-1"
      >
        {SECURITY.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
      <Input
        className="col-span-2 sm:col-span-3"
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

function Advanced({ open, onToggle, children }: { open: boolean; onToggle(): void; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-hairline">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[13px] font-medium text-ink hover:bg-hover" aria-expanded={open}>
        {open ? <ChevronDown className="size-4 text-muted" /> : <ChevronRight className="size-4 text-muted" />}
        Advanced: mail servers
      </button>
      {open && <div className="flex flex-col gap-4 border-t border-hairline px-3 pt-3 pb-4">{children}</div>}
    </div>
  );
}

function PasswordHint({ preset }: { preset: ProviderPreset | null }) {
  return (
    <>
      {preset ? `${preset.name} may need an app password: ` : 'Many providers need an app password: '}a separate password made for one app in your mail account’s security settings, rather
      than the one you sign in with. It is stored encrypted and used only to reach your mail.
      {preset?.appPasswordUrl && (
        <>
          {' '}
          <a href={preset.appPasswordUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline">
            Make one for {preset.name} <ExternalLink className="size-3" />
          </a>
        </>
      )}
    </>
  );
}

const guess = (email: string): { imap: ServerSettings; smtp: ServerSettings } => {
  const domain = email.split('@')[1] ?? '';
  return { imap: { host: domain ? `imap.${domain}` : '', port: 993, security: 'tls' }, smtp: { host: domain ? `smtp.${domain}` : '', port: 465, security: 'tls' } };
};

export function AddAccountDialog({ onClose, onAdded, defaultName }: { onClose(): void; onAdded(account: MailAccount): void; defaultName?: string }) {
  const qc = useQueryClient();
  const [step, setStep] = useState<'email' | 'details'>('email');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState(defaultName ?? '');
  const [password, setPassword] = useState('');
  const [preset, setPreset] = useState<ProviderPreset | null>(null);
  const [servers, setServers] = useState(guess(''));
  const [advanced, setAdvanced] = useState(false);

  const lookup = useMutation({
    mutationFn: () => mailApi.provider(email.trim()),
    onSuccess: (p) => {
      setPreset(p);
      setServers(p ? { imap: p.imap, smtp: p.smtp } : guess(email.trim()));
      setAdvanced(!p);
      setStep('details');
    },
    // No answer about the provider: the user fills the servers in.
    onError: () => {
      setPreset(null);
      setServers(guess(email.trim()));
      setAdvanced(true);
      setStep('details');
    },
  });
  const add = useMutation({
    mutationFn: () => mailApi.addAccount({ email: email.trim(), displayName: displayName.trim() || email.trim(), password, imap: servers.imap, smtp: servers.smtp }),
    onSuccess: (account) => {
      qc.setQueryData<MailAccount[]>(keys.accounts, (old) => [...(old ?? []).filter((a) => a.id !== account.id), account]);
      void qc.invalidateQueries({ queryKey: keys.accounts });
      onAdded(account);
    },
    onError: (e) => {
      if (e instanceof MailApiError && e.code === 'connect_failed') setAdvanced(true);
    },
  });

  const submitEmail = (e: FormEvent) => {
    e.preventDefault();
    if (isEmail(email)) lookup.mutate();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (password) add.mutate();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a mail account</DialogTitle>
          <DialogDescription>Connect the mail you already have: Gmail, iCloud, Outlook, Yahoo, Fastmail or your company’s mail server.</DialogDescription>
        </DialogHeader>
        {step === 'email' ? (
          <form onSubmit={submitEmail} className="flex flex-col gap-4">
            <Field label="Email address" htmlFor="acct-email">
              <Input id="acct-email" type="email" autoFocus autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={!isEmail(email) || lookup.isPending}>
                {lookup.isPending && <Loader2 className="animate-spin" />}
                Next
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div className="flex items-center justify-between rounded-lg bg-panel px-3 py-2 text-[13px]">
              <span className="min-w-0 truncate">
                <span className="font-medium">{email}</span>
                {preset && <span className="text-muted"> · {preset.name}</span>}
              </span>
              <button type="button" className="ml-2 shrink-0 text-primary hover:underline" onClick={() => setStep('email')}>
                Change
              </button>
            </div>
            <Field label="Your name" htmlFor="acct-name" hint="Shown to the people you write to.">
              <Input id="acct-name" autoComplete="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Ann Lee" />
            </Field>
            <Field label="Password" htmlFor="acct-password" hint={<PasswordHint preset={preset} />}>
              <Input id="acct-password" type="password" autoFocus autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={add.error instanceof MailApiError && add.error.code === 'auth_failed'} />
            </Field>
            <Advanced open={advanced} onToggle={() => setAdvanced(!advanced)}>
              <ServerFields id="imap" title="Incoming (IMAP)" value={servers.imap} onChange={(imap) => setServers((s) => ({ ...s, imap }))} email={email} />
              <ServerFields id="smtp" title="Outgoing (SMTP)" value={servers.smtp} onChange={(smtp) => setServers((s) => ({ ...s, smtp }))} email={email} />
            </Advanced>
            <ErrorBox error={add.error} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={!password || add.isPending || !servers.imap.host || !servers.smtp.host}>
                {add.isPending && <Loader2 className="animate-spin" />}
                {add.isPending ? 'Checking…' : 'Connect'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function AccountSettingsDialog({ accounts, initialId, focusPassword, onClose, onRemoved }: { accounts: MailAccount[]; initialId: string | null; focusPassword?: boolean; onClose(): void; onRemoved(id: string): void }) {
  const qc = useQueryClient();
  const [id, setId] = useState(initialId ?? accounts[0]?.id ?? null);
  const account = accounts.find((a) => a.id === id) ?? null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Mail accounts</DialogTitle>
          <DialogDescription>The accounts connected to FreeFlow Mail. Only you can see them.</DialogDescription>
        </DialogHeader>
        {accounts.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            {accounts.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => setId(a.id)}
                className={cn('rounded-full border px-3 py-1 text-[13px]', a.id === id ? 'border-primary bg-selected-blue font-semibold text-primary-deep' : 'border-border hover:bg-hover')}
              >
                {a.email}
                {a.status !== 'ok' && <span className="ml-1 text-danger">!</span>}
              </button>
            ))}
          </div>
        )}
        {account ? (
          <AccountEditor
            key={account.id}
            account={account}
            focusPassword={!!focusPassword && account.id === initialId}
            onSaved={(a) => qc.setQueryData<MailAccount[]>(keys.accounts, (old) => (old ?? []).map((x) => (x.id === a.id ? a : x)))}
            onRemoved={() => {
              qc.setQueryData<MailAccount[]>(keys.accounts, (old) => (old ?? []).filter((x) => x.id !== account.id));
              onRemoved(account.id);
            }}
          />
        ) : (
          <p className="text-sm text-muted">No accounts yet.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AccountEditor({ account, focusPassword, onSaved, onRemoved }: { account: MailAccount; focusPassword: boolean; onSaved(a: MailAccount): void; onRemoved(): void }) {
  const [displayName, setDisplayName] = useState(account.displayName);
  const [password, setPassword] = useState('');
  const [servers, setServers] = useState({ imap: account.imap, smtp: account.smtp });
  const [advanced, setAdvanced] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [saved, setSaved] = useState(false);
  const serversChanged = JSON.stringify(servers) !== JSON.stringify({ imap: account.imap, smtp: account.smtp });
  const save = useMutation({
    mutationFn: () =>
      mailApi.updateAccount(account.id, {
        ...(displayName.trim() !== account.displayName ? { displayName: displayName.trim() } : {}),
        ...(password ? { password } : {}),
        ...(serversChanged ? servers : {}),
      }),
    onSuccess: (a) => {
      onSaved(a);
      setPassword('');
      setSaved(true);
    },
  });
  const remove = useMutation({ mutationFn: () => mailApi.deleteAccount(account.id), onSuccess: onRemoved });
  const dirty = displayName.trim() !== account.displayName || !!password || serversChanged;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        setSaved(false);
        if (dirty) save.mutate();
      }}
    >
      {account.status !== 'ok' && (
        <div className="rounded-lg border border-warn-border bg-warn-bg p-3 text-[13px]">
          <b>{account.status === 'auth_failed' ? 'The mail server stopped accepting the password.' : 'The mail server could not be reached.'}</b>
          {account.statusMessage && <div className="mt-0.5 text-muted">{account.statusMessage}</div>}
        </div>
      )}
      <Field label="Email address" htmlFor="edit-email">
        <Input id="edit-email" value={account.email} disabled />
      </Field>
      <Field label="Your name" htmlFor="edit-name">
        <Input id="edit-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </Field>
      <Field label={account.status === 'auth_failed' ? 'Password (enter it again)' : 'New password'} htmlFor="edit-password" hint={<PasswordHint preset={null} />}>
        <Input id="edit-password" type="password" autoComplete="off" autoFocus={focusPassword} placeholder={account.status === 'auth_failed' ? '' : 'Leave empty to keep the current one'} value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <Advanced open={advanced} onToggle={() => setAdvanced(!advanced)}>
        <ServerFields id="edit-imap" title="Incoming (IMAP)" value={servers.imap} onChange={(imap) => setServers((s) => ({ ...s, imap }))} email={account.email} />
        <ServerFields id="edit-smtp" title="Outgoing (SMTP)" value={servers.smtp} onChange={(smtp) => setServers((s) => ({ ...s, smtp }))} email={account.email} />
      </Advanced>
      <ErrorBox error={save.error ?? remove.error} />
      {saved && !dirty && <div className="text-[13px] text-[#1e8e3e]">Saved.</div>}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
        {confirmRemove ? (
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <span>Remove {account.email} from FreeFlow? Your mail stays on the server.</span>
            <Button type="button" size="sm" variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>
              Remove
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setConfirmRemove(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button type="button" variant="ghost" className="text-danger hover:bg-danger/5" onClick={() => setConfirmRemove(true)}>
            <Trash2 /> Remove account
          </Button>
        )}
        <Button type="submit" className="sm:ml-auto" disabled={!dirty || save.isPending}>
          {save.isPending && <Loader2 className="animate-spin" />}
          {save.isPending ? 'Checking…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
