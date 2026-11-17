// The channel visitor's page (docs/specs/chat-visitors.md §1.2, §1.3): /chat/visit/<token>.
//
// A visitor has no account, so this page shares nothing with the signed-in app but its components. It asks the server
// who the `vsid` cookie names first (a returning visitor goes straight in, even after the link stopped working), then
// the link's preview for the name screen. Inside, the channel is Chat's own message list, thread and composer, mounted
// on a VisitorRuntime (lib/visitor.ts) with the contexts they read, and a visitor socket for live updates.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Event, MessageDTO, VisitorMeDTO, VisitorPreviewDTO } from '@flow/shared';
import {
  AuthContext,
  ConnectionContext,
  LiveContext,
  MobileNavContext,
  SelectionContext,
  typingKey,
  useLive,
  useSelection,
  type LiveState,
  type Selection,
} from '../state';
import type { SocketStatus } from '../lib/ws';
import { applyMessageEvent, removeMessageFromCache } from '../lib/messageCache';
import {
  LINK_GONE,
  TURNSTILE_SCRIPT,
  TURNSTILE_SITE_KEY,
  VISITOR_NAME_MAX,
  VisitorRuntime,
  VisitorSocketClient,
  cleanName,
  visitorUser,
} from '../lib/visitor';
import { flattenMessages, useChannelPeople, useMessages } from '../hooks';
import { renderBody } from '../lib/format';
import MessageList from './MessageList';
import Composer, { arrowUpEdit } from './Composer';
import ThreadPanel from './ThreadPanel';

type Phase =
  | { kind: 'loading' }
  | { kind: 'join'; preview: VisitorPreviewDTO }
  | { kind: 'gone' }
  | { kind: 'in'; me: VisitorMeDTO }
  | { kind: 'ended'; channelName: string; left: boolean };

/** The visitor's REST calls before there is a runtime: plain same-origin fetches, the cookie sent by the browser. */
async function visit<T>(method: string, path: string, body?: unknown): Promise<{ ok: true; value: T } | { ok: false; status: number; message: string }> {
  try {
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!res.ok) return { ok: false, status: res.status, message: json.error?.message ?? `HTTP ${res.status}` };
    return { ok: true, value: json };
  } catch (err) {
    return { ok: false, status: 0, message: err instanceof Error ? err.message : 'network error' };
  }
}

export default function VisitorApp({ token }: { token: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });

  useEffect(() => {
    document.title = 'Visitor · FreeFlow';
    let cancelled = false;
    void (async () => {
      const me = await visit<VisitorMeDTO>('GET', '/v1/visitor/me');
      if (cancelled) return;
      if (me.ok) return setPhase({ kind: 'in', me: me.value });
      const preview = await visit<VisitorPreviewDTO>('GET', `/v1/visit/${encodeURIComponent(token)}`);
      if (cancelled) return;
      setPhase(preview.ok ? { kind: 'join', preview: preview.value } : { kind: 'gone' });
    })();
    return () => { cancelled = true; };
  }, [token]);

  if (phase.kind === 'loading') return <Centered><p className="text-sm text-muted">Loading…</p></Centered>;
  if (phase.kind === 'gone') {
    return (
      <Centered>
        <p data-testid="visitor-link-gone" className="text-sm text-ink">{LINK_GONE}</p>
      </Centered>
    );
  }
  if (phase.kind === 'join') {
    return <VisitorJoin token={token} preview={phase.preview} onJoined={(me) => setPhase({ kind: 'in', me })} onGone={() => setPhase({ kind: 'gone' })} />;
  }
  if (phase.kind === 'ended') {
    return (
      <Centered>
        <p data-testid="visitor-ended" className="text-sm text-ink">
          {phase.left
            ? `You left #${phase.channelName}.`
            : `Your visit to #${phase.channelName} has ended. Ask the person who sent the link for a new one.`}
        </p>
      </Centered>
    );
  }
  return <VisitorChannel me={phase.me} onEnded={(left) => setPhase({ kind: 'ended', channelName: phase.me.channel.name, left })} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-base p-4">
      <div className="w-[min(24rem,100%)] rounded-xl border border-hairline bg-white p-6 text-center shadow-sm">{children}</div>
    </div>
  );
}

function OrgIcon({ name, url }: { name: string; url: string | null }) {
  const [failed, setFailed] = useState(false);
  if (url && !failed) return <img src={url} alt="" className="mx-auto mb-2 size-12 rounded-xl object-cover" onError={() => setFailed(true)} />;
  return (
    <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-xl bg-accent text-xl font-bold text-white">
      {name.trim().charAt(0).toUpperCase() || '?'}
    </div>
  );
}

// ---- the name screen --------------------------------------------------------------------------------------------------

interface TurnstileApi {
  render(el: HTMLElement, options: Record<string, unknown>): string;
  remove?(id: string): void;
}
declare global {
  interface Window { turnstile?: TurnstileApi }
}

/** Loads Cloudflare Turnstile once and renders its check into `ref` (V10). `failed`: the widget could not run here, and
 * the server, which decides, is asked anyway. */
function useTurnstile(ref: React.RefObject<HTMLDivElement | null>) {
  const [token, setToken] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let widget: string | null = null;
    let stopped = false;
    const render = () => {
      if (stopped || !ref.current || !window.turnstile || widget) return;
      try {
        widget = window.turnstile.render(ref.current, {
          sitekey: TURNSTILE_SITE_KEY,
          callback: (t: string) => { setToken(t); setFailed(false); },
          'expired-callback': () => setToken(null),
          'error-callback': () => { setFailed(true); return true; },
        });
      } catch {
        setFailed(true);
      }
    };
    if (window.turnstile) render();
    else {
      let script = document.querySelector<HTMLScriptElement>('script[data-turnstile]');
      if (!script) {
        script = document.createElement('script');
        script.src = TURNSTILE_SCRIPT;
        script.async = true;
        script.dataset.turnstile = '';
        document.head.appendChild(script);
      }
      script.addEventListener('load', render);
      script.addEventListener('error', () => setFailed(true));
    }
    return () => {
      stopped = true;
      if (widget) window.turnstile?.remove?.(widget);
    };
  }, [ref]);
  return { token, failed };
}

function VisitorJoin({
  token,
  preview,
  onJoined,
  onGone,
}: {
  token: string;
  preview: VisitorPreviewDTO;
  onJoined: (me: VisitorMeDTO) => void;
  onGone: () => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const widget = useRef<HTMLDivElement>(null);
  const turnstile = useTurnstile(widget);
  const clean = cleanName(name);
  const ready = !!clean && (!!turnstile.token || turnstile.failed) && !busy;

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || !clean) return;
    setBusy(true);
    setError(null);
    const res = await visit<VisitorMeDTO>('POST', `/v1/visit/${encodeURIComponent(token)}`, { name: clean, turnstile: turnstile.token ?? '' });
    setBusy(false);
    if (res.ok) return onJoined(res.value);
    if (res.status === 404) return onGone();
    setError(res.message);
  };

  return (
    <Centered>
      <form onSubmit={(e) => void join(e)} data-testid="visitor-join">
        <OrgIcon name={preview.organization.name} url={preview.organization.avatarUrl} />
        <p className="text-xs text-muted">{preview.organization.name}</p>
        <h1 data-testid="visitor-join-channel" className="mt-1 text-xl font-bold text-ink"># {preview.channel.name}</h1>
        {preview.channel.topic && <p className="mt-1 text-sm text-muted">{preview.channel.topic}</p>}
        <p className="mt-3 text-sm text-ink-soft">
          You are invited to this channel as a visitor. You will see messages from when you join.
        </p>
        <label className="mt-4 block text-left text-xs font-semibold text-ink-soft" htmlFor="visitor-name">Your name</label>
        <input
          id="visitor-name"
          data-testid="visitor-name"
          autoFocus
          maxLength={VISITOR_NAME_MAX}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 w-full rounded-lg border border-hairline px-3 py-2 text-sm"
          placeholder="How people here will see you"
        />
        <div ref={widget} data-testid="visitor-turnstile" className="mt-3 flex min-h-[65px] justify-center" />
        {error && <p data-testid="visitor-join-error" className="mt-2 text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          data-testid="visitor-join-submit"
          disabled={!ready}
          className="mt-3 w-full rounded-lg bg-accent py-2 text-sm font-semibold text-white hover:bg-accent-deep disabled:opacity-50"
        >
          {busy ? 'Joining…' : 'Join'}
        </button>
      </form>
    </Centered>
  );
}

// ---- inside the channel -----------------------------------------------------------------------------------------------

/** Everything the shared components read from context, for a visitor: their identity, their one channel, live typing. */
function VisitorChannel({ me: first, onEnded }: { me: VisitorMeDTO; onEnded: (left: boolean) => void }) {
  const qc = useQueryClient();
  const runtime = useMemo(() => new VisitorRuntime(first), [first]);
  const [me, setMe] = useState(first);
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;

  // Who is in the channel changes as people join and leave: ask again, and let every list read it afresh.
  const refreshMe = useCallback(async () => {
    const res = await visit<VisitorMeDTO>('GET', '/v1/visitor/me');
    if (!res.ok) {
      if (res.status === 401) onEndedRef.current(false);
      return;
    }
    runtime.setMe(res.value);
    setMe(res.value);
    for (const key of ['members', 'channels', 'channelMembers', 'channelVisitors', 'workspaces']) void qc.invalidateQueries({ queryKey: [key] });
  }, [qc, runtime]);

  useEffect(() => {
    runtime.setUnauthorizedHandler(() => onEndedRef.current(false));
    return () => runtime.setUnauthorizedHandler(null);
  }, [runtime]);

  // ---- selection: one channel, its threads, the message being edited ----
  const [threadRootId, setThreadRootId] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [focusMessageId, setFocusMessageId] = useState<string | null>(null);
  const selection = useMemo((): Selection => {
    const none = () => {};
    return {
      workspaceId: me.organization.id,
      channelId: me.channel.id,
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
      jumpToMessage: (_c, messageId, root) => { setThreadRootId(root ?? null); setFocusMessageId(messageId); },
      clearFocusMessage: () => setFocusMessageId(null),
    };
  }, [me.organization.id, me.channel.id, threadRootId, editingMessageId, focusMessageId]);

  // ---- the socket: the channel's events the visitor may see (§2) ----
  const [status, setStatus] = useState<SocketStatus>('connecting');
  const [typing, setTyping] = useState<Record<string, Record<string, number>>>({});
  const socket = useRef<VisitorSocketClient | null>(null);
  useEffect(() => {
    let wasDown = false;
    const onEvent = (event: Event) => {
      switch (event.type) {
        case 'message.created':
        case 'message.updated':
        case 'message.deleted':
        case 'thread.reply': {
          const msg = event.data as MessageDTO;
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
          // Someone this page does not know yet (they just joined): ask who is here now.
          if (!runtime.me.channel.people.some((p) => p.userId === msg.userId)) void refreshMe();
          break;
        }
        case 'message.purged': {
          const msg = event.data as MessageDTO;
          removeMessageFromCache(qc, msg);
          if (msg.threadRootId === null) setThreadRootId((cur) => (cur === msg.id ? null : cur));
          break;
        }
        case 'reaction.added':
        case 'reaction.removed':
          void qc.invalidateQueries({ queryKey: ['messages'] });
          void qc.invalidateQueries({ queryKey: ['thread'] });
          break;
        case 'typing': {
          const t = event.data as { userId: string; channelId: string; threadRootId?: string };
          if (t.userId === runtime.me.user.id) break;
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
        case 'channel.updated':
        case 'channel.archived':
        case 'member.joined':
        case 'member.left':
          void refreshMe();
          break;
        default:
          break;
      }
    };
    const client = new VisitorSocketClient({
      onEvent,
      onStatus: (s) => {
        setStatus(s);
        if (s === 'reconnecting') {
          wasDown = true;
          // A closed socket may mean the visit ended (removed, link off, visitors off): the server says so here.
          void refreshMe();
        } else if (s === 'connected' && wasDown) {
          wasDown = false;
          void qc.invalidateQueries({ queryKey: ['messages'] });
          void qc.invalidateQueries({ queryKey: ['thread'] });
        }
      },
    });
    socket.current = client;
    client.start();
    return () => {
      client.stop();
      socket.current = null;
    };
  }, [qc, runtime, refreshMe]);

  const live = useMemo((): LiveState => ({
    status,
    isOnline: () => false,
    typing,
    notificationUnread: 0,
    setNotificationUnread: () => {},
    sendTyping: (channelId, root) => socket.current?.sendTyping(channelId, root),
  }), [status, typing]);

  const leave = useCallback(async () => {
    socket.current?.stop();
    await visit('POST', '/v1/visitor/leave');
    onEndedRef.current(true);
  }, []);

  const auth = useMemo(() => ({ user: visitorUser(me), setUser: () => {}, signOut: () => void leave() }), [me, leave]);

  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 767px)').matches);
  useEffect(() => {
    const mq = window.matchMedia?.('(max-width: 767px)');
    if (!mq) return;
    const on = () => setIsMobile(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const mobileNav = useMemo(() => ({ isMobile, drawerOpen: false, openDrawer: () => {}, closeDrawer: () => {} }), [isMobile]);

  return (
    <ConnectionContext.Provider value={runtime}>
      <AuthContext.Provider value={auth}>
        <SelectionContext.Provider value={selection}>
          <LiveContext.Provider value={live}>
            <MobileNavContext.Provider value={mobileNav}>
              <div className="flex h-full min-h-0" data-testid="visitor-app">
                <VisitorChannelPane me={me} onLeave={() => void leave()} />
                {threadRootId && <ThreadPanel key={threadRootId} rootId={threadRootId} />}
              </div>
            </MobileNavContext.Provider>
          </LiveContext.Provider>
        </SelectionContext.Provider>
      </AuthContext.Provider>
    </ConnectionContext.Provider>
  );
}

/** The channel: its name and topic, the visitor line and Leave; the shared message list, typing line and composer. */
function VisitorChannelPane({ me, onLeave }: { me: VisitorMeDTO; onLeave: () => void }) {
  const channelId = me.channel.id;
  const messagesQ = useMessages(channelId);
  const messages = useMemo(() => flattenMessages(messagesQ.data?.pages), [messagesQ.data]);
  const channel = useMemo(() => ({ id: channelId, kind: 'standard' as const, isPrivate: false }), [channelId]);
  const { names, memberMap } = useChannelPeople(me.organization.id, channel);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const live = useLive();
  const typingNow = Object.entries(live.typing[typingKey(channelId)] ?? {})
    .filter(([uid, ts]) => Date.now() - ts < 5000 && uid !== me.user.id)
    .map(([uid]) => names[uid] ?? 'Someone');

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-white">
      <header className="flex min-h-[60px] shrink-0 items-center justify-between gap-3 border-b border-hairline px-[22px] py-2 max-md:px-3">
        <div className="min-w-0 flex-1">
          <h2 data-testid="channel-header" className="truncate text-[15px] font-bold">
            <span className="text-muted"># </span>{me.channel.name}
            <span className="ml-2 text-xs font-normal text-faint">{me.organization.name}</span>
          </h2>
          {me.channel.topic && (
            <p data-testid="channel-topic" className="truncate text-xs text-muted">{renderBody(me.channel.topic, names, me.user.id)}</p>
          )}
          <p data-testid="visitor-note" className="truncate text-xs text-ink-soft">You are a visitor. You see messages from when you joined.</p>
        </div>
        {confirmLeave ? (
          <span className="flex shrink-0 items-center gap-2 text-xs">
            <span className="text-muted max-md:hidden">Leave this channel? You cannot come back without a new link.</span>
            <button type="button" data-testid="visitor-leave-confirm" className="rounded-lg bg-red-600 px-2.5 py-1 font-semibold text-white" onClick={onLeave}>Leave</button>
            <button type="button" className="rounded-lg px-2 py-1 text-ink-soft hover:bg-daypill" onClick={() => setConfirmLeave(false)}>Cancel</button>
          </span>
        ) : (
          <button
            type="button"
            data-testid="visitor-leave"
            className="shrink-0 rounded-lg border border-hairline px-2.5 py-1 text-xs font-semibold text-ink-soft hover:bg-daypill"
            onClick={() => setConfirmLeave(true)}
          >
            Leave
          </button>
        )}
      </header>

      <MessageList
        key={channelId}
        scrollKey={channelId}
        messages={messages}
        names={names}
        membersById={memberMap}
        hasMore={messagesQ.hasNextPage ?? false}
        onLoadOlder={() => void messagesQ.fetchNextPage()}
        showThreadAffordances
      />

      <div className="h-5 px-[22px] text-xs text-muted" data-testid="typing-indicator-slot">
        {typingNow.length === 1 && <span data-testid="typing-indicator">{typingNow[0]} is typing…</span>}
        {typingNow.length > 1 && <span data-testid="typing-indicator">Several people are typing…</span>}
      </div>

      <VisitorComposer channelId={channelId} channelName={me.channel.name} messages={messages} userId={me.user.id} />
    </section>
  );
}

function VisitorComposer({ channelId, channelName, messages, userId }: { channelId: string; channelName: string; messages: MessageDTO[]; userId: string }) {
  const sel = useSelection();
  return (
    <Composer
      channelId={channelId}
      placeholder={`Message #${channelName}`}
      onArrowUpEdit={arrowUpEdit(messages, userId, sel.setEditingMessage)}
      editingMessage={messages.find((m) => m.id === sel.editingMessageId)}
    />
  );
}
