import { useBoundApi } from '../lib/useBoundApi';
// Admin panel (owner/admin, web-only per operator ruling — like Apps/Agents).
// A virtual content-pane view (not a real channel) reached from the workspace
// menu's "Manage Users…" and pinned into the sidebar as the "Manage users" row.
// Lists workspace members and lets owners/admins change roles and remove people.
// Its Automations tab (platform.md §5.2) is open to every member: the workspace
// menu's "Automations…" opens the panel on it.
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { WORKSPACE_POLICY_DEFAULTS, type AccountDTO, type AccountKind, type BulkAccountKindResult, type MemberRole, type WorkspaceDTO, type WorkspaceMemberDTO, type WorkspacePolicies } from '@flow/shared';
import { publicConfig } from '../lib/google';
import { useAuth, useSelection } from '../state';
import { useChannels, useMembers, useWorkspaces } from '../hooks';
import { AutomationsSection } from './AutomationsSection';
import { Avatar } from './Avatar';
import { MobileMenuButton } from './MobileMenuButton';

export type AdminTab = 'organization' | 'automations';
const ADMIN_TAB_EVENT = 'flow:admin-tab';
let requestedTab: AdminTab | null = null;

/** Ask the admin panel to show a tab: on its next mount, or now if it is open. */
export function requestAdminTab(tab: AdminTab) {
  requestedTab = tab;
  window.dispatchEvent(new CustomEvent(ADMIN_TAB_EVENT, { detail: tab }));
}

export default function AdminView() {
  const auth = useAuth();
  const sel = useSelection();
  const workspaces = useWorkspaces();
  const members = useMembers(sel.workspaceId);
  const channels = useChannels(sel.workspaceId);
  const { api } = useBoundApi();
  const [tab, setTab] = useState<AdminTab>(() => requestedTab ?? 'organization');
  // Whether accounts get hosted mailboxes here (platform.md §3.4): the Organization tab's "Set up mailboxes" then shows.
  const [hostedMail, setHostedMail] = useState(false);
  useEffect(() => {
    let live = true;
    publicConfig().then((c) => live && setHostedMail(!!c.hostedMail), () => {});
    return () => { live = false; };
  }, []);

  useEffect(() => {
    requestedTab = null;
    const on = (e: Event) => {
      setTab((e as CustomEvent<AdminTab>).detail);
      requestedTab = null;
    };
    window.addEventListener(ADMIN_TAB_EVENT, on);
    return () => window.removeEventListener(ADMIN_TAB_EVENT, on);
  }, []);

  const ws = (workspaces.data ?? []).find((w) => w.id === sel.workspaceId);
  const isAdmin = ws?.role === 'owner' || ws?.role === 'admin';
  // Each member's account (platform.md §3.3): its kind, native or guest, and its address. Owners and admins only.
  const accounts = useQuery({
    queryKey: ['accounts', sel.workspaceId],
    queryFn: () => api<{ accounts: AccountDTO[] }>('GET', `/v1/workspaces/${sel.workspaceId}/accounts`),
    select: (d) => d.accounts,
    enabled: isAdmin && sel.workspaceId !== null,
  });
  const accountOf = (m: WorkspaceMemberDTO) => (accounts.data ?? []).find((a) => a.principalId === m.userId);
  // Members who are not admins see only Automations.
  const shown: AdminTab = isAdmin ? tab : 'automations';
  const roster = (members.data ?? []).slice().sort((a, b) => {
    // Owner first, then admins, then members; alphabetical within a rank.
    const rank = (r: MemberRole) => (r === 'owner' ? 0 : r === 'admin' ? 1 : 2);
    return rank(a.role) - rank(b.role) || a.displayName.localeCompare(b.displayName);
  });

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-base">
      <header className="flex h-[60px] shrink-0 items-center justify-between border-b border-hairline px-[22px] max-md:px-3">
        <MobileMenuButton />
        <div className="min-w-0 flex-1">
          <h2 data-testid="admin-header" className="truncate text-[15px] font-bold">
            {shown === 'automations' ? '⚡ Automations' : '🛡️ Manage users'}
          </h2>
          <p className="truncate text-xs text-muted">
            {ws?.name ?? 'Workspace'} {shown === 'automations' ? 'automations' : <>members &amp; roles</>}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            data-testid="admin-close"
            className="text-sm text-muted hover:text-ink hover:underline"
            onClick={() => sel.closeAdminPanel()}
          >
            Close
          </button>
        </div>
      </header>

      <div className="mc-scroll min-h-0 flex-1 overflow-y-auto px-[22px] py-5">
        {isAdmin && (
          <div role="tablist" className="mx-auto mb-4 flex max-w-3xl gap-1 border-b border-hairline text-sm">
            {(['organization', 'automations'] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={shown === t}
                data-testid={`admin-tab-${t}`}
                className={`-mb-px border-b-2 px-3 py-1.5 ${shown === t ? 'border-accent font-semibold text-ink' : 'border-transparent text-muted hover:text-ink'}`}
                onClick={() => setTab(t)}
              >
                {t === 'organization' ? 'Organization' : 'Automations'}
              </button>
            ))}
          </div>
        )}
        {shown === 'automations' ? (
          sel.workspaceId && (
            <div className="mx-auto max-w-3xl">
              <AutomationsSection workspaceId={sel.workspaceId} members={members.data ?? []} channels={channels.data ?? []} />
            </div>
          )
        ) : (
          <div className="mx-auto max-w-3xl">
            {ws && <OrganizationSection ws={ws} roster={roster} meId={auth.user.id} hostedMail={hostedMail} accounts={accounts.data} />}
            <p className="mb-4 text-sm text-muted">
              {roster.length} {roster.length === 1 ? 'member' : 'members'}. Owners and admins can change
              roles and remove people. The workspace owner can't be changed or removed.
            </p>
            <div className="overflow-hidden rounded-lg border border-hairline">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-hairline bg-daypill/40 text-left text-xs text-faint uppercase">
                    <th className="px-3 py-2 font-semibold">Member</th>
                    <th className="px-3 py-2 font-semibold">Role</th>
                    <th className="px-3 py-2 font-semibold" title="Native accounts have an address and a mailbox; guests have neither">Kind</th>
                    <th className="px-3 py-2 text-right font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {roster.map((m) => (
                    <MemberRow key={m.userId} member={m} meId={auth.user.id} workspaceId={sel.workspaceId!} account={accountOf(m)} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

export function MemberRow({
  member,
  meId,
  workspaceId,
  account,
}: {
  member: WorkspaceMemberDTO;
  meId: string;
  workspaceId: string;
  /** The member's account here (GET /v1/workspaces/:id/accounts), once loaded. */
  account?: AccountDTO | undefined;
}) {
  const { api } = useBoundApi();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isOwner = member.role === 'owner';
  const isSelf = member.userId === meId;
  // Owner is immutable; you can't act on yourself (no self-lockout).
  const locked = isOwner || isSelf;

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['members', workspaceId] }),
      qc.invalidateQueries({ queryKey: ['workspaces'] }),
      qc.invalidateQueries({ queryKey: ['accounts', workspaceId] }),
    ]);

  // A guest has no address and no mailbox (platform.md §3.3). An owner is always native.
  const setKind = async (kind: AccountKind) => {
    if (!account || kind === account.kind) return;
    setBusy(true);
    setError(null);
    try {
      await api('PATCH', `/v1/workspaces/${workspaceId}/accounts/${account.id}/kind`, { kind });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setBusy(false);
    }
  };

  const setRole = async (role: Exclude<MemberRole, 'owner'>) => {
    if (role === member.role) return;
    setBusy(true);
    setError(null);
    try {
      await api('PATCH', `/v1/workspaces/${workspaceId}/members/${member.userId}/role`, { role });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('DELETE', `/v1/workspaces/${workspaceId}/members/${member.userId}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
      setBusy(false);
      setConfirmRemove(false);
    }
    // On success the row disappears with the roster refetch — no state to reset.
  };

  return (
    <tr data-testid={`admin-member-${member.email}`} className="border-b border-hairline last:border-0">
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2.5">
          <Avatar userId={member.userId} name={member.displayName} avatarUrl={member.avatarUrl} size={30} radius={9} />
          <div className="min-w-0">
            <div className="truncate font-semibold">
              {member.displayName}
              {member.isAgent && <span title="AI agent"> 🤖</span>}
              {isSelf && <span className="text-faint"> (you)</span>}
            </div>
            <div className="truncate text-xs text-muted">{member.email}</div>
            {account && (
              <div data-testid={`admin-address-${member.email}`} className="truncate text-xs text-faint">
                {account.kind === 'guest' ? 'guest' : account.address}
              </div>
            )}
          </div>
        </div>
      </td>
      <td className="px-3 py-2.5">
        {locked ? (
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${
              isOwner ? 'bg-accent/10 text-accent-deep' : 'bg-daypill text-ink-soft'
            }`}
          >
            {member.role}
          </span>
        ) : (
          <select
            data-testid={`admin-role-${member.email}`}
            className="rounded border border-hairline bg-base px-2 py-1 text-sm disabled:opacity-50"
            value={member.role}
            disabled={busy}
            onChange={(e) => void setRole(e.target.value as Exclude<MemberRole, 'owner'>)}
          >
            <option value="admin">Admin</option>
            <option value="member">Member</option>
          </select>
        )}
      </td>
      <td className="px-3 py-2.5">
        {!account ? (
          <span className="text-xs text-faint">—</span>
        ) : isOwner ? (
          <span data-testid={`admin-kind-${member.email}`} className="text-xs text-ink-soft">Native</span>
        ) : (
          <select
            data-testid={`admin-kind-${member.email}`}
            className="rounded border border-hairline bg-base px-2 py-1 text-sm disabled:opacity-50"
            value={account.kind}
            disabled={busy}
            onChange={(e) => void setKind(e.target.value as AccountKind)}
          >
            <option value="native">Native</option>
            <option value="guest">Guest</option>
          </select>
        )}
      </td>
      <td className="px-3 py-2.5 text-right">
        {error && <span className="mr-2 text-xs text-red-600">{error}</span>}
        {locked ? (
          <span className="text-xs text-faint">—</span>
        ) : confirmRemove ? (
          <span className="inline-flex items-center gap-2">
            <span className="text-xs text-muted">Remove?</span>
            <button
              data-testid={`admin-remove-confirm-${member.email}`}
              className="rounded bg-red-600 px-2 py-1 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
              disabled={busy}
              onClick={() => void remove()}
            >
              Yes
            </button>
            <button
              className="text-xs text-muted hover:underline"
              disabled={busy}
              onClick={() => setConfirmRemove(false)}
            >
              No
            </button>
          </span>
        ) : (
          <button
            data-testid={`admin-remove-${member.email}`}
            className="rounded border border-red-200 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"
            disabled={busy}
            onClick={() => setConfirmRemove(true)}
          >
            Remove
          </button>
        )}
      </td>
    </tr>
  );
}

/**
 * The organization itself (platform.md §3.1): who owns it, its policies, and — for the owner — handing it to someone
 * else. Policies save on change through the workspace PATCH, like the other workspace settings.
 */
export function OrganizationSection({
  ws,
  roster,
  meId,
  hostedMail = false,
  accounts,
}: {
  ws: WorkspaceDTO;
  roster: WorkspaceMemberDTO[];
  meId: string;
  /** A mail provider is configured (GET /v1/config `hostedMail`): offer to set up mailboxes for everyone. */
  hostedMail?: boolean;
  /** The organization's accounts (GET /v1/workspaces/:id/accounts), once loaded: who is native and who a guest. */
  accounts?: AccountDTO[] | undefined;
}) {
  const { api } = useBoundApi();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [heir, setHeir] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [queued, setQueued] = useState<number | null>(null);
  const [confirmGuests, setConfirmGuests] = useState(false);
  const [guested, setGuested] = useState<number | null>(null);

  const owner = roster.find((m) => m.role === 'owner');
  const policies: WorkspacePolicies = { ...WORKSPACE_POLICY_DEFAULTS, ...ws.policies };
  const isOwner = ws.role === 'owner';
  // Ownership goes to a person: never an agent or an app.
  const candidates = roster.filter((m) => m.userId !== meId && !m.isAgent && !m.isBot);
  const heirName = candidates.find((m) => m.userId === heir)?.displayName;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['workspaces'] }),
        qc.invalidateQueries({ queryKey: ['members', ws.id] }),
        qc.invalidateQueries({ queryKey: ['accounts', ws.id] }),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setBusy(false);
    }
  };

  const setPolicy = <K extends keyof WorkspacePolicies>(key: K, value: WorkspacePolicies[K]) =>
    run(() => api('PATCH', `/v1/workspaces/${ws.id}`, { policies: { [key]: value } }));

  // Every account without a hosted mailbox (members from before the provider, or one whose setup stopped) is sent to be set up.
  const provisionAll = () =>
    run(async () => {
      const out = await api<{ queued: number }>('POST', `/v1/workspaces/${ws.id}/provision`, {});
      setQueued(out.queued);
    });

  // Native accounts are the ones with mailboxes; "set up mailboxes for everyone" covers them and no guest.
  const live = (accounts ?? []).filter((a) => a.state !== 'removed' && a.state !== 'suspended');
  const natives = live.filter((a) => a.kind === 'native').length;
  const nativeMembers = live.filter((a) => a.kind === 'native' && a.role === 'member').length;

  // Every person whose role is member becomes a guest; owners, admins and agents keep theirs.
  const makeEveryoneGuests = () =>
    run(async () => {
      const out = await api<BulkAccountKindResult>('POST', `/v1/workspaces/${ws.id}/accounts/kind`, { kind: 'guest', all: true });
      setGuested(out.changed);
      setConfirmGuests(false);
    });

  const transfer = () =>
    run(async () => {
      await api('POST', `/v1/workspaces/${ws.id}/owner`, { userId: heir });
      setConfirming(false);
      setHeir('');
    });

  return (
    <section data-testid="admin-organization" className="mb-6 rounded-lg border border-hairline p-4">
      <h3 className="mb-3 text-sm font-bold">Organization</h3>
      <p className="mb-3 text-sm">
        <span className="text-muted">Owner: </span>
        <span data-testid="admin-owner" className="font-semibold">{owner?.displayName ?? '—'}</span>
      </p>
      <div className="mb-3 grid gap-2 text-sm sm:grid-cols-2">
        <label className="flex items-center justify-between gap-2">
          <span className="text-muted">Who can invite people</span>
          <select
            data-testid="admin-policy-invite"
            className="rounded border border-hairline bg-base px-2 py-1 text-sm disabled:opacity-50"
            value={policies.inviteBy}
            disabled={busy}
            onChange={(e) => void setPolicy('inviteBy', e.target.value as WorkspacePolicies['inviteBy'])}
          >
            <option value="members">Every member</option>
            <option value="admins">Owners and admins</option>
          </select>
        </label>
        <label className="flex items-center justify-between gap-2">
          <span className="text-muted">Who can add agents</span>
          <select
            data-testid="admin-policy-agents"
            className="rounded border border-hairline bg-base px-2 py-1 text-sm disabled:opacity-50"
            value={policies.agentsBy}
            disabled={busy}
            onChange={(e) => void setPolicy('agentsBy', e.target.value as WorkspacePolicies['agentsBy'])}
          >
            <option value="members">Every member</option>
            <option value="admins">Owners and admins</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input
            data-testid="admin-policy-links"
            type="checkbox"
            checked={policies.linkSharing}
            disabled={busy}
            onChange={(e) => void setPolicy('linkSharing', e.target.checked)}
          />
          <span className="text-muted">Allow sharing by link</span>
        </label>
        <label className="flex items-center justify-between gap-2">
          <span className="text-muted" title="Native accounts get an address and a mailbox; guests get neither">New members join as</span>
          <select
            data-testid="admin-policy-kind"
            className="rounded border border-hairline bg-base px-2 py-1 text-sm disabled:opacity-50"
            value={policies.defaultAccountKind}
            disabled={busy}
            onChange={(e) => void setPolicy('defaultAccountKind', e.target.value as WorkspacePolicies['defaultAccountKind'])}
          >
            <option value="native">Native (with a mailbox)</option>
            <option value="guest">Guests (no mailbox)</option>
          </select>
        </label>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2 border-t border-hairline pt-3 text-sm">
        <span className="text-muted">Guests have no address and no mailbox</span>
        {confirmGuests ? (
          <span className="inline-flex items-center gap-2">
            <span className="text-xs text-muted">
              Make {nativeMembers} {nativeMembers === 1 ? 'member' : 'members'} guests? Their mailboxes are suspended. Owners and admins keep theirs.
            </span>
            <button
              data-testid="admin-guests-confirm"
              className="rounded bg-red-600 px-2 py-1 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
              disabled={busy}
              onClick={() => void makeEveryoneGuests()}
            >
              Yes
            </button>
            <button className="text-xs text-muted hover:underline" disabled={busy} onClick={() => setConfirmGuests(false)}>
              No
            </button>
          </span>
        ) : (
          <button
            data-testid="admin-guests"
            className="rounded border border-hairline px-2.5 py-1 text-xs hover:bg-daypill disabled:opacity-50"
            disabled={busy}
            onClick={() => { setGuested(null); setConfirmGuests(true); }}
          >
            Make every member a guest
          </button>
        )}
        {guested !== null && (
          <span data-testid="admin-guests-result" className="text-xs text-muted">
            {guested === 0 ? 'Every member was a guest already.' : `${guested} ${guested === 1 ? 'member is' : 'members are'} now ${guested === 1 ? 'a guest' : 'guests'}.`}
          </span>
        )}
      </div>
      {hostedMail && (
        <div className="mb-3 flex flex-wrap items-center gap-2 border-t border-hairline pt-3 text-sm">
          <span className="text-muted">Mailboxes at the organization's address</span>
          <button
            data-testid="admin-provision"
            className="rounded border border-hairline px-2.5 py-1 text-xs hover:bg-daypill disabled:opacity-50"
            disabled={busy}
            onClick={() => void provisionAll()}
          >
            Set up mailboxes for everyone
          </button>
          {accounts && (
            <span data-testid="admin-provision-count" className="text-xs text-muted">
              {natives} native {natives === 1 ? 'account' : 'accounts'}; guests get none
            </span>
          )}
          {queued !== null && (
            <span data-testid="admin-provision-result" className="text-xs text-muted">
              {queued === 0 ? 'Everyone has a mailbox.' : `Setting up ${queued} ${queued === 1 ? 'mailbox' : 'mailboxes'}.`}
            </span>
          )}
        </div>
      )}
      {isOwner && (
        <div className="flex flex-wrap items-center gap-2 border-t border-hairline pt-3 text-sm">
          <span className="text-muted">Transfer ownership to</span>
          <select
            data-testid="admin-transfer-select"
            className="rounded border border-hairline bg-base px-2 py-1 text-sm disabled:opacity-50"
            value={heir}
            disabled={busy || confirming}
            onChange={(e) => setHeir(e.target.value)}
          >
            <option value="">Choose a member…</option>
            {candidates.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.displayName}
              </option>
            ))}
          </select>
          {confirming ? (
            <span className="inline-flex items-center gap-2">
              <span className="text-xs text-muted">Make {heirName} the owner? You will become an admin.</span>
              <button
                data-testid="admin-transfer-confirm"
                className="rounded bg-red-600 px-2 py-1 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                disabled={busy}
                onClick={() => void transfer()}
              >
                Yes
              </button>
              <button className="text-xs text-muted hover:underline" disabled={busy} onClick={() => setConfirming(false)}>
                No
              </button>
            </span>
          ) : (
            <button
              data-testid="admin-transfer"
              className="rounded border border-hairline px-2.5 py-1 text-xs hover:bg-daypill disabled:opacity-50"
              disabled={busy || !heir}
              onClick={() => setConfirming(true)}
            >
              Transfer…
            </button>
          )}
        </div>
      )}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </section>
  );
}
