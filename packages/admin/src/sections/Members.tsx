// Members (docs/specs/workspace-admin.md §3.2 and §5): one Add member button (a dialog for a user or an agent, AddMember.tsx),
// and the roster, one line per member: name, email, role, kind and actions, with the pending invitations and setups below
// it. Every change saves at once; a destructive one confirms inline.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccountDTO, AccountKind, AgentInviteDTO, MemberRole, PendingSetupDTO, WorkspaceDTO, WorkspaceInviteDTO, WorkspaceMemberDTO } from '@flow/shared';
import { Plus } from 'lucide-react';
import { adminApi } from '../api';
import { suite } from '../suite';
import { tellHome } from '@flow/suite-bar';
import { Button, Card, Confirm, ErrorLine, Select } from '../components/ui';
import { AddMemberModal, ConnectAgentModal, type Added } from './AddMember';

export { suggestUsername } from './AddMember';

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
  // A person where people get no hosted address (platform.md §3.2): their own linked mailbox, or none.
  if (!a.address && !a.agentMode) return { text: a.linkedAddress ? 'linked' : 'none', tone: 'muted', retry: false };
  if (a.state !== 'active') return { text: 'being set up', tone: 'muted', retry: false };
  return { text: 'no mailbox yet', tone: 'muted', retry: true };
}

const needsAttention = (a: AccountDTO | undefined) => !!a && a.kind === 'native' && (a.state !== 'active' || !!a.statusMessage);

/** The Kind column's word for a member (agents.md §1, §2): a person, a guest, a shared agent hosted here or connected
 * from elsewhere, or a person's own agent (private and hosted here, their assistant included, or connected over MCP). */
export function kindLabel(m: WorkspaceMemberDTO, a: AccountDTO | undefined): string {
  const hosted = (m.agentRuntime ?? a?.agentRuntime) === 'hosted';
  // A private hosted agent (a person's assistant among them, agents.md §1.3), or one the person connected over MCP.
  if (m.kind === 'personal_agent' || a?.kind === 'personal_agent') return hosted ? 'Private agent' : 'Personal agent';
  if (m.isAgent) return hosted ? 'Agent' : 'External agent';
  if ((m.kind ?? a?.kind) === 'guest') return 'Guest';
  return 'Person';
}

/** An address a person can write to: never an agent's synthetic sign-in (`agent-<id>@agents.flow.local`) or a hidden one. */
export const visibleEmail = (e: string | null | undefined): string | null => (e && !/@(agents\.flow\.local|hidden\.invalid)$/i.test(e) ? e : null);

export function Members({ org }: { org: WorkspaceDTO }) {
  const qc = useQueryClient();
  const config = useQuery({ queryKey: ['config'], queryFn: adminApi.config, staleTime: Infinity });
  const hostedMail = !!config.data?.hostedMail;
  const me = useQuery({ queryKey: ['suite', 'me'], queryFn: suite.me });
  // While an external agent's connection steps are open, the roster is re-read, so the agent appears when it connects;
  // and for a while after a mailbox is sent to be made, which happens on the provisioning queue, so its state follows.
  const [connecting, setConnecting] = useState<{ name: string; invite: AgentInviteDTO } | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  useEffect(() => {
    if (!provisioning) return;
    const t = setTimeout(() => setProvisioning(false), 30_000);
    return () => clearTimeout(t);
  }, [provisioning]);
  const poll = connecting ? 3000 : provisioning ? 2000 : false;
  const members = useQuery({ queryKey: ['members', org.id], queryFn: () => adminApi.members(org.id), refetchInterval: poll });
  const accounts = useQuery({ queryKey: ['accounts', org.id], queryFn: () => adminApi.accounts(org.id), refetchInterval: poll });
  const refresh = useCallback(() => {
    tellHome('members');
    return Promise.all([qc.invalidateQueries({ queryKey: ['members', org.id] }), qc.invalidateQueries({ queryKey: ['accounts', org.id] })]);
  }, [qc, org.id]);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<Added | null>(null);
  const onAdded = async (a: Added) => {
    setAdded(a);
    await Promise.all([refresh(), qc.invalidateQueries({ queryKey: ['setups', org.id] }), qc.invalidateQueries({ queryKey: ['invites', org.id] })]);
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
  const nameOf = (id: string | null | undefined) => (id ? roster.find((x) => x.userId === id)?.displayName : undefined);

  return (
    <>
      <div className="flex min-h-8 items-center gap-3" data-testid="members-top">
        <Button kind="primary" onClick={() => setAdding(true)} testid="add-member">
          <span className="inline-flex items-center gap-1">
            <Plus className="size-4" aria-hidden="true" />
            Add member
          </span>
        </Button>
        {added && (
          <span className={`min-w-0 truncate text-xs ${added.tone === 'ok' ? 'text-ok' : 'text-warn'}`} title={added.message} data-testid="add-done">
            {added.message}
          </span>
        )}
      </div>
      <Card title="Members" testid="card-members">
        <div className="flex flex-wrap items-center gap-2 text-xs" role="tablist" aria-label="Filter">
          {FILTERS.map((f) => {
            const n = f.id === 'attention' ? counts.attention : f.id === 'guests' ? counts.guests : null;
            if (f.id === 'attention' && n === 0) return null;
            return (
              <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} className={`rounded-full px-2.5 py-0.5 ${filter === f.id ? 'bg-primary text-white' : 'bg-panel text-muted hover:bg-hover'}`} onClick={() => setFilter(f.id)} data-testid={`filter-${f.id}`}>
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
          <table className="w-full min-w-[720px] table-fixed text-sm">
            <colgroup>
              <col className="w-[24%]" />
              <col className="w-[29%]" />
              <col className="w-[96px]" />
              <col />
              <col className="w-[76px]" />
            </colgroup>
            <thead>
              <tr className="border-b border-hairline bg-panel text-left text-xs text-faint uppercase">
                <th className="px-3 py-1.5 font-semibold">Name</th>
                <th className="px-3 py-1.5 font-semibold">Email</th>
                <th className="px-3 py-1.5 font-semibold">Role</th>
                <th className="px-3 py-1.5 font-semibold" title="A person has an address and a mailbox; a guest has neither and uses Chat only">Kind</th>
                <th className="px-3 py-1.5 text-right font-semibold">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((m) => (
                <MemberRow key={m.userId} org={org} member={m} account={accountOf(m)} sponsorName={nameOf(m.sponsorId ?? accountOf(m)?.sponsorId)} meId={me.data?.id} hostedMail={hostedMail} fresh={added?.userId === m.userId} onChanged={refresh} onProvisioned={() => setProvisioning(true)} />
              ))}
              {members.isSuccess && shown.length === 0 && (
                <tr>
                  <td className="px-3 py-3 text-sm text-muted" colSpan={5}>
                    Nobody here.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pending org={org} />
        <Bulk org={org} hostedMail={hostedMail} accounts={accounts.data} onChanged={refresh} />
      </Card>
      {adding && <AddMemberModal org={org} onClose={() => setAdding(false)} onAdded={onAdded} onExternal={(name, invite) => { setAdded(null); setConnecting({ name, invite }); }} />}
      {connecting && (
        <ConnectAgentModal
          name={connecting.name}
          invite={connecting.invite}
          onClose={() => {
            setConnecting(null);
            void refresh();
          }}
        />
      )}
    </>
  );
}

/** The Email column: the member's address here, else (a person) their sign-in email, with the mailbox's state beside it
 * when it is not ready: Create inbox for an agent with none (or whose setup stopped), Set up or Retry for a person. */
function EmailCell({ m, a, hostedMail, keyId, busy, queued, onProvision }: { m: WorkspaceMemberDTO; a: AccountDTO | undefined; hostedMail: boolean; keyId: string; busy: boolean; queued: boolean; onProvision(): void }) {
  const mail = mailState(a, hostedMail);
  const shownEmail = a?.address ?? a?.linkedAddress ?? (m.isAgent ? null : visibleEmail(m.email));
  const action = 'shrink-0 text-xs text-primary hover:underline disabled:opacity-50';
  if (m.isAgent) {
    // A shared agent is native, and gets its inbox when it is made (decision_log 2026-11-09); one without (provisioning
    // stopped, or none was set up) gets it here, through the same route as Set up mailboxes (§5).
    const mayCreate = hostedMail && !queued && !!a && a.kind === 'native' && !a.hosted && a.state !== 'suspended' && a.state !== 'removed' && (a.state === 'active' || !!a.statusMessage);
    const settingUp = hostedMail && !!a && a.kind === 'native' && !a.hosted && !mayCreate && a.state !== 'suspended';
    return (
      <div className="flex min-w-0 items-center gap-2" data-testid={`email-${keyId}`}>
        {shownEmail ? (
          <span className={`truncate ${a?.hosted || !hostedMail ? '' : 'text-muted'}`} title={shownEmail} data-testid={`address-${keyId}`}>
            {shownEmail}
          </span>
        ) : (
          <span className="truncate text-xs text-faint" title={a?.agentRuntime === 'hosted' ? 'A private agent acts as its person and has no inbox of its own; a person’s assistant gets one when its person names it (Admin › Assistant).' : 'A personal agent acts as its person and has no address of its own.'} data-testid={`address-${keyId}`}>
            No inbox
          </span>
        )}
        {mayCreate && (
          <button type="button" className={action} disabled={busy} onClick={onProvision} title={a?.statusMessage ? `The last setup stopped: ${a.statusMessage}` : 'Make its mailbox and calendar'} data-testid={`create-inbox-${keyId}`}>
            {busy ? 'Creating…' : 'Create inbox'}
          </button>
        )}
        {settingUp && (
          <span className="shrink-0 text-xs text-faint" data-testid={`mail-${keyId}`}>
            setting up…
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-2" data-testid={`email-${keyId}`}>
      <span className="truncate" title={shownEmail ?? undefined} data-testid={`address-${keyId}`}>
        {shownEmail ?? <span className="text-faint">—</span>}
      </span>
      {mail && mail.text !== 'ready' && mail.text !== '—' && (
        <span className={`shrink-0 text-xs ${mail.tone === 'warn' ? 'text-warn' : 'text-faint'}`} title={mail.text} data-testid={`mail-${keyId}`}>
          {mail.tone === 'warn' ? 'stopped' : mail.text}
        </span>
      )}
      {mail?.retry && !queued && (
        <button type="button" className={action} disabled={busy} onClick={onProvision} data-testid={`retry-${keyId}`}>
          {busy ? 'Sending…' : a?.statusMessage ? 'Retry' : 'Set up'}
        </button>
      )}
    </div>
  );
}

function MemberRow({ org, member: m, account: a, sponsorName, meId, hostedMail, fresh, onChanged, onProvisioned }: { org: WorkspaceDTO; member: WorkspaceMemberDTO; account: AccountDTO | undefined; sponsorName: string | undefined; meId: string | undefined; hostedMail: boolean; fresh: boolean; onChanged(): Promise<unknown>; onProvisioned(): void }) {
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
  const retry = act(async () => {
    await adminApi.provisionOne(org.id, a!.id);
    onProvisioned();
  });
  // Sent to be made: "setting up…" until the account says its mailbox is there (or the run stops again).
  const queued = retry.isSuccess && !!a && !a.hosted;
  const busy = setRole.isPending || setKind.isPending || remove.isPending || retry.isPending;
  const key = m.email || m.userId;
  const kind = kindLabel(m, a);
  const sponsor = m.isAgent && sponsorName ? `of ${sponsorName}` : null;
  const cell = 'px-3 py-1.5 align-middle';

  return (
    <tr data-testid={`member-${key}`} className={`border-b border-hairline last:border-0 ${fresh ? 'bg-selected-blue' : ''}`}>
      <td className={cell}>
        <div className="flex min-w-0 items-center gap-2">
          {m.avatarUrl ? (
            <img src={m.avatarUrl} alt="" className="size-6 shrink-0 rounded-md object-cover" />
          ) : (
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-panel text-[11px] font-semibold text-muted">{m.displayName.slice(0, 1).toUpperCase()}</span>
          )}
          <span className="truncate font-medium" title={m.displayName}>
            {m.displayName}
          </span>
          {isSelf && <span className="shrink-0 text-xs text-faint">(you)</span>}
        </div>
      </td>
      <td className={cell}>
        <EmailCell m={m} a={a} hostedMail={hostedMail} keyId={key} busy={retry.isPending} queued={queued} onProvision={() => retry.mutate(undefined)} />
      </td>
      <td className={cell}>
        {locked || personal ? (
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${isOwner ? 'bg-primary-tint text-primary-deep' : 'bg-panel text-muted'}`} data-testid={`role-${key}`}>
            {m.role}
          </span>
        ) : (
          <Select
            compact
            label={`Role of ${m.displayName}`}
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
      <td className={cell}>
        {!a || isOwner || m.isAgent || personal ? (
          <div className="flex min-w-0 items-baseline gap-1 text-xs whitespace-nowrap" title={sponsor ? `${kind} ${sponsor}` : kind}>
            <span className="shrink-0 text-muted" data-testid={`kind-${key}`}>
              {kind}
            </span>
            {sponsor && (
              <span className="truncate text-faint" data-testid={`sponsor-${key}`}>
                {sponsor}
              </span>
            )}
          </div>
        ) : (
          <Select
            compact
            label={`Kind of ${m.displayName}`}
            value={(m.kind ?? a.kind) as AccountKind}
            disabled={busy}
            options={[
              { value: 'native', label: 'Person' },
              { value: 'guest', label: 'Guest' },
            ]}
            onChange={(v) => setKind.mutate(v)}
            testid={`kind-${key}`}
          />
        )}
      </td>
      <td className={`${cell} relative text-right`}>
        <div className="flex items-center justify-end gap-2 whitespace-nowrap">
          {locked ? null : confirming ? (
            // Over the row's end, so the confirmation does not widen the column.
            <span className="absolute inset-y-0 right-0 z-10 flex w-max items-center bg-white pr-3 pl-3 shadow-[-8px_0_8px_white]">
              <Confirm question={`Remove ${m.displayName}?`} busy={busy} onYes={() => remove.mutate(undefined)} onNo={() => setConfirming(false)} testid={`remove-confirm-${key}`} />
            </span>
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

/** Everyone on their way in, below the roster: created members who have not set a password (with Resend), and open invitations. */
function Pending({ org }: { org: WorkspaceDTO }) {
  const setups = useQuery({ queryKey: ['setups', org.id], queryFn: () => adminApi.pendingSetups(org.id) });
  const invites = useQuery({ queryKey: ['invites', org.id], queryFn: () => adminApi.invites(org.id) });
  if (setups.isSuccess && invites.isSuccess && setups.data.length === 0 && invites.data.length === 0) return null;
  return (
    <div className="flex flex-col gap-3" data-testid="card-invites">
      <PendingSetups org={org} list={setups.data ?? []} error={setups.isError ? errorText(setups.error) : null} />
      <PendingInvites org={org} />
    </div>
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
