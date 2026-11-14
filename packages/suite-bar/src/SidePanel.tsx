// The side panel (docs/specs/side-panel.md): another app beside this one, in a panel on the right with a tab per app.
// Closed, it is a pill on the right edge with one button per panel; a button opens the panel on that tab. Each tab is
// the other app's panel page in a frame, made the first time the tab shows and kept, hidden, while another shows. The
// host app draws it in its own layout (so it is the same in Home and in the app's tab); which panels a host shows is
// its manifest's `sidePanels` (@flow/shared/manifests' sidePanelsOf).
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { SidePanelEntry } from '@flow/shared/manifests';
export { sidePanelsOf, type SidePanelEntry } from '@flow/shared/manifests';
import { isInHome, isOpenMessage, openInHome } from './lib/embed';
import './side-panel.css';

export const SIDE_PANEL_WIDTH = 360;
const MIN_WIDTH = 280;
const MAX_WIDTH = 720;

export interface SidePanelState {
  open: boolean;
  /** The app whose tab shows. */
  tab: string | null;
  width: number;
}

const CLOSED: SidePanelState = { open: false, tab: null, width: SIDE_PANEL_WIDTH };
const clamp = (w: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(w)));

/** The panel's state, remembered in this browser per host (`flow.<host>.sidePanel`). */
export function readSidePanelState(host: string): SidePanelState {
  try {
    const raw = window.localStorage.getItem(`flow.${host}.sidePanel`);
    if (!raw) return CLOSED;
    const v = JSON.parse(raw) as Partial<SidePanelState>;
    return { open: v.open === true, tab: typeof v.tab === 'string' ? v.tab : null, width: typeof v.width === 'number' ? clamp(v.width) : SIDE_PANEL_WIDTH };
  } catch {
    return CLOSED;
  }
}

function writeSidePanelState(host: string, s: SidePanelState): void {
  try {
    window.localStorage.setItem(`flow.${host}.sidePanel`, JSON.stringify(s));
  } catch {
    // Storage unavailable: the panel just won't remember.
  }
}

/** Opens an address a panel asked for: in Home when this app is inside it, else in this tab (as the suite's intents do). */
function follow(href: string): void {
  if (isInHome()) openInHome(href);
  else window.location.assign(href);
}

/**
 * The host's own assistant as the last tab (side-panel.md §5), while it is anchored: the app's panel itself, not a frame,
 * kept mounted once shown. `open` is the app's: its suite bar button and shortcut show the tab, and closing the side
 * panel (or the assistant's own Close) closes it. Another tab over it leaves it open, hidden.
 */
export interface SidePanelAssistant {
  label: string;
  avatarUrl?: string | null;
  content: ReactNode;
  open: boolean;
  setOpen(open: boolean): void;
}

/** The assistant tab's id among the panels' (an app is never named this). */
export const ASSISTANT_TAB = 'assistant';

export interface SidePanelProps {
  /** The host app's name: where its state is kept, and what its panels' pages are told (`?host=`). */
  host: string;
  panels: SidePanelEntry[];
  /** Over the page instead of beside it (a narrow window). */
  overlay?: boolean;
  assistant?: SidePanelAssistant;
}

/**
 * The side panel, or its pill while closed. Goes in the host's row, right of its main area, inside a
 * `position: relative` element; it takes no width while closed.
 */
export function SidePanel({ host, panels, overlay = false, assistant }: SidePanelProps) {
  const [state, setState] = useState<SidePanelState>(() => readSidePanelState(host));
  const update = useCallback(
    (next: Partial<SidePanelState>) =>
      setState((s) => {
        const v = { ...s, ...next };
        writeSidePanelState(host, v);
        return v;
      }),
    [host],
  );
  const tabs = assistant ? [...panels.map((p) => p.app), ASSISTANT_TAB] : panels.map((p) => p.app);
  const active = tabs.find((t) => t === state.tab) ?? tabs[0] ?? null;
  // The tabs shown so far: their frames stay, so going back to one is instant and it is where it was left.
  const [made, setMade] = useState<string[]>(() => (state.open && active ? [active] : []));
  useEffect(() => {
    if (state.open && active && !made.includes(active)) setMade((m) => [...m, active]);
  }, [state.open, active, made]);

  // The app opens or closes its assistant (its suite bar button, its shortcut, the assistant's own Close): the panel
  // shows its tab, or closes when that tab is the one showing.
  const assistantOpen = assistant?.open;
  const shown = useRef({ open: state.open, active });
  shown.current = { open: state.open, active };
  useEffect(() => {
    if (assistantOpen === undefined) return;
    if (assistantOpen) update({ open: true, tab: ASSISTANT_TAB });
    else if (shown.current.open && shown.current.active === ASSISTANT_TAB) update({ open: false });
  }, [assistantOpen, update]);

  // A panel's page asks to open an address (an event, a file): only from this panel's own frames.
  const frames = useRef<Record<string, HTMLIFrameElement | null>>({});
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || !isOpenMessage(e.data)) return;
      if (!Object.values(frames.current).some((f) => f && f.contentWindow === e.source)) return;
      follow(e.data.href);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // The resize grip on the left edge: the pointer is captured, so the frames under it do not take the drag.
  const drag = useRef<{ x: number; width: number } | null>(null);
  const grip = {
    onPointerDown(e: ReactPointerEvent<HTMLElement>) {
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { x: e.clientX, width: state.width };
    },
    onPointerMove(e: ReactPointerEvent<HTMLElement>) {
      if (!drag.current) return;
      const width = clamp(drag.current.width + drag.current.x - e.clientX);
      setState((s) => (s.width === width ? s : { ...s, width }));
    },
    onPointerUp(e: ReactPointerEvent<HTMLElement>) {
      if (!drag.current) return;
      drag.current = null;
      e.currentTarget.releasePointerCapture(e.pointerId);
      setState((s) => (writeSidePanelState(host, s), s));
    },
    onDoubleClick() {
      update({ width: SIDE_PANEL_WIDTH });
    },
  };

  if (!tabs.length) return null;
  const open = (tab: string) => {
    update({ open: true, tab });
    if (tab === ASSISTANT_TAB && !assistant?.open) assistant?.setOpen(true);
  };
  const close = () => {
    update({ open: false });
    if (assistant?.open) assistant.setOpen(false);
  };
  const assistantLabel = assistant?.label.trim() || 'Assistant';

  return (
    <div className={`side-panel-slot${state.open ? ' open' : ''}${overlay ? ' overlay' : ''}`} data-testid="side-panel">
      {!state.open ? (
        <div className="side-panel-pill" role="toolbar" aria-label="Side panel">
          {panels.map((p) => (
            <button key={p.app} type="button" className="side-panel-pill-btn" onClick={() => open(p.app)} aria-label={`Show ${p.label}`} title={p.label}>
              <PanelIcon icon={p.icon} />
            </button>
          ))}
          {assistant && (
            <button type="button" className="side-panel-pill-btn" onClick={() => open(ASSISTANT_TAB)} aria-label={`Show ${assistantLabel}`} title={assistantLabel}>
              <AssistantIcon avatarUrl={assistant.avatarUrl ?? null} />
            </button>
          )}
        </div>
      ) : (
        <aside className="side-panel" style={{ width: state.width }} aria-label="Side panel">
          {!overlay && <div role="separator" aria-orientation="vertical" aria-label="Resize the side panel" title="Drag to resize, double-click to reset" className="side-panel-grip" {...grip} />}
          <div className="side-panel-head">
            <div role="tablist" aria-label="Side panel" className="side-panel-tabs">
              {panels.map((p) => (
                <button key={p.app} type="button" role="tab" aria-selected={p.app === active} className="side-panel-tab" onClick={() => open(p.app)}>
                  <PanelIcon icon={p.icon} />
                  <span>{p.label}</span>
                </button>
              ))}
              {assistant && (
                <button type="button" role="tab" aria-selected={active === ASSISTANT_TAB} className="side-panel-tab" onClick={() => open(ASSISTANT_TAB)}>
                  <AssistantIcon avatarUrl={assistant.avatarUrl ?? null} />
                  <span className="side-panel-tab-label">{assistantLabel}</span>
                </button>
              )}
            </div>
            <button type="button" className="side-panel-close" onClick={close} aria-label="Close the side panel" title="Close">
              <CloseIcon />
            </button>
          </div>
          <div className="side-panel-body">
            {panels
              .filter((p) => made.includes(p.app))
              .map((p) => (
                <iframe
                  key={p.app}
                  ref={(el) => {
                    frames.current[p.app] = el;
                  }}
                  title={p.label}
                  src={`${p.path}?host=${encodeURIComponent(host)}`}
                  className="side-panel-frame"
                  hidden={p.app !== active}
                />
              ))}
            {assistant && made.includes(ASSISTANT_TAB) && (
              <div className="side-panel-assistant" hidden={active !== ASSISTANT_TAB}>
                {assistant.content}
              </div>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}

function PanelIcon({ icon }: { icon: SidePanelEntry['icon'] }) {
  return icon === 'calendar' ? (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4.5" width="18" height="16.5" rx="2.5" />
      <path d="M3 9.5h18M8 3v3M16 3v3" />
    </svg>
  ) : (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h6" />
    </svg>
  );
}

function AssistantIcon({ avatarUrl }: { avatarUrl: string | null }) {
  return avatarUrl ? (
    <img className="side-panel-avatar" src={avatarUrl} alt="" />
  ) : (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2.5l1.9 5.6 5.6 1.9-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.9zM18.5 15l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
