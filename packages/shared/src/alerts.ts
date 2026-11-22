// Alerts in the suite bar (the cards that slide down under it, packages/suite-bar/src/alerts.tsx) that the server sends:
// an agent's `show_alert`, for one person only. Each is an event in the organization's log like any other
// (platform.md §5.2): `alert.created` for one account, `alert.closed` when that person closes it, which closes it in
// every tab. The log's Events object pushes both to the person's suite-bar sockets as they are published.

export const ALERT_CREATED = 'alert.created';
export const ALERT_CLOSED = 'alert.closed';

/** How long an alert shows when the sender names no time, and the most it may ask for. */
export const ALERT_DEFAULT_MINUTES = 30;
export const ALERT_MAX_MINUTES = 24 * 60;

/** A link on an alert: `primary` is its main one. */
export interface AlertActionDTO { label: string; href: string; primary?: boolean }

/** `alert.created`'s data. */
export interface AlertDTO {
  /** Unique; `alert.closed` names it. */
  alertId: string;
  /** A short word above the title ("Reminder"). */
  kind: string;
  title: string;
  lines: string[];
  actions: AlertActionDTO[];
  /** When it stops showing on its own (ISO). */
  endsAt: string;
  /** Who sent it, for people: the agent's name. */
  from?: string;
}

/** `alert.closed`'s data. */
export interface AlertClosedDTO { alertId: string }

/** The server's frame on a suite-bar socket: one alert event, as the log has it. */
export interface AlertFrame { op: 'alert'; type: typeof ALERT_CREATED | typeof ALERT_CLOSED; seq: number; data: AlertDTO | AlertClosedDTO }

/**
 * The alerts still showing, from `alert.*` events oldest first: created, not closed, not past their end. A later
 * `alert.created` with the same id replaces the earlier one.
 */
export function activeAlerts(events: readonly { type: string; data: unknown }[], now: number): AlertDTO[] {
  const open = new Map<string, AlertDTO>();
  for (const e of events) {
    const d = e.data as Partial<AlertDTO> | null;
    if (!d || typeof d.alertId !== 'string') continue;
    if (e.type === ALERT_CREATED) open.set(d.alertId, d as AlertDTO);
    else if (e.type === ALERT_CLOSED) open.delete(d.alertId);
  }
  return [...open.values()].filter((a) => Date.parse(a.endsAt) > now);
}
