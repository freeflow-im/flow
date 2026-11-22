// Alerts in the suite bar (shared/alerts.ts), the event log's half: an alert is an `alert.created` event for the one
// person the Org object picks, pushed to their sockets as it is published; their open alerts are read back from the log;
// closing one is an `alert.closed` event, pushed the same way; and show_alert's checks (links, lines, time).
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { activeAlerts, type AlertFrame } from '@flow/shared';
import { Events } from './object';
import { alertsAs, safeHref } from './alerts';
import { ALERT_TOOLS, EventToolError } from './eventTools';

function sqlite() {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query: string, ...args: unknown[]) {
      const stmt = db.prepare(query);
      const rows = stmt.columns().length ? stmt.all(...(args as never[])) : (stmt.run(...(args as never[])), []);
      return { toArray: () => rows as Record<string, unknown>[] };
    },
  };
}

const ORG = 'org-1';
const ANN = 'acct-ann';
const CAL = 'acct-cal';
const BOT = 'acct-bot';
const MIN = 60_000;

/** The Events object with an Org object that sends a shared agent's alerts to whoever asked, else to Ann, its owner. */
function harness() {
  const pushed: { accountId: string; frame: AlertFrame }[] = [];
  const pending: Promise<unknown>[] = [];
  const org = {
    alertRecipientOf: async (accountId: string, invokedBy: string | null) =>
      accountId === BOT ? (invokedBy ? { accountId: invokedBy, agentName: 'Helper' } : { accountId: ANN, agentName: 'Helper' }) : accountId === 'acct-orphan' ? null : { accountId },
    pushAlert: async (accountId: string, frame: AlertFrame) => { pushed.push({ accountId, frame }); return 1; },
    pokeSubscription: async () => 0,
  };
  const env = { ORG: { idFromName: (n: string) => n, get: () => org } };
  const storage = { sql: sqlite(), transactionSync: <T>(fn: () => T) => fn(), getAlarm: async () => 1, setAlarm: async () => undefined };
  const events = new Events({ storage, waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as never, env as never);
  let now = Date.parse('2026-11-22T18:00:00Z');
  const as = (accountId: string, invokedBy?: string) => alertsAs(events as never, org as never, { accountId, organizationId: ORG, ...(invokedBy ? { invokedBy } : {}), now: () => now });
  return { events, pushed, as, settle: () => Promise.all(pending), later: (ms: number) => { now += ms; } };
}

describe('an alert', () => {
  it('goes into the log for the one person, and is pushed to them as it is published', async () => {
    const h = harness();
    const shown = await h.as(BOT, CAL).show({ title: 'Report ready', lines: ['Q3 numbers'], links: [{ label: 'Open', url: '/docs/x' }], minutes: 10 });
    expect(shown).toMatchObject({ to: 'the person you are working for', endsAt: '2026-11-22T18:10:00.000Z' });
    await h.settle();
    expect(h.pushed).toHaveLength(1);
    expect(h.pushed[0]!.accountId).toBe(CAL);
    expect(h.pushed[0]!.frame).toMatchObject({
      op: 'alert', type: 'alert.created',
      data: { alertId: shown.alertId, kind: 'Alert', title: 'Report ready', lines: ['Q3 numbers'], actions: [{ label: 'Open', href: '/docs/x', primary: true }], from: 'Helper' },
    });
    // An event like any other: the sender is its actor, the person who asked its invokedBy; only Cal may read it.
    const cal = await h.events.read({ since: 0, types: ['alert.*'] }, { accountId: CAL, channelIds: [] });
    expect(cal.events[0]).toMatchObject({ type: 'alert.created', actor: BOT, invokedBy: CAL });
    expect((await h.events.read({ since: 0, types: ['alert.*'] }, { accountId: ANN, channelIds: [] })).events).toEqual([]);
  });

  it('goes to the owner when no one asked, and says so', async () => {
    const h = harness();
    expect((await h.as(BOT).show({ title: 'Nightly import failed' })).to).toBe('your owner');
    await h.settle();
    expect(h.pushed[0]!.accountId).toBe(ANN);
  });

  it('shows until it is closed or its time is up, and closing it is pushed too', async () => {
    const h = harness();
    const a = await h.as(BOT, CAL).show({ title: 'One', minutes: 5 });
    const b = await h.as(BOT, CAL).show({ title: 'Two', minutes: 60 });
    const c = await h.as(BOT, CAL).show({ title: 'Three', minutes: 60 });
    expect((await h.as(CAL).open()).map((x) => x.title)).toEqual(['One', 'Two', 'Three']);
    expect(await h.as(CAL).close(b.alertId)).toBe(true);
    h.later(6 * MIN);
    expect((await h.as(CAL).open()).map((x) => x.alertId)).toEqual([c.alertId]);
    // Only one's own: Ann cannot close Cal's, and a gone one is not closed twice.
    expect(await h.as(ANN).close(c.alertId)).toBe(false);
    expect(await h.as(CAL).close(a.alertId)).toBe(false);
    await h.settle();
    expect(h.pushed.map((p) => [p.accountId, p.frame.type])).toEqual([[CAL, 'alert.created'], [CAL, 'alert.created'], [CAL, 'alert.created'], [CAL, 'alert.closed']]);
  });
});

describe('show_alert', () => {
  const tool = ALERT_TOOLS.find((t) => t.name === 'show_alert')!;

  it('refuses what the card cannot show, as the agent’s to fix', async () => {
    const h = harness();
    const ctx = { alerts: h.as(BOT, CAL) };
    await expect(tool.run(ctx, { title: 'x', links: [{ label: 'x', url: 'javascript:alert(1)' }] })).rejects.toThrow(EventToolError);
    await expect(tool.run(ctx, { title: 'x', minutes: 0 })).rejects.toThrow(/minutes/);
    await expect(tool.run(ctx, { title: '   ' })).rejects.toThrow(/title/);
    await expect(tool.run({ alerts: h.as('acct-orphan') }, { title: 'x' })).rejects.toThrow(/Post in a channel/);
    expect(await tool.run(ctx, { title: 'Done', kind: 'Done' })).toMatchObject({ alert: { to: 'the person you are working for' } });
  });

  it('names no recipient', () => {
    expect(Object.keys(tool.shape)).toEqual(['title', 'lines', 'kind', 'links', 'minutes']);
  });

  it('opens web addresses and paths in the suite only', () => {
    expect(safeHref('/calendar/?event=1')).toBe('/calendar/?event=1');
    expect(safeHref('https://meet.example.com/x')).toBe('https://meet.example.com/x');
    expect(safeHref('//evil.test/x')).toBeNull();
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,x')).toBeNull();
  });
});

describe('the open alerts', () => {
  it('are the created ones less the closed and the ended, a later one with the same id replacing it', () => {
    const now = Date.parse('2026-11-22T18:00:00Z');
    const card = (alertId: string, title: string, endsAt = '2026-11-22T19:00:00Z') => ({ type: 'alert.created', data: { alertId, kind: 'Alert', title, lines: [], actions: [], endsAt } });
    const open = activeAlerts([card('a', 'A'), card('b', 'B'), card('c', 'C', '2026-11-22T17:00:00Z'), { type: 'alert.closed', data: { alertId: 'b' } }, card('a', 'A2')], now);
    expect(open.map((a) => a.title)).toEqual(['A2']);
  });
});
