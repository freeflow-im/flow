import { isDesktop } from '../lib/host';
import { useBoundApi } from '../lib/useBoundApi';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { isProfileWebsiteUrl } from '@flow/shared';
import { SETTINGS_SECTIONS } from '@flow/shared/addresses';
import { AccountSettings, type AccountSettingsApi } from '@flow/suite-bar/account-settings';
import type {
  ChannelDTO,
  InviteBatchDTO,
  InviteResultDTO,
  InviteStatus,
  JoinLinkDTO,
  NotificationPrefs,
  UserDTO,
  UserWorkspaceInviteResponse,
  WorkspaceDTO,
  WorkspaceInviteTargetsDTO,
} from '@flow/shared';
import { ApiError, api, uploadAvatar } from '../lib/api';
import { useAuth, useSelection } from '../state';
import { useChannelMembers, useChannels, useMemberMap, useMembers, useSelfRegisterDomain, useWorkspaces } from '../hooks';
import { AuthImg, Avatar } from './Avatar';

export function Modal({
  children,
  onClose,
  testid,
  wide,
}: {
  children: React.ReactNode;
  onClose: () => void;
  testid?: string;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onMouseDown={onClose}>
      <div
        data-testid={testid}
        className={`${
          // cap to the viewport on phones so the dialog never overflows
          wide ? 'w-[min(560px,calc(100vw-2rem))]' : 'w-[min(24rem,calc(100vw-2rem))]'
        } max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-xl bg-white p-5 text-ink shadow-2xl`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

export function CreateChannelModal({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const { api } = useBoundApi();
  const qc = useQueryClient();
  const sel = useSelection();
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    try {
      const ch = await api<ChannelDTO>('POST', `/v1/workspaces/${workspaceId}/channels`, {
        name: name.toLowerCase().replaceAll(' ', '-'),
        ...(topic ? { topic } : {}),
        isPrivate,
      });
      await qc.invalidateQueries({ queryKey: ['channels', workspaceId] });
      onClose();
      sel.selectChannel(ch.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  };

  return (
    <Modal onClose={onClose} testid="create-channel-modal">
      <h3 className="mb-3 font-bold">Create Channel</h3>
      <input data-testid="create-channel-name" className="mb-2 w-full rounded border border-hairline2 px-3 py-2 text-sm"
        placeholder="name (lowercase, a-z 0-9 - _)" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      <input className="mb-2 w-full rounded border border-hairline2 px-3 py-2 text-sm"
        placeholder="Topic (optional)" value={topic} onChange={(e) => setTopic(e.target.value)} />
      <label className="mb-3 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
        Private channel
      </label>
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      <div className="flex justify-end gap-2">
        <button className="px-3 py-1.5 text-sm text-ink-soft" onClick={onClose}>Cancel</button>
        <button data-testid="create-channel-submit"
          className="rounded bg-accent px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
          disabled={!name.trim()} onClick={() => void create()}>Create</button>
      </div>
    </Modal>
  );
}

/**
 * Channel options (#188): name, topic and delete, reached from the header's
 * "⋯" menu — the same three on every client. Deleting is the server's archive
 * (soft: the channel leaves the sidebar and goes read-only), and #general
 * can be neither renamed nor deleted.
 */
export function ChannelOptionsModal({ channel, onClose }: { channel: ChannelDTO; onClose: () => void }) {
  const { api } = useBoundApi();
  const qc = useQueryClient();
  const sel = useSelection();
  const [name, setName] = useState(channel.name ?? '');
  const [topic, setTopic] = useState(channel.topic ?? '');
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isGeneral = channel.name === 'general';

  const remove = async () => {
    try {
      await api('POST', `/v1/channels/${channel.id}/archive`);
      await qc.invalidateQueries({ queryKey: ['channels', channel.workspaceId] });
      if (sel.channelId === channel.id) sel.selectChannel(null);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  };

  const save = async () => {
    try {
      await api('PATCH', `/v1/channels/${channel.id}`, {
        ...(isGeneral ? {} : { name: name.toLowerCase().replaceAll(' ', '-') }),
        topic, // '' clears
      });
      await qc.invalidateQueries({ queryKey: ['channels', channel.workspaceId] });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  };

  return (
    <Modal onClose={onClose} testid="channel-options-modal">
      <h3 className="mb-3 font-bold">Channel options</h3>
      <label className="mb-1 block text-xs font-semibold text-faint uppercase">Name</label>
      <input data-testid="edit-channel-name" className="mb-2 w-full rounded border border-hairline2 px-3 py-2 text-sm disabled:opacity-60"
        placeholder="name (lowercase, a-z 0-9 - _)" value={name} disabled={isGeneral}
        title={isGeneral ? '#general cannot be renamed' : undefined}
        onChange={(e) => setName(e.target.value)} autoFocus={!isGeneral} />
      <label className="mb-1 block text-xs font-semibold text-faint uppercase">Topic</label>
      <input data-testid="edit-channel-topic" className="mb-3 w-full rounded border border-hairline2 px-3 py-2 text-sm"
        placeholder="What's this channel about?" value={topic} maxLength={250}
        onChange={(e) => setTopic(e.target.value)} autoFocus={isGeneral}
        onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} />
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      <div className="flex items-center justify-between gap-2">
        {isGeneral ? (
          <span />
        ) : confirmDelete ? (
          <button data-testid="channel-delete-confirm"
            className="rounded bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700"
            onClick={() => void remove()}>Really delete?</button>
        ) : (
          <button data-testid="channel-delete"
            className="rounded border border-red-200 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"
            onClick={() => setConfirmDelete(true)}>Delete channel</button>
        )}
        <div className="flex gap-2">
          <button className="px-3 py-1.5 text-sm text-ink-soft" onClick={onClose}>Cancel</button>
          <button data-testid="edit-channel-save"
            className="rounded bg-accent px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
            disabled={!isGeneral && !name.trim()} onClick={() => void save()}>Save</button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Google domain self-registration (phase16 §5a), offered in the invite dialog
 * because "let everyone at acme.com in" is the same job as inviting them one
 * by one. Only shown to an owner/admin who signed in with Google on a
 * non-consumer domain; the server re-checks all of that.
 */
function SelfRegisterToggle({ workspaceId }: { workspaceId: string }) {
  const { api } = useBoundApi();
  const qc = useQueryClient();
  const workspaces = useWorkspaces();
  const domain = useSelfRegisterDomain();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ws = (workspaces.data ?? []).find((w) => w.id === workspaceId);
  if (!ws || !domain) return null;
  const on = ws.googleSelfRegisterDomain === domain;

  const toggle = async (next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api('PATCH', `/v1/workspaces/${workspaceId}`, { googleSelfRegisterDomain: next ? domain : null });
      await qc.invalidateQueries({ queryKey: ['workspaces'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 border-t border-hairline pt-3">
      <label data-testid="invite-self-register" className="flex items-start gap-2 text-sm text-ink-soft">
        <input type="checkbox" className="mt-0.5" checked={on} disabled={busy}
          onChange={(e) => void toggle(e.target.checked)} />
        <span>
          Let anyone with an <span className="font-semibold text-ink">@{domain}</span> email join automatically when
          they sign in with Google — no invite needed.
        </span>
      </label>
      {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
    </div>
  );
}

/**
 * The workspace's persistent join link (issue #85) — the "drop it in a doc"
 * counterpart to emailing one address at a time. One link is live at a time:
 * Regenerate replaces it (which kills the old URL) and Revoke removes it.
 */
function JoinLinkSection({ workspaceId }: { workspaceId: string }) {
  const { api } = useBoundApi();
  const [url, setUrl] = useState<string | null>(null);
  // null = still asking; false = the server said no (not an owner/admin), which
  // is the same permission that gates emailed invites, so we hide the section.
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const link = await api<JoinLinkDTO>('GET', `/v1/workspaces/${workspaceId}/join-link`);
        if (!live) return;
        setUrl(link.joinUrl);
        setAllowed(true);
      } catch {
        if (live) setAllowed(false);
      }
    })();
    return () => { live = false; };
  }, [workspaceId]);

  const run = async (method: 'POST' | 'DELETE') => {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const link = await api<JoinLinkDTO>(method, `/v1/workspaces/${workspaceId}/join-link`);
      setUrl(link.joinUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setCopied(true);
  };

  if (!allowed) return null;

  return (
    <div className="mt-4 border-t border-hairline pt-3" data-testid="join-link-section">
      <p className="mb-1 text-sm font-semibold">Share a join link</p>
      <p className="mb-2 text-xs text-ink-soft">
        Anyone with this link can join the workspace. It stays valid until you regenerate or revoke it.
      </p>
      {url ? (
        <>
          <code data-testid="join-link-url" className="mb-2 block rounded bg-daypill p-2 text-xs break-all select-all">{url}</code>
          <div className="flex gap-2">
            <button data-testid="join-link-copy"
              className="rounded bg-accent px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
              disabled={busy} onClick={() => void copy()}>{copied ? 'Copied' : 'Copy link'}</button>
            <button data-testid="join-link-regenerate"
              className="px-3 py-1.5 text-sm text-ink-soft disabled:opacity-50"
              disabled={busy} onClick={() => void run('POST')}>Regenerate</button>
            <button data-testid="join-link-revoke"
              className="px-3 py-1.5 text-sm text-red-600 disabled:opacity-50"
              disabled={busy} onClick={() => void run('DELETE')}>Revoke</button>
          </div>
        </>
      ) : (
        <button data-testid="join-link-create"
          className="rounded bg-accent px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
          disabled={busy} onClick={() => void run('POST')}>Create join link</button>
      )}
      {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
    </div>
  );
}

/**
 * Splits whatever an admin pasted into addresses: commas, semicolons, spaces
 * and newlines all separate, so a list copied out of a mail client works as-is.
 * Deduped case-insensitively (first spelling wins) — the server collapses
 * duplicates anyway, and two results for one person reads like a bug.
 * Nothing is validated here: a typo has to reach the server to come back as
 * that address's `invalid_email`, not silently vanish from the batch (#578).
 */
export function parseInviteEmails(input: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.split(/[,;\s]+/)) {
    const addr = raw.trim();
    if (!addr) continue;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
  }
  return out;
}

/** What each per-address status (#577) says to the person who hit Send. */
export function inviteStatusText(status: InviteStatus): string {
  switch (status) {
    case 'sent':
      return 'Invite emailed';
    case 'resent':
      return 'Invite emailed again';
    case 'already_member':
      return 'Already a member';
    case 'invalid_email':
      return 'Not a valid email address';
    case 'email_failed':
      return "Couldn't send the email — share this link yourself:";
  }
}

/** Addresses worth another try: the ones nothing was delivered to. */
export function retryableInviteEmails(results: InviteResultDTO[]): string[] {
  return results.filter((r) => r.status === 'invalid_email' || r.status === 'email_failed').map((r) => r.email);
}

export function InviteResultRow({ result }: { result: InviteResultDTO }) {
  const failed = result.status === 'invalid_email' || result.status === 'email_failed';
  const ok = result.status === 'sent' || result.status === 'resent';
  return (
    <li data-testid={`invite-result-${result.email}`} className="border-b border-hairline2 py-1.5 last:border-0">
      <div className="flex items-baseline gap-2">
        <span aria-hidden className={failed ? 'text-red-600' : ok ? 'text-green-600' : 'text-ink-soft'}>
          {failed ? '✕' : ok ? '✓' : '•'}
        </span>
        <span className="min-w-0 flex-1 break-all text-sm">{result.email}</span>
        <span data-testid={`invite-status-${result.email}`} className={`text-xs ${failed ? 'text-red-600' : 'text-ink-soft'}`}>
          {inviteStatusText(result.status)}
        </span>
      </div>
      {result.status === 'email_failed' && result.inviteUrl && (
        <code data-testid={`invite-url-${result.email}`} className="mt-1 block rounded bg-daypill p-2 text-xs break-all select-all">
          {result.inviteUrl}
        </code>
      )}
    </li>
  );
}

export function InviteModal({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const { api } = useBoundApi();
  const [emails, setEmails] = useState('');
  const [results, setResults] = useState<InviteResultDTO[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = parseInviteEmails(emails);
  // Everything landed: nothing left to edit, so the form gives way to Done.
  const allDelivered = results !== null && retryableInviteEmails(results).length === 0;

  const send = async () => {
    if (parsed.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<InviteBatchDTO>('POST', `/v1/workspaces/${workspaceId}/invites`, { emails: parsed });
      setResults(res.results);
      // Only what failed stays in the box — retrying must not re-send the rest.
      setEmails(retryableInviteEmails(res.results).join(', '));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} testid="invite-modal">
      <h3 className="mb-3 font-bold">Invite People</h3>
      {results && (
        <ul data-testid="invite-result" className="mb-3 rounded border border-hairline2 px-2">
          {results.map((r) => (
            <InviteResultRow key={r.email} result={r} />
          ))}
        </ul>
      )}
      {allDelivered ? (
        <div className="flex justify-end">
          <button className="rounded bg-accent px-3 py-1.5 text-sm font-semibold text-white" onClick={onClose}>Done</button>
        </div>
      ) : (
        <>
          <textarea data-testid="invite-email" rows={2}
            className="mb-1 w-full resize-y rounded border border-hairline2 px-3 py-2 text-sm"
            placeholder="email@example.com, someone@example.com"
            value={emails} onChange={(e) => setEmails(e.target.value)} autoFocus />
          <p className="mb-2 text-xs text-faint">
            Separate addresses with commas. We'll email each person an invite link.
          </p>
          {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-2">
            <button className="px-3 py-1.5 text-sm text-ink-soft" onClick={onClose}>Cancel</button>
            <button data-testid="invite-submit"
              className="rounded bg-accent px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
              disabled={busy || parsed.length === 0} onClick={() => void send()}>
              {parsed.length > 1 ? `Send ${parsed.length} Invites` : 'Send Invites'}
            </button>
          </div>
          <SelfRegisterToggle workspaceId={workspaceId} />
        </>
      )}
      {/* Always available, emailed invite or not: the link is the workspace's,
          not this dialog's. Renders nothing for non-admins. */}
      <JoinLinkSection workspaceId={workspaceId} />
    </Modal>
  );
}

export function NewDmModal({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const { api } = useBoundApi();
  const auth = useAuth();
  const sel = useSelection();
  const qc = useQueryClient();
  const members = useMembers(workspaceId);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    try {
      const ch = await api<ChannelDTO>('POST', `/v1/workspaces/${workspaceId}/dms`, {
        userIds: Array.from(selected),
      });
      await qc.invalidateQueries({ queryKey: ['channels', workspaceId] });
      onClose();
      sel.selectChannel(ch.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  };

  return (
    <Modal onClose={onClose} testid="new-dm-modal">
      <h3 className="mb-1 font-bold">New Direct Message</h3>
      <p className="mb-3 text-sm text-muted">Pick one person for a DM, several for a group DM (max 8).</p>
      <div className="mc-scroll mb-3 max-h-56 overflow-y-auto">
        {(members.data ?? [])
          .filter((m) => m.userId !== auth.user.id)
          .map((m) => (
            <label key={m.userId} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-daypill/50">
              <input
                type="checkbox"
                data-testid={`dm-member-${m.displayName}`}
                checked={selected.has(m.userId)}
                onChange={(e) => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(m.userId);
                  else next.delete(m.userId);
                  setSelected(next);
                }}
              />
              {m.displayName}
              {m.isAgent && <span title="AI agent"> 🤖</span>}
            </label>
          ))}
      </div>
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      <div className="flex justify-end gap-2">
        <button className="px-3 py-1.5 text-sm text-ink-soft" onClick={onClose}>Cancel</button>
        <button data-testid="dm-start"
          className="rounded bg-accent px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
          disabled={selected.size === 0 || selected.size > 8} onClick={() => void start()}>Start</button>
      </div>
    </Modal>
  );
}

/**
 * The organization's people who are not in a channel yet, each with an Add button. Shown in the sidebar row's channel
 * settings and in the header's "Add people" dialog (the header is the only way in when Chat runs inside Home, which
 * hides Chat's channel list).
 */
export function ChannelInviteList({ channel, onError }: { channel: ChannelDTO; onError: (message: string | null) => void }) {
  const { api } = useBoundApi();
  const qc = useQueryClient();
  const auth = useAuth();
  const members = useMembers(channel.workspaceId);
  // Real membership (standard channels have no memberIds in the DTO): keeps
  // the list from offering people who are already here.
  const chanMembers = useChannelMembers(channel.id);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const candidates = (members.data ?? []).filter(
    (m) =>
      m.userId !== auth.user.id &&
      // Someone's personal assistant joins only channels its own person brings it into (agents.md §1.1); the server refuses the rest.
      (m.kind !== 'personal_agent' || m.sponsorId === auth.user.id) &&
      (added.has(m.userId) || !(chanMembers.data ?? channel.memberIds ?? []).includes(m.userId)),
  );
  const shown = candidates.filter((m) => m.displayName.toLowerCase().includes(filter.trim().toLowerCase()));
  const add = async (userId: string) => {
    onError(null);
    try {
      await api('POST', `/v1/channels/${channel.id}/members`, { userId });
      setAdded((prev) => new Set(prev).add(userId));
      await qc.invalidateQueries({ queryKey: ['channelMembers', channel.id] });
      await qc.invalidateQueries({ queryKey: ['channels', channel.workspaceId] });
    } catch (err) {
      onError(err instanceof Error ? err.message : 'could not add to channel');
    }
  };
  return (
    <>
      {candidates.length > 6 && (
        <input data-testid="channel-add-filter" className="mb-2 w-full rounded border border-hairline2 px-3 py-1.5 text-sm"
          placeholder="Find someone" value={filter} onChange={(e) => setFilter(e.target.value)} />
      )}
      <div className="mc-scroll mb-3 max-h-60 overflow-y-auto">
        {members.isLoading || chanMembers.isLoading ? (
          <p className="px-1 py-1 text-sm text-faint">Loading…</p>
        ) : candidates.length === 0 ? (
          <p className="px-1 py-1 text-sm text-faint">Everyone is here.</p>
        ) : shown.length === 0 ? (
          <p className="px-1 py-1 text-sm text-faint">No one matches.</p>
        ) : null}
        {shown.map((m) => (
          <div key={m.userId} className="flex items-center justify-between px-1 py-1 text-sm">
            <span>
              {m.displayName}
              {m.isAgent && <span title="AI agent"> 🤖</span>}
            </span>
            {added.has(m.userId) ? (
              <span className="text-xs text-green-600">added ✓</span>
            ) : (
              <button data-testid={`channel-add-${m.displayName}`} className="text-xs text-accent-soft hover:underline" onClick={() => void add(m.userId)}>
                Add
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

/** "Add people" from the channel header's member list. */
export function AddPeopleModal({ channel, onClose }: { channel: ChannelDTO; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal onClose={onClose} testid="channel-add-people-modal">
      <h3 className="mb-3 font-bold">Add people to #{channel.name}</h3>
      <ChannelInviteList channel={channel} onError={setError} />
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      <div className="flex justify-end">
        <button data-testid="channel-add-done" className="rounded bg-accent px-3 py-1.5 text-sm font-semibold text-white" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}

/** Channel actions: notify level, invite members, leave, archive. */
export function ChannelMenu({ channel, onClose }: { channel: ChannelDTO; onClose: () => void }) {
  const { api } = useBoundApi();
  const sel = useSelection();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ['channels', sel.workspaceId] });

  const act = (fn: () => Promise<unknown>, close = true) => {
    void (async () => {
      setError(null);
      try {
        await fn();
        await refresh();
        if (close) onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed');
      }
    })();
  };

  const setLevel = (level: number) =>
    act(() => api('PUT', `/v1/channels/${channel.id}/notify`, { level }), false);

  const isDm = channel.kind !== 'standard';

  return (
    <Modal onClose={onClose} testid="channel-menu-modal">
      <h3 className="mb-3 font-bold">{channel.name ? `#${channel.name}` : 'Conversation'} settings</h3>

      <p className="mb-1 text-xs font-semibold text-faint uppercase">Notifications</p>
      <div className="mb-3 flex gap-1">
        {[
          { level: 1, label: 'Mentions' },
          { level: 2, label: 'All' },
          { level: 0, label: 'Mute' },
        ].map((o) => (
          <button
            key={o.level}
            data-testid={`notify-${o.label.toLowerCase()}`}
            className={`rounded border px-3 py-1 text-sm ${channel.notifyLevel === o.level ? 'border-accent bg-accent/10 font-semibold' : 'border-hairline hover:bg-daypill/50'}`}
            onClick={() => setLevel(o.level)}
          >
            {o.label}
          </button>
        ))}
      </div>

      {!isDm && (
        <>
          <p className="mb-1 text-xs font-semibold text-faint uppercase">Invite to channel</p>
          <ChannelInviteList channel={channel} onError={setError} />
        </>
      )}

      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}

      <div className="flex justify-between">
        <div className="flex gap-2">
          {(channel.kind === 'group_dm' || (!isDm && channel.name !== 'general')) && (
            <button
              data-testid="channel-leave"
              className="rounded border border-red-200 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"
              onClick={() =>
                act(async () => {
                  await api('POST', `/v1/channels/${channel.id}/leave`);
                  if (sel.channelId === channel.id) sel.selectChannel(null);
                })
              }
            >
              Leave
            </button>
          )}
          {!isDm && channel.name !== 'general' && (
            <button
              data-testid="channel-archive"
              className="rounded border border-red-200 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"
              onClick={() =>
                act(async () => {
                  await api('POST', `/v1/channels/${channel.id}/archive`);
                  if (sel.channelId === channel.id) sel.selectChannel(null);
                })
              }
            >
              Archive
            </button>
          )}
        </div>
        <button className="px-3 py-1.5 text-sm text-ink-soft" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

/**
 * Leaving a workspace (#340). Destructive and irreversible from the leaver's
 * side — they need a re-invite to come back — so it confirms first and says
 * plainly what survives. The owner never reaches this dialog; the menu item
 * that opens it is disabled for them.
 */
export function LeaveWorkspaceModal({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const { api, serverOrigin } = useBoundApi();
  const account = useAuth();
  const qc = useQueryClient();
  const sel = useSelection();
  const workspaces = useWorkspaces();
  const ws = (workspaces.data ?? []).find((w) => w.id === workspaceId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const leave = async () => {
    setError(null);
    setBusy(true);
    try {
      await api('POST', `/v1/workspaces/${workspaceId}/leave`);
      // Land somewhere valid before the list refetches, so no render sees a
      // selection pointing at a workspace that is gone.
      const next = (workspaces.data ?? []).find((w) => w.id !== workspaceId);
      sel.selectWorkspace(next?.id ?? null);
      await qc.invalidateQueries({ queryKey: ['workspaces'] });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} testid="leave-workspace-modal">
      <h3 className="mb-2 font-bold">Leave {ws?.name ?? 'workspace'}?</h3>
      <p className="mb-2 text-sm">{account.user?.email} · {serverOrigin}</p>
      <p className="mb-4 text-sm text-ink-soft">
        You&rsquo;ll lose access to all its channels. Your past messages will remain.
      </p>
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      <div className="flex justify-end gap-2">
        <button className="px-3 py-1.5 text-sm text-ink-soft" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          data-testid="leave-workspace-confirm"
          className="rounded bg-red-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
          disabled={busy}
          onClick={() => void leave()}
        >
          {busy ? 'Leaving…' : 'Leave workspace'}
        </button>
      </div>
    </Modal>
  );
}

/**
 * Deleting a workspace (#340 follow-up). Only reachable by an owner who is the
 * last person in it — otherwise there is somebody to hand it to, and the menu
 * offers "transfer ownership first" instead.
 *
 * Confirmation weight matches "Delete account" in `ProfileModal`, the nearest
 * equally irreversible action in this app: an explicit destructive press, no
 * type-the-name gesture. The blast radius here is one person's own workspace.
 */
export function DeleteWorkspaceModal({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const { api } = useBoundApi();
  const qc = useQueryClient();
  const sel = useSelection();
  const workspaces = useWorkspaces();
  const ws = (workspaces.data ?? []).find((w) => w.id === workspaceId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const destroy = async () => {
    setError(null);
    setBusy(true);
    try {
      await api('DELETE', `/v1/workspaces/${workspaceId}`);
      const next = (workspaces.data ?? []).find((w) => w.id !== workspaceId);
      sel.selectWorkspace(next?.id ?? null);
      await qc.invalidateQueries({ queryKey: ['workspaces'] });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} testid="delete-workspace-modal">
      <h3 className="mb-2 font-bold">Delete {ws?.name ?? 'workspace'}?</h3>
      <p className="mb-4 text-sm text-ink-soft">
        You&rsquo;re the only one left, so there&rsquo;s nobody to hand it to. Deleting removes the workspace
        and every channel, message and file in it, for good. This cannot be undone.
      </p>
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      <div className="flex justify-end gap-2">
        <button className="px-3 py-1.5 text-sm text-ink-soft" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          data-testid="delete-workspace-confirm"
          className="rounded bg-red-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
          disabled={busy}
          onClick={() => void destroy()}
        >
          {busy ? 'Deleting…' : 'Delete workspace'}
        </button>
      </div>
    </Modal>
  );
}

/**
 * The profile and the account's settings in a dialog, for where Home's Settings page cannot be reached: the desktop
 * shell, or an organization on another server. In a browser on the suite's own server the account menu opens Home's page
 * instead (ChatSuiteBar). The form is the suite's one (@flow/suite-bar/account-settings), saved through this connection;
 * `section: 'notifications'` brings the notification settings into view (the menu's Settings row).
 */
export function ProfileModal({ onClose, section, avatarSrc }: { onClose: () => void; section?: 'notifications'; avatarSrc: string | null }) {
  const { serverOrigin, api, uploadAvatar } = useBoundApi();
  const auth = useAuth();
  const sel = useSelection();
  const workspaces = useWorkspaces();
  // platform.md §3.2: the caller's own address in the workspace they are in, when the server sends it.
  const address = (workspaces.data ?? []).find((w) => w.id === sel.workspaceId)?.address;
  const qc = useQueryClient();
  const settingsApi: AccountSettingsApi = {
    patchMe: (patch) => api<UserDTO>('PATCH', '/v1/me', patch),
    uploadAvatar: async (file) => (await uploadAvatar(file)) as UserDTO,
    deleteAccount: async () => void (await api('DELETE', '/v1/me')),
  };
  const onUser = (me: UserDTO) => {
    auth.setUser(me);
    // The roster carries the name, picture and privacy mode (the Directory drops a private member in the same beat).
    void qc.invalidateQueries({ queryKey: ['members'] });
  };
  return (
    <Modal onClose={onClose} testid="profile-modal">
      <h3 className="mb-3 font-bold">Settings</h3>
      <AccountSettings
        user={auth.user}
        sections={SETTINGS_SECTIONS}
        {...(section ? { focus: section } : {})}
        api={settingsApi}
        avatarSrc={avatarSrc}
        address={address ?? null}
        serverOrigin={serverOrigin}
        // In the desktop shell how long a banner stays is an OS setting, as on macOS and iOS.
        persistentBanners={!isDesktop()}
        onUser={onUser}
        onProfileSaved={onClose}
        onCancel={onClose}
        // Local teardown; its logout POST failing on the dead session is fine.
        onDeleted={auth.signOut}
      />
    </Modal>
  );
}

/**
 * "Invite to workspace" (#358): bring this member into another workspace of
 * mine. One control for two flows, because from the inviter's side it is one
 * intention — an agent joins on the spot (its sponsor vouches for it, #357), a
 * person is asked and joins when they accept (#359).
 *
 * The list is the server's answer to "which of my workspaces is this member NOT
 * in", so it never offers a move that can only fail.
 */
function InviteToWorkspace({ user, onDone }: { user: UserDTO; onDone: () => void }) {
  const { api } = useBoundApi();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<WorkspaceDTO[] | null>(null);
  // Whether the server had nothing to offer in the first place. Distinct from
  // "the list is empty now": after inviting into the last candidate, the right
  // thing to say is the confirmation, not "already in all your workspaces".
  const [noneToOffer, setNoneToOffer] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const show = async () => {
    setOpen(true);
    setError(null);
    if (targets) return;
    try {
      const res = await api<WorkspaceInviteTargetsDTO>('GET', `/v1/users/${user.id}/workspace-invites`);
      setTargets(res.workspaces);
      setNoneToOffer(res.workspaces.length === 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  };

  const invite = async (ws: WorkspaceDTO) => {
    setBusy(ws.id);
    setError(null);
    try {
      if (user.isAgent) {
        await api('POST', `/v1/agents/${user.id}/workspace-invites`, { workspaceId: ws.id });
        setDone(`${user.displayName} joined ${ws.name}`);
        await qc.invalidateQueries({ queryKey: ['members', ws.id] });
      } else {
        // Idempotent server-side (#359): `created: false` means an identical
        // invitation was already in flight, which is "already invited", not a
        // second send.
        const res = await api<UserWorkspaceInviteResponse>(
          'POST',
          `/v1/users/${user.id}/workspace-invites`,
          { workspaceId: ws.id },
        );
        setDone(
          res.created
            ? `Invitation sent to ${user.displayName}`
            : `${user.displayName} has already been invited to ${ws.name}`,
        );
      }
      // Whatever happened, that workspace is no longer a candidate.
      setTargets((prev) => (prev ?? []).filter((w) => w.id !== ws.id));
      onDone();
    } catch (err) {
      setError(inviteErrorText(err, user, ws));
    } finally {
      setBusy(null);
    }
  };

  if (!open) {
    return (
      <button
        data-testid="user-card-invite-workspace"
        className="rounded border border-hairline px-4 py-1.5 text-sm"
        onClick={() => void show()}
      >
        Invite to workspace
      </button>
    );
  }

  return (
    <div data-testid="invite-workspace-panel" className="mt-2 w-full text-left">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Invite to workspace</p>
      {targets === null && !error && <p className="text-sm text-faint">Loading…</p>}
      {noneToOffer && (
        <p data-testid="invite-workspace-empty" className="text-sm text-muted">
          {user.displayName} is already in all your workspaces.
        </p>
      )}
      <div className="space-y-1">
        {(targets ?? []).map((ws) => (
          <button
            key={ws.id}
            data-testid={`invite-workspace-${ws.slug}`}
            className="flex w-full items-center gap-2 rounded border border-hairline px-3 py-1.5 text-sm hover:border-accent disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => void invite(ws)}
          >
            {ws.avatarUrl ? (
              <AuthImg path={ws.avatarUrl} alt={ws.name} className="h-5 w-5 rounded object-cover" />
            ) : (
              <span className="flex h-5 w-5 items-center justify-center rounded bg-accent text-[10px] font-bold text-white">
                {ws.name.slice(0, 1).toUpperCase()}
              </span>
            )}
            <span className="flex-1 truncate text-left">{ws.name}</span>
            {busy === ws.id && <span className="text-xs text-faint">…</span>}
          </button>
        ))}
      </div>
      {done && <p data-testid="invite-workspace-done" className="mt-1 text-sm text-accent-deep">{done}</p>}
      {error && <p data-testid="invite-workspace-error" className="mt-1 text-sm text-red-600">{error}</p>}
    </div>
  );
}

/** The inline message for a failed invite — the server's codes, said in names. */
export function inviteErrorText(err: unknown, user: UserDTO, ws: WorkspaceDTO): string {
  const code = err instanceof ApiError ? err.code : '';
  if (code === 'already_member') return `${user.displayName} is already in ${ws.name}.`;
  if (code === 'username_taken') {
    return `A member of ${ws.name} already uses ${user.displayName}'s handle — rename one of them first.`;
  }
  if (code === 'invite_exists') return `${user.displayName} has already been invited to ${ws.name}.`;
  return err instanceof Error ? err.message : 'failed';
}

/** Member profile card: avatar, email, local time, Message button. */
export function UserCard({ userId, onClose }: { userId: string; onClose: () => void }) {
  const { api } = useBoundApi();
  const auth = useAuth();
  const sel = useSelection();
  const qc = useQueryClient();
  const memberMap = useMemberMap(sel.workspaceId);
  const [user, setUser] = useState<UserDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Agents carry a human sponsor; the id lives on the workspace roster, not the
  // /v1/users payload, so resolve name + avatar from the member map (ui_nits).
  const sponsorId = user?.isAgent ? memberMap[userId]?.sponsorId ?? null : null;
  const sponsor = sponsorId ? memberMap[sponsorId] : undefined;

  useEffect(() => {
    void api<UserDTO>('GET', `/v1/users/${userId}`)
      .then(setUser)
      .catch((err) => setError(err instanceof Error ? err.message : 'failed'));
  }, [userId]);

  const localTime = (tz: string) => {
    try {
      return `${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: tz })} local time (${tz})`;
    } catch {
      return tz;
    }
  };

  const message = async () => {
    if (!sel.workspaceId) return;
    try {
      const ch = await api<ChannelDTO>('POST', `/v1/workspaces/${sel.workspaceId}/dms`, { userIds: [userId] });
      await qc.invalidateQueries({ queryKey: ['channels', sel.workspaceId] });
      onClose();
      sel.selectChannel(ch.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  };

  return (
    <Modal onClose={onClose} testid="user-card">
      {user ? (
        <div className="flex flex-col items-center gap-2 text-center">
          {user.avatarUrl && /^https?:\/\//.test(user.avatarUrl) ? (
            // A provider's avatar is a public image URL, not a path on this server.
            <img src={user.avatarUrl} alt="avatar" className="h-16 w-16 rounded-full object-cover" />
          ) : user.avatarUrl ? (
            <AuthImg path={user.avatarUrl} alt="avatar" className="h-16 w-16 rounded-full object-cover" />
          ) : (
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-daypill text-xl font-bold text-muted">
              {user.displayName.slice(0, 1).toUpperCase()}
            </span>
          )}
          <p data-testid="user-card-name" className="text-lg font-bold">
            {user.displayName}
            {user.isAgent && <span title="AI agent"> 🤖</span>}
          </p>
          {/* platform.md §3.2: their address in this organization, from the roster. */}
          {memberMap[userId]?.address && (
            <p data-testid="user-card-address" className="max-w-full truncate text-sm text-muted select-all">
              {memberMap[userId]!.address}
            </p>
          )}
          {/* #434: under the name, same as the Directory card it opens from. */}
          {user.title && (
            <p data-testid="user-card-title" className="max-w-full truncate text-sm text-ink-soft">
              {user.title}
            </p>
          )}
          {user.isAgent && <p className="text-xs text-muted">AI agent</p>}
          {/* #489: '' means the address is hidden — draw no line rather than an
              empty one that reserves space for something nobody will see. */}
          {user.email && <p className="text-sm text-muted select-all">{user.email}</p>}
          <p data-testid="user-card-localtime" className="text-sm text-muted">{localTime(user.timezone)}</p>
          {/* #220: the server only stores http(s) URLs, but re-check before
              making it clickable — a row written before that rule must not
              become a javascript: link in someone else's page. */}
          {user.website &&
            (isProfileWebsiteUrl(user.website) ? (
              <a data-testid="user-card-website" href={user.website} target="_blank" rel="noreferrer noopener"
                className="max-w-full truncate text-sm text-accent-deep underline">
                {user.website.replace(/^https?:\/\//i, '')}
              </a>
            ) : (
              <span data-testid="user-card-website" className="max-w-full truncate text-sm text-muted">
                {user.website}
              </span>
            ))}
          {/* Plain text, not markdown: a React text child escapes it, and
              whitespace-pre-wrap is what keeps the author's line breaks. */}
          {user.bio && (
            <p data-testid="user-card-bio" className="mt-1 max-w-xs whitespace-pre-wrap text-left text-sm text-ink-soft">
              {user.bio}
            </p>
          )}
          {sponsor && (
            <div
              data-testid="user-card-sponsor"
              className="mt-1 flex items-center gap-2 rounded-lg bg-daypill px-3 py-1.5"
            >
              <span className="text-xs text-muted">Sponsored by</span>
              <Avatar
                userId={sponsor.userId}
                name={sponsor.displayName}
                avatarUrl={sponsor.avatarUrl}
                size={20}
                radius={6}
              />
              <span className="text-sm font-semibold">{sponsor.displayName}</span>
            </div>
          )}
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            {userId !== auth.user.id && (
              <button data-testid="user-card-message"
                className="rounded bg-accent px-4 py-1.5 text-sm font-semibold text-white"
                onClick={() => void message()}>Message</button>
            )}
            {/* Phase 5.4: an agent reads and answers mail at its address; copied rather than a mailto: link,
                which would open the system's mail app instead of FreeFlow Mail. */}
            {user.isAgent && memberMap[userId]?.address && (
              <button data-testid="user-card-copy-address" title="Email this agent at its address"
                className="rounded border border-hairline px-4 py-1.5 text-sm"
                onClick={() => void navigator.clipboard.writeText(memberMap[userId]!.address!).then(() => setCopied(true), () => {})}>
                {copied ? 'Copied' : 'Copy email address'}
              </button>
            )}
            {/* Never on your own profile: you are already in your workspaces. */}
            {userId !== auth.user.id && (
              <InviteToWorkspace
                user={user}
                onDone={() => void qc.invalidateQueries({ queryKey: ['workspaces'] })}
              />
            )}
            <button className="rounded border border-hairline px-4 py-1.5 text-sm" onClick={onClose}>Close</button>
          </div>
        </div>
      ) : error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : (
        <p className="py-6 text-center text-sm text-faint">Loading…</p>
      )}
    </Modal>
  );
}
