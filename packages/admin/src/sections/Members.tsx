// Members (docs/specs/workspace-admin.md §3.2 and §5): inviting people and chat guests or creating a member at an address
// on the organization's domain, the pending invitations and setups, and
// the roster with each member's role, kind and mail state. Every change saves at once; a destructive one confirms inline.
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccountDTO, AccountKind, CreateMemberResultDTO, InviteResultDTO, MemberRole, PendingSetupDTO, WorkspaceDTO, WorkspaceInviteDTO, WorkspaceMemberDTO } from '@flow/shared';
import { adminApi } from '../api';
import { suite } from '../suite';
import { tellHome } from '@flow/suite-bar';
import { Button, Card, Confirm, ErrorLine, Select } from '../components/ui';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Filter = 'all' | 'people' | 'agents' | 'guests' | 'attention';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'people', label: 'People' },
  { id: 'agents', label: 'Agents' },
  { id: 'guests', label: 'Guests' },
  { id: 'attention', label: 'Needs attention' },
];

/** The Mail column (§5): what the account's provisioning state says, in the admin's words. */
export function mailState(a: AccountDTO | undefined, hostedMail: boolean): { text: string; tone: 'ok' | 'muted' | 'warn'; retry: boolean } | null {
  if (!hostedMail || !a) return null;
  if (a.kind === 'guest') return { text: '—', tone: 'muted', retry: false };
  if (a.state === 'suspended') return { text: 'suspended', tone: 'muted', retry: false };
  if (a.statusMessage) return { text: `stopped: ${a.statusMessage}`, tone: 'warn', retry: true };
  if (a.state === 'active' && a.hosted) return { text: 'ready', tone: 'ok', retry: false };
  if (a.state !== 'active') return { text: 'being set up', tone: 'muted', retry: false };
  return { text: 'no mailbox yet', tone: 'muted', retry: true };
}

const needsAttention = (a: AccountDTO | undefined) => !!a && a.kind === 'native' && (a.state !== 'active' || !!a.statusMessage);

export function Members({ org }: { org: WorkspaceDTO }) {
  const qc = useQueryClient();
  const config = useQuery({ queryKey: ['config'], queryFn: adminApi.config, staleTime: Infinity });
  const hostedMail = !!config.data?.hostedMail;
  const me = useQuery({ queryKey: ['suite', 'me'], queryFn: suite.me });
  const members = useQuery({ queryKey: ['members', org.id], queryFn: () => adminApi.members(org.id) });
  const accounts = useQuery({ queryKey: ['accounts', org.id], queryFn: () => adminApi.accounts(org.id) });
  const refresh = () => {
    tellHome('members');
    return Promise.all([qc.invalidateQueries({ queryKey: ['members', org.id] }), qc.invalidateQueries({ queryKey: ['accounts', org.id] })]);
  };

  const accountOf = (m: WorkspaceMemberDTO) => (accounts.data ?? []).find((a) => a.principalId === m.userId);
  const [filter, setFilter] = useState<Filter>('all');
  const roster = useMemo(() => {
    const rank = (r: MemberRole) => (r === 'owner' ? 0 : r === 'admin' ? 1 : 2);
    return (members.data ?? []).slice().sort((a, b) => rank(a.role) - rank(b.role) || a.displayName.localeCompare(b.displayName));
  }, [members.data]);
  const shown = roster.filter((m) => {
    const a = accountOf(m);
    if (filter === 'people') return !m.isAgent && !m.isBot;
    if (filter === 'agents') return m.isAgent;
    if (filter === 'guests') return (m.kind ?? a?.kind) === 'guest';
    if (filter === 'attention') return needsAttention(a);
    return true;
  });
  const counts = {
    attention: roster.filter((m) => needsAttention(accountOf(m))).length,
    guests: roster.filter((m) => (m.kind ?? accountOf(m)?.kind) === 'guest').length,
  };

  return (
    <>
      <AddPeople org={org} onInvited={() => void qc.invalidateQueries({ queryKey: ['invites', org.id] })} onCreated={() => Promise.all([refresh(), qc.invalidateQueries({ queryKey: ['setups', org.id] })])} />
      <Pending org={org} />
      <Card title="Members" testid="card-members">
        <div className="flex flex-wrap items-center gap-2 text-xs" role="tablist" aria-label="Filter">
          {FILTERS.map((f) => {
            const n = f.id === 'attention' ? counts.attention : f.id === 'guests' ? counts.guests : null;
            if (f.id === 'attention' && n === 0) return null;
            return (
              <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} className={`rounded-full px-2.5 py-1 ${filter === f.id ? 'bg-primary text-white' : 'bg-panel text-muted hover:bg-hover'}`} onClick={() => setFilter(f.id)} data-testid={`filter-${f.id}`}>
                {f.label}
                {n !== null && n > 0 ? ` ${n}` : ''}
              </button>
            );
          })}
          <span className="flex-1" />
          <span className="text-muted" data-testid="members-count">
            {roster.length} {roster.length === 1 ? 'member' : 'members'}
          </span>
        </div>
        {members.isError && <ErrorLine error={errorText(members.error)} />}
        <div className="overflow-x-auto rounded-lg border border-hairline">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-hairline bg-panel text-left text-xs text-faint uppercase">
                <th className="px-3 py-2 font-semibold">Member</th>
                <th className="px-3 py-2 font-semibold">Role</th>
                <th className="px-3 py-2 font-semibold" title="Native accounts have an address and a mailbox; guests have neither and use Chat only">Kind</th>
                {hostedMail && <th className="px-3 py-2 font-semibold">Mail</th>}
                <th className="px-3 py-2 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((m) => (
                <MemberRow key={m.userId} org={org} member={m} account={accountOf(m)} sponsorName={roster.find((x) => x.userId === m.sponsorId)?.displayName} meId={me.data?.id} hostedMail={hostedMail} onChanged={refresh} />
              ))}
              {members.isSuccess && shown.length === 0 && (
                <tr>
                  <td className="px-3 py-3 text-sm text-muted" colSpan={hostedMail ? 5 : 4}>
                    Nobody here.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Bulk org={org} hostedMail={hostedMail} accounts={accounts.data} onChanged={refresh} />
      </Card>
    </>
  );
}

function MemberRow({ org, member: m, account: a, sponsorName, meId, hostedMail, onChanged }: { org: WorkspaceDTO; member: WorkspaceMemberDTO; account: AccountDTO | undefined; sponsorName: string | undefined; meId: string | undefined; hostedMail: boolean; onChanged(): Promise<unknown> }) {
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const isOwner = m.role === 'owner';
  const isSelf = m.userId === meId;
  const personal = m.kind === 'personal_agent';
  const assistant = personal && m.agentRuntime === 'hosted';
  // The owner is immutable; nobody acts on themselves (no self-lockout). A person's assistant comes and goes with them
  // (agents.md §6); an external personal agent is removed through its own route.
  const locked = isOwner || isSelf || assistant;
  const act = <V,>(fn: (v: V) => Promise<unknown>) =>
    useMutation({
      mutationFn: fn,
      onMutate: () => setError(null),
      onSuccess: async () => {
        setConfirming(false);
        await onChanged();
      },
      onError: (e) => setError(errorText(e)),
    });
  const setRole = act((role: Exclude<MemberRole, 'owner'>) => adminApi.setRole(org.id, m.userId, role));
  const setKind = act((kind: AccountKind) => adminApi.setKind(org.id, a!.id, kind));
  const remove = act(() => (personal ? adminApi.removePersonalAgent(org.id, m.accountId ?? a!.id) : adminApi.removeMember(org.id, m.userId)));
  const retry = act(() => adminApi.provisionOne(org.id, a!.id));
  const busy = setRole.isPending || setKind.isPending || remove.isPending || retry.isPending;
  const mail = mailState(a, hostedMail);
  const key = m.email || m.userId;

  return (
    <tr data-testid={`member-${key}`} className="border-b border-hairline last:border-0">
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2.5">
          {m.avatarUrl ? (
            <img src={m.avatarUrl} alt="" className="size-8 rounded-lg object-cover" />
          ) : (
            <span className="flex size-8 items-center justify-center rounded-lg bg-panel text-xs font-semibold text-muted">{m.displayName.slice(0, 1).toUpperCase()}</span>
          )}
          <div className="min-w-0">
            <div className="truncate font-medium">
              {m.displayName}
              {m.isAgent && <span title="AI agent"> 🤖</span>}
              {isSelf && <span className="text-faint"> (you)</span>}
            </div>
            <div className="truncate text-xs text-muted">{m.email}</div>
            {a && (
              <div className="truncate text-xs text-faint" data-testid={`address-${key}`}>
                {a.kind === 'guest' ? 'guest' : a.address}
              </div>
            )}
          </div>
        </div>
      </td>
      <td className="px-3 py-2.5">
        {locked || personal ? (
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${isOwner ? 'bg-primary-tint text-primary-deep' : 'bg-panel text-muted'}`}>{m.role}</span>
        ) : (
          <Select
            value={m.role as Exclude<MemberRole, 'owner'>}
            disabled={busy}
            options={[
              { value: 'admin', label: 'Admin' },
              { value: 'member', label: 'Member' },
            ]}
            onChange={(v) => setRole.mutate(v)}
            testid={`role-${key}`}
          />
        )}
      </td>
      <td className="px-3 py-2.5">
        {personal ? (
          <span className="text-xs text-muted" data-testid={`kind-${key}`}>
            {assistant ? 'Assistant' : 'Personal agent'}
            {sponsorName && <span className="text-faint"> · of {sponsorName}</span>}
          </span>
        ) : !a ? (
          <span className="text-xs text-faint">—</span>
        ) : isOwner || m.isAgent ? (
          <span className="text-xs text-muted" data-testid={`kind-${key}`}>
            Native
          </span>
        ) : (
          <Select
            value={(m.kind ?? a.kind) as AccountKind}
            disabled={busy}
            options={[
              { value: 'native', label: 'Native' },
              { value: 'guest', label: 'Guest' },
            ]}
            onChange={(v) => setKind.mutate(v)}
            testid={`kind-${key}`}
          />
        )}
      </td>
      {hostedMail && (
        <td className="px-3 py-2.5">
          {mail && (
            <span className={`text-xs ${mail.tone === 'ok' ? 'text-ok' : mail.tone === 'warn' ? 'text-warn' : 'text-muted'}`} data-testid={`mail-${key}`}>
              {mail.text}
            </span>
          )}
        </td>
      )}
      <td className="px-3 py-2.5 text-right">
        <div className="flex flex-wrap items-center justify-end gap-2">
          {mail?.retry && a && (
            <Button disabled={busy} onClick={() => retry.mutate(undefined)} testid={`retry-${key}`}>
              {retry.isPending ? 'Sending…' : a.statusMessage ? 'Retry setup' : 'Set up'}
            </Button>
          )}
          {locked ? null : confirming ? (
            <Confirm question={`Remove ${m.displayName}?`} busy={busy} onYes={() => remove.mutate(undefined)} onNo={() => setConfirming(false)} testid={`remove-confirm-${key}`} />
          ) : (
            <Button kind="link" disabled={busy} onClick={() => setConfirming(true)} testid={`remove-${key}`}>
              Remove
            </Button>
          )}
        </div>
        <ErrorLine error={error} testid={`error-${key}`} />
      </td>
    </tr>
  );
}

/** The two actions over everyone (as Chat's Manage users had them): mailboxes for every native account, and every
 * member (not owners, admins or agents) made a guest. */
function Bulk({ org, hostedMail, accounts, onChanged }: { org: WorkspaceDTO; hostedMail: boolean; accounts: AccountDTO[] | undefined; onChanged(): Promise<unknown> }) {
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState<number | null>(null);
  const [guested, setGuested] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const live = (accounts ?? []).filter((a) => a.state !== 'removed' && a.state !== 'suspended');
  const natives = live.filter((a) => a.kind === 'native').length;
  const nativeMembers = live.filter((a) => a.kind === 'native' && a.role === 'member').length;
  const provision = useMutation({
    mutationFn: () => adminApi.provisionAll(org.id),
    onMutate: () => setError(null),
    onSuccess: async (out) => {
      setQueued(out.queued);
      await onChanged();
    },
    onError: (e) => setError(errorText(e)),
  });
  const guests = useMutation({
    mutationFn: () => adminApi.makeMembersGuests(org.id),
    onMutate: () => setError(null),
    onSuccess: async (out) => {
      setGuested(out.changed);
      setConfirming(false);
      await onChanged();
    },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <div className="flex flex-col gap-2 border-t border-hairline pt-3 text-sm">
      {hostedMail && (
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={provision.isPending} onClick={() => provision.mutate()} testid="provision-all">
            Set up mailboxes for everyone
          </Button>
          {accounts && (
            <span className="text-xs text-muted" data-testid="provision-count">
              {natives} native {natives === 1 ? 'account' : 'accounts'}; guests get none
            </span>
          )}
          {queued !== null && <span className="text-xs text-muted">{queued === 0 ? 'Everyone has a mailbox.' : `Setting up ${queued} ${queued === 1 ? 'mailbox' : 'mailboxes'}.`}</span>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {confirming ? (
          <Confirm question={`Make ${nativeMembers} ${nativeMembers === 1 ? 'member' : 'members'} guests? Their mailboxes are suspended. Owners, admins and agents keep theirs.`} busy={guests.isPending} onYes={() => guests.mutate()} onNo={() => setConfirming(false)} testid="guests-confirm" />
        ) : (
          <Button disabled={guests.isPending} onClick={() => { setGuested(null); setConfirming(true); }} testid="guests-all">
            Make every member a guest
          </Button>
        )}
        {guested !== null && <span className="text-xs text-muted">{guested === 0 ? 'Every member was a guest already.' : `${guested} ${guested === 1 ? 'member is' : 'members are'} now ${guested === 1 ? 'a guest' : 'guests'}.`}</span>}
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

const parseEmails = (text: string) => [...new Set(text.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean))];

const STATUS_TEXT: Record<InviteResultDTO['status'], string> = {
  sent: 'invited',
  resent: 'invited again',
  already_member: 'already a member',
  invalid_email: 'not an email address',
  email_failed: 'invited, but the email could not be sent',
};

type AddMode = 'invite' | 'create';

/** The ways in, one card: invite people by their own email (as members or chat guests), or create a member with an address
 * on the organization's domain. */
function AddPeople({ org, onInvited, onCreated }: { org: WorkspaceDTO; onInvited(): void; onCreated(): Promise<unknown> }) {
  const [mode, setMode] = useState<AddMode>('invite');
  const tabs: { id: AddMode; label: string }[] = [
    { id: 'invite', label: 'Invite by email' },
    { id: 'create', label: 'Create member' },
  ];
  return (
    <Card title="Add people" testid="card-invite">
      <div className="flex gap-1 rounded-lg bg-panel p-1 text-sm self-start" role="tablist" aria-label="How to add people">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={mode === t.id} className={`rounded-md px-3 py-1 ${mode === t.id ? 'bg-white font-semibold shadow-sm' : 'text-muted hover:text-ink'}`} onClick={() => setMode(t.id)} data-testid={`add-${t.id}`}>
            {t.label}
          </button>
        ))}
      </div>
      {mode === 'invite' ? <Invite org={org} onInvited={onInvited} /> : <CreateMember org={org} onCreated={onCreated} />}
    </Card>
  );
}

/** A username from a display name, until the admin types one: "Bea Lin" → "bea.lin". The server checks it. */
export const suggestUsername = (name: string) =>
  name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9]+/).filter(Boolean).join('.').slice(0, 64);

/** Create member: a native account at username@domain, right away, with no password; the setup link (a week) goes to the
 * backup email, which "Forgot password" reaches too. */
function CreateMember({ org, onCreated }: { org: WorkspaceDTO; onCreated(): Promise<unknown> }) {
  const domains = useQuery({ queryKey: ['domains', org.id], queryFn: () => adminApi.domains(org.id) });
  const usable = (domains.data ?? []).filter((d) => d.verified).sort((a, b) => Number(b.primary) - Number(a.primary));
  const primary = usable.find((d) => d.primary)?.domain ?? usable[0]?.domain ?? '';
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [typedUsername, setTypedUsername] = useState(false);
  const [domain, setDomain] = useState('');
  const [backupEmail, setBackupEmail] = useState('');
  const [done, setDone] = useState<CreateMemberResultDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chosenDomain = domain || primary;
  const shownUsername = typedUsername ? username : suggestUsername(displayName);
  const create = useMutation({
    mutationFn: () => adminApi.createMember(org.id, { displayName: displayName.trim(), username: shownUsername.trim(), domain: chosenDomain, backupEmail: backupEmail.trim() }),
    onMutate: () => {
      setError(null);
      setDone(null);
    },
    onSuccess: async (out) => {
      setDone(out);
      setDisplayName('');
      setUsername('');
      setTypedUsername(false);
      setBackupEmail('');
      await onCreated();
    },
    onError: (e) => setError(errorText(e)),
  });
  const ready = !!displayName.trim() && !!shownUsername.trim() && !!chosenDomain && !!backupEmail.trim();
  const input = 'w-full rounded-md border border-border px-2 py-1 text-sm disabled:opacity-50';
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) create.mutate();
      }}
      data-testid="create-member"
    >
      <p className="text-xs text-muted">Creates a member with an address on your domain. They get no password yet: a setup link, good for 7 days, goes to their backup email.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Display name</span>
          <input className={input} value={displayName} disabled={create.isPending} onChange={(e) => setDisplayName(e.target.value)} placeholder="Bea Lin" autoComplete="off" data-testid="create-name" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Backup email</span>
          <input className={input} type="email" value={backupEmail} disabled={create.isPending} onChange={(e) => setBackupEmail(e.target.value)} placeholder="bea@gmail.com" autoComplete="off" data-testid="create-backup" />
          <span className="text-xs text-muted">Outside your domain. The setup link and password resets go here.</span>
        </label>
        <div className="flex flex-col gap-1 text-sm sm:col-span-2">
          <span className="font-medium">Sign-in address</span>
          <div className="flex items-center gap-1">
            <input
              className={`${input} min-w-0 flex-1`}
              aria-label="Username"
              value={shownUsername}
              disabled={create.isPending}
              onChange={(e) => {
                setTypedUsername(true);
                setUsername(e.target.value.replace(/@.*$/, '').toLowerCase());
              }}
              placeholder="bea.lin"
              autoComplete="off"
              data-testid="create-username"
            />
            <span className="text-muted">@</span>
            {usable.length > 1 ? (
              <Select value={chosenDomain} disabled={create.isPending} options={usable.map((d) => ({ value: d.domain, label: d.domain }))} onChange={setDomain} testid="create-domain" />
            ) : (
              <span className="rounded-md bg-panel px-2 py-1 text-sm" data-testid="create-domain">
                {chosenDomain || '…'}
              </span>
            )}
          </div>
          <span className="text-xs text-muted">Letters, digits, dots, hyphens and underscores. Verified domains only; the primary one is first.</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button kind="primary" type="submit" disabled={create.isPending || !ready} testid="create-submit">
          {create.isPending ? 'Creating…' : 'Create member'}
        </Button>
        {done && (
          <span className={`text-xs ${done.emailSent ? 'text-ok' : 'text-warn'}`} data-testid="create-done">
            {done.emailSent
              ? `Created ${done.account.address}. A setup link went to ${done.pending?.backupEmail}.`
              : `Created ${done.account.address}, but the setup email could not be sent. Use Resend setup link below.`}
          </span>
        )}
      </div>
      {domains.isError && <ErrorLine error={errorText(domains.error)} />}
      <ErrorLine error={error} testid="create-error" />
    </form>
  );
}

/** Invite people (native members) or chat guests (§3.2, §6.5): the same addresses box, two buttons. */
function Invite({ org, onInvited }: { org: WorkspaceDTO; onInvited(): void }) {
  const [text, setText] = useState('');
  const [results, setResults] = useState<InviteResultDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const emails = parseEmails(text);
  const send = useMutation({
    mutationFn: (kind: AccountKind) => adminApi.invite(org.id, emails, kind),
    onMutate: () => setError(null),
    onSuccess: (out) => {
      setResults(out);
      // Only what failed stays in the box, so a retry does not send the rest again.
      setText(out.filter((r) => r.status === 'invalid_email' || r.status === 'email_failed').map((r) => r.email).join(', '));
      onInvited();
    },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <>
      <p className="text-xs text-muted">Separate addresses with commas. Each person gets an email with a link and joins with that address.</p>
      <textarea className="w-full rounded-md border border-border px-2 py-1 text-sm" rows={2} placeholder="email@example.com, someone@example.com" value={text} disabled={send.isPending} onChange={(e) => setText(e.target.value)} data-testid="invite-emails" />
      <div className="flex flex-wrap items-center gap-3">
        <Button kind="primary" disabled={send.isPending || emails.length === 0} onClick={() => send.mutate('native')} testid="invite-people">
          {emails.length > 1 ? `Invite ${emails.length} people` : 'Invite people'}
        </Button>
        <Button disabled={send.isPending || emails.length === 0} onClick={() => send.mutate('guest')} testid="invite-guests">
          {emails.length > 1 ? `Invite ${emails.length} as chat guests` : 'Invite a chat guest'}
        </Button>
        <span className="text-xs text-muted">Guests use Chat only. They get no address and no mailbox here.</span>
      </div>
      {results && (
        <ul className="divide-y divide-hairline rounded-lg border border-hairline text-sm" data-testid="invite-results">
          {results.map((r) => (
            <li key={r.email} className="flex items-center justify-between gap-3 px-3 py-1.5">
              <span className="truncate">{r.email}</span>
              <span className={`text-xs ${r.status === 'invalid_email' || r.status === 'email_failed' ? 'text-warn' : 'text-muted'}`}>
                {STATUS_TEXT[r.status]}
                {r.kind === 'guest' && (r.status === 'sent' || r.status === 'resent') ? ' as a chat guest' : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      <ErrorLine error={error} testid="invite-error" />
    </>
  );
}

/** Everyone on their way in: created members who have not set a password (with Resend), and open invitations. */
function Pending({ org }: { org: WorkspaceDTO }) {
  const setups = useQuery({ queryKey: ['setups', org.id], queryFn: () => adminApi.pendingSetups(org.id) });
  const invites = useQuery({ queryKey: ['invites', org.id], queryFn: () => adminApi.invites(org.id) });
  if (setups.isSuccess && invites.isSuccess && setups.data.length === 0 && invites.data.length === 0) return null;
  return (
    <Card title="Pending" testid="card-invites">
      <PendingSetups org={org} list={setups.data ?? []} error={setups.isError ? errorText(setups.error) : null} />
      <PendingInvites org={org} />
    </Card>
  );
}

function PendingSetups({ org, list, error: loadError }: { org: WorkspaceDTO; list: PendingSetupDTO[]; error: string | null }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [resent, setResent] = useState<string | null>(null);
  const resend = useMutation({
    mutationFn: (accountId: string) => adminApi.resendSetupLink(org.id, accountId),
    onMutate: () => {
      setError(null);
      setResent(null);
    },
    onSuccess: (p) => {
      setResent(p.accountId);
      void qc.invalidateQueries({ queryKey: ['setups', org.id] });
    },
    onError: (e) => setError(errorText(e)),
  });
  if (!list.length && !loadError) return null;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold text-faint uppercase">Waiting to set a password</h3>
      {loadError && <ErrorLine error={loadError} />}
      <ul className="divide-y divide-hairline rounded-lg border border-hairline text-sm">
        {list.map((p) => (
          <li key={p.accountId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2" data-testid={`setup-${p.address}`}>
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">{p.displayName}</span> <span className="text-muted">{p.address}</span>
            </span>
            <span className="text-xs text-muted">link to {p.backupEmail}</span>
            <span className={`text-xs ${p.linkExpiresAt ? 'text-muted' : 'text-warn'}`}>{resent === p.accountId ? 'sent again' : p.linkExpiresAt ? `expires ${new Date(p.linkExpiresAt).toLocaleDateString()}` : 'link expired'}</span>
            <Button kind="link" disabled={resend.isPending} onClick={() => resend.mutate(p.accountId)} testid={`resend-${p.address}`}>
              {resend.isPending && resend.variables === p.accountId ? 'Sending…' : 'Resend setup link'}
            </Button>
          </li>
        ))}
      </ul>
      <ErrorLine error={error} />
    </div>
  );
}

function PendingInvites({ org }: { org: WorkspaceDTO }) {
  const qc = useQueryClient();
  const key = ['invites', org.id];
  const invites = useQuery({ queryKey: key, queryFn: () => adminApi.invites(org.id) });
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const revoke = useMutation({
    mutationFn: (inviteId: string) => adminApi.revokeInvite(org.id, inviteId),
    onMutate: () => setError(null),
    onSuccess: () => {
      setConfirming(null);
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => setError(errorText(e)),
  });
  const list = invites.data ?? [];
  if (invites.isSuccess && list.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold text-faint uppercase">Invitations</h3>
      {invites.isError && <ErrorLine error={errorText(invites.error)} />}
      {list.length > 0 && (
        <ul className="divide-y divide-hairline rounded-lg border border-hairline text-sm">
          {list.map((i: WorkspaceInviteDTO) => (
            <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2" data-testid={`invite-${i.email}`}>
              <span className="min-w-0 flex-1 truncate">{i.email}</span>
              <span className="text-xs text-muted">{i.kind === 'guest' ? 'chat guest' : 'member'}</span>
              <span className="text-xs text-muted">
                by {i.invitedBy.displayName}, {new Date(i.createdAt).toLocaleDateString()}
              </span>
              {confirming === i.id ? (
                <Confirm question="Revoke? The link stops working." busy={revoke.isPending} onYes={() => revoke.mutate(i.id)} onNo={() => setConfirming(null)} testid={`revoke-confirm-${i.email}`} />
              ) : (
                <Button kind="link" disabled={revoke.isPending} onClick={() => setConfirming(i.id)} testid={`revoke-${i.email}`}>
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ErrorLine error={error} />
    </div>
  );
}
