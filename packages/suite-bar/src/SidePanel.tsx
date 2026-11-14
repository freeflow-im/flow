// The side panel (docs/specs/side-panel.md): another app beside this one, in a panel on the right with a tab per app.
// Closed, it is a pill on the right edge with one button per panel; a button opens the panel on that tab. Each tab is
// the other app's panel page in a frame, made the first time the tab shows and kept, hidden, while another shows. The
// host app draws it in its own layout (so it is the same in Home and in the app's tab); which panels a host shows is
// its manifest's `sidePanels` (@flow/shared/manifests' sidePanelsOf).
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
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

export interface SidePanelProps {
  /** The host app's name: where its state is kept, and what its panels' pages are told (`?host=`). */
  host: string;
  panels: SidePanelEntry[];
  /** Over the page instead of beside it (a narrow window). */
  overlay?: boolean;
}

/**
 * The side panel, or its pill while closed. Goes in the host's row, right of its main area, inside a
 * `position: relative` element; it takes no width while closed.
 */
export function SidePanel({ host, panels, overlay = false }: SidePanelProps) {
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
  const active = panels.find((p) => p.app === state.tab) ?? panels[0] ?? null;
  // The tabs shown so far: their frames stay, so going back to one is instant and it is where it was left.
  const [made, setMade] = useState<string[]>(() => (state.open && active ? [active.app] : []));
  useEffect(() => {
    if (state.open && active && !made.includes(active.app)) setMade((m) => [...m, active.app]);
  }, [state.open, active, made]);

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

  if (!panels.length) return null;
  const open = (app: string) => update({ open: true, tab: app });

  return (
    <div className={`side-panel-slot${state.open ? ' open' : ''}${overlay ? ' overlay' : ''}`} data-testid="side-panel">
      {!state.open ? (
        <div className="side-panel-pill" role="toolbar" aria-label="Side panel">
          {panels.map((p) => (
            <button key={p.app} type="button" className="side-panel-pill-btn" onClick={() => open(p.app)} aria-label={`Show ${p.label}`} title={p.label}>
              <PanelIcon icon={p.icon} />
            </button>
          ))}
        </div>
      ) : (
        <aside className="side-panel" style={{ width: state.width }} aria-label="Side panel">
          {!overlay && <div role="separator" aria-orientation="vertical" aria-label="Resize the side panel" title="Drag to resize, double-click to reset" className="side-panel-grip" {...grip} />}
          <div className="side-panel-head">
            <div role="tablist" aria-label="Side panel" className="side-panel-tabs">
              {panels.map((p) => (
                <button key={p.app} type="button" role="tab" aria-selected={p.app === active?.app} className="side-panel-tab" onClick={() => open(p.app)}>
                  <PanelIcon icon={p.icon} />
                  <span>{p.label}</span>
                </button>
              ))}
            </div>
            <button type="button" className="side-panel-close" onClick={() => update({ open: false })} aria-label="Close the side panel" title="Close">
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
                  hidden={p.app !== active?.app}
                />
              ))}
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

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
