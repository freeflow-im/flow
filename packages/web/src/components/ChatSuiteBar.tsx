// The suite bar on Chat (packages/suite-bar; docs/specs/freeflow-suite.md §2.5), above Main and the workspace
// chooser. It takes over what the workspace rail and the sidebar's lower-left user block did: the organization menu
// is the rail's switcher (every connection's workspaces with their unread counts, "+" for the chooser and its
// invitations), and the account menu has presence, status, the profile, settings, Help and sign out.
import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { UserDTO } from '@flow/shared';
import { AWAY_STATUS, isAway, StatusDialog, statusPatch, SuiteBar, type StatusOption } from '@flow/suite-bar';
import { useSwitcherEntries, useWorkspaceInvites, useWorkspaces } from '../hooks';
import { useCapabilities } from '../lib/backend';
import { connectionManager, type ConnectionRuntime } from '../lib/connectionRuntime';
import { openWorkspace, showsSource } from '../lib/workspaceSwitcher';
import { ACTIVITY_VIEW_ID, useAuth, useRuntime, useSelection } from '../state';
import { FIND_EVENT } from './FindBar';
import { HelpModal } from './HelpModal';
import { InviteModal, ProfileModal } from './modals';

/** What another page of the suite asks Chat to open (`/?open=…`, read once in App.tsx). The bar opens the ones it owns. */
export type SuiteIntent = 'chooser' | 'admin' | 'invite' | 'activity' | 'profile';

/** An authenticated image path (`/v1/avatars/…`) as an object URL, fetched with its connection's bearer. */
function useImage(path: string | null | undefined, runtime: ConnectionRuntime | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(() => (path && runtime ? runtime.cachedBlobUrl(path) ?? null : null));
  useEffect(() => {
    if (!path || !runtime) return setUrl(null);
    if (/^https?:\/\//.test(path)) return setUrl(path);
    let alive = true;
    void runtime.blobUrl(path).then((u) => alive && setUrl(u), () => alive && setUrl(null));
    return () => {
      alive = false;
    };
  }, [path, runtime]);
  return url;
}

function useNarrow(): boolean {
  const query = '(max-width: 767px)';
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

/** The suite's Docs app is on this page's own server; an organization on another server has none yet. */
function onThisServer(runtime: ConnectionRuntime): boolean {
  try {
    return new URL(runtime.origin).origin === window.location.origin;
  } catch {
    return false;
  }
}

export default function ChatSuiteBar({ activityUnread, intent }: { activityUnread: number | null; intent: SuiteIntent | null }) {
  const auth = useAuth();
  const sel = useSelection();
  const runtime = useRuntime();
  const qc = useQueryClient();
  const caps = useCapabilities();
  const workspaces = useWorkspaces();
  const switcher = useSwitcherEntries();
  const invites = (useWorkspaceInvites().data ?? []).length;
  const narrow = useNarrow();
  const [modal, setModal] = useState<null | 'profile' | 'settings' | 'invite' | 'status' | 'help'>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  const ws = (workspaces.data ?? []).find((w) => w.id === sel.workspaceId);
  const isAdmin = ws?.role === 'owner' || ws?.role === 'admin';
  const canSetStatus = caps.status.state !== 'unavailable';
  const canInvite = caps.channelManagement.state !== 'unavailable' && !!sel.workspaceId;
  const canAdmin = isAdmin && caps.admin.state !== 'unavailable';
  const docsHere = onThisServer(runtime);
  const me = auth.user;

  // Opened from another page of the suite (Docs' menus).
  useEffect(() => {
    if (intent === 'profile') setModal('profile');
    else if (intent === 'invite' && canInvite) setModal('invite');
    // `canInvite` settles once the workspace list has loaded.
  }, [intent, canInvite]);

  const avatar = useImage(me.avatarUrl, runtime);
  // The rows' avatars, each fetched from (and authorized by) its own server.
  const [orgAvatars, setOrgAvatars] = useState<Record<string, string>>({});
  const avatarPaths = switcher.map((e) => `${e.connectionId}:${e.workspaceId}:${e.avatarUrl ?? ''}`).join('|');
  useEffect(() => {
    let alive = true;
    for (const e of switcher) {
      if (!e.avatarUrl) continue;
      const key = `${e.connectionId}:${e.workspaceId}`;
      const owner = e.foreground ? runtime : connectionManager().runtime(e.connectionId);
      void owner?.blobUrl(e.avatarUrl).then((u) => alive && setOrgAvatars((m) => (m[key] === u ? m : { ...m, [key]: u })), () => {});
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avatarPaths, runtime]);

  const grouped = showsSource(switcher);
  const entries = useMemo(
    () =>
      switcher.map((e) => {
        const key = `${e.connectionId}:${e.workspaceId}`;
        return {
          id: key,
          name: e.name,
          unread: e.unread,
          active: e.foreground && e.workspaceId === sel.workspaceId,
          avatarUrl: orgAvatars[key] ?? null,
          ...(grouped ? { group: e.source } : {}),
        };
      }),
    [switcher, sel.workspaceId, orgAvatars, grouped],
  );

  const setStatus = async (option: StatusOption | null) => {
    setStatusBusy(true);
    setStatusError(null);
    try {
      const updated = await runtime.api<UserDTO>('PATCH', '/v1/me', statusPatch(option));
      auth.setUser(updated);
      void qc.invalidateQueries({ queryKey: ['members'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      setModal((m) => (m === 'status' ? null : m));
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'failed');
    } finally {
      setStatusBusy(false);
    }
  };

  const status = me.statusText || me.statusEmoji ? { emoji: me.statusEmoji, text: me.statusText } : null;
  const away = isAway(status);
  // The Chat tab's count is the Activity count Main keeps live; until Main has it (the chooser, a first render),
  // the workspace list's number for the same unread rows.
  const chatBadge = activityUnread ?? ws?.unreadCount ?? 0;

  return (
    <>
      <SuiteBar
        // The logo: Chat's home, #general (no channel selected falls back to it).
        home={{ href: '/', onSelect: () => sel.selectChannel(null) }}
        tabs={[
          {
            id: 'docs',
            label: 'Docs',
            href: '/workspace',
            disabled: !docsHere,
            ...(docsHere ? {} : { title: 'Docs is not available for an organization on another server yet' }),
          },
          { id: 'chat', label: 'Chat', href: '/', active: true, badge: chatBadge },
          { id: 'mail', label: 'Mail', href: '/mail', disabled: !docsHere, ...(docsHere ? {} : { title: 'Mail is not available for an organization on another server yet' }) },
          { id: 'calendar', label: 'Calendar', href: '', disabled: true },
        ]}
        organization={{
          name: ws?.name ?? '',
          entries,
          onSelect: (id) => {
            const e = switcher.find((x) => `${x.connectionId}:${x.workspaceId}` === id);
            if (!e) return;
            if (e.foreground) sel.selectWorkspace(e.workspaceId);
            else openWorkspace(e.connectionId, e.workspaceId);
          },
          onAdd: () => sel.selectWorkspace(null),
          addBadge: invites,
          ...(canAdmin ? { onSettings: () => sel.openAdminPanel() } : {}),
          ...(canInvite ? { onInvite: () => setModal('invite') } : {}),
        }}
        search={{
          placeholder: 'Find in this conversation',
          onSubmit: (q) => window.dispatchEvent(new CustomEvent(FIND_EVENT, { detail: q })),
        }}
        {...(docsHere ? { assistant: { onOpen: () => window.location.assign('/workspace?assistant') } } : {})}
        {...(sel.workspaceId && caps.notifications.state !== 'unavailable'
          ? { notifications: { onOpen: () => sel.selectChannel(ACTIVITY_VIEW_ID) } }
          : {})}
        account={{
          name: me.displayName,
          email: me.email,
          avatarUrl: avatar,
          status,
          ...(canSetStatus
            ? {
                presence: { active: !away, onToggle: () => void setStatus(away ? null : AWAY_STATUS) },
                onSetStatus: () => {
                  setStatusError(null);
                  setModal('status');
                },
              }
            : {}),
          onProfile: () => setModal('profile'),
          onSettings: () => setModal('settings'),
          onLogout: auth.signOut,
          // Built-in help (#383) moved here from the rail's "?"; large layout only, as it was.
          extra: narrow ? [] : [{ label: 'Help', onSelect: () => setModal('help') }],
        }}
      />
      {(modal === 'profile' || modal === 'settings') && <ProfileModal onClose={() => setModal(null)} {...(modal === 'settings' ? { section: 'notifications' as const } : {})} />}
      {modal === 'invite' && sel.workspaceId && <InviteModal workspaceId={sel.workspaceId} onClose={() => setModal(null)} />}
      {modal === 'help' && <HelpModal onClose={() => setModal(null)} />}
      {modal === 'status' && (
        <StatusDialog
          current={status}
          busy={statusBusy}
          error={statusError}
          onPick={(o) => void setStatus(o)}
          onClear={() => void setStatus(null)}
          onClose={() => setModal(null)}
        />
      )}
    </>
  );
}
