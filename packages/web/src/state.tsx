// App-level contexts: auth, selection, and ephemeral live state
// (presence/typing/connection/unread-notifications).
import { createContext, useContext } from 'react';
import type { UserDTO } from '@flow/shared';
import type { SocketStatus } from './lib/ws';
import { activeRuntime, type ConnectionRuntime } from './lib/connectionRuntime';

export interface AuthState {
  user: UserDTO;
  setUser(u: UserDTO): void;
  signOut(): void;
}


/**
 * Sentinel channel id for the Activity feed (phase 12) — an always-present,
 * virtual per-user "channel" that replaces the notifications bell. When it's
 * the active selection the content pane renders <ActivityView>, which surfaces
 * this user's notification rows (mentions/DMs/thread replies/activity) as a
 * message-like stream. Not a real channel — there is no server row.
 */
export const ACTIVITY_VIEW_ID = '__activity__';

/**
 * Sentinel channel id for the Scheduled panel (#420) — the same virtual-view
 * trick as the Activity feed, opened by the clock next to the bell. Selecting
 * it renders <ScheduledView>, a workspace-wide list of scheduled messages
 * rather than a message stream. Being a selection is what makes back/forward
 * work on it for free.
 */
export const SCHEDULED_VIEW_ID = '__scheduled__';

/**
 * Sentinel channel id for the Directory (#430) — the same virtual-view trick
 * again: a browsable grid of every workspace member, opened from the sidebar
 * entry under Direct messages or the workspace menu. Not a real channel.
 */
export const DIRECTORY_VIEW_ID = '__directory__';

/**
 * Sentinel channel id for the channel browser (#588) — every public channel,
 * joined or not, with search and an include-archived toggle. Opened from the
 * "Browse all" row at the end of the sidebar's Channels section.
 */
export const CHANNEL_BROWSER_VIEW_ID = '__channel_browser__';

/**
 * Sentinel channel id for message search (docs/specs/search.md): the suite bar's search on Chat opens it, and
 * <SearchView> lists the messages that match (lib/messageSearch.ts holds the text). Not a real channel.
 */
export const SEARCH_VIEW_ID = '__search__';

export interface Selection {
  workspaceId: string | null;
  channelId: string | null;
  threadRootId: string | null;
  /** Active artifact tab in the side panel (phase 13). The side panel is a
   * tabbed container shared with the thread: `artifactId` set → that artifact
   * is the visible tab; null with `threadRootId` set → the Thread tab is
   * visible. Threads and artifacts coexist (both can be open); this just picks
   * which tab shows. */
  artifactId: string | null;
  /** Channel Files tab in the side panel (#347). It sits alongside the thread
   * and artifact tabs on the same surface: true means the Files tab is the
   * visible one. */
  filesOpen: boolean;
  /** Message being edited inline (hover menu or composer ↑) — ui_nits item 4. */
  editingMessageId: string | null;
  /** Message to scroll to + flash after navigation (phase 12 Activity feed
   * jump-to-message). The channel/thread view pages history until it's loaded,
   * scrolls to it, then clears this. */
  focusMessageId: string | null;
  /** Is there a previous / next view in this session's visit history (#386)?
   * Drives the enabled state of the workspace header's back and forward
   * buttons. */
  canGoBack: boolean;
  canGoForward: boolean;
  /** Return to the previously viewed channel/view; no-op at the start of the
   * history. Behaves exactly like clicking that channel, minus recording a
   * new visit. */
  goBack(): void;
  /** Re-advance after a `goBack`; no-op with an empty forward branch. */
  goForward(): void;
  selectWorkspace(id: string | null): void;
  /** Switch channels. The channel being left remembers its open thread and the
   * one being entered reopens whatever it had, so a thread survives a detour
   * through another channel (issue #89). Only within a session — the memory
   * dies with the workspace switch, the sign-out, and the page. */
  selectChannel(id: string | null): void;
  /** Open/activate an artifact tab (null just clears the active artifact — e.g.
   * when the shown artifact is deleted; the thread tab, if any, stays). */
  selectArtifact(id: string | null): void;
  /** Open a channel *and* an artifact tab in it in one action (#394): what the
   * sidebar's Apps section does, where the app's channel is often not the
   * current one and may have only just been joined — so the artifact cannot be
   * looked up in the member-artifact cache the way `selectArtifact` does. */
  openArtifactIn(channelId: string, artifactId: string): void;
  /** Open (or close) the channel Files tab in the side panel. */
  openFiles(open: boolean): void;
  openThread(id: string | null): void;
  /** Make the Thread tab the visible one (thread stays open). */
  showThread(): void;
  /** Close the whole side panel — clears the thread, the active artifact and Files. */
  closeSidePanel(): void;
  setEditingMessage(id: string | null): void;
  /** Navigate to a specific message: selects its channel (and thread, if any)
   * and marks it as the scroll-to + flash target. */
  jumpToMessage(channelId: string, messageId: string, threadRootId?: string | null): void;
  /** Clear the scroll-to target once it's been reached (or given up on). */
  clearFocusMessage(): void;
}

export interface LiveState {
  status: SocketStatus;
  /** Is this user online *in the selected workspace* (#364)? Presence is per
   * (user, workspace): an agent connected to another workspace is not online
   * here, and its dot must stay grey. */
  isOnline(userId: string): boolean;
  /** typingKey(channelId, threadRootId) -> userId -> ts(ms). Keyed by composer,
   * not by channel, so a thread's indicator never shows in the main view. */
  typing: Record<string, Record<string, number>>;
  notificationUnread: number;
  setNotificationUnread(n: number): void;
  sendTyping(channelId: string, threadRootId?: string): void;
}

/**
 * Mobile navigation state (responsive layout): below the `md` breakpoint the
 * rail + sidebar collapse into a slide-in drawer over a full-width content
 * pane. `isMobile` mirrors the `(max-width: 767px)` media query; the drawer is
 * always "open" (in flow) on desktop.
 */
export interface MobileNav {
  isMobile: boolean;
  drawerOpen: boolean;
  openDrawer(): void;
  closeDrawer(): void;
}

/** Typing indicators are per-composer: a channel's main composer and each of
 * its threads are separate conversations and get separate keys. */
export function typingKey(channelId: string, threadRootId?: string | null): string {
  return `${channelId}|${threadRootId ?? ''}`;
}

/** The connection whose session everything below this provider belongs to
 * (docs/specs/multi-server-workspaces.md, "Runtime architecture"). Views take
 * their backend from here rather than from the page's origin, and an operation
 * that reads it once at start cannot be retargeted by a later switch. */
export const ConnectionContext = createContext<ConnectionRuntime | null>(null);

export const AuthContext = createContext<AuthState | null>(null);
export const SelectionContext = createContext<Selection | null>(null);
export const LiveContext = createContext<LiveState | null>(null);
export const MobileNavContext = createContext<MobileNav | null>(null);

/** The runtime for the connection this subtree is mounted on. Falls back to
 * the active connection so a component rendered outside a provider (tests,
 * the signed-out screens) still works. */
export function useRuntime(): ConnectionRuntime {
  return useContext(ConnectionContext) ?? activeRuntime();
}

export function useAuth(): AuthState {
  const v = useContext(AuthContext);
  if (!v) throw new Error('AuthContext missing');
  return v;
}
export function useSelection(): Selection {
  const v = useContext(SelectionContext);
  if (!v) throw new Error('SelectionContext missing');
  return v;
}
export function useLive(): LiveState {
  const v = useContext(LiveContext);
  if (!v) throw new Error('LiveContext missing');
  return v;
}
export function useMobileNav(): MobileNav {
  const v = useContext(MobileNavContext);
  if (!v) throw new Error('MobileNavContext missing');
  return v;
}
