// A meeting's chat inside Meet (docs/specs/meetings.md §9 3b): /chat/meeting/<channelId>, which Meet's room shows in a
// frame on its Chat tab, as the suite's side panels show one app inside another (@flow/shared meetingChat.ts).
//
// The page is Chat's message list, thread and composer on their own, the way the visitor page (VisitorApp) mounts
// them: a member's page runs on their Chat session (the connection for this origin) with a socket of its own; a
// guest's (`?visitor=1`) runs on the visitor cookie the guest join set, through VisitorApp's VisitorChannel. Either way
// the page tells the room of each new message, for the dot on the Chat tab, and reads the channel only while the room
// says the tab is open.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  MEETING_CHAT_FRAME_MESSAGE,
  isMeetingChatShownMessage,
  type Event,
  type MeetingChatFrameMessage,
  type MeetingChatFrameTarget,
  type MessageDTO,
  type UserDTO,
  type VisitorMeDTO,
} from '@flow/shared';
import { AuthContext, ConnectionContext, LiveContext, MobileNavContext, SelectionContext, typingKey, useAuth, useLive, useSelection, type LiveState, type Selection } from '../state';
import { connectionManager, type ConnectionRuntime } from '../lib/connectionRuntime';
import { SocketClient, SocketCursors, type SocketStatus } from '../lib/ws';
import { applyMessageEvent, removeMessageFromCache } from '../lib/messageCache';
import { flattenMessages, useChannelPeople, useMarkRead, useMessages } from '../hooks';
import { VisitorChannel } from './VisitorApp';
import MessageList from './MessageList';
import Composer, { arrowUpEdit } from './Composer';
import ThreadPanel from './ThreadPanel';

/** Tells the room that frames this page about a new message. */
function tellRoom(msg: MessageDTO, selfId: string): void {
  if (window.parent === window) return;
  const note: MeetingChatFrameMessage = { type: MEETING_CHAT_FRAME_MESSAGE, event: 'message', mine: msg.userId === selfId };
  window.parent.postMessage(note, location.origin);
}

/** Whether the room shows the chat now (its Chat tab is open). On its own, not in a frame, the page always shows. */
function useShownInRoom(): boolean {
  const [shown, setShown] = useState(() => window.parent === window);
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== window.parent) return;
      if (isMeetingChatShownMessage(e.data)) setShown(e.data.shown);
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, []);
  return shown;
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-white p-6 text-center">
      <p data-testid="meeting-chat-note" className="text-sm text-muted">{children}</p>
    </div>
  );
}

export default function MeetingChatApp({ target }: { target: MeetingChatFrameTarget }) {
  useEffect(() => {
    document.title = 'Meeting chat · FreeFlow';
  }, []);
  return target.visitor ? <GuestChat channelId={target.channelId} /> : <MemberChat channelId={target.channelId} workspaceId={target.workspaceId} />;
}

// ---- a guest: the visitor the guest join made ------------------------------------------------------------------------

function GuestChat({ channelId }: { channelId: string }) {
  const [phase, setPhase] = useState<{ kind: 'loading' } | { kind: 'in'; me: VisitorMeDTO } | { kind: 'ended' }>({ kind: 'loading' });
  useEffect(() => {
    let cancelled = false;
    void fetch('/v1/visitor/me', { credentials: 'same-origin' })
      .then(async (res) => (res.ok ? ((await res.json()) as VisitorMeDTO) : null))
      .catch(() => null)
      .then((me) => {
        if (cancelled) return;
        setPhase(me && me.channel.id === channelId ? { kind: 'in', me } : { kind: 'ended' });
      });
    return () => {
      cancelled = true;
    };
  }, [channelId]);
  if (phase.kind === 'loading') return <Note>Loading…</Note>;
  if (phase.kind === 'ended') return <Note>The chat is not open to you now. It opens again when you join the meeting.</Note>;
  return (
    <VisitorChannel
      me={phase.me}
      onEnded={() => setPhase({ kind: 'ended' })}
      onMessage={(msg) => tellRoom(msg, phase.me.user.id)}
      pane={(me) => <ChatPane channelId={me.channel.id} workspaceId={me.organization.id} selfId={me.user.id} guest />}
    />
  );
}

// ---- a member: their Chat session on this origin ---------------------------------------------------------------------

function MemberChat({ channelId, workspaceId }: { channelId: string; workspaceId: string | null }) {
  const runtime = useMemo(() => connectionManager().add(location.origin), []);
  const [user, setUser] = useState<UserDTO | null | 'signed-out'>(null);
  useEffect(() => {
    let cancelled = false;
    runtime.api<UserDTO>('GET', '/v1/me').then(
      (u) => !cancelled && setUser(u),
      () => !cancelled && setUser('signed-out'),
    );
    return () => {
      cancelled = true;
    };
  }, [runtime]);
  if (user === null) return <Note>Loading…</Note>;
  if (user === 'signed-out' || !workspaceId) return <Note>Sign in to FreeFlow Chat in this browser to see the meeting’s chat.</Note>;
  return <MemberChannel runtime={runtime} user={user} setUser={setUser} channelId={channelId} workspaceId={workspaceId} />;
}

function MemberChannel({
  runtime,
  user,
  setUser,
  channelId,
  workspaceId,
}: {
  runtime: ConnectionRuntime;
  user: UserDTO;
  setUser: (u: UserDTO) => void;
  channelId: string;
  workspaceId: string;
}) {
  const qc = useQueryClient();
  const [threadRootId, setThreadRootId] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [focusMessageId, setFocusMessageId] = useState<string | null>(null);
  const selection = useMemo((): Selection => {
    const none = () => {};
    return {
      workspaceId,
      channelId,
      threadRootId,
      artifactId: null,
      filesOpen: false,
      editingMessageId,
      focusMessageId,
      canGoBack: false,
      canGoForward: false,
      goBack: none,
      goForward: none,
      selectWorkspace: none,
      selectChannel: none,
      selectArtifact: none,
      openArtifactIn: none,
      openFiles: none,
      openThread: setThreadRootId,
      showThread: none,
      closeSidePanel: () => setThreadRootId(null),
      setEditingMessage: setEditingMessageId,
      jumpToMessage: (c, messageId, root) => {
        if (c !== channelId) return;
        setThreadRootId(root ?? null);
        setFocusMessageId(messageId);
      },
      clearFocusMessage: () => setFocusMessageId(null),
    };
  }, [workspaceId, channelId, threadRootId, editingMessageId, focusMessageId]);

  // The socket: this channel's events (the member's socket carries every channel they are in; the rest are ignored).
  const [status, setStatus] = useState<SocketStatus>('connecting');
  const [typing, setTyping] = useState<Record<string, Record<string, number>>>({});
  const socket = useRef<SocketClient | null>(null);
  useEffect(() => {
    const token = runtime.getToken();
    if (!token) return;
    let client: SocketClient | null = null;
    let cancelled = false;
    const onEvent = (event: Event) => {
      switch (event.type) {
        case 'message.created':
        case 'message.updated':
        case 'message.deleted':
        case 'thread.reply': {
          const msg = event.data as MessageDTO;
          if (msg.channelId !== channelId) break;
          const insert = event.type === 'message.created' || event.type === 'thread.reply';
          if (insert) {
            const key = typingKey(msg.channelId, msg.threadRootId);
            setTyping((prev) => {
              if (!prev[key]?.[msg.userId]) return prev;
              const { [msg.userId]: _gone, ...rest } = prev[key]!;
              return { ...prev, [key]: rest };
            });
          }
          applyMessageEvent(qc, msg, insert);
          if (event.type === 'message.created') tellRoom(msg, user.id);
          break;
        }
        case 'message.purged': {
          const msg = event.data as MessageDTO;
          if (msg.channelId !== channelId) break;
          removeMessageFromCache(qc, msg);
          if (msg.threadRootId === null) setThreadRootId((cur) => (cur === msg.id ? null : cur));
          break;
        }
        case 'reaction.added':
        case 'reaction.removed':
          void qc.invalidateQueries({ queryKey: ['messages', channelId] });
          void qc.invalidateQueries({ queryKey: ['thread'] });
          break;
        case 'typing': {
          const t = event.data as { userId: string; channelId: string; threadRootId?: string };
          if (t.userId === user.id || t.channelId !== channelId) break;
          const key = typingKey(t.channelId, t.threadRootId);
          setTyping((prev) => ({ ...prev, [key]: { ...(prev[key] ?? {}), [t.userId]: Date.now() } }));
          window.setTimeout(() => setTyping((prev) => {
            const at = prev[key]?.[t.userId];
            if (at === undefined || Date.now() - at < 5000) return prev;
            const { [t.userId]: _gone, ...rest } = prev[key]!;
            return { ...prev, [key]: rest };
          }), 5200);
          break;
        }
        case 'member.joined':
        case 'member.left':
          void qc.invalidateQueries({ queryKey: ['channelMembers', channelId] });
          void qc.invalidateQueries({ queryKey: ['channelVisitors', channelId] });
          break;
        default:
          break;
      }
    };
    let wasDown = false;
    void (async () => {
      // A server with a socket per organization (as Main does): this page needs only the meeting's.
      const info = (await fetch(`${runtime.origin}/v1/client-info`).then((r) => r.json()).catch(() => null)) as { capabilities?: { socketPerOrganization?: boolean } } | null;
      if (cancelled) return;
      const url = info?.capabilities?.socketPerOrganization ? `${runtime.socketUrl}?workspace=${encodeURIComponent(workspaceId)}` : runtime.socketUrl;
      client = new SocketClient(token, {
        onEvent,
        onStatus: (s) => {
          setStatus(s);
          if (s === 'reconnecting') wasDown = true;
          else if (s === 'connected' && wasDown) {
            wasDown = false;
            void qc.invalidateQueries({ queryKey: ['messages', channelId] });
            void qc.invalidateQueries({ queryKey: ['thread'] });
          }
        },
      }, url, Math.random, new SocketCursors(() => null));
      socket.current = client;
      client.start();
    })();
    return () => {
      cancelled = true;
      client?.stop();
      socket.current = null;
    };
  }, [qc, runtime, channelId, workspaceId, user.id]);

  const live = useMemo((): LiveState => ({
    status,
    isOnline: () => false,
    typing,
    notificationUnread: 0,
    setNotificationUnread: () => {},
    sendTyping: (c, root) => socket.current?.sendTyping(c, root),
  }), [status, typing]);
  const auth = useMemo(() => ({ user, setUser, signOut: () => {} }), [user, setUser]);
  const mobileNav = useNarrow();

  return (
    <ConnectionContext.Provider value={runtime}>
      <AuthContext.Provider value={auth}>
        <SelectionContext.Provider value={selection}>
          <LiveContext.Provider value={live}>
            <MobileNavContext.Provider value={mobileNav}>
              <div className="flex h-full min-h-0" data-testid="meeting-chat-app">
                <ChatPane channelId={channelId} workspaceId={workspaceId} selfId={user.id} />
              </div>
            </MobileNavContext.Provider>
          </LiveContext.Provider>
        </SelectionContext.Provider>
      </AuthContext.Provider>
    </ConnectionContext.Provider>
  );
}

/** The panel is narrow: the shared components lay out as on a phone (a thread over the list, not beside it). */
function useNarrow() {
  const [isMobile, setIsMobile] = useState(() => !!window.matchMedia?.('(max-width: 767px)').matches);
  useEffect(() => {
    const mq = window.matchMedia?.('(max-width: 767px)');
    if (!mq) return;
    const on = () => setIsMobile(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return useMemo(() => ({ isMobile, drawerOpen: false, openDrawer: () => {}, closeDrawer: () => {} }), [isMobile]);
}

/**
 * The chat itself, for a member or a guest: the shared message list, typing line and composer, the open thread over
 * them. No header: the room's panel has its own. A member's page reads the channel while the room shows it.
 */
function ChatPane({ channelId, workspaceId, selfId, guest = false }: { channelId: string; workspaceId: string; selfId: string; guest?: boolean }) {
  const sel = useSelection();
  const auth = useAuth();
  const live = useLive();
  const messagesQ = useMessages(channelId);
  const messages = useMemo(() => flattenMessages(messagesQ.data?.pages), [messagesQ.data]);
  const channel = useMemo(() => ({ id: channelId, kind: 'meeting' as const, isPrivate: true }), [channelId]);
  const { names, memberMap, refetchVisitors } = useChannelPeople(workspaceId, channel);
  // A guest who joined after the list was read (their first message): read the channel's visitors again, once.
  const unknownVisitor = messages.find((m) => m.visitor && !memberMap[m.userId])?.userId ?? null;
  const askedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!unknownVisitor || askedFor.current === unknownVisitor) return;
    askedFor.current = unknownVisitor;
    void refetchVisitors();
  }, [unknownVisitor, refetchVisitors]);
  const typingNow = Object.entries(live.typing[typingKey(channelId)] ?? {})
    .filter(([uid, ts]) => Date.now() - ts < 5000 && uid !== selfId)
    .map(([uid]) => names[uid] ?? 'Someone');

  // Reading it: a mention of you here is read once the room shows the chat (a guest has no read cursor).
  const shown = useShownInRoom();
  const markRead = useMarkRead();
  const lastRead = useRef<string | null>(null);
  const newestId = messages.at(-1)?.id ?? null;
  const read = useCallback(() => {
    if (guest || !shown || !newestId || newestId === lastRead.current || newestId.startsWith('pending')) return;
    lastRead.current = newestId;
    markRead.mutate({ channelId, lastReadMsgId: newestId });
  }, [guest, shown, newestId, channelId, markRead]);
  useEffect(read, [read]);

  return (
    <section className="relative flex min-w-0 flex-1 flex-col bg-white">
      {guest && <p data-testid="meeting-chat-guest-note" className="m-0 shrink-0 border-b border-hairline px-3 py-1.5 text-xs text-ink-soft">You are a guest. You see the chat from when you joined.</p>}
      <MessageList
        key={channelId}
        scrollKey={`meeting:${channelId}`}
        messages={messages}
        names={names}
        membersById={memberMap}
        hasMore={messagesQ.hasNextPage ?? false}
        onLoadOlder={() => void messagesQ.fetchNextPage()}
        showThreadAffordances
        focusMessageId={sel.threadRootId ? null : sel.focusMessageId}
        onFocused={() => sel.clearFocusMessage()}
      />
      <div className="h-5 px-3 text-xs text-muted" data-testid="typing-indicator-slot">
        {typingNow.length === 1 && <span data-testid="typing-indicator">{typingNow[0]} is typing…</span>}
        {typingNow.length > 1 && <span data-testid="typing-indicator">Several people are typing…</span>}
      </div>
      <Composer
        channelId={channelId}
        placeholder="Message everyone in the meeting"
        onArrowUpEdit={arrowUpEdit(messages, auth.user.id, sel.setEditingMessage)}
        editingMessage={messages.find((m) => m.id === sel.editingMessageId)}
      />
      {sel.threadRootId && (
        <div className="absolute inset-0 z-30 flex bg-white">
          <ThreadPanel key={sel.threadRootId} rootId={sel.threadRootId} />
        </div>
      )}
    </section>
  );
}
