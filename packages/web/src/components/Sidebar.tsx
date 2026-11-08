import { useBoundApi } from '../lib/useBoundApi';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { webSidebarColor } from '../lib/sidebarTheme';
import type { ArtifactDTO, ChannelDTO, WorkspaceMemberDTO } from '@flow/shared';
import { api } from '../lib/api';
import { artifactGlyph } from '../lib/fileKind';
import { dmTitle, isSelfDm as isSelfDmChannel } from '../lib/channelTitle';
import { workspaceExit } from '../lib/workspaceExit';
import { ACTIVITY_VIEW_ID, ADMIN_VIEW_ID, CHANNEL_BROWSER_VIEW_ID, DIRECTORY_VIEW_ID, SCHEDULED_VIEW_ID, useAuth, useLive, useMobileNav, useSelection } from '../state';
import type { Selection } from '../state';
import { useCapabilities } from '../lib/backend';
import {
  useAppArtifacts,
  useArtifacts,
  useChannels,
  useDisplayNameMap,
  useMarkRead,
  useMemberMap,
  useMembers,
  useNameMap,
  useWorkspaces,
  useSwitcherEntries,
} from '../hooks';
import {
  ChannelMenu,
  CreateChannelModal,
  DeleteWorkspaceModal,
  InviteModal,
  LeaveWorkspaceModal,
  NewDmModal,
  WorkspaceColorModal,
} from './modals';
import { AgentsModal } from './AgentsModal';
import { requestAdminTab } from './AdminView';
import { EmojiModal } from './EmojiModal';
import { InviteAgentModal } from './InviteAgentModal';
import { openServerConnections } from './ServerConnections';
import { openWorkspace, showsSource } from '../lib/workspaceSwitcher';
import { FeaturesModal } from './FeaturesModal';
import { useHoverTooltip } from './HoverTooltip';

// Sidebar width (phase 3.5 ruling 5): local per-device preference.
/**
 * Sub-channels (#118): flatten the channel list into display order — each
 * parent immediately followed by its children, indented one level.
 *
 * Membership is per channel, so you can be in a child without being in its
 * parent. Such a child has nowhere to nest under, and hiding it would lose a
 * channel you belong to, so it renders at top level instead. That is also what
 * happens when the parent is archived.
 *
 * Input order is preserved (the server sorts by name), so parents stay
 * alphabetical and so do children within a parent.
 *
 * Only a top-level channel can host children. The server rejects grandchildren,
 * but one arriving anyway (an old row, a future rule change) renders at top
 * level rather than being indented twice or — worse — silently dropped.
 */
/** Channels A→Z by name, ignoring case (matches the native `COLLATE NOCASE`). */
export function sortChannelsByName(list: ChannelDTO[]): ChannelDTO[] {
  return [...list].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', undefined, { sensitivity: 'base' }));
}

export function nestChannels(list: ChannelDTO[]): { channel: ChannelDTO; nested: boolean }[] {
  const byId = new Map(list.map((c) => [c.id, c]));
  const parentOf = (c: ChannelDTO) => (c.parentId ? byId.get(c.parentId) : undefined);
  const childrenOf = new Map<string, ChannelDTO[]>();
  const roots: ChannelDTO[] = [];
  for (const c of list) {
    const parent = parentOf(c);
    if (parent && !parentOf(parent)) {
      childrenOf.set(parent.id, [...(childrenOf.get(parent.id) ?? []), c]);
    } else {
      roots.push(c);
    }
  }
  return roots.flatMap((c) => [
    { channel: c, nested: false },
    ...(childrenOf.get(c.id) ?? []).map((k) => ({ channel: k, nested: true })),
  ]);
}

/**
 * Minimal scroll (#319): how far the sidebar must move to bring a row into
 * view, in scrollTop pixels. Zero when the row is already fully visible — that
 * is what keeps clicking a channel in the sidebar from jumping the list.
 *
 * All three arguments are relative to the scroll viewport: `rowTop` is the
 * row's top edge measured from the viewport's top edge (negative = above the
 * fold). A row taller than the viewport aligns to its top rather than its
 * bottom, so you see the start of it.
 */
export function nearestScrollDelta(rowTop: number, rowHeight: number, viewHeight: number): number {
  if (rowTop < 0 || rowHeight > viewHeight) return rowTop;
  const overshoot = rowTop + rowHeight - viewHeight;
  return overshoot > 0 ? overshoot : 0;
}

/**
 * Scroll a sidebar row into view within the sidebar's own scroller. Deliberately
 * not `Element.scrollIntoView`, which also scrolls every scrollable ancestor —
 * here only the channel list should move.
 */
function scrollRowIntoView(row: HTMLElement) {
  const view = row.closest('[data-sidebar-scroll]') as HTMLElement | null;
  if (!view) return;
  const r = row.getBoundingClientRect();
  const v = view.getBoundingClientRect();
  const delta = nearestScrollDelta(r.top - v.top, r.height, v.height);
  if (delta !== 0) view.scrollTop += delta;
}

const WIDTH_KEY = 'flow.sidebarWidth';
const DEFAULT_WIDTH = 240;
const clampWidth = (w: number) => Math.min(360, Math.max(180, w));
function storedWidth(): number {
  const w = Number(localStorage.getItem(WIDTH_KEY));
  return Number.isFinite(w) && w > 0 ? clampWidth(w) : DEFAULT_WIDTH;
}

export { dmTitle };

/** Agents section: collapsed or not, remembered per device (like the width). */
const AGENTS_COLLAPSED_KEY = 'flow.sidebarAgentsCollapsed';
/** Apps section (#394): same per-device collapse memory as Agents. */
const APPS_COLLAPSED_KEY = 'flow.sidebarAppsCollapsed';
/**
 * Docs list (#574): the artifacts nested under a channel row. A busy channel
 * collects dozens of them and pushes the next channel off the screen, so the
 * run of rows is a group you can fold away, with a filter for finding one by
 * name. Collapse is remembered per device like the sections above — but per
 * channel, so the key holds a list of channel ids rather than a flag.
 *
 * The filter text is deliberately *not* remembered: a query left behind from
 * last week would reopen the sidebar hiding most of a channel's docs, which
 * reads as "my docs are gone", not as "a filter is on".
 */
const DOCS_COLLAPSED_KEY = 'flow.sidebarDocsCollapsed';
/** Below this many docs the group has no header: a caret, a label, a count
 * and a filter to present one or two rows is more chrome than content, and
 * the rows alone are what the macOS client shows. From here up the list can
 * push other channels off the screen, which is what the header is for. */
export const DOCS_GROUP_MIN = 4;

/** Case-insensitive substring match on an artifact name. An empty or
 * whitespace-only query matches everything, so clearing the box restores the
 * full list instead of emptying it. */
export function filterDocs<T extends { name: string }>(docs: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return docs;
  return docs.filter((d) => d.name.toLowerCase().includes(q));
}

export function readCollapsedDocs(): Set<string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(DOCS_COLLAPSED_KEY) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set(); // an unreadable preference is not worth breaking the sidebar over
  }
}

export function writeCollapsedDocs(channelId: string, collapsed: boolean) {
  const ids = readCollapsedDocs();
  if (collapsed) ids.add(channelId);
  else ids.delete(channelId);
  try {
    localStorage.setItem(DOCS_COLLAPSED_KEY, JSON.stringify([...ids]));
  } catch {
    /* storage denied (private mode): the toggle still works for this session */
  }
}

/** A row in the Apps section: the app plus the channel that hosts it. */
export type AppEntry = { artifact: ArtifactDTO; channel: ChannelDTO };

/**
 * The Apps section (#394): every mini app in the workspace the server let us
 * see — apps in public channels count whether or not we've joined them, which
 * is the whole point (a Task Board in #factory is discoverable from anywhere).
 *
 * The server already applied the visibility rule, so all this does is attach
 * each app to its host channel for the label. An app whose channel isn't in the
 * local list is dropped rather than rendered channel-less: without the channel
 * there is nothing to join and nowhere to open.
 */
export function appEntries(apps: ArtifactDTO[], channels: ChannelDTO[]): AppEntry[] {
  const byId = new Map(channels.map((c) => [c.id, c]));
  return apps.flatMap((artifact) => {
    const channel = byId.get(artifact.channelId);
    return channel ? [{ artifact, channel }] : [];
  });
}

export type AgentEntry = { member: WorkspaceMemberDTO; channel?: ChannelDTO };

/**
 * The Agents section (#361): every agent in the workspace gets a row between
 * Channels and Direct messages, whether or not a DM with it exists yet. The
 * agent's 1:1 DM moves up here with it — an agent is listed once, never twice.
 *
 * A *group* DM that happens to include an agent stays under Direct messages:
 * it's a conversation with several people, not a way to reach the agent. So is
 * the self-DM, even if you are yourself an agent.
 */
export function splitAgents(
  dms: ChannelDTO[],
  members: WorkspaceMemberDTO[],
  me: string,
): { agents: AgentEntry[]; rest: ChannelDTO[] } {
  const agentIds = new Set(members.filter((m) => m.isAgent && m.userId !== me).map((m) => m.userId));
  const dmWith = new Map<string, ChannelDTO>();
  const rest: ChannelDTO[] = [];
  for (const c of dms) {
    const others = (c.memberIds ?? []).filter((id) => id !== me);
    const only = others.length === 1 ? others[0] : undefined;
    const agentId = c.kind === 'dm' && only && agentIds.has(only) ? only : null;
    // Duplicate 1:1 rows shouldn't exist (the server dedupes by member set),
    // but if one ever does, the extra stays under Direct messages rather than
    // vanishing.
    if (agentId && !dmWith.has(agentId)) dmWith.set(agentId, c);
    else rest.push(c);
  }
  const agents = members
    .filter((m) => agentIds.has(m.userId))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }))
    .map((member) => ({ member, channel: dmWith.get(member.userId) }));
  return { agents, rest };
}

export default function Sidebar() {
  const { api } = useBoundApi();
  const auth = useAuth();
  const sel = useSelection();
  const live = useLive();
  const qc = useQueryClient();
  const workspaces = useWorkspaces();
  const switcher = useSwitcherEntries();
  const labelSources = showsSource(switcher);
  const channels = useChannels(sel.workspaceId);
  const artifacts = useArtifacts(sel.workspaceId);
  const appArtifacts = useAppArtifacts(sel.workspaceId);
  const members = useMembers(sel.workspaceId);
  const memberMap = useMemberMap(sel.workspaceId);
  const names = useNameMap(sel.workspaceId);
  const displayNames = useDisplayNameMap(sel.workspaceId); // agent names carry the 🤖 badge
  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [showNewDm, setShowNewDm] = useState(false);
  const [showColor, setShowColor] = useState(false);
  const [showLeave, setShowLeave] = useState(false);
  const [showDeleteWs, setShowDeleteWs] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const [showAgents, setShowAgents] = useState(false);
  const [showInviteAgent, setShowInviteAgent] = useState(false);
  const [showFeatures, setShowFeatures] = useState(false);
  const [menuChannel, setMenuChannel] = useState<ChannelDTO | null>(null);
  const [width, setWidth] = useState(storedWidth);
  const [agentsCollapsed, setAgentsCollapsed] = useState(
    () => localStorage.getItem(AGENTS_COLLAPSED_KEY) === '1',
  );
  const [appsCollapsed, setAppsCollapsed] = useState(
    () => localStorage.getItem(APPS_COLLAPSED_KEY) === '1',
  );
  const dragRef = useRef<{ x: number; w: number } | null>(null);
  const wsMenuRef = useRef<HTMLDivElement>(null);
  // Inside the mobile drawer the sidebar fills whatever the rail leaves, so
  // the stored desktop width (and its drag handle) sit this one out.
  const { isMobile } = useMobileNav();

  // Dismiss the workspace dropdown on outside click or Escape
  // (QA w7g2 finding: it previously only closed via the trigger).
  useEffect(() => {
    if (!wsMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wsMenuRef.current && !wsMenuRef.current.contains(e.target as Node)) setWsMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setWsMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [wsMenuOpen]);

  // Cmd/Ctrl+[ and Cmd/Ctrl+] mirror the header's back/forward buttons (#386).
  // Skipped while the caret is in a composer or any other text field, where
  // the browser's own bracket handling belongs to the person typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.key !== '[' && e.key !== ']') return;
      if (isTextEntry(e.target)) return;
      e.preventDefault();
      if (e.key === '[') sel.goBack();
      else sel.goForward();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [sel]);

  const ws = (workspaces.data ?? []).find((w) => w.id === sel.workspaceId);
  const isAdmin = ws?.role === 'owner' || ws?.role === 'admin';
  // Which way out this workspace offers — see lib/workspaceExit, which is
  // mirrored in Swift and holds the "roster not loaded yet" rule.
  const exit = workspaceExit(ws?.role, members.data, auth.user.id);
  const color = webSidebarColor(ws?.sidebarColor);

  // Restored-workspace guard + default channel: a stale persisted workspace id
  // falls back to the chooser; a workspace opened with no channel selected
  // lands on #general (phase 3.5 fixes).
  useEffect(() => {
    if (workspaces.data && sel.workspaceId && !workspaces.data.some((w) => w.id === sel.workspaceId)) {
      sel.selectWorkspace(null);
    }
  }, [workspaces.data, sel]);
  useEffect(() => {
    if (sel.channelId || !channels.data) return;
    const general = channels.data.find((c) => c.isMember && c.name === 'general');
    const fallback = channels.data.find((c) => c.isMember && c.kind === 'standard');
    const target = general ?? fallback;
    if (target) sel.selectChannel(target.id);
  }, [channels.data, sel]);

  // Persistent self-DM: ensure "<Name> (you)" always exists under Direct
  // Messages (upsert — the server dedupes by dm_key, so this is idempotent).
  // Capability gating (#545): Flow-only controls are not rendered in a
  // workspace whose backend cannot do them, and never fall through to a Flow
  // mutation. The reasons come from the backend, not from guesses here.
  const caps = useCapabilities();
  const canManage = caps.channelManagement.state !== 'unavailable';
  const ensuredSelfDm = useRef<string | null>(null);
  useEffect(() => {
    const wsId = sel.workspaceId;
    if (!wsId || !channels.data || ensuredSelfDm.current === wsId || !canManage) return;
    const haveSelf = channels.data.some(
      (c) => c.kind === 'dm' && (c.memberIds ?? []).every((id) => id === auth.user.id),
    );
    if (haveSelf) { ensuredSelfDm.current = wsId; return; }
    ensuredSelfDm.current = wsId;
    void api('POST', `/v1/workspaces/${wsId}/dms`, { userIds: [auth.user.id] })
      .then(() => qc.invalidateQueries({ queryKey: ['channels', wsId] }))
      .catch(() => { ensuredSelfDm.current = null; });
  }, [sel.workspaceId, channels.data, auth.user.id, qc, canManage]);

  const openDm = async (userId: string) => {
    if (!sel.workspaceId) return;
    const ch = await api<ChannelDTO>('POST', `/v1/workspaces/${sel.workspaceId}/dms`, { userIds: [userId] });
    await qc.invalidateQueries({ queryKey: ['channels', sel.workspaceId] });
    sel.selectChannel(ch.id);
  };
  const all = channels.data ?? [];
  const dms = all.filter((c) => c.isMember && c.kind !== 'standard');
  // A sub-channel of a DM (an agent's log channel, say) belongs to that
  // conversation, not to the workspace — so it renders under its DM row down in
  // Direct Messages and is kept out of Channels entirely.
  const dmIds = new Set(dms.map((c) => c.id));
  const dmChildren = new Map<string, ChannelDTO[]>();
  for (const c of all) {
    if (c.isMember && c.kind === 'standard' && c.parentId && dmIds.has(c.parentId)) {
      dmChildren.set(c.parentId, [...(dmChildren.get(c.parentId) ?? []), c]);
    }
  }
  // Sorted here, not trusted from the server (the native sidebars sort by name
  // in their local query too).
  const joinedAll = all.filter((c) => c.isMember && c.kind === 'standard' && !(c.parentId && dmIds.has(c.parentId)));
  const joined = nestChannels(sortChannelsByName(joinedAll));
  // The self-DM ("<you> (you)") is a personal scratchpad — it never carries an
  // unread badge (ui_nits): you can't have unread messages from yourself.
  const isSelfDm = (c: ChannelDTO) => isSelfDmChannel(c, auth.user.id);
  // Phase 13: artifacts nest under their channel. Group the (newest-first) list
  // by channelId so each channel row can render its pinned artifacts beneath it.
  const artifactsByChannel = new Map<string, ArtifactDTO[]>();
  for (const a of artifacts.data ?? []) {
    const list = artifactsByChannel.get(a.channelId);
    if (list) list.push(a);
    else artifactsByChannel.set(a.channelId, [a]);
  }
  // Apps (#394): workspace-wide mini-app discovery. Server-ordered by name.
  const apps = appEntries(appArtifacts.data ?? [], all);
  /**
   * One click = land in the app. A public channel we haven't joined is joined
   * first, and we wait for the refetch before switching: the side panel builds
   * its tabs from the *member* artifact list, so opening early would show a
   * panel with nothing in it and immediately close itself again.
   */
  const openApp = async ({ artifact, channel }: AppEntry) => {
    if (!channel.isMember) {
      try {
        await api('POST', `/v1/channels/${channel.id}/join`);
      } catch {
        return; // the channel went private/archived under us — leave the user put
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['channels', sel.workspaceId] }),
        qc.invalidateQueries({ queryKey: ['artifacts', sel.workspaceId] }),
      ]);
    }
    sel.openArtifactIn(channel.id, artifact.id);
  };
  // Agents live in their own section between Channels and Direct messages
  // (#361) — every workspace agent, with or without an existing DM. The ones
  // that have a DM take it with them, so nobody is listed twice.
  const { agents, rest: dmList } = splitAgents(dms, Object.values(memberMap), auth.user.id);
  // Direct messages is ONE alphabetically-sorted list (ui_nits). The self-DM
  // ("<you> (you)") is always pinned last: it's a personal scratchpad, not a
  // conversation, so it sinks below everyone else.
  const dmItems = dmList
    .map((c) => ({ title: dmTitle(c, displayNames, auth.user.id), self: isSelfDm(c), channel: c }))
    .sort((a, b) =>
      a.self !== b.self
        ? Number(a.self) - Number(b.self)
        : a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
    );

  return (
    <aside
      className="relative flex shrink-0 flex-col text-white max-md:min-w-0 max-md:grow max-md:basis-0"
      style={{
        width: isMobile ? undefined : width,
        background: `linear-gradient(to bottom, ${color.top}, ${color.bottom})`,
      }}
    >
      <div ref={wsMenuRef} className="relative flex items-center justify-between px-3.5 pt-5 pb-2">
        <WorkspaceTitle name={ws?.name} onClick={() => setWsMenuOpen((v) => !v)} />
        {wsMenuOpen && (
          <div className="absolute top-12 left-3 right-3 z-20 rounded-lg bg-white py-1 text-ink shadow-[0_12px_40px_rgba(20,8,40,.4)]">
            {/* Every connection's workspaces, other servers' included; one on
                another connection switches this window to it. */}
            {switcher.map((w) => (
              <MenuItem
                key={`${w.connectionId}:${w.workspaceId}`}
                testid={`menu-workspace-${w.workspaceId}`}
                onClick={() => {
                  setWsMenuOpen(false);
                  if (w.foreground) sel.selectWorkspace(w.workspaceId);
                  else openWorkspace(w.connectionId, w.workspaceId);
                }}
              >
                {w.foreground && w.workspaceId === sel.workspaceId ? '✓ ' : ''}{w.name}
                {labelSources && <span className="ml-1.5 text-xs text-faint">{w.source}</span>}
              </MenuItem>
            ))}
            <hr className="my-1 border-hairline3" />
            {canManage && <MenuItem testid="menu-invite" onClick={() => { setWsMenuOpen(false); setShowInvite(true); }}>
              Invite People…
            </MenuItem>}
            <MenuItem testid="menu-directory" onClick={() => { setWsMenuOpen(false); sel.selectChannel(DIRECTORY_VIEW_ID); }}>
              Directory
            </MenuItem>
            {/* any member can sponsor agents (AGENT_MEMBERS.md) — the modal
                explains registration and lets sponsors remove their own */}
            {caps.agents.state !== 'unavailable' && <MenuItem testid="menu-agents" onClick={() => { setWsMenuOpen(false); setShowAgents(true); }}>
              Agents…
            </MenuItem>}
            {caps.admin.state !== 'unavailable' && <MenuItem testid="menu-automations" onClick={() => { setWsMenuOpen(false); requestAdminTab('automations'); sel.openAdminPanel(); }}>
              Automations…
            </MenuItem>}
            {isAdmin && caps.admin.state !== 'unavailable' && (
              <>
                <MenuItem testid="menu-workspace-color" onClick={() => { setWsMenuOpen(false); setShowColor(true); }}>
                  Workspace appearance…
                </MenuItem>
                <MenuItem testid="menu-emoji" onClick={() => { setWsMenuOpen(false); setShowEmoji(true); }}>
                  Custom Emoji…
                </MenuItem>
                <MenuItem testid="menu-admin" onClick={() => { setWsMenuOpen(false); requestAdminTab('organization'); sel.openAdminPanel(); }}>
                  Manage Users…
                </MenuItem>
              </>
            )}
            <MenuItem onClick={() => { setWsMenuOpen(false); sel.selectWorkspace(null); }}>
              All Workspaces
            </MenuItem>
            {/* Workspace/nav-level actions live in this menu (#563, #565) —
                the switcher used to be a button floating over the composer. */}
            <MenuItem testid="menu-connections" onClick={() => { setWsMenuOpen(false); openServerConnections(); }}>
              Workspaces &amp; servers…
            </MenuItem>
            {/* Leaving is self-service for everyone but the owner (#340). An
                owner with company has to hand the workspace over first; an
                owner on their own has nobody to hand it to, so they get to end
                it instead of staring at a permanently disabled row. */}
            {!canManage ? null : exit === 'delete' ? (
              <MenuItem
                testid="menu-delete-workspace"
                destructive
                onClick={() => { setWsMenuOpen(false); setShowDeleteWs(true); }}
              >
                Delete workspace…
              </MenuItem>
            ) : (
              <MenuItem
                testid="menu-leave-workspace"
                destructive
                disabled={exit === 'transferFirst'}
                title={exit === 'transferFirst' ? 'Transfer ownership first' : undefined}
                onClick={() => { setWsMenuOpen(false); setShowLeave(true); }}
              >
                Leave workspace
                {exit === 'transferFirst' && (
                  <span className="ml-1 text-ink/35">— transfer ownership first</span>
                )}
              </MenuItem>
            )}
            <hr className="my-1 border-hairline3" />
            <button
              data-testid="build-number"
              className="block w-full px-3 py-1 text-left text-xs text-ink/40 italic hover:bg-accent/10"
              title="What's new"
              onClick={() => { setWsMenuOpen(false); setShowFeatures(true); }}
            >
              Build {__BUILD__}
            </button>
          </div>
        )}
        <div className="flex shrink-0 items-center">
          <NavButton dir="back" enabled={sel.canGoBack} onClick={() => sel.goBack()} />
          <NavButton dir="forward" enabled={sel.canGoForward} onClick={() => sel.goForward()} />
          {caps.scheduledMessages.state !== 'unavailable' && <ScheduledClock
            active={sel.channelId === SCHEDULED_VIEW_ID}
            onOpen={() => sel.selectChannel(SCHEDULED_VIEW_ID)}
          />}
          {caps.notifications.state !== 'unavailable' && <ActivityBell
            active={sel.channelId === ACTIVITY_VIEW_ID}
            unread={live.notificationUnread}
            onOpen={() => sel.selectChannel(ACTIVITY_VIEW_ID)}
          />}
        </div>
      </div>

      <div
        data-sidebar-scroll
        className="mc-scroll mc-scroll-dark min-h-0 flex-1 overflow-y-auto px-3.5 pb-2 text-sm"
      >
        {sel.adminPanelOpen && caps.admin.state !== 'unavailable' && (
          <AdminRow
            label={isAdmin ? 'Manage users' : 'Automations'}
            active={sel.channelId === ADMIN_VIEW_ID}
            onOpen={() => sel.selectChannel(ADMIN_VIEW_ID)}
            onClose={() => sel.closeAdminPanel()}
          />
        )}

        <SectionHeader
          label="Channels"
          action={canManage ? {
            label: '+',
            testid: 'sidebar-create-channel',
            title: 'Create a channel',
            onClick: () => setShowCreateChannel(true),
          } : undefined}
        />
        {joined.map(({ channel: c, nested }) => (
          <div key={c.id}>
            <ChannelRow channel={c} label={c.name ?? ''} nested={nested} onMenu={() => setMenuChannel(c)} />
            <DocsGroup channelId={c.id} docs={artifactsByChannel.get(c.id) ?? []} />
          </div>
        ))}
        {/* Channel browser (#588): one nav row replaces the inline Browse list
            of every unjoined channel, which didn't scale. */}
        {canManage && (
          <BrowseAllRow
            active={sel.channelId === CHANNEL_BROWSER_VIEW_ID}
            onOpen={() => sel.selectChannel(CHANNEL_BROWSER_VIEW_ID)}
          />
        )}

        {/* Apps (#394): every mini app in the workspace, including ones in public
            channels this user hasn't joined — clicking joins, then opens the app.
            Collapsible, and absent entirely when there is nothing to list. */}
        {apps.length > 0 && (
          <>
            <SectionHeader
              label="Apps"
              collapsed={appsCollapsed}
              onToggle={() => {
                const next = !appsCollapsed;
                setAppsCollapsed(next);
                localStorage.setItem(APPS_COLLAPSED_KEY, next ? '1' : '0');
              }}
            />
            {!appsCollapsed &&
              apps.map((entry) => (
                <AppRow
                  key={entry.artifact.id}
                  entry={entry}
                  channelLabel={channelLabel(entry.channel, displayNames, auth.user.id)}
                  onOpen={() => void openApp(entry)}
                />
              ))}
          </>
        )}

        {/* Agents (#361): one row per workspace agent, above Direct messages.
            Collapsible, and hidden entirely in a workspace with no agents. */}
        {agents.length > 0 && (
          <>
            <SectionHeader
              label="Agents"
              collapsed={agentsCollapsed}
              onToggle={() => {
                const next = !agentsCollapsed;
                setAgentsCollapsed(next);
                localStorage.setItem(AGENTS_COLLAPSED_KEY, next ? '1' : '0');
              }}
            />
            {!agentsCollapsed &&
              agents.map(({ member: a, channel: c }) =>
                c ? (
                  // The agent's DM, rendered as the agent: same row as any DM,
                  // so unread badges, the working-here spinner and its
                  // sub-channels all come along.
                  <div key={c.id}>
                    <ChannelRow
                      channel={c}
                      testid={`sidebar-agent-${a.displayName}`}
                      label={a.displayName}
                      statusEmoji={a.statusEmoji}
                      statusTitle={a.statusText}
                      leading={<PresenceDot online={live.isOnline(a.userId)} />}
                      onMenu={() => setMenuChannel(c)}
                    />
                    <DocsGroup channelId={c.id} docs={artifactsByChannel.get(c.id) ?? []} />
                    {(dmChildren.get(c.id) ?? []).map((k) => (
                      <div key={k.id}>
                        <ChannelRow channel={k} label={k.name ?? ''} nested onMenu={() => setMenuChannel(k)} />
                        <DocsGroup channelId={k.id} docs={artifactsByChannel.get(k.id) ?? []} />
                      </div>
                    ))}
                  </div>
                ) : (
                  // No DM yet — a virtual row; clicking creates one.
                  <button
                    key={`agent-${a.userId}`}
                    data-testid={`sidebar-agent-${a.displayName}`}
                    title="Start a direct message"
                    className="flex w-full items-center gap-[9px] rounded-lg px-2 py-[7px] text-left text-white/80 hover:bg-white/10"
                    onClick={() => void openDm(a.userId)}
                  >
                    <PresenceDot online={live.isOnline(a.userId)} />
                    <span className="truncate">{a.displayName}</span>
                  </button>
                ),
              )}
          </>
        )}

        <SectionHeader
          label="Direct messages"
          action={canManage ? {
            label: '+',
            testid: 'sidebar-new-dm',
            title: 'New direct message',
            onClick: () => setShowNewDm(true),
          } : undefined}
        />
        {/* Directory (#430): a nav entry, not a DM row — it highlights when
            active and opens the member grid rather than a conversation. */}
        <DirectoryRow
          active={sel.channelId === DIRECTORY_VIEW_ID}
          onOpen={() => sel.selectChannel(DIRECTORY_VIEW_ID)}
        />
        {dmItems.map((item) => {
          const c = item.channel;
          const title = dmTitle(c, names, auth.user.id);
          const otherId = (c.memberIds ?? []).find((id) => id !== auth.user.id);
          const status = otherId ? memberMap[otherId] : undefined;
          return (
            <div key={c.id}>
              <ChannelRow
                channel={c}
                testid={`sidebar-dm-${title}`}
                hideUnread={isSelfDm(c)}
                label={dmTitle(c, displayNames, auth.user.id)}
                statusEmoji={c.kind === 'dm' ? status?.statusEmoji : ''}
                statusTitle={c.kind === 'dm' ? status?.statusText : ''}
                leading={
                  c.kind === 'dm' ? (
                    // self-DM: you're online by definition (this client is connected)
                    <PresenceDot online={otherId ? live.isOnline(otherId) : true} />
                  ) : (
                    <span className="text-xs text-white/60">👥</span>
                  )
                }
                onMenu={() => setMenuChannel(c)}
              />
              <DocsGroup channelId={c.id} docs={artifactsByChannel.get(c.id) ?? []} />
              {(dmChildren.get(c.id) ?? []).map((k) => (
                <div key={k.id}>
                  <ChannelRow channel={k} label={k.name ?? ''} nested onMenu={() => setMenuChannel(k)} />
                  <DocsGroup channelId={k.id} docs={artifactsByChannel.get(k.id) ?? []} />
                </div>
              ))}
            </div>
          );
        })}

      </div>

      {/* Invite your Agent (phase 15): pinned to the sidebar's foot (the
          profile footer moved into the suite bar's account menu) — a slightly
          raised translucent CTA, noticeable without shouting. */}
      {caps.agents.state !== 'unavailable' && <div className="px-3.5 pt-2 pb-3.5">
        <button
          data-testid="invite-agent-button"
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/35 bg-white/[0.18] px-3 py-2 text-[13px] font-semibold text-white shadow-sm hover:bg-white/25"
          onClick={() => setShowInviteAgent(true)}
        >
          <span aria-hidden>🤖</span>
          Invite your Agent
        </button>
      </div>}

      <div
        data-testid="sidebar-resizer"
        className="absolute inset-y-0 right-0 z-10 w-1 cursor-col-resize hover:bg-white/30 max-md:hidden"
        onPointerDown={(e) => {
          e.preventDefault();
          dragRef.current = { x: e.clientX, w: width };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const drag = dragRef.current;
          if (drag) setWidth(clampWidth(drag.w + e.clientX - drag.x));
        }}
        onPointerUp={(e) => {
          const drag = dragRef.current;
          if (!drag) return;
          dragRef.current = null;
          const final = clampWidth(drag.w + e.clientX - drag.x);
          setWidth(final);
          localStorage.setItem(WIDTH_KEY, String(final));
        }}
        onDoubleClick={() => {
          setWidth(DEFAULT_WIDTH);
          localStorage.setItem(WIDTH_KEY, String(DEFAULT_WIDTH));
        }}
      />

      {showCreateChannel && sel.workspaceId && (
        <CreateChannelModal workspaceId={sel.workspaceId} onClose={() => setShowCreateChannel(false)} />
      )}
      {showInvite && sel.workspaceId && <InviteModal workspaceId={sel.workspaceId} onClose={() => setShowInvite(false)} />}
      {showNewDm && sel.workspaceId && <NewDmModal workspaceId={sel.workspaceId} onClose={() => setShowNewDm(false)} />}
      {showColor && sel.workspaceId && <WorkspaceColorModal workspaceId={sel.workspaceId} onClose={() => setShowColor(false)} />}
      {showLeave && sel.workspaceId && (
        <LeaveWorkspaceModal workspaceId={sel.workspaceId} onClose={() => setShowLeave(false)} />
      )}
      {showDeleteWs && sel.workspaceId && (
        <DeleteWorkspaceModal workspaceId={sel.workspaceId} onClose={() => setShowDeleteWs(false)} />
      )}
      {showEmoji && sel.workspaceId && <EmojiModal workspaceId={sel.workspaceId} onClose={() => setShowEmoji(false)} />}
      {showAgents && sel.workspaceId && <AgentsModal workspaceId={sel.workspaceId} onClose={() => setShowAgents(false)} />}
      {showInviteAgent && sel.workspaceId && (
        <InviteAgentModal workspaceId={sel.workspaceId} onClose={() => setShowInviteAgent(false)} />
      )}
      {showFeatures && <FeaturesModal onClose={() => setShowFeatures(false)} />}
      {menuChannel && <ChannelMenu channel={menuChannel} onClose={() => setMenuChannel(null)} />}
    </aside>
  );
}

/** Is the keyboard event aimed at somewhere a person is typing? */
function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable
  );
}

/**
 * One of the workspace header's visit-history buttons (#386). Disabled — dimmed
 * and non-interactive — at whichever end of the history it sits at, which on a
 * fresh session is both of them.
 */
/**
 * The workspace name + switcher affordance. It is the only thing in the header
 * that gives ground (#456): `min-w-0` lets it shrink below its text width and
 * `truncate` ellipsises what is left, so the nav/clock/bell cluster beside it —
 * all `shrink-0` — stays whole down to the 180px minimum sidebar. The full name
 * stays reachable as the hover tooltip.
 */
export function WorkspaceTitle({ name, onClick }: { name?: string; onClick: () => void }) {
  const label = name ?? 'Workspace';
  return (
    <button
      data-testid="workspace-menu"
      title={label}
      className="flex min-w-0 items-center gap-1 rounded px-1 text-left text-base font-bold hover:bg-white/10"
      onClick={onClick}
    >
      <span className="truncate">{label}</span>
      <span className="shrink-0 text-xs text-white/55">▾</span>
    </button>
  );
}

export function NavButton({
  dir,
  enabled,
  onClick,
}: {
  dir: 'back' | 'forward';
  enabled: boolean;
  onClick: () => void;
}) {
  const label = dir === 'back' ? 'Back' : 'Forward';
  return (
    <button
      data-testid={`nav-${dir}`}
      title={label}
      aria-label={label}
      disabled={!enabled}
      className={`shrink-0 rounded-lg px-1 py-1.5 leading-none ${
        enabled ? 'text-white/75 hover:bg-white/10' : 'cursor-default text-white/25'
      }`}
      onClick={onClick}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <polyline points={dir === 'back' ? '15 18 9 12 15 6' : '9 18 15 12 9 6'} />
      </svg>
    </button>
  );
}

/**
 * The Activity feed's bell (#385) — fixed in the workspace header rather than
 * sitting at the top of the channel list, so it can never scroll out of view
 * and the list holds only real channels. Carries the notification unread badge
 * and shows a selected state while the Activity feed is the open view.
 */
/**
 * The Scheduled panel's entry point (#420) — a clock sitting next to the
 * Activity bell, because both open a global per-user view rather than a
 * channel. No badge: a scheduled message that fired is already a message in a
 * channel, so there is nothing here left unread.
 */
export function ScheduledClock({ active, onOpen }: { active: boolean; onOpen: () => void }) {
  return (
    <button
      data-testid="sidebar-scheduled"
      data-active={active ? 'true' : 'false'}
      title="Scheduled messages"
      aria-label="Scheduled messages"
      aria-current={active ? 'page' : undefined}
      className={`relative ml-1 shrink-0 rounded-lg px-1.5 py-1 text-base leading-none ${
        active ? 'bg-white' : 'hover:bg-white/10'
      }`}
      onClick={onOpen}
    >
      <span className={active ? 'opacity-70' : 'opacity-75'}>🕐</span>
    </button>
  );
}

export function ActivityBell({
  active,
  unread,
  onOpen,
}: {
  active: boolean;
  unread: number;
  onOpen: () => void;
}) {
  return (
    <button
      data-testid="sidebar-activity"
      data-unread={unread}
      data-active={active ? 'true' : 'false'}
      title="Activity"
      aria-label="Activity"
      aria-current={active ? 'page' : undefined}
      className={`relative ml-1 shrink-0 rounded-lg px-1.5 py-1 text-base leading-none ${
        active ? 'bg-white' : 'hover:bg-white/10'
      }`}
      onClick={onOpen}
    >
      <span className={active ? 'opacity-70' : 'opacity-75'}>🔔</span>
      {unread > 0 && (
        <span className="absolute -top-1 -right-1 rounded-[9px] bg-unread px-[5px] py-px text-[10px] font-bold text-white">
          {Math.min(unread, 99)}
        </span>
      )}
    </button>
  );
}

/**
 * The admin panel's pinned sidebar row — a virtual, client-only entry (no real
 * channel). Selectable like a channel; the hover × closes it (pure UI hide,
 * reopen from the workspace menu). Only rendered for admins.
 */
/** "Browse all" at the end of the Channels section (#588) — opens the channel
 * browser. Muted, so it reads as a nav affordance rather than a channel. */
function BrowseAllRow({ active, onOpen }: { active: boolean; onOpen: () => void }) {
  return (
    <button
      data-testid="sidebar-browse-all"
      title="Browse all channels"
      className={`flex w-full items-center gap-[9px] rounded-lg px-2 py-[7px] text-left text-[13px] ${
        active ? 'bg-white text-accent-deep' : 'hover:bg-white/10'
      }`}
      onClick={onOpen}
    >
      <span className={active ? 'opacity-70' : 'text-white/50'}>⋯</span>
      <span className={`truncate ${active ? 'font-[650]' : 'text-white/60'}`}>Browse all</span>
    </button>
  );
}

/** The Directory entry under the Direct messages header (#430) — same nav-item
 * shape as the admin row, minus the dismiss button (it is always offered). */
function DirectoryRow({ active, onOpen }: { active: boolean; onOpen: () => void }) {
  return (
    <button
      data-testid="sidebar-directory"
      title="Browse everyone in this workspace"
      className={`flex w-full items-center gap-[9px] rounded-lg px-2 py-[7px] text-left ${
        active ? 'bg-white text-accent-deep' : 'hover:bg-white/10'
      }`}
      onClick={onOpen}
    >
      <span className={active ? 'opacity-70' : 'text-white/60'}>👥</span>
      <span className={`truncate ${active ? 'font-[650]' : 'text-white/82'}`}>Directory</span>
    </button>
  );
}

function AdminRow({
  label,
  active,
  onOpen,
  onClose,
}: {
  label: string;
  active: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className={`group mt-1 flex items-center gap-[9px] rounded-lg px-2 py-[7px] ${
        active ? 'bg-white text-accent-deep' : 'hover:bg-white/10'
      }`}
    >
      <button
        data-testid="sidebar-admin"
        className="flex min-w-0 flex-1 items-center gap-[9px] text-left"
        onClick={onOpen}
      >
        <span className={active ? 'opacity-70' : 'text-white/60'}>🛡️</span>
        <span className={`truncate ${active ? 'font-[650]' : 'text-white/82'}`}>{label}</span>
      </button>
      <button
        data-testid="sidebar-admin-close"
        title="Close"
        className={`hidden rounded px-1 text-xs group-hover:block ${
          active ? 'text-accent-deep/60 hover:text-accent-deep' : 'text-white/55 hover:text-white'
        }`}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        ✕
      </button>
    </div>
  );
}

/**
 * The Docs group under a channel (#574): the channel's artifacts, foldable and
 * filterable.
 *
 * The filter hides behind a 🔍 so a channel with two docs doesn't grow a search
 * box it will never need — but it is there at any length, so a list you can't
 * scan is always one click from being scannable. Nothing about opening a doc
 * changes: the rows below are the same `ArtifactRow`s as before.
 */
export function DocsGroup({ channelId, docs }: { channelId: string; docs: ArtifactDTO[] }) {
  const [collapsed, setCollapsed] = useState(() => readCollapsedDocs().has(channelId));
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (searching) inputRef.current?.focus();
  }, [searching]);

  if (docs.length === 0) return null;
  // A short list is just the rows, nested under the channel like before #574.
  if (docs.length < DOCS_GROUP_MIN) {
    return (
      <div className="ml-3" data-testid={`sidebar-docs-plain-${channelId}`}>
        {docs.map((a) => <ArtifactRow key={a.id} artifact={a} />)}
      </div>
    );
  }
  const shown = filterDocs(docs, query);
  const closeSearch = () => {
    setSearching(false);
    setQuery('');
  };

  return (
    <div className="ml-3">
      <div className="flex items-center gap-1 px-2 pt-1">
        <button
          data-testid={`sidebar-docs-toggle-${channelId}`}
          aria-expanded={!collapsed}
          title={collapsed ? 'Show docs' : 'Hide docs'}
          className="flex min-w-0 flex-1 items-center gap-1 rounded text-[10px] font-semibold tracking-[.06em] text-white/45 uppercase hover:text-white/75"
          onClick={() => {
            const next = !collapsed;
            setCollapsed(next);
            writeCollapsedDocs(channelId, next);
            if (next) closeSearch(); // a hidden list has nothing to filter
          }}
        >
          <span className="text-[9px]" aria-hidden>{collapsed ? '▸' : '▾'}</span>
          Docs
          {/* While filtering, the count says how much of the list you are
              looking at — 2/14 reads as "filtered", a bare 2 reads as "two
              docs", which is the one thing it must not say. */}
          <span className="font-normal tracking-normal tabular-nums opacity-70">
            {query.trim() ? `${shown.length}/${docs.length}` : docs.length}
          </span>
        </button>
        {!collapsed && !searching && (
          <button
            data-testid={`sidebar-docs-search-${channelId}`}
            title="Filter docs"
            className="rounded px-1 text-[10px] text-white/40 hover:bg-white/10 hover:text-white"
            onClick={() => setSearching(true)}
          >
            🔍
          </button>
        )}
      </div>

      {!collapsed && searching && (
        <input
          ref={inputRef}
          data-testid={`sidebar-docs-filter-${channelId}`}
          value={query}
          placeholder="Filter docs…"
          aria-label="Filter docs"
          className="mt-1 mb-0.5 w-full rounded-md bg-white/10 px-2 py-1 text-xs text-white placeholder:text-white/40 focus:bg-white/15 focus:outline-none"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') closeSearch();
          }}
          onBlur={() => {
            if (!query) setSearching(false); // an empty box is just clutter
          }}
        />
      )}

      {!collapsed &&
        shown.map((a) => <ArtifactRow key={a.id} artifact={a} />)}
      {!collapsed && shown.length === 0 && (
        <div data-testid={`sidebar-docs-empty-${channelId}`} className="px-2 py-1 text-xs text-white/40">
          No docs match “{query.trim()}”
        </div>
      )}
    </div>
  );
}

/** An artifact row (phase 13): nested under its channel; selectable opens the
 * side panel; hover ✕ DELETES the shared artifact (and its own file, if the
 * artifact owns it — server-side). */
/** How an app row names its host channel: `#name` for a channel, the member
 * names for a DM (an app can be pinned in one). */
export function channelLabel(c: ChannelDTO, names: Record<string, string>, me: string): string {
  return c.kind === 'standard' ? `#${c.name ?? ''}` : dmTitle(c, names, me);
}

/**
 * An Apps-section row: the app's name over its host channel in muted text —
 * two channels can host same-named apps, and for a channel you haven't joined
 * the channel *is* the context. Not nested like an artifact row: this list is
 * flat, and the channel is named rather than implied by indentation.
 */
function AppRow({
  entry,
  channelLabel: channelName,
  onOpen,
}: {
  entry: AppEntry;
  channelLabel: string;
  onOpen: () => void;
}) {
  const sel = useSelection();
  const { artifact, channel } = entry;
  const active = sel.artifactId === artifact.id && sel.channelId === channel.id;
  return (
    <button
      data-testid={`sidebar-app-${artifact.name}`}
      title={`${artifact.name} — ${channelName}`}
      className="flex w-full items-center gap-[9px] rounded-lg px-2 py-[5px] text-left hover:bg-white/10"
      onClick={onOpen}
    >
      <span className={active ? 'text-white' : 'text-white/60'}>🧩</span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className={`truncate ${active ? 'font-bold text-white' : 'text-white/82'}`}>{artifact.name}</span>
        <span className="truncate text-[11px] text-white/45">{channelName}</span>
      </span>
    </button>
  );
}

function ArtifactRow({ artifact }: { artifact: ArtifactDTO }) {
  const { api } = useBoundApi();
  const sel = useSelection();
  const qc = useQueryClient();
  const active = sel.artifactId === artifact.id;
  return (
    // No white pill for the active artifact — it would stack under the active
    // channel's pill (double-highlight). Selection reads as bold white text.
    <div className="group flex items-center gap-[9px] rounded-lg px-2 py-[5px] hover:bg-white/10">
      <button
        data-testid={`sidebar-artifact-${artifact.name}`}
        className="flex min-w-0 flex-1 items-center gap-[9px] text-left"
        onClick={() => sel.selectArtifact(artifact.id)}
      >
        <span className={active ? 'text-white' : 'text-white/60'}>{artifactGlyph(artifact)}</span>
        <span className={`truncate ${active ? 'font-bold text-white' : 'text-white/82'}`}>{artifact.name}</span>
      </button>
      <button
        data-testid={`sidebar-artifact-remove-${artifact.name}`}
        title="Remove artifact"
        className="hidden rounded px-1 text-xs text-white/55 hover:text-white group-hover:block"
        onClick={(e) => {
          e.stopPropagation();
          void api('DELETE', `/v1/artifacts/${artifact.id}`).then(() => {
            if (active) sel.selectArtifact(null);
            return qc.invalidateQueries({ queryKey: ['artifacts', artifact.workspaceId] });
          });
        }}
      >
        ✕
      </button>
    </div>
  );
}

function PresenceDot({ online }: { online: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${online ? 'bg-online' : 'border-[1.5px] border-white/40'}`}
    />
  );
}

function SectionHeader({
  label,
  action,
  collapsed,
  onToggle,
}: {
  label: string;
  action?: { label: string; testid: string; title: string; onClick: () => void };
  /** Collapsible section (#361): the label becomes a toggle with a caret. */
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  return (
    <div className="mt-4 mb-1 flex items-center justify-between px-2 first:mt-1">
      {onToggle ? (
        <button
          data-testid={`sidebar-section-${label.toLowerCase()}`}
          aria-expanded={!collapsed}
          className="flex items-center gap-1 rounded text-[11px] font-semibold tracking-[.06em] text-white/55 uppercase hover:text-white/80"
          onClick={onToggle}
        >
          <span className="text-[9px]" aria-hidden>{collapsed ? '▸' : '▾'}</span>
          {label}
        </button>
      ) : (
        <span className="text-[11px] font-semibold tracking-[.06em] text-white/55 uppercase">{label}</span>
      )}
      {action && (
        <button
          data-testid={action.testid}
          className="rounded px-1 text-white/55 hover:bg-white/10 hover:text-white"
          onClick={action.onClick}
          title={action.title}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

/**
 * "Someone is working in here" (#137) — a small ring at the end of the channel
 * label while an agent has this channel's indicator set. Deliberately quiet: no
 * colour of its own, no layout shift, and it stops moving under
 * prefers-reduced-motion (the ring alone still reads as busy).
 */
export function ActivitySpinner({ active }: { active: boolean }) {
  return (
    <span
      data-testid="channel-indicator"
      title="an agent is working in this channel"
      className={`h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none ${
        active ? 'opacity-50' : 'text-white/60'
      }`}
    />
  );
}

/**
 * Opening a channel from the sidebar (#327). A channel whose unreads all live
 * inside a thread looks unchanged when you click it — the main timeline has
 * nothing new in it — so when the server says the oldest unread is a reply,
 * open the channel *and* that thread, landing on the first unread reply.
 * Everything else is the plain channel switch it has always been.
 *
 * Deliberately tied to the click and not to render: replies arriving while you
 * sit in a channel must not yank the thread panel open under you.
 *
 * Clicking the row of the channel already on screen used to do nothing at all,
 * which made the gesture people reach for when a badge won't clear the one
 * gesture that couldn't clear it (#533). `revisit` re-runs the read pass —
 * ChannelView's own effect fires on the newest message changing, so sitting
 * still in the channel never triggers it again.
 */
/**
 * The read pass for the channel already on screen (#533): re-send its cursor,
 * which is what makes the server sweep the channel's notification rows —
 * thread replies included. Nothing else re-runs it, because ChannelView marks
 * read off the newest *message* changing and sitting still changes nothing.
 *
 * The cursor comes from the channel row itself, so this can only ever repeat a
 * read the server already recorded; the server refuses to move a cursor
 * backwards, so a stale row cannot un-read the timeline.
 */
export function useChannelRevisit(): (channel: ChannelDTO) => void {
  const markRead = useMarkRead();
  return (channel) => {
    if (channel.lastReadMsgId) {
      markRead.mutate({ channelId: channel.id, lastReadMsgId: channel.lastReadMsgId });
    }
  };
}

export function openChannelFromSidebar(
  sel: Selection,
  channel: ChannelDTO,
  revisit?: (channel: ChannelDTO) => void,
): void {
  if (sel.channelId === channel.id) revisit?.(channel);
  const jump = channel.oldestUnreadThreadReply;
  if (jump) sel.jumpToMessage(channel.id, jump.replyId, jump.rootId);
  else sel.selectChannel(channel.id);
}

function ChannelRow({
  channel,
  label,
  leading,
  statusEmoji,
  statusTitle,
  testid,
  hideUnread,
  nested,
  onMenu,
}: {
  channel: ChannelDTO;
  label: string;
  leading?: React.ReactNode;
  statusEmoji?: string;
  statusTitle?: string;
  testid?: string;
  hideUnread?: boolean;
  /** Sub-channel (#118) — indented under its parent, same as ArtifactRow. */
  nested?: boolean;
  onMenu: () => void;
}) {
  const sel = useSelection();
  // The channel stays selected (and highlighted) even with an artifact tab open
  // in the side panel — the conversation is still shown behind it (phase 13).
  const active = sel.channelId === channel.id;
  // Two separate signals (operator ruling 2026-07-26): unread *messages* only
  // embolden the row — "something happened here". A *number* means "this needs
  // you", so it counts unread notifications (mentions, thread replies,
  // reactions; every message in a DM) and nothing else.
  const unread = channel.unreadCount > 0 && !hideUnread;
  const notifications = hideUnread ? 0 : channel.unreadNotifications;
  // Arriving at a channel by any route other than clicking it here — a
  // notification, a deep link, the switcher, being added to a channel — left the
  // sidebar wherever it was, so the row you just landed on could sit below the
  // fold (#319). Scroll it back into view, by the minimum needed: a row that is
  // already visible does not move, which is why a plain sidebar click still
  // never jumps.
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active && rowRef.current) scrollRowIntoView(rowRef.current);
  }, [active]);
  // #392: the topic on hover, so you can tell what a channel is for without
  // opening it. The hover target is the whole row, not the few dozen pixels the
  // name occupies — pointing at a channel means the row, and anchoring to the
  // row is also what keeps the bubble clear of it. No topic, no tooltip and no
  // handlers; DMs never have one, so they're inert here.
  const topicTip = useHoverTooltip(channel.topic, `channel-topic-tooltip-${channel.name ?? channel.id}`);
  const { ref: tipRef, ...tipHandlers } = topicTip.anchorProps;
  const revisit = useChannelRevisit();
  return (
    <div
      ref={(el) => {
        rowRef.current = el;
        tipRef(el);
      }}
      {...tipHandlers}
      data-nested={nested ? 'true' : undefined}
      className={`group flex items-center gap-[9px] rounded-lg px-2 py-[7px] ${nested ? 'ml-3' : ''} ${
        active ? 'bg-white text-accent-deep' : 'hover:bg-white/10'
      }`}
    >
      <button
        data-testid={testid ?? `sidebar-channel-${channel.name}`}
        data-unread={channel.unreadCount}
        data-notifications={notifications}
        className="flex min-w-0 flex-1 items-center gap-[9px] text-left"
        onClick={() => openChannelFromSidebar(sel, channel, revisit)}
      >
        {leading ?? (
          <span className={active ? 'opacity-60' : 'text-white/60'}>{channel.isPrivate ? '🔒' : '#'}</span>
        )}
        <span
          className={`truncate ${
            active ? 'font-[650]' : unread ? 'font-[650] text-white' : 'text-white/82'
          }`}
        >
          {label}
        </span>
        {/* One slot, two tenants (#396): the spinner is a claim about right now,
            so it wins while it's up; the emoji is decoration and comes back the
            moment it clears. Never both — they'd read as one confused status. */}
        {channel.indicator ? (
          <ActivitySpinner active={active} />
        ) : (
          channel.emoji && (
            <span data-testid="channel-emoji" className="shrink-0 text-sm leading-none">
              {channel.emoji}
            </span>
          )
        )}
        {statusEmoji && (
          <span className="ml-0.5 shrink-0 text-sm" title={statusTitle}>{statusEmoji}</span>
        )}
        {channel.notifyLevel === 0 && <span className="text-xs opacity-60">🔕</span>}
        {notifications > 0 && (
          <span className="ml-auto rounded-[9px] bg-unread px-[7px] py-px text-[11px] font-bold text-white">
            {Math.min(notifications, 99)}
          </span>
        )}
      </button>
      <button
        data-testid={`channel-menu-${channel.name ?? channel.id}`}
        className={`hidden rounded px-1 text-xs group-hover:block ${
          active ? 'text-accent-deep/60 hover:text-accent-deep' : 'text-white/55 hover:text-white'
        }`}
        onClick={onMenu}
      >
        ⋯
      </button>
      {topicTip.tooltip}
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  testid,
  destructive,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  testid?: string;
  destructive?: boolean;
  disabled?: boolean;
  /** Hover hint — how a disabled item explains itself. */
  title?: string;
}) {
  return (
    <button
      data-testid={testid}
      title={title}
      disabled={disabled}
      className={`block w-full px-3 py-1.5 text-left text-sm ${
        disabled
          ? 'cursor-default text-ink/35'
          : `${destructive ? 'text-red-600 hover:bg-red-50' : ''} hover:bg-accent/10`
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
