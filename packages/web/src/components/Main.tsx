import { useBoundApi } from '../lib/useBoundApi';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { sidebarColor } from '@flow/shared';
import type {
  ArtifactDTO,
  ChannelDTO,
  ChannelEmojiData,
  ChannelIndicatorData,
  Event,
  HuddleInviteData,
  HuddleUpdatedData,
  MessageDTO,
  NotificationDTO,
  TypingData,
  PresenceData,
  WorkspaceMemberDTO,
} from '@flow/shared';
import { applyMessageEvent, removeMessageFromCache } from '../lib/messageCache';
import { applyChannelEmoji, applyHuddle, applyIndicator } from '../lib/channelCache';
import { api } from '../lib/api';
import { shouldOpenArtifact } from '../lib/artifactDelivery';
import { backendFor } from '../lib/backend';
import { SocketClient, type SocketStatus } from '../lib/ws';
import { plainBody } from '../lib/format';
import { ACTIVITY_VIEW_ID, ADMIN_VIEW_ID, CHANNEL_BROWSER_VIEW_ID, DIRECTORY_VIEW_ID, SCHEDULED_VIEW_ID, LiveContext, MobileNavContext, typingKey, useAuth, useRuntime, useSelection } from '../state';
import { HuddleProvider, useHuddle, type HuddleState } from '../huddle';
import { useNameMap, useSwitcherEntries, useWorkspaceInvites, useWorkspaces } from '../hooks';
import { getHost, isLookingAtApp, onLookingChange } from '../lib/host';
import { backAction } from '../lib/hardwareBack';
import { useConnectionSync } from '../lib/backgroundSync';
import type { NotificationRouting } from '@flow/shared';
import { openWorkspace } from '../lib/workspaceSwitcher';
import { connectionManager } from '../lib/connectionRuntime';
import Sidebar from './Sidebar';
import ChannelView from './ChannelView';
import AdminView from './AdminView';
import ActivityView from './ActivityView';
import DirectoryView from './DirectoryView';
import ChannelBrowserView from './ChannelBrowserView';
import ScheduledView from './ScheduledView';
import SidePanel from './SidePanel';
import { OpenInAppBanner } from './OpenInApp';
import HuddleMiniBar from './HuddleMiniBar';
import HuddleGrid from './HuddleGrid';
import IncomingHuddle from './IncomingHuddle';
import { MobileMenuButton } from './MobileMenuButton';
import { HelpModal } from './HelpModal';
import { AuthImg } from './Avatar';
import { RailUnreadBadge } from './RailUnreadBadge';

export default function Main() {
  const { api } = useBoundApi();
  const auth = useAuth();
  const sel = useSelection();
  // Every request and the socket below belong to this connection, not to the
  // page's origin — see docs/specs/multi-server-workspaces.md.
  const runtime = useRuntime();
  const qc = useQueryClient();
  const [status, setStatus] = useState<SocketStatus>('connecting');
  // Post-connect refetches in flight (#234) — see the socket effect below.
  const [catchUpCount, setCatchUpCount] = useState(0);
  // workspaceId -> userId -> online? Presence is per (user, workspace) since
  // #364 — one socket carries every workspace we belong to, so a flat
  // userId -> bool map lit the dot in all of them at once.
  const [presence, setPresence] = useState<Record<string, Record<string, boolean>>>({});
  const [typing, setTyping] = useState<Record<string, Record<string, number>>>({});
  const [notificationUnread, setNotificationUnread] = useState(0);
  // Responsive layout: below `md` the rail+sidebar collapse into a slide-in
  // drawer over a full-width content pane (see the layout JSX below).
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches,
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Built-in help docs (#383) — large layout only, so it closes with the
  // breakpoint rather than being stranded open on a phone-width window.
  const [helpOpen, setHelpOpen] = useState(false);
  const socketRef = useRef<SocketClient | null>(null);
  // The huddle controller lives *inside* HuddleProvider, which this component
  // renders — so socket events reach it through a ref that HuddleWiring (below
  // the provider) fills in, rather than a hook this scope cannot call.
  const huddleBridge = useRef<{
    applyInviteEvent: HuddleState['applyInviteEvent'];
    setSessionId: HuddleState['setSessionId'];
  } | null>(null);
  // refs so the socket handler always sees current selection
  const selRef = useRef(sel);
  selRef.current = sel;

  // The hardware back button (ANDROID.md phase 1): thread → side panel →
  // drawer, and only then the OS. Registered for as long as the main pane is
  // mounted; an overlay that opens later registers above it and wins. A
  // browser or desktop host reports no back, so this never runs there.
  useEffect(() => {
    return getHost().back.onBack(() => {
      const cur = selRef.current;
      switch (backAction({
        threadOpen: cur.threadRootId !== null,
        panelOpen: cur.artifactId !== null || cur.filesOpen,
        isMobile,
        drawerOpen,
      })) {
        case 'close-thread': cur.openThread(null); return true;
        case 'close-panel': cur.closeSidePanel(); return true;
        case 'open-drawer': setDrawerOpen(true); return true;
        case 'leave': return false;
      }
    });
  }, [isMobile, drawerOpen]);
  const authRef = useRef(auth);
  authRef.current = auth;
  const names = useNameMap(sel.workspaceId);
  const namesRef = useRef(names);
  namesRef.current = names;

  useEffect(() => {
    if (!getHost().isDesktop && 'Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
  }, []);

  // A banner click lands here (docs/specs/desktop-electron.md, "Notifications"):
  // the same navigation the in-app Activity row does, then the row is read.
  // Registered once; the ref keeps it pointed at the current selection.
  useEffect(() => {
    return getHost().notifications.onClick((routing: NotificationRouting) => {
      if (routing.routingId !== runtime.connectionId) return; // another connection's banner
      const s = selRef.current;
      if (s.workspaceId !== routing.workspaceId) s.selectWorkspace(routing.workspaceId);
      s.jumpToMessage(routing.channelId, routing.messageId, routing.threadRootId);
      void api('POST', '/v1/me/notifications/read', { id: routing.notificationId }).then(() =>
        qc.invalidateQueries({ queryKey: ['notifications'] }),
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime.connectionId]);

  // The app badge (dock, taskbar, launcher): unread notifications across
  // every connection — this one's per-workspace numbers plus what the
  // background supervisor reports for the others — the sum
  // `refreshAggregateBadge()` computes on macOS. Re-asked when the window
  // comes back to the front, so a count that moved on the phone catches up.
  const workspacesForBadge = useWorkspaces();
  const syncStates = useConnectionSync();
  useEffect(() => {
    if (!getHost().isDesktop) return;
    const own = (workspacesForBadge.data ?? []).reduce((sum, ws) => sum + (ws.unreadCount ?? 0), 0);
    const others = syncStates.filter((s) => s.connectionId !== runtime.connectionId).reduce((sum, s) => sum + s.unread, 0);
    getHost().badge.set(own + others);
  }, [workspacesForBadge.data, syncStates, runtime.connectionId]);
  useEffect(() => {
    if (!getHost().isDesktop) return;
    return onLookingChange(() => {
      if (isLookingAtApp()) void qc.invalidateQueries({ queryKey: ['workspaces'] });
    });
  }, [qc]);

  // The Activity badge counts this workspace only — the feed behind it is
  // scoped the same way. Refetched on every workspace switch, and whenever the
  // server tells us rows went read (its event carries the cross-workspace
  // total, which can't drive a per-workspace badge).
  const refreshNotificationBadge = useCallback(async () => {
    const workspaceId = selRef.current.workspaceId;
    // Notifications are a Flow feature; another provider's runtime has no
    // such endpoint and its badge stays at zero (#545).
    if (!workspaceId || runtime.provider !== 'flow') return;
    try {
      const j = await runtime.api<{ unreadCount?: number }>(
        'GET', `/v1/me/notifications?limit=1&workspaceId=${workspaceId}`,
      );
      // A slower response for a previously selected workspace must not clobber
      // the badge after a quick switch — nor a response for a connection that
      // has since been disposed.
      if (runtime.isDisposed) return;
      if (selRef.current.workspaceId === workspaceId) setNotificationUnread(j.unreadCount ?? 0);
    } catch {
      /* offline */
    }
  }, [runtime]);

  useEffect(() => {
    void refreshNotificationBadge();
  }, [sel.workspaceId, refreshNotificationBadge]);

  // Track the mobile breakpoint; leaving mobile always dismisses the drawer.
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const onChange = () => {
      setIsMobile(mq.matches);
      if (!mq.matches) setDrawerOpen(false);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (isMobile) setHelpOpen(false);
  }, [isMobile]);

  // On mobile, picking a channel/artifact from the drawer closes it so the
  // conversation takes the full screen. (Covers every selection path at once.)
  useEffect(() => {
    setDrawerOpen(false);
  }, [sel.channelId, sel.artifactId]);

  useEffect(() => {
    const token = runtime.getToken();
    if (!token) return;
    // A non-Flow provider has no Flow socket: its backend's normalized stream
    // feeds the same message cache (#545). Flow keeps the socket below, whose
    // non-chat events (artifacts, huddles, notifications) are Flow's own.
    if (runtime.provider !== 'flow') {
      setStatus('connected');
      const backend = backendFor(runtime);
      const unsubscribe = backend.subscribe((event) => {
        switch (event.type) {
          case 'message.created':
          case 'thread.reply':
            applyMessageEvent(qc, event.message, true);
            void qc.invalidateQueries({ queryKey: ['channels'] });
            break;
          case 'message.updated':
            applyMessageEvent(qc, event.message, false);
            break;
          case 'message.deleted':
            removeMessageFromCache(qc, { id: event.messageId, channelId: event.channelId, threadRootId: event.threadRootId } as MessageDTO);
            break;
          case 'reaction.added':
          case 'reaction.removed':
            void qc.invalidateQueries({ queryKey: ['messages', event.channelId] });
            void qc.invalidateQueries({ queryKey: ['thread'] });
            break;
          case 'channel.updated':
            void qc.invalidateQueries({ queryKey: ['channels'] });
            break;
          case 'channel.activity':
            // Patched in place: a sidebar row may unfold, and a list refetch
            // per message would spend the provider's conversation budget.
            qc.setQueriesData<{ channels: ChannelDTO[] }>({ queryKey: ['channels'] }, (data) =>
              data ? { ...data, channels: data.channels.map((c) => (c.id === event.channelId ? { ...c, lastActivityAt: event.lastActivityAt } : c)) } : data,
            );
            break;
          case 'stream.degraded':
            setStatus('reconnecting');
            break;
          case 'stream.recovered': {
            // A gap means events were missed: refetch what is on screen — the
            // visible conversation, its open thread and the channel list — not
            // every cached transcript, which would burn a limited provider's
            // history budget for channels nobody is looking at (#546).
            setStatus('connected');
            setCatchUpCount((n) => n + 1);
            const current = selRef.current;
            if (current.channelId) {
              // Keep only the newest page so the refetch costs one history call;
              // older pages reload lazily as the user scrolls, as they did before.
              qc.setQueryData<{ pages: unknown[]; pageParams: unknown[] }>(['messages', current.channelId], (old) =>
                old ? { pages: old.pages.slice(0, 1), pageParams: old.pageParams.slice(0, 1) } : old,
              );
            }
            const scoped = [
              qc.invalidateQueries({ queryKey: ['channels'] }),
              ...(current.channelId ? [qc.invalidateQueries({ queryKey: ['messages', current.channelId] })] : []),
              ...(current.threadRootId ? [qc.invalidateQueries({ queryKey: ['thread', current.threadRootId] })] : []),
            ];
            void Promise.all(scoped).finally(() => setCatchUpCount((n) => Math.max(0, n - 1)));
            break;
          }
          case 'member.updated': {
            // Patch the roster in place: a refetch per profile change would spend
            // the provider's member-list budget on every status anyone sets.
            const { member } = event;
            // A sender the roster has not seen yet (a Slack app's first message) is added.
            for (const [key, data] of qc.getQueriesData<{ members: WorkspaceMemberDTO[] }>({ queryKey: ['members'] })) {
              if (!data) continue;
              const known = data.members.some((m) => m.userId === member.userId);
              qc.setQueryData(key, { ...data, members: known ? data.members.map((m) => (m.userId === member.userId ? member : m)) : [...data.members, member] });
            }
            const current = authRef.current;
            if (member.userId === current.user.id) {
              current.setUser({ ...current.user, displayName: member.displayName, avatarUrl: member.avatarUrl, statusEmoji: member.statusEmoji, statusText: member.statusText, title: member.title });
            }
            break;
          }
          case 'auth.changed':
            if (event.auth.status !== 'authenticated') setStatus('reconnecting');
            break;
          default:
            break;
        }
      });
      return unsubscribe;
    }
    const client = new SocketClient(token, {
      onStatus: (s) => {
        setStatus(s);
        if (s === 'connected') {
          // reconnect backfill = refetch everything (online-only client).
          // The refetch is what the reconnect bar waits on (#234): the socket
          // says hello long before the screen stops being stale. Counted, not
          // flagged, so a second reconnect mid-refetch can't clear the first.
          // the server sends a fresh presence snapshot right after hello, and
          // nobody sends `offline` for a user who left while we were down
          setPresence({});
          setCatchUpCount((n) => n + 1);
          void qc.invalidateQueries().finally(() => setCatchUpCount((n) => Math.max(0, n - 1)));
        }
      },
      onEvent: (event: Event) => handleEvent(event),
      onSession: (sessionId) => huddleBridge.current?.setSessionId(sessionId),
    }, runtime.socketUrl);
    socketRef.current = client;
    client.start();
    return () => {
      client.stop();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime]);

  function clearTyping(key: string, userId: string): void {
    setTyping((prev) => {
      const chan = prev[key];
      if (!chan || !(userId in chan)) return prev;
      const { [userId]: _gone, ...rest } = chan;
      return { ...prev, [key]: rest };
    });
  }

  function handleEvent(event: Event): void {
    const cur = selRef.current;
    switch (event.type) {
      case 'message.purged': {
        // Hard delete: remove the message entirely (no tombstone). This covers
        // agent status cleanup and owner/admin moderation.
        const msg = event.data as MessageDTO;
        removeMessageFromCache(qc, msg);
        if (msg.threadRootId === null && cur.threadRootId === msg.id) cur.openThread(null);
        void qc.invalidateQueries({ queryKey: ['messages', msg.channelId] });
        if (msg.threadRootId) void qc.invalidateQueries({ queryKey: ['thread', msg.threadRootId] });
        void qc.invalidateQueries({ queryKey: ['pins', msg.channelId] });
        void qc.invalidateQueries({ queryKey: ['channelFiles', msg.channelId] });
        void qc.invalidateQueries({ queryKey: ['notifications'] });
        void refreshNotificationBadge();
        void qc.invalidateQueries({ queryKey: ['channels', event.workspaceId] });
        void qc.invalidateQueries({ queryKey: ['workspaces'] });
        break;
      }
      case 'message.created':
      case 'message.updated':
      case 'message.deleted':
      case 'thread.reply': {
        // Events carry the full MessageDTO: apply it to the cache directly
        // (local-first; no refetch of the whole list per incoming message).
        const msg = event.data as MessageDTO;
        if (event.type === 'message.created' || event.type === 'thread.reply') {
          // The sender's message arrived — drop their lingering typing entry
          // for the composer they sent it from (main view or that thread).
          clearTyping(typingKey(msg.channelId, msg.threadRootId), msg.userId);
        }
        const insert = event.type === 'message.created' || event.type === 'thread.reply';
        applyMessageEvent(qc, msg, insert);
        // Pin/unpin and delete events are full message updates; keep the
        // channel's independently fetched pinned-message list in sync too.
        void qc.invalidateQueries({ queryKey: ['pins', msg.channelId] });
        // The Files panel (#347) is built from message attachments, so a new
        // upload — or the deletion that takes one out of the list — has to
        // reach an open panel. Only messages that carry files can move it.
        // (a tombstone carries no files, so deletions can't be gated on them)
        if (msg.files.length > 0 || event.type === 'message.deleted') {
          void qc.invalidateQueries({ queryKey: ['channelFiles', msg.channelId] });
        }
        // Sidebar unread counts/ordering still come from the channels query.
        void qc.invalidateQueries({ queryKey: ['channels', event.workspaceId] });
        break;
      }
      case 'reaction.added':
      case 'reaction.removed': {
        const data = event.data as { channelId: string };
        void qc.invalidateQueries({ queryKey: ['messages', data.channelId] });
        void qc.invalidateQueries({ queryKey: ['thread'] });
        break;
      }
      case 'typing': {
        const t = event.data as TypingData;
        if (t.userId === auth.user.id) break;
        // Scoped to the composer it came from: a thread's indicator belongs to
        // that thread, not the channel's main view.
        const key = typingKey(t.channelId, t.threadRootId);
        setTyping((prev) => ({
          ...prev,
          [key]: { ...(prev[key] ?? {}), [t.userId]: Date.now() },
        }));
        // The render-time 5s filter never re-renders on its own, so a stale
        // entry would linger; sweep it once the window has passed.
        window.setTimeout(() => {
          setTyping((prev) => {
            const at = prev[key]?.[t.userId];
            if (at === undefined || Date.now() - at < 5000) return prev;
            const { [t.userId]: _gone, ...rest } = prev[key]!;
            return { ...prev, [key]: rest };
          });
        }, 5200);
        break;
      }
      case 'channel.indicator': {
        // Patch the cached channel rather than invalidating (#137): the spinner
        // is high-frequency and purely cosmetic — it must never cost the
        // sidebar a refetch, and it should appear the instant the event lands.
        const d = event.data as ChannelIndicatorData;
        qc.setQueryData<{ channels: ChannelDTO[] }>(['channels', event.workspaceId], (old) =>
          old ? { channels: applyIndicator(old.channels, d) } : old,
        );
        break;
      }
      case 'channel.emoji': {
        // Same patch-don't-invalidate reasoning as channel.indicator (#396):
        // one glyph on one row must never cost the sidebar a refetch.
        const d = event.data as ChannelEmojiData;
        qc.setQueryData<{ channels: ChannelDTO[] }>(['channels', event.workspaceId], (old) =>
          old ? { channels: applyChannelEmoji(old.channels, d) } : old,
        );
        break;
      }
      case 'huddle.updated': {
        // Same reasoning as channel.indicator: patch, don't invalidate — the
        // roster is transient and should update the instant the event lands.
        const d = event.data as HuddleUpdatedData;
        qc.setQueryData<{ channels: ChannelDTO[] }>(['channels', event.workspaceId], (old) =>
          old ? { channels: applyHuddle(old.channels, d) } : old,
        );
        break;
      }
      case 'presence': {
        const p = event.data as PresenceData;
        setPresence((prev) => ({
          ...prev,
          [event.workspaceId]: { ...prev[event.workspaceId], [p.userId]: p.status === 'online' },
        }));
        break;
      }
      case 'channel.created':
      case 'channel.updated':
      case 'channel.archived':
      case 'member.joined':
      case 'member.left': {
        // Our own workspace-level departure (#340) — left from another client,
        // or removed by an admin. Drop the workspace before refetching, so no
        // render sees a selection pointing at one we can no longer read, and
        // *remove* its caches rather than invalidating them: an invalidate
        // refetches, and every one of those refetches is now a 404.
        const left = event.data as { userId?: string } | undefined;
        if (event.type === 'member.left' && !event.channelId && left?.userId === auth.user.id) {
          if (cur.workspaceId === event.workspaceId) cur.selectWorkspace(null);
          const gone = qc.getQueryData<{ channels: ChannelDTO[] }>(['channels', event.workspaceId]);
          for (const c of gone?.channels ?? []) qc.removeQueries({ queryKey: ['channelMembers', c.id] });
          qc.removeQueries({ queryKey: ['channels', event.workspaceId] });
          qc.removeQueries({ queryKey: ['members', event.workspaceId] });
          qc.removeQueries({ queryKey: ['artifacts', event.workspaceId] });
          qc.removeQueries({ queryKey: ['app-artifacts', event.workspaceId] });
          void qc.invalidateQueries({ queryKey: ['workspaces'] });
          break;
        }
        void qc.invalidateQueries({ queryKey: ['channels', event.workspaceId] });
        void qc.invalidateQueries({ queryKey: ['members', event.workspaceId] });
        void qc.invalidateQueries({ queryKey: ['channelMembers'] });
        break;
      }
      case 'workspace.invited':
        // Someone invited me to a workspace (#359), or the invitation I was
        // shown just ended (accepted on another device, declined, expired).
        // Same refetch either way — the list IS the answer.
        void qc.invalidateQueries({ queryKey: ['workspaceInvites'] });
        break;
      case 'member.updated':
        // Role change (admin panel): refresh the roster, and the workspace list
        // so the affected member's own menu gating (owner/admin) re-derives.
        void qc.invalidateQueries({ queryKey: ['members', event.workspaceId] });
        void qc.invalidateQueries({ queryKey: ['workspaces'] });
        break;
      case 'user.updated':
        void qc.invalidateQueries({ queryKey: ['members'] });
        void qc.invalidateQueries({ queryKey: ['me'] });
        break;
      case 'workspace.joined':
        // this user joined a workspace in another session/tab — refresh the list
        void qc.invalidateQueries({ queryKey: ['workspaces'] });
        break;
      case 'workspace.updated':
        void qc.invalidateQueries({ queryKey: ['workspaces'] });
        // Custom emoji (#175) ride this event rather than a new type, so a
        // freshly added emoji renders in other sessions without a reload.
        void qc.invalidateQueries({ queryKey: ['emoji', event.workspaceId] });
        break;
      case 'artifact.created':
      case 'artifact.updated':
      case 'artifact.deleted': {
        // per-channel shared artifacts (phase 13): keep the sidebar list fresh;
        // a deletion of the open artifact closes the side panel
        void qc.invalidateQueries({ queryKey: ['artifacts', event.workspaceId] });
        // …and the workspace-wide app list behind the sidebar's Apps section (#394).
        void qc.invalidateQueries({ queryKey: ['app-artifacts', event.workspaceId] });
        const a = event.data as ArtifactDTO;
        if (event.type === 'artifact.deleted') qc.removeQueries({ queryKey: ['artifact', a.id] });
        else qc.setQueryData(['artifact', a.id], a);
        if (event.type === 'artifact.deleted' && cur.artifactId === a.id) cur.selectArtifact(null);
        // Co-browsing: an updated link artifact's url must reach every viewer
        // right away (the refetch above is async). Seed the new DTO into the
        // list cache so an open mini-browser follows the navigation instantly.
        if (event.type === 'artifact.updated') {
          qc.setQueryData<{ artifacts: ArtifactDTO[] }>(['artifacts', event.workspaceId], (old) =>
            old ? { artifacts: old.artifacts.map((x) => (x.id === a.id ? a : x)) } : old,
          );
        }
        // Auto-open only a report explicitly delivered to the requester in the
        // originating conversation. File ownership is a lifecycle concern, not
        // an attention-routing signal. Updates never re-open a report.
        if (event.type === 'artifact.created' && shouldOpenArtifact(a, authRef.current.user.id, cur.channelId, cur.threadRootId)) {
          // Seed the list cache with the DTO *before* selecting: the invalidate
          // above refetches async, and ArtifactBody self-closes if the selected
          // id isn't in the (still-stale) list — so without this the panel would
          // pop open and immediately close. The refetch reconciles a moment later.
          qc.setQueryData<{ artifacts: ArtifactDTO[] }>(['artifacts', event.workspaceId], (old) => {
            const list = old?.artifacts ?? [];
            return list.some((x) => x.id === a.id) ? old! : { artifacts: [a, ...list] };
          });
          cur.selectArtifact(a.id);
        }
        break;
      }
      case 'notification.created': {
        const n = event.data as NotificationDTO;
        void qc.invalidateQueries({ queryKey: ['notifications'] });
        // the sidebar badge is this channel's unread-notification count
        void qc.invalidateQueries({ queryKey: ['channels', event.workspaceId] });
        // …and the rail badge (#345) counts these same rows per workspace.
        void qc.invalidateQueries({ queryKey: ['workspaces'] });
        // "Looking at it" means the row is actually on screen: this channel,
        // tab visible, and — when the message lives in a thread (a reply, a
        // mention in a reply, a reaction on your reply) — that thread open.
        // Threads are behind a click, same scoping the server's channel-read
        // path uses (threadRootId IS NULL).
        const viewing =
          n.channelId === cur.channelId &&
          isLookingAtApp() &&
          (n.message.threadRootId == null || n.message.threadRootId === cur.threadRootId);
        if (viewing) {
          // Read it now (issue #63): messages clear via the read cursor, but a
          // reaction moves no cursor, so without this the row would stay
          // unread on the server and reappear as a badge on the next load.
          void api('POST', '/v1/me/notifications/read', { id: n.id }).then(() =>
            qc.invalidateQueries({ queryKey: ['notifications'] }),
          );
        } else {
          // The badge counts this workspace only — a row from another one
          // belongs to that workspace's Activity, not this sidebar's.
          if (n.workspaceId === cur.workspaceId) setNotificationUnread((v) => v + 1);
          maybeBanner(n);
        }
        break;
      }
      case 'huddle.invite': {
        // The DM ring (#436). Every device of every participant gets this;
        // the controller decides from it whether *this* device shows a card.
        const d = event.data as HuddleInviteData;
        huddleBridge.current?.applyInviteEvent(d.invite, {
          selfId: authRef.current.user.id,
          answeredBySessionId: d.answeredBySessionId,
          unavailable: d.unavailable,
        });
        // A resolved ring posts its line into the DM, so the sidebar's unread
        // and ordering move with it.
        void qc.invalidateQueries({ queryKey: ['channels', event.workspaceId] });
        break;
      }
      case 'notification.read': {
        // Another session (or the server, on a channel/thread visit) read rows.
        // The event's count is the cross-workspace total, so it can't drive a
        // per-workspace badge — refetch the scoped one instead.
        void qc.invalidateQueries({ queryKey: ['notifications'] });
        void refreshNotificationBadge();
        // rows can span workspaces (Activity feed) — refresh every channel list
        void qc.invalidateQueries({ queryKey: ['channels'] });
        // …and the rail badges, which another session's reading also moves.
        void qc.invalidateQueries({ queryKey: ['workspaces'] });
        break;
      }
      default:
        break;
    }
  }

  /** An OS banner through the host: the browser's Notification API in a tab,
   * the shell's notifier on desktop (docs/specs/desktop-electron.md). What
   * qualifies is decided here and on the server, never by the shell. */
  function maybeBanner(n: NotificationDTO): void {
    // phase 10: the server computed the alert decision (prefs + status)
    if (n.suppressAlert) return;
    if (isLookingAtApp() && n.channelId === selRef.current.channelId) return;
    // The actor is the reactor for kind 4, the author otherwise.
    const sender = namesRef.current[n.actorId ?? n.message.userId] ?? 'Someone';
    const title =
      n.kind === 1 ? `${sender} (DM)`
      : n.kind === 2 ? `${sender} replied in a thread`
      : n.kind === 4 ? `${sender} reacted ${n.reactionEmoji ?? ''}`.trim()
      : n.kind === 5 ? `${sender} added you to a channel`
      : `${sender} mentioned you`;
    // Name the conversation (#460's subtitle): the channel when it has a
    // name; a DM already names its sender in the title.
    const channel = qc.getQueryData<{ channels: ChannelDTO[] }>(['channels', n.workspaceId])?.channels.find((c) => c.id === n.channelId);
    const prefs = authRef.current.user.notificationPrefs;
    getHost().notifications.show({
      id: n.id,
      title,
      ...(channel?.name ? { subtitle: `#${channel.name}` } : {}),
      body: plainBody(n.message.body, namesRef.current),
      // #251: the same `sound` pref the phone honours.
      silent: prefs.sound === false,
      // Browser only: keep the banner up until dismissed (the desktop shell
      // leaves that to the OS, as macOS and iOS do).
      ...({ persistent: prefs.persistentBanners === true } as object),
      routing: {
        routingId: runtime.connectionId,
        workspaceId: n.workspaceId,
        channelId: n.channelId,
        messageId: n.messageId,
        threadRootId: n.message.threadRootId ?? null,
        notificationId: n.id,
      },
    });
  }

  const live = useMemo(
    () => ({
      status,
      syncing: status !== 'connected' || catchUpCount > 0,
      isOnline: (userId: string) => !!(sel.workspaceId && presence[sel.workspaceId]?.[userId]),
      typing,
      notificationUnread,
      setNotificationUnread,
      sendTyping: (channelId: string, threadRootId?: string) =>
        socketRef.current?.sendTyping(channelId, threadRootId),
    }),
    [status, catchUpCount, presence, sel.workspaceId, typing, notificationUnread],
  );

  const mobileNav = useMemo(
    () => ({
      isMobile,
      drawerOpen,
      openDrawer: () => setDrawerOpen(true),
      closeDrawer: () => setDrawerOpen(false),
    }),
    [isMobile, drawerOpen],
  );

  return (
    <LiveContext.Provider value={live}>
     <MobileNavContext.Provider value={mobileNav}>
      <HuddleProvider>
      <HuddleWiring bridge={huddleBridge} />
      <div className="flex h-full flex-col bg-base text-ink">
        <OpenInAppBanner />
        <HuddleMiniBar />
        <HuddleGrid />
        <IncomingHuddle />
        <div className="relative flex min-h-0 flex-1">
          {/* Rail + sidebar. Desktop: inline flex columns. Mobile (<md): a
              fixed slide-in drawer over the content, toggled by the header
              hamburger and dismissed by the backdrop or a selection. */}
          <div
            data-testid="nav-drawer"
            className={`z-40 flex shrink-0 max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:w-[min(86vw,320px)] max-md:shadow-[6px_0_28px_rgba(20,8,40,.4)] max-md:transition-transform max-md:duration-200 ${
              drawerOpen ? 'max-md:translate-x-0' : 'max-md:-translate-x-full'
            }`}
          >
            <WorkspaceRail showHelp={!isMobile} onOpenHelp={() => setHelpOpen(true)} />
            <Sidebar />
          </div>
          {isMobile && drawerOpen && (
            <button
              data-testid="nav-drawer-backdrop"
              aria-label="Close menu"
              className="fixed inset-0 z-30 bg-black/40 md:hidden"
              onClick={() => setDrawerOpen(false)}
            />
          )}
          <div className="flex min-h-0 min-w-0 flex-1">
            {sel.channelId === ADMIN_VIEW_ID ? (
              <AdminView />
            ) : sel.channelId === ACTIVITY_VIEW_ID ? (
              <ActivityView />
            ) : sel.channelId === SCHEDULED_VIEW_ID ? (
              <ScheduledView />
            ) : sel.channelId === DIRECTORY_VIEW_ID ? (
              <DirectoryView />
            ) : sel.channelId === CHANNEL_BROWSER_VIEW_ID ? (
              <ChannelBrowserView />
            ) : sel.channelId ? (
              <>
                <ChannelView key={sel.channelId} channelId={sel.channelId} />
                {/* tabbed side panel: Thread + the channel's artifacts (phase 13) */}
                {(sel.threadRootId || sel.artifactId || sel.filesOpen) && <SidePanel />}
              </>
            ) : (
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex h-[60px] items-center justify-between border-b border-hairline px-[22px]">
                  <MobileMenuButton />
                </div>
                <div className="flex flex-1 items-center justify-center text-faint">
                  Select a channel
                </div>
              </div>
            )}
          </div>
        </div>
        {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
      </div>
      </HuddleProvider>
     </MobileNavContext.Provider>
    </LiveContext.Provider>
  );
}

/**
 * The seam between the socket (owned by Main) and the huddle controller (owned
 * by HuddleProvider, which Main renders). Renders nothing; it exists so the
 * event handler above can reach `applyInviteEvent` without every huddle state
 * change re-rendering the whole app shell.
 */
function HuddleWiring({
  bridge,
}: {
  bridge: React.MutableRefObject<{
    applyInviteEvent: HuddleState['applyInviteEvent'];
    setSessionId: HuddleState['setSessionId'];
  } | null>;
}) {
  const huddle = useHuddle();
  useEffect(() => {
    bridge.current = { applyInviteEvent: huddle.applyInviteEvent, setSessionId: huddle.setSessionId };
    return () => {
      bridge.current = null;
    };
  }, [bridge, huddle.applyInviteEvent, huddle.setSessionId]);
  return null;
}

/** Marks a Slack team on the rail: a small corner tag, so it reads as Slack
 * without covering the unread badge on the opposite corner. */
function RailSlackMark({ ringColor }: { ringColor: string }) {
  return (
    <span
      data-testid="rail-slack-mark"
      aria-hidden="true"
      className="pointer-events-none absolute -bottom-1 -right-1 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-white"
      style={{ boxShadow: `0 0 0 2px ${ringColor}` }}
    >
      {/* Slack's four-colour hash, reduced to four bars. */}
      <svg viewBox="0 0 12 12" className="h-3 w-3">
        <rect x="2.6" y="0.5" width="2.2" height="11" rx="1.1" fill="#36C5F0" />
        <rect x="7.2" y="0.5" width="2.2" height="11" rx="1.1" fill="#2EB67D" />
        <rect x="0.5" y="2.6" width="11" height="2.2" rx="1.1" fill="#ECB22E" />
        <rect x="0.5" y="7.2" width="11" height="2.2" rx="1.1" fill="#E01E5A" />
      </svg>
    </span>
  );
}

/** Design 3a column 1: the 64px violet workspace rail. */
function WorkspaceRail({ showHelp, onOpenHelp }: { showHelp: boolean; onOpenHelp: () => void }) {
  const sel = useSelection();
  const workspaces = useWorkspaces();
  const switcher = useSwitcherEntries();
  const activeWs = (workspaces.data ?? []).find((w) => w.id === sel.workspaceId);
  const railBg = sidebarColor(activeWs?.sidebarColor).rail;
  const invites = (useWorkspaceInvites().data ?? []).length;
  return (
    <nav
      className="flex w-16 shrink-0 flex-col items-center gap-3.5 py-4"
      style={{ background: railBg }}
    >
      {/* Every connection's workspaces (#592): Slack teams and other Flow
          servers sit on the rail with this one's, and picking one on another
          connection switches this window to it. */}
      {switcher.map((e) => {
        // The foreground connection's live row carries avatar and slug.
        const w = e.foreground ? (workspaces.data ?? []).find((ws) => ws.id === e.workspaceId) : undefined;
        const active = e.foreground && e.workspaceId === sel.workspaceId;
        const avatarUrl = w ? w.avatarUrl : e.avatarUrl;
        // Another connection's avatar is fetched from, and authorized by, that server.
        const avatarRuntime = e.foreground ? undefined : connectionManager().runtime(e.connectionId) ?? undefined;
        const testKey = w?.slug ?? e.workspaceId;
        // Unread across this workspace's channels (#345): live for the
        // foreground connection, from background sync for the others.
        const unread = e.unread;
        const where = e.provider === 'slack' ? ' (Slack)' : e.foreground ? '' : ` (${e.source})`;
        // With an avatar (#336) the image *is* the mark, so "active" can't be
        // the white fill any more — a white ring plus full opacity says it.
        return (
          // The badge overhangs the icon's corner, so it can't live inside the
          // button — that one clips its children (overflow-hidden, for round
          // avatars). The wrapper is what it's positioned against.
          <div key={`${e.connectionId}:${e.workspaceId}`} className="relative">
            <button
              data-testid={`rail-workspace-${testKey}`}
              title={`${e.name}${where}${unread > 0 ? ` — ${unread} unread` : ''}`}
              className={`flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl ${
                avatarUrl
                  ? active
                    ? 'ring-2 ring-white'
                    : 'opacity-70 hover:opacity-100'
                  : active
                    ? 'bg-white text-[17px] font-extrabold text-accent'
                    : 'bg-white/15 text-sm font-bold text-white hover:bg-white/25'
              }`}
              onClick={() => {
                if (active) return;
                if (e.foreground) sel.selectWorkspace(e.workspaceId);
                else openWorkspace(e.connectionId, e.workspaceId);
              }}
            >
              {avatarUrl ? (
                <AuthImg path={avatarUrl} alt={e.name} className="h-10 w-10 object-cover" runtime={avatarRuntime} />
              ) : (
                e.name.slice(0, 1).toUpperCase()
              )}
            </button>
            <RailUnreadBadge count={unread} ringColor={railBg} testId={`rail-unread-${testKey}`} />
            {e.provider === 'slack' && <RailSlackMark ringColor={railBg} />}
          </div>
        );
      })}
      {/* Pending workspace invitations (#359) live on the chooser behind this
          button, so it carries their badge — otherwise an invitation would be
          found only by accident. */}
      <div className="relative">
        <button
          data-testid="rail-add-workspace"
          title={invites > 0 ? `${invites} workspace invitation${invites === 1 ? '' : 's'}` : 'Add a workspace'}
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-dashed border-white/40 text-white/70 hover:border-white/70 hover:text-white"
          onClick={() => sel.selectWorkspace(null)}
        >
          +
        </button>
        <RailUnreadBadge count={invites} ringColor={railBg} testId="rail-workspace-invites" what="workspace invitations" />
      </div>
      {/* Built-in help (#383): far lower-left, large layout only. `max-md:hidden`
          as well as the prop — the class is true the instant the window
          narrows, before the media-query listener has re-rendered anything. */}
      {showHelp && (
        <button
          data-testid="help-button"
          title="Help"
          aria-label="Help"
          className="mt-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/15 text-lg font-bold text-white hover:bg-white/25 max-md:hidden"
          onClick={onOpenHelp}
        >
          ?
        </button>
      )}
    </nav>
  );
}
