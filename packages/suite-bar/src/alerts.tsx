// The suite bar's alerts (Taskboard task 12): cards that slide down at the window's top edge, over the account menu, on every page that
// draws the suite bar. Generic: an alert is a title, a line or two and links, closed by the person or ended by its own
// time. The first kind is the meeting alert (useMeetingAlerts): any timed event not declined, from two minutes before it starts
// until it is closed or five minutes have passed since its start, with its Join link. Closing one closes it in every tab.
import { useCallback, useEffect, useMemo, useState } from 'react';

/** A link or button on an alert: `primary` is its main one (Join). An address on another site opens in a new tab; an action
 * with `onClick` and no `href` is a button (Copy code). */
export interface SuiteAlertAction { label: string; href?: string; onClick?: () => void; primary?: boolean }

export interface SuiteAlert {
  /** Unique while it shows; a closed alert stays closed by this id. */
  id: string;
  /** A short word above the title: "Meeting". */
  kind: string;
  title: string;
  /** Lines under the title: when, where. */
  lines: string[];
  actions: SuiteAlertAction[];
}

// ---- closing, remembered in this browser and seen by every tab ----

const CLOSED_KEY = 'suite-alerts-closed';
/** A closed alert is forgotten after a day: its meeting is long over. */
const CLOSED_FOR_MS = 24 * 60 * 60_000;

function readClosed(): Record<string, number> {
  try {
    const all = JSON.parse(localStorage.getItem(CLOSED_KEY) ?? '{}') as Record<string, number>;
    const now = Date.now();
    return Object.fromEntries(Object.entries(all).filter(([, at]) => typeof at === 'number' && now - at < CLOSED_FOR_MS));
  } catch {
    return {};
  }
}

/** The alerts closed here, and the way to close one; another tab's closing shows at once (the storage event). */
export function useClosedAlerts(): [Set<string>, (id: string) => void] {
  const [closed, setClosed] = useState<Record<string, number>>(readClosed);
  useEffect(() => {
    const again = (e: StorageEvent) => { if (e.key === CLOSED_KEY) setClosed(readClosed()); };
    window.addEventListener('storage', again);
    return () => window.removeEventListener('storage', again);
  }, []);
  const close = useCallback((id: string) => {
    const next = { ...readClosed(), [id]: Date.now() };
    try { localStorage.setItem(CLOSED_KEY, JSON.stringify(next)); } catch { /* storage unavailable: this tab alone */ }
    setClosed(next);
  }, []);
  return [useMemo(() => new Set(Object.keys(closed)), [closed]), close];
}

// ---- meetings ----

/** From this long before a meeting starts… */
export const MEETING_ALERT_BEFORE_MS = 2 * 60_000;
/** …until this long after it started. */
export const MEETING_ALERT_AFTER_MS = 5 * 60_000;
/** The calendar is read again this often (and when the page is shown again). */
const READ_EVERY_MS = 2 * 60_000;

/** What an alert needs of a calendar event (GET /v1/calendar/events, Calendar's EventOccurrence). */
export interface AlertEvent {
  id: string;
  summary: string;
  location: string | null;
  description: string | null;
  start: string;
  end: string;
  allDay: boolean;
  status: 'confirmed' | 'tentative' | 'cancelled';
  organizer: { self?: true } | null;
  attendees: { self?: true }[];
  myResponse?: 'accepted' | 'declined' | 'tentative' | 'needs-action';
  conference?: { url: string; label: string };
}

/** Video call links an event may carry in its location or description, when the server names none. */
const CALL_LINK = /https:\/\/(?:meet\.google\.com\/[a-z-]+|[\w.-]*zoom\.us\/[^\s<>"')\]]+|teams\.(?:microsoft|live)\.com\/[^\s<>"')\]]+|[\w.-]*webex\.com\/[^\s<>"')\]]+|[^\s/<>"')]+\/meet\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?![a-z-]))/i;

/** The event's video call link: the server's, else one found in its location or description. */
export function callLinkOf(e: Pick<AlertEvent, 'conference' | 'location' | 'description'>): string | null {
  return e.conference?.url ?? CALL_LINK.exec(e.location ?? '')?.[0] ?? CALL_LINK.exec(e.description ?? '')?.[0] ?? null;
}

/**
 * An event worth an alert: timed, not cancelled, and not declined. That takes in events with no guests, and invitations
 * not yet answered (task 15: every calendar event). The events come from the person's own shown calendars only.
 */
export function isMyMeeting(e: AlertEvent): boolean {
  return !e.allDay && e.status !== 'cancelled' && e.myResponse !== 'declined';
}

const clock = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** "Starts in 2 min", "Starting now", "Started 3 min ago". */
export function startsLine(start: number, now: number): string {
  const min = Math.round((start - now) / 60_000);
  if (min > 0) return `Starts in ${min} min`;
  if (min === 0) return 'Starting now';
  return `Started ${-min} min ago`;
}

/** The meeting alerts at `now`: one per meeting in its window, not closed, the same meeting in two calendars once. */
export function meetingAlertsAt(events: readonly AlertEvent[], now: number, closed: ReadonlySet<string>): SuiteAlert[] {
  const seen = new Set<string>();
  const alerts: SuiteAlert[] = [];
  for (const e of [...events].sort((a, b) => Date.parse(a.start) - Date.parse(b.start))) {
    const start = Date.parse(e.start);
    if (!isMyMeeting(e) || Number.isNaN(start) || now < start - MEETING_ALERT_BEFORE_MS || now >= start + MEETING_ALERT_AFTER_MS) continue;
    const id = `meeting:${e.id}`;
    const same = `${e.summary}|${start}`;
    if (closed.has(id) || seen.has(same)) continue;
    seen.add(same);
    const link = callLinkOf(e);
    const where = e.location && !CALL_LINK.test(e.location) ? e.location : null;
    alerts.push({
      id,
      kind: 'Meeting',
      title: e.summary || '(No title)',
      lines: [`${startsLine(start, now)} · ${clock(new Date(start))} – ${clock(new Date(Date.parse(e.end)))}`, ...(where ? [where] : [])],
      actions: [
        ...(link ? [{ label: 'Join', href: link, primary: true }] : []),
        { label: 'Open in Calendar', href: `/calendar/?event=${encodeURIComponent(e.id)}` },
      ],
    });
  }
  return alerts;
}

/**
 * The person's meeting alerts in the organization the bar shows: its calendar read now and every two minutes (and when
 * the page is shown again), the alerts worked out each 15 seconds. None for a guest or a page with no calendar.
 */
export function useMeetingAlerts(organizationId: string | null, closed: ReadonlySet<string>): SuiteAlert[] {
  const [events, setEvents] = useState<AlertEvent[]>([]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!organizationId || typeof fetch !== 'function') return;
    let live = true;
    const read = () => {
      const at = Date.now();
      const q = new URLSearchParams({ from: new Date(at - MEETING_ALERT_AFTER_MS - 60_000).toISOString(), to: new Date(at + READ_EVERY_MS + MEETING_ALERT_BEFORE_MS + 60_000).toISOString(), workspace: organizationId });
      fetch(`/v1/calendar/events?${q}`, { credentials: 'same-origin', headers: { accept: 'application/json' } })
        .then((r) => (r.ok ? (r.json() as Promise<{ events?: AlertEvent[] }>) : null))
        .then((b) => { if (live && b) setEvents(Array.isArray(b.events) ? b.events : []); })
        .catch(() => undefined);
    };
    read();
    const every = setInterval(read, READ_EVERY_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') read(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { live = false; clearInterval(every); document.removeEventListener('visibilitychange', onVisible); };
  }, [organizationId]);
  useEffect(() => {
    if (!events.length) return;
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    setNow(Date.now());
    return () => clearInterval(tick);
  }, [events]);
  return useMemo(() => meetingAlertsAt(events, now, closed), [events, now, closed]);
}

// ---- the cards ----

const isElsewhere = (href: string) => /^https?:\/\//i.test(href) && !href.startsWith(window.location.origin);

/**
 * The alerts as cards sliding down at the window's top edge, over the bar's right side; each closes on ×. Nothing when
 * there are none. `onTurnOnDesktop`: desktop notifications are not yet allowed, so a meeting's card offers to turn them on.
 */
export function SuiteAlerts({ alerts, onClose, onTurnOnDesktop }: { alerts: readonly SuiteAlert[]; onClose: (id: string) => void; onTurnOnDesktop?: () => void }) {
  if (!alerts.length) return null;
  return (
    <div className="sb-alerts" role="region" aria-label="Alerts" data-testid="suite-alerts">
      {alerts.map((a) => (
        <div key={a.id} className="sb-alert" role="alert" data-testid="suite-alert">
          <div className="sb-alert-head">
            <span className="sb-alert-kind">{a.kind}</span>
            <button type="button" className="sb-alert-close" aria-label="Close alert" title="Close" onClick={() => onClose(a.id)}>×</button>
          </div>
          <div className="sb-alert-title">{a.title}</div>
          {a.lines.map((l, i) => <div key={i} className="sb-alert-line">{l}</div>)}
          {a.actions.length > 0 && (
            <div className="sb-alert-actions">
              {a.actions.map((x) => x.href === undefined ? (
                <button key={x.label} type="button" className={`sb-alert-action${x.primary ? ' primary' : ''}`} onClick={x.onClick}>{x.label}</button>
              ) : (
                <a key={x.label} className={`sb-alert-action${x.primary ? ' primary' : ''}`} href={x.href} onClick={x.onClick} {...(isElsewhere(x.href) ? { target: '_blank', rel: 'noreferrer' } : {})}>{x.label}</a>
              ))}
            </div>
          )}
          {onTurnOnDesktop && a.kind === 'Meeting' && (
            <button type="button" className="sb-alert-desktop" data-testid="suite-alert-desktop" onClick={onTurnOnDesktop}>Notify me on the desktop too</button>
          )}
        </div>
      ))}
    </div>
  );
}
