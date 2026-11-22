// Alerts in the suite bar (shared/alerts.ts), as one account in one organization: what the `show_alert` tool and the
// HTTP routes (routes/events.ts) both do. An alert is an `alert.created` event in the organization's log for one person,
// and closing it is an `alert.closed` event; the Events object pushes both to that person's suite-bar sockets.
// Who gets an alert is never the sender's choice (Org.alertRecipientOf): the person themself, a personal agent's sponsor,
// or the person a shared agent is working for (else its owner). Telling anyone else is a Chat message.
import {
  ALERT_CLOSED, ALERT_CREATED, ALERT_DEFAULT_MINUTES, ALERT_MAX_MINUTES, activeAlerts,
  type AlertActionDTO, type AlertClosedDTO, type AlertDTO,
} from '@flow/shared';
import type { Events } from './object';
import type { Org } from '../org/object';
import { ApiError, badRequest } from '../errors';

export interface AlertInput {
  title: string;
  lines?: string[];
  /** A short word above the title; "Alert" when absent. */
  kind?: string;
  /** Links on the card; the first is its main one. */
  links?: { label: string; url: string }[];
  /** How long it shows, in minutes. */
  minutes?: number;
}

export interface ShownAlert { alertId: string; to: 'the person you are working for' | 'your owner'; endsAt: string }

export interface AlertOps {
  /** Sends an alert to the person the rule picks. A 403 `no_recipient` when there is no one. */
  show(input: AlertInput): Promise<ShownAlert>;
  /** The caller's own alerts that still show, oldest first. */
  open(): Promise<AlertDTO[]>;
  /** Closes one of the caller's alerts everywhere. False when it is not one of theirs. */
  close(alertId: string): Promise<boolean>;
}

const MAX_LINES = 4;
const MAX_LINKS = 3;

/** A link the card may open: a web address, or a path on this origin. Anything else (`javascript:`, `data:`) is refused. */
export function safeHref(url: string): string | null {
  const u = url.trim();
  if (/^\/(?!\/)/.test(u)) return u;
  try {
    const p = new URL(u);
    return p.protocol === 'https:' || p.protocol === 'http:' ? p.toString() : null;
  } catch {
    return null;
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The alert's data, checked and trimmed; a 400 `bad_alert` the sender can act on. */
export function alertData(input: AlertInput, now: number, from?: string): AlertDTO {
  const title = clip(String(input.title ?? '').trim(), 120);
  if (!title) throw badRequest('bad_alert', 'An alert needs a title.');
  const lines = (input.lines ?? []).map((l) => clip(String(l).trim(), 200)).filter(Boolean);
  if (lines.length > MAX_LINES) throw badRequest('bad_alert', `At most ${MAX_LINES} lines.`);
  const links = input.links ?? [];
  if (links.length > MAX_LINKS) throw badRequest('bad_alert', `At most ${MAX_LINKS} links.`);
  const actions: AlertActionDTO[] = links.map((l, i) => {
    const href = safeHref(String(l.url ?? ''));
    if (!href) throw badRequest('bad_alert', `Link ${i + 1} is not a web address (https://…) or a path in the suite (/calendar/…).`);
    return { label: clip(String(l.label ?? '').trim() || 'Open', 40), href, ...(i === 0 ? { primary: true } : {}) };
  });
  const minutes = input.minutes ?? ALERT_DEFAULT_MINUTES;
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > ALERT_MAX_MINUTES) throw badRequest('bad_alert', `minutes is from 1 to ${ALERT_MAX_MINUTES}.`);
  return {
    alertId: crypto.randomUUID(),
    kind: clip(String(input.kind ?? '').trim() || 'Alert', 24),
    title, lines, actions,
    endsAt: new Date(now + Math.round(minutes) * 60_000).toISOString(),
    ...(from ? { from } : {}),
  };
}

/**
 * The alert operations as `accountId` (the caller's account; a hosted turn's actor). `invokedBy` is the account whose
 * request started a shared agent's turn, as the caller context carries it; `via` marks a personal agent at work.
 */
export function alertsAs(
  events: DurableObjectStub<Events>, org: DurableObjectStub<Org>,
  opts: { accountId: string; organizationId: string; invokedBy?: string | null; via?: string | null; now?: () => number },
): AlertOps {
  const now = opts.now ?? Date.now;
  const mine = async () => {
    const out = (await events.read({ before: 0, limit: 500, types: ['alert.*'], self: opts.accountId }, { accountId: opts.accountId, channelIds: [] })) as { events: { type: string; data: unknown }[] };
    return activeAlerts([...out.events].reverse(), now());
  };
  return {
    show: async (input) => {
      const to = (await org.alertRecipientOf(opts.accountId, opts.invokedBy ?? null)) as { accountId: string; agentName?: string } | null;
      if (!to) throw new ApiError(403, 'no_recipient', 'There is no one to alert: an agent with no owner cannot send alerts. Post in a channel instead.');
      const data = alertData(input, now(), to.agentName);
      await events.publish({
        type: ALERT_CREATED, organizationId: opts.organizationId, actor: opts.accountId, audience: `account:${to.accountId}`, ts: new Date(now()).toISOString(), data,
        ...(opts.via ? { via: opts.via } : {}), ...(opts.invokedBy ? { invokedBy: opts.invokedBy } : {}),
      });
      const owner = to.accountId !== opts.accountId && to.accountId !== opts.invokedBy;
      const whom: ShownAlert['to'] = owner ? 'your owner' : 'the person you are working for';
      return { alertId: data.alertId, to: whom, endsAt: data.endsAt };
    },
    open: mine,
    close: async (alertId) => {
      if (!(await mine()).some((a) => a.alertId === alertId)) return false;
      const data: AlertClosedDTO = { alertId };
      await events.publish({ type: ALERT_CLOSED, organizationId: opts.organizationId, actor: opts.accountId, audience: `account:${opts.accountId}`, ts: new Date(now()).toISOString(), data });
      return true;
    },
  };
}
