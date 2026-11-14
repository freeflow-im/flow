// The assistant's surface, shared by the suite's apps (Docs, Mail, Calendar; design: the floating assistant spec of
// 2026-11-10). A launcher pill floats over the page's bottom-right corner; it opens into a floating panel (or its
// larger, expanded size), and the panel can be anchored beside the page as a side panel, which is each app's own
// layout. One wrapper for every state (`display: contents` once docked), so the app's panel keeps its draft when it
// is anchored or set afloat. Each app keeps its chat; this is only the box around it, the pill, the header buttons
// (AssistantDockControls), the idle timer (useIdleMinimize) and the new chat after a close (useNewChatOnClose).
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import './assistant-dock.css';

/** The person's own assistant in an organization (agents.md §1.1): its name and picture, for the pill. */
export interface MyAssistant { displayName: string; avatarUrl: string | null }

/**
 * Reads the person's assistant in the organization (`GET /api/agent/agents`, its `self` row), again when the organization
 * changes. Null until it is known, and for a guest (who has none): the pill then says "AI Help".
 */
/** The window event that says the person's assistant changed here (a name, a picture): the pill reads it again. */
export const ASSISTANT_CHANGED = 'flow:assistant-changed';
export function assistantChanged(): void {
  window.dispatchEvent(new Event(ASSISTANT_CHANGED));
}

export function useMyAssistant(organizationId: string | null): MyAssistant | null {
  const [mine, setMine] = useState<MyAssistant | null>(null);
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    const again = () => setAsked((n) => n + 1);
    window.addEventListener(ASSISTANT_CHANGED, again);
    return () => window.removeEventListener(ASSISTANT_CHANGED, again);
  }, []);
  useEffect(() => {
    let live = true;
    const url = organizationId ? `/api/agent/agents?workspace=${encodeURIComponent(organizationId)}` : '/api/agent/agents';
    fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { agents?: { self?: boolean; displayName?: string; avatarUrl?: string | null }[] } | null) => {
        const self = body?.agents?.find((a) => a.self);
        if (live) setMine(self?.displayName ? { displayName: self.displayName, avatarUrl: self.avatarUrl ?? null } : null);
      })
      .catch(() => live && setMine(null));
    return () => { live = false; };
  }, [organizationId, asked]);
  return mine;
}

/** Where the panel sits: floating over the page bottom-right (the default), or docked as a side panel beside it. */
export type AssistantPlacement = 'floating' | 'docked';

export interface AssistantDockState {
  open: boolean;
  setOpen(open: boolean): void;
  placement: AssistantPlacement;
  setPlacement(placement: AssistantPlacement): void;
  /** Floating only: the larger panel size. */
  expanded: boolean;
  setExpanded(expanded: boolean): void;
}

/** The floating panel minimizes to the pill after this long with no new text from either side. */
export const IDLE_CLOSE_MS = 2 * 60_000;

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable; the dock just won't remember its state.
  }
}

/**
 * The dock's placement and size, remembered in this browser under `<key>-placement` and `<key>-expanded`. Whether the
 * panel is open stays the app's (its suite bar button and shortcut toggle it).
 */
export function useAssistantDockState(key: string, open: boolean, setOpen: (open: boolean) => void): AssistantDockState {
  const [placement, setPlacementState] = useState<AssistantPlacement>(() => (readStored(`${key}-placement`) === 'docked' ? 'docked' : 'floating'));
  const [expanded, setExpandedState] = useState(() => readStored(`${key}-expanded`) === '1');
  const setPlacement = (p: AssistantPlacement) => {
    setPlacementState(p);
    remember(`${key}-placement`, p);
  };
  const setExpanded = (e: boolean) => {
    setExpandedState(e);
    remember(`${key}-expanded`, e ? '1' : '0');
  };
  return { open, setOpen, placement, setPlacement, expanded, setExpanded };
}

/** Rendered outside a dock (a test, a page of its own), a panel lays out as the side panel. */
const ALONE: AssistantDockState = { open: true, setOpen() {}, placement: 'docked', setPlacement() {}, expanded: false, setExpanded() {} };

const DockCtx = createContext<AssistantDockState>(ALONE);

/** The dock the panel is in: its placement, and the way to change it. */
export const useAssistantDock = () => useContext(DockCtx);

/**
 * An anchored panel drawn outside the dock (a tab of the app's side panel, SidePanel.tsx): its header buttons and
 * idle timer still read and change the dock's state.
 */
export function AssistantDockScope({ state, children }: { state: AssistantDockState; children: ReactNode }) {
  return <DockCtx.Provider value={state}>{children}</DockCtx.Provider>;
}

export interface AssistantDockProps {
  state: AssistantDockState;
  /** The pill's text: the person's assistant's name (useMyAssistant), else "AI Help". */
  label?: string;
  /** The assistant's picture, shown on the pill in place of the spark; none, the spark. */
  avatarUrl?: string | null;
  /** The shortcut that opens and closes the panel (`⌘K`), named in the pill's accessible label and the Minimize button's tooltip. */
  shortcut?: string;
  /** The app's panel, drawn when the dock is open. */
  children: ReactNode;
}

/**
 * The box around an app's assistant panel: the pill when closed, the floating panel when open, and only a wrapper
 * once anchored, when the panel is a child of the app's own layout (beside the page, with the app's resize handle).
 * Goes inside a `position: relative` element: the page area the pill floats over.
 */
export function AssistantDock({ state, label, avatarUrl, shortcut, children }: AssistantDockProps) {
  const text = label?.trim() || 'AI Help';
  const { open, placement, expanded, setOpen } = state;
  const launcherRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(open);
  // Minimized: the launcher takes the focus the panel had. Not on the first draw, which would take it from the page.
  useEffect(() => {
    if (wasOpen.current && !open) launcherRef.current?.focus();
    wasOpen.current = open;
  }, [open]);
  const mode = !open ? 'closed' : placement === 'docked' ? 'docked' : expanded ? 'expanded' : 'open';
  return (
    <DockCtx.Provider value={state}>
      <section className={`assistant-dock ${mode}`} aria-label="Assistant" data-testid="assistant-dock">
        {open ? (
          children
        ) : (
          <button ref={launcherRef} type="button" className="assistant-dock-launcher" onClick={() => setOpen(true)} aria-label={shortcut ? `Open Assistant (${shortcut})` : 'Open Assistant'}>
            {avatarUrl ? <img className="assistant-dock-launcher-avatar" src={avatarUrl} alt="" data-testid="assistant-dock-avatar" /> : <SparkIcon />}
            <span className="assistant-dock-launcher-label">{text}</span>
          </button>
        )}
      </section>
    </DockCtx.Provider>
  );
}

/**
 * The header buttons of a panel in a dock: anchor beside the page and expand or shrink while floating, float again
 * once anchored, and close (which minimizes to the pill). `shortcut` names the key that closes it too.
 */
export function AssistantDockControls({ shortcut }: { shortcut?: string }) {
  const dock = useAssistantDock();
  const docked = dock.placement === 'docked';
  const close = docked ? 'Close' : 'Minimize';
  return (
    <>
      {docked ? (
        <button type="button" className="assistant-dock-btn" onClick={() => dock.setPlacement('floating')} aria-label="Float the panel" title="Float over the page">
          <FloatIcon />
        </button>
      ) : (
        <>
          <button type="button" className="assistant-dock-btn" onClick={() => dock.setPlacement('docked')} aria-label="Anchor the panel beside the page" title="Anchor beside the page">
            <AnchorIcon />
          </button>
          <button type="button" className="assistant-dock-btn" onClick={() => dock.setExpanded(!dock.expanded)} aria-label={dock.expanded ? 'Shrink the panel' : 'Expand the panel'} title={dock.expanded ? 'Shrink' : 'Expand'}>
            {dock.expanded ? <ShrinkIcon /> : <ExpandIcon />}
          </button>
        </>
      )}
      <button type="button" className="assistant-dock-btn assistant-dock-close" onClick={() => dock.setOpen(false)} aria-label={docked ? 'Close assistant' : 'Minimize to the launcher'} title={shortcut ? `${close} (${shortcut})` : close}>
        {docked ? '×' : <MinimizeIcon />}
      </button>
    </>
  );
}

/**
 * Floating and idle, the panel gets out of the way: with no new text for `ms` (any change in `activity`: the draft,
 * a sent message, the assistant's reply or tool calls) it minimizes to the pill. Not while `hold` (a turn runs, a
 * question waits), and never when docked.
 */
export function useIdleMinimize(activity: readonly unknown[], hold: boolean, ms: number = IDLE_CLOSE_MS) {
  const { open, placement, setOpen } = useAssistantDock();
  const setOpenRef = useRef(setOpen);
  setOpenRef.current = setOpen;
  const docked = placement === 'docked';
  useEffect(() => {
    if (!open || docked || hold) return;
    const t = setTimeout(() => setOpenRef.current(false), ms);
    return () => clearTimeout(t);
    // The activity values are the timer's reset; which values there are is fixed per caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, docked, hold, ms, ...activity]);
}

/**
 * Closed, the chat is over: the next open starts a new one (`reset`, the app's New chat, which the idle timer's
 * minimize ends with too). A turn still running when the panel closes finishes first, and the chat resets once it
 * has, unless the panel is opened again before then: the person came back for the answer.
 */
export function useNewChatOnClose(open: boolean, running: boolean, reset: () => void) {
  const pending = useRef(false);
  const wasOpen = useRef(open);
  const resetRef = useRef(reset);
  resetRef.current = reset;
  useEffect(() => {
    if (wasOpen.current && !open) pending.current = true;
    wasOpen.current = open;
    if (open) {
      pending.current = false;
      return;
    }
    if (pending.current && !running) {
      pending.current = false;
      resetRef.current();
    }
  }, [open, running]);
}

export function SparkIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.5l1.6 4.2 4.4 1.6-4.4 1.6L8 13.1 6.4 8.9 2 7.3l4.4-1.6z" fill="currentColor" />
      <path d="M13 11l.6 1.4 1.4.6-1.4.6L13 15l-.6-1.4L11 13l1.4-.6z" fill="currentColor" opacity=".7" />
    </svg>
  );
}

/** Two overlapping windows: the panel set afloat over the page. */
/** One conversation of a chat, as GET /api/agent/history lists it (Docs' ChatSummary). */
export interface ChatSummary {
  id: string;
  startedAt: string;
  title: string;
  active: boolean;
}

const withOrg = (path: string, org: string | null) => (org ? `${path}${path.includes('?') ? '&' : '?'}workspace=${encodeURIComponent(org)}` : path);

/** Where ‹ and › go from the active conversation, newest first: older and newer, or none. A new, empty chat is before the newest. */
export function historySteps(chats: ChatSummary[]): { older?: ChatSummary; newer?: ChatSummary; position: number | null } {
  const at = chats.findIndex((c) => c.active);
  if (at === -1) return { older: chats[0], position: null };
  return { older: chats[at + 1], newer: at > 0 ? chats[at - 1] : undefined, position: chats.length - at };
}

const describeChat = (c: ChatSummary) => {
  const when = new Date(c.startedAt);
  const date = Number.isNaN(when.getTime()) ? '' : when.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return [c.title || 'Chat', date].filter(Boolean).join(' · ');
};

/** How a panel reads its chat's conversations and goes back to one: its app's own API calls (Docs' carry a folder). */
export interface ChatHistoryApi {
  list(): Promise<ChatSummary[]>;
  reopen(id: string): Promise<void>;
}

/** The history calls of a chat in the suite's organization `org` (Mail's, Calendar's, the suite bar's own chat). */
export function orgChatHistory(org: string | null, scope: string): ChatHistoryApi {
  return {
    list: async () => {
      const r = await fetch(withOrg(`/api/agent/history?scope=${encodeURIComponent(scope)}`, org), { credentials: 'same-origin' });
      return r.ok ? ((await r.json()) as { chats: ChatSummary[] }).chats ?? [] : [];
    },
    reopen: async (id) => {
      const r = await fetch(withOrg('/api/agent/reopen', org), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope, id }) });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Request failed (${r.status})`);
    },
  };
}

/**
 * ‹ › in an assistant panel's header: back to the chat's earlier conversations (GET /api/agent/history), one step at a
 * time, and forward again. A step makes that conversation the chat's active one (POST /api/agent/reopen), which then
 * goes on from where it stopped; the panel reloads it (`onReopened`). Hidden while there is nothing earlier. `refreshKey`
 * changes when the chat does (which chat it is, its items, a turn ending), so the list follows.
 */
export function ChatHistoryNav({ history, busy, refreshKey, onReopened }: { history: ChatHistoryApi; busy: boolean; refreshKey: unknown; onReopened: () => void }) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [moving, setMoving] = useState(false);
  const [seq, setSeq] = useState(0);
  const api = useRef(history);
  api.current = history;
  useEffect(() => {
    let live = true;
    api.current.list().then((list) => { if (live) setChats(list); }).catch(() => undefined);
    return () => { live = false; };
  }, [refreshKey, seq]);
  const { older, newer, position } = historySteps(chats);
  if (!older && !newer) return null;
  const go = async (c: ChatSummary) => {
    setMoving(true);
    try {
      await api.current.reopen(c.id);
      onReopened();
    } catch {
      // Gone, or the assistant started working: the list is read again below.
    } finally {
      setMoving(false);
      setSeq((n) => n + 1);
    }
  };
  const off = busy || moving;
  return (
    <span className="assistant-history" data-testid="assistant-history">
      <button type="button" className="assistant-dock-btn" disabled={off || !older} onClick={() => older && void go(older)} aria-label="Earlier chat" title={older ? `Earlier chat: ${describeChat(older)}` : 'No earlier chat'} data-testid="assistant-history-older">
        <ChevronIcon left />
      </button>
      {position !== null && <span className="assistant-history-pos" aria-label={`Chat ${position} of ${chats.length}`}>{position}/{chats.length}</span>}
      <button type="button" className="assistant-dock-btn" disabled={off || !newer} onClick={() => newer && void go(newer)} aria-label="Later chat" title={newer ? `Later chat: ${describeChat(newer)}` : 'This is the latest chat'} data-testid="assistant-history-newer">
        <ChevronIcon />
      </button>
    </span>
  );
}

function ChevronIcon({ left = false }: { left?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={left ? 'M15 18l-6-6 6-6' : 'M9 18l6-6-6-6'} />
    </svg>
  );
}

function FloatIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="7" width="14" height="14" rx="2" />
      <path d="M7 7V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2" />
    </svg>
  );
}

/** A window with a column on its right: the panel anchored beside the page. */
function AnchorIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
    </svg>
  );
}

function ShrinkIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
    </svg>
  );
}

function MinimizeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M5 12h14" />
    </svg>
  );
}
