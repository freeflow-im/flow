// What an agent may look back on in the organization's event log (Taskboard task 32; decision_log 2026-11-22, "Agents
// remember through the event log"): search_events. Each turn of an agent is its own conversation, so what it did in one
// (a meeting it was sent to, a message it posted, a job it ran) was lost to the others; the log already has all of it.
//
// Who sees what: an agent sees its own events, and the events of the person who started the current turn; never another
// person's. So a personal agent (it acts as its sponsor) sees its sponsor's events and its own. A shared agent asked by a
// person sees that person's events, its own events that person asked for, and its own events that person may see anyway;
// not what it did for someone else. With no one asking (an automation nobody started), a shared agent sees only its own
// events nobody asked for. Each side is also read with the visibility its account has (private channels, shares).
import type { PlatformEvent } from '@flow/shared';
import type { Events } from './object';
import type { Org } from '../org/object';
import type { ReadQuery, Reader } from './core';
import { badRequest } from '../errors';

export interface HistoryQuery {
  /** Type patterns: exact, or a prefix and `*`. */
  types?: string[];
  /** ISO times: only events at or after `since`, at or before `until`. */
  since?: string;
  until?: string;
  /** Whose events: the agent's own (`you`), the person's it works for (`person`), or both (default). */
  actor?: 'you' | 'person' | 'any';
  /** Words the event's data contains. */
  text?: string;
  limit?: number;
}

/** One event as the agent is shown it: who took part in its terms, the data cut to a readable size. */
export interface HistoryEvent {
  seq: number; type: string; at: string;
  /** The agent itself, the person it works for, someone else, or nobody (the platform). */
  by: 'you' | 'the person you work for' | 'someone else' | 'the platform';
  channelId?: string; ref?: string; data: unknown;
}

export interface HistoryOps {
  search(q: HistoryQuery): Promise<{ events: HistoryEvent[]; note?: string }>;
}

export const HISTORY_LIMIT_DEFAULT = 20;
export const HISTORY_LIMIT_MAX = 50;
/** How much of one event's data the agent is shown. */
const DATA_CHARS = 2_000;

/** The parts of a search: each a read of the log as one account, limited to the events of the accounts it may see. */
export function historyParts(
  p: { self: string; person: string | null; personal: boolean; channels: Record<string, string[]> },
  base: ReadQuery,
  actor: HistoryQuery['actor'] = 'any',
): { query: ReadQuery; reader: Reader }[] {
  const readerOf = (accountId: string, extra: Partial<Reader> = {}): Reader => ({ accountId, channelIds: p.channels[accountId] ?? [], ...extra });
  const wantSelf = actor !== 'person', wantPerson = actor !== 'you';
  if (p.personal && p.person) {
    // A personal agent acts as its sponsor: one reader, the sponsor's, who may read the agent's own events too.
    const involves = [...(wantPerson ? [p.person] : []), ...(wantSelf ? [p.self] : [])];
    return [{ query: { ...base, involves }, reader: readerOf(p.person, { sponsoredAgentIds: [p.self] }) }];
  }
  const parts: { query: ReadQuery; reader: Reader }[] = [];
  if (p.person && wantPerson) parts.push({ query: { ...base, involves: [p.person] }, reader: readerOf(p.person) });
  if (wantSelf) {
    if (p.person) {
      // What it did for this person, as it may see it; what it did for no one, only where this person may see it too.
      parts.push({ query: { ...base, involves: [p.self], invokedBy: p.person }, reader: readerOf(p.self) });
      parts.push({ query: { ...base, involves: [p.self], invokedBy: null }, reader: readerOf(p.person) });
    } else {
      parts.push({ query: { ...base, involves: [p.self], invokedBy: null }, reader: readerOf(p.self) });
    }
  }
  return parts;
}

function time(s: string | undefined, name: string): number | undefined {
  if (s === undefined || s === '') return undefined;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) throw badRequest('bad_time', `${name} is not a time: give an ISO time, like 2026-11-21T09:00:00-08:00 or 2026-11-21.`);
  return t;
}

/** An event as the agent sees it (`by` in its terms, the data cut). */
export function shown(e: PlatformEvent, self: string, person: string | null): HistoryEvent {
  const by = !e.actor ? 'the platform' : e.actor === self ? 'you' : e.actor === person ? 'the person you work for' : 'someone else';
  const raw = JSON.stringify(e.data ?? null);
  const data = raw.length > DATA_CHARS ? `${raw.slice(0, DATA_CHARS)}…` : e.data;
  return {
    seq: e.seq, type: e.type, at: e.ts, by, ...(e.channelId ? { channelId: e.channelId } : {}),
    ...(e.ref ? { ref: `${e.ref.organizationId}/${e.ref.app}/${e.ref.kind}/${e.ref.id}` } : {}), data,
  };
}

/**
 * search_events as `selfAccountId` (the turn's agent), for `personAccountId` (who started the turn: a personal agent's
 * sponsor, the member who asked a shared agent; null when nobody did).
 */
export function historyAs(
  events: DurableObjectStub<Events>, org: DurableObjectStub<Org>, opts: { selfAccountId: string; personAccountId: string | null },
): HistoryOps {
  return {
    search: async (q) => {
      const fromTs = time(q.since, 'since'), toTs = time(q.until, 'until');
      const limit = Math.min(HISTORY_LIMIT_MAX, Math.max(1, Math.floor(Number(q.limit) || HISTORY_LIMIT_DEFAULT)));
      const agent = (await org.agentSponsorOf(opts.selfAccountId)) as { personal: boolean } | null;
      const person = opts.personAccountId && opts.personAccountId !== opts.selfAccountId ? opts.personAccountId : null;
      const accounts = [opts.selfAccountId, ...(person ? [person] : [])];
      const channels = (await org.privateChannelIdsOfAccounts(accounts)) as Record<string, string[]>;
      const base: ReadQuery = {
        ...(q.types?.length ? { types: q.types } : {}), ...(q.text?.trim() ? { text: q.text.trim() } : {}),
        ...(fromTs !== undefined ? { fromTs } : {}), ...(toTs !== undefined ? { toTs } : {}),
      };
      const parts = historyParts({ self: opts.selfAccountId, person, personal: !!agent?.personal, channels }, base, q.actor);
      const found = parts.length ? ((await events.search(parts, limit)) as PlatformEvent[]) : [];
      return {
        events: found.map((e) => shown(e, opts.selfAccountId, person)),
        ...(found.length === limit ? { note: `There may be more: narrow by type or time (until the oldest shown, ${found.at(-1)!.ts}).` } : {}),
        ...(!person && q.actor === 'person' ? { note: 'Nobody started this turn, so there is no person whose events to show.' } : {}),
      };
    },
  };
}
