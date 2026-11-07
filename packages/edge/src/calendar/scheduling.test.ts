// Scheduling between accounts (phase 4.2): Ann's, Bob's and an agent's Calendar objects wired to each other by a stand-in
// CALENDAR namespace, a stand-in directory resolving addresses, and one event log. An invitation by object call, the answer
// back, an update keeping it, an attendee refused a change, a cancellation kept as cancelled, a failed delivery retried
// once and the organizer's write standing.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import type { PublishInput } from '../events/core';
import type { CallerContext } from '../org/routes/compat';
import { Calendar, type ItipDelivery } from './object';

const toBinding = (v: unknown): SQLInputValue => (v instanceof ArrayBuffer ? new Uint8Array(v) : (v as SQLInputValue));
const ORG = 'org-1';
const ADDR = (id: string) => `${id}@acme.freeflow.im`;

function world(opts: { failFirst?: Set<string>; down?: Set<string> } = {}) {
  const published: PublishInput[] = [];
  const objects = new Map<string, Calendar>();
  const calls: { to: string; method: string }[] = [];
  const accounts = new Map([['ann', 'Ann'], ['bob', 'Bob'], ['bot', 'Builder']].map(([id, name]) => [ADDR(id!), { id: `acct-${id}`, organizationId: ORG, displayName: name, state: 'active' }]));
  accounts.set('carol@other.freeflow.im', { id: 'acct-carol', organizationId: 'org-2', displayName: 'Carol', state: 'active' });
  const env: Record<string, unknown> = {
    CALENDAR_ALARM: 'off', WEB_URL_BASE: 'https://app.test',
    EVENTS: { idFromName: (n: string) => n, get: () => ({ publish: async (e: PublishInput) => { published.push(e); return { seq: published.length, id: 'e' }; } }) },
    DIRECTORY: { idFromName: (n: string) => n, get: () => ({ call: async (m: string, a: unknown[]) => ({ ok: true, value: m === 'accountByAddress' ? accounts.get(String(a[0]).toLowerCase()) ?? null : null }) }) },
    CALENDAR: {
      idFromName: (n: string) => n,
      get: (id: string) => ({
        receiveItip: async (m: ItipDelivery) => {
          calls.push({ to: id, method: m.method });
          if (opts.down?.has(id)) throw new Error('object unreachable');
          if (opts.failFirst?.delete(id)) throw new Error('a transient failure');
          return objectFor(id).receiveItip(m);
        },
      }),
    },
  };
  function objectFor(accountId: string): Calendar {
    let o = objects.get(accountId);
    if (o) return o;
    const db = new DatabaseSync(':memory:');
    const exec = (query: string, ...bindings: unknown[]) => {
      const statement = db.prepare(query);
      const values = bindings.map(toBinding);
      const rows = statement.columns().length ? (statement.all(...values) as Record<string, unknown>[]) : (statement.run(...values), []);
      return { toArray: () => rows, one: () => rows[0] };
    };
    const ctx = { storage: { sql: { exec, databaseSize: 0 }, getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} }, id: {}, waitUntil: () => {} };
    o = new Calendar(ctx as never, env as never);
    objects.set(accountId, o);
    return o;
  }
  const callerOf = (id: string, name: string) => ({
    user: { id: `u-${id}` }, token: null, authKind: 'session', ip: '', organizationId: ORG,
    account: { id: `acct-${id}`, principalId: `u-${id}`, organizationId: ORG, address: ADDR(id), displayName: name },
  }) as unknown as CallerContext;
  const as = (id: string, name: string) => async (method: string, path: string, body?: unknown) => {
    const res = await objectFor(`acct-${id}`).handle(new Request(`https://edge.test${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) }), callerOf(id, name));
    return { s: res.status, j: (await res.json()) as Record<string, any> };
  };
  return { published, calls, objects, ann: as('ann', 'Ann'), bob: as('bob', 'Bob') };
}

const W = '/v1/calendar/events?from=2026-12-01T00:00:00Z&to=2026-12-31T00:00:00Z';
const enc = encodeURIComponent;
const attendee = (ev: { attendees: { email: string; response: string }[] }, email: string) => ev.attendees.find((a) => a.email === email)?.response;

describe('scheduling between accounts', () => {
  it('invites by object call, hears the answer, updates keeping it, refuses an attendee\'s change, cancels', async () => {
    const w = world();
    await w.bob('GET', '/v1/calendar/calendars');
    let r = await w.ann('POST', '/v1/calendar/events', { summary: 'Review', start: '2026-12-03T15:00:00Z', end: '2026-12-03T16:00:00Z', attendees: [{ email: ADDR('bob') }, { email: ADDR('bot') }, { email: 'carol@other.freeflow.im' }, { email: 'guest@example.com' }] });
    expect(r.s).toBe(201);
    const ev = r.j.event;
    // Bob and the agent are accounts of the organization: called, never emailed; Carol (another organization) and the guest are outside.
    expect(ev.attendees.map((a: { email: string; accountId?: string }) => [a.email, a.accountId ?? null])).toEqual([[ADDR('bob'), 'acct-bob'], [ADDR('bot'), 'acct-bot'], ['carol@other.freeflow.im', null], ['guest@example.com', null], [ADDR('ann'), 'acct-ann']]);
    expect(w.calls.sort((a, b) => a.to.localeCompare(b.to))).toEqual([{ to: 'acct-bob', method: 'REQUEST' }, { to: 'acct-bot', method: 'REQUEST' }]);
    expect(r.j).toMatchObject({ invitationsSent: false });

    // Bob's default calendar holds it, needs-action; the agent's object, never used before, made its calendar for it.
    r = await w.bob('GET', W);
    const copy = r.j.events[0];
    expect(r.j.events).toHaveLength(1);
    expect(copy).toMatchObject({ summary: 'Review', myResponse: 'needs-action', organizer: { email: ADDR('ann'), accountId: 'acct-ann' } });
    expect(copy.calendarId).toMatch(/^n\.acct-bob\./);
    const invited = w.published.filter((e) => e.type === 'calendar.invited');
    expect(invited.map((e) => e.audience).sort()).toEqual(['account:acct-bob', 'account:acct-bot']);
    expect(invited.find((e) => e.audience === 'account:acct-bob')).toMatchObject({
      organizationId: ORG, actor: 'acct-ann',
      data: { eventId: copy.eventId, summary: 'Review', start: '2026-12-03T15:00:00.000Z', allDay: false, organizer: { email: ADDR('ann'), name: 'Ann', accountId: 'acct-ann' }, url: expect.stringContaining('/calendar/week/2026-12-03?event=') },
    });
    expect(w.objects.get('acct-bot')!.busy(Date.parse('2026-12-01T00:00:00Z'), Date.parse('2026-12-31T00:00:00Z'))).toHaveLength(1);

    // Bob accepts: his copy, and Ann's within the same request, with calendar.event.updated carrying the answer.
    r = await w.bob('POST', `/v1/calendar/events/${enc(copy.id)}/respond`, { response: 'accepted' });
    expect(r.j).toMatchObject({ event: { myResponse: 'accepted' }, replied: 'server' });
    r = await w.ann('GET', `/v1/calendar/events/${enc(ev.id)}`);
    expect(attendee(r.j.event, ADDR('bob'))).toBe('accepted');
    expect(w.published.at(-1)).toMatchObject({ type: 'calendar.event.updated', actor: 'acct-bob', data: { ownerAccountId: 'acct-ann', attendeeResponse: { email: ADDR('bob'), response: 'accepted' } } });

    // An attendee changes nothing but their own answer and reminders.
    r = await w.bob('PATCH', `/v1/calendar/events/${enc(copy.id)}`, { summary: 'Mine now' });
    expect(r).toMatchObject({ s: 403, j: { error: { code: 'not_organizer' } } });
    expect((await w.bob('PATCH', `/v1/calendar/events/${enc(copy.id)}`, { reminders: [{ minutes: 5 }] })).s).toBe(200);

    // Ann moves it an hour later: Bob's copy moves and keeps his answer and his reminder.
    r = await w.ann('PATCH', `/v1/calendar/events/${enc(ev.id)}`, { start: '2026-12-03T16:00:00Z', end: '2026-12-03T17:00:00Z' });
    expect(r.s).toBe(200);
    r = await w.bob('GET', W);
    expect(r.j.events[0]).toMatchObject({ start: '2026-12-03T16:00:00.000Z', myResponse: 'accepted', reminders: [5] });

    // The agent declines through its own object.
    const botCopy = (await w.objects.get('acct-bot')!.handle(new Request(`https://edge.test${W}`), { user: { id: 'u-bot' }, organizationId: ORG, account: { id: 'acct-bot', principalId: 'u-bot', organizationId: ORG, address: ADDR('bot'), displayName: 'Builder' } } as never).then((x) => x.json()) as { events: { id: string }[] }).events[0]!;
    const res = await w.objects.get('acct-bot')!.handle(new Request(`https://edge.test/v1/calendar/events/${enc(botCopy.id)}/respond`, { method: 'POST', body: JSON.stringify({ response: 'declined' }), headers: { 'content-type': 'application/json' } }),
      { user: { id: 'u-bot' }, organizationId: ORG, account: { id: 'acct-bot', principalId: 'u-bot', organizationId: ORG, address: ADDR('bot'), displayName: 'Builder' } } as never);
    expect(((await res.json()) as { replied: string }).replied).toBe('server');
    r = await w.ann('GET', `/v1/calendar/events/${enc(ev.id)}`);
    expect([attendee(r.j.event, ADDR('bob')), attendee(r.j.event, ADDR('bot'))]).toEqual(['accepted', 'declined']);

    // Ann cancels: Bob's copy stays, cancelled.
    w.calls.length = 0;
    expect((await w.ann('DELETE', `/v1/calendar/events/${enc(ev.id)}`)).s).toBe(200);
    expect(w.calls.map((c) => c.method)).toEqual(['CANCEL', 'CANCEL']);
    r = await w.bob('GET', W);
    expect(r.j.events[0]).toMatchObject({ status: 'cancelled', summary: 'Review' });
    expect(w.published.filter((e) => e.type === 'calendar.event.cancelled').map((e) => (e.data as { ownerAccountId: string }).ownerAccountId).sort()).toEqual(['acct-ann', 'acct-bob', 'acct-bot']);
  });

  it('a guest taken off the list is cancelled; a REQUEST from someone else is refused by the attendee\'s object', async () => {
    const w = world();
    let r = await w.ann('POST', '/v1/calendar/events', { summary: 'Sync', start: '2026-12-04T15:00:00Z', end: '2026-12-04T16:00:00Z', attendees: [{ email: ADDR('bob') }] });
    const ev = r.j.event;
    r = await w.ann('PATCH', `/v1/calendar/events/${enc(ev.id)}`, { attendees: [{ email: 'guest@example.com' }] });
    expect(w.calls.map((c) => `${c.to} ${c.method}`)).toEqual(['acct-bob REQUEST', 'acct-bob CANCEL']);
    r = await w.bob('GET', W);
    expect(r.j.events[0]).toMatchObject({ summary: 'Sync', status: 'cancelled' });
    const raw = (await w.ann('GET', `/v1/calendar/events/${enc(ev.id)}`)).j.raw as string;
    const forged = await w.objects.get('acct-bob')!.receiveItip({ method: 'REQUEST', ics: raw.replace('BEGIN:VEVENT', 'METHOD:REQUEST\r\nBEGIN:VEVENT').replace('SEQUENCE:0', 'SEQUENCE:9'), from: { accountId: 'acct-mallory', email: 'mallory@acme.freeflow.im' } });
    expect(forged).toMatchObject({ ok: false, code: 'not_organizer' });
  });

  it('retries a failed delivery once; one that fails twice is logged and the organizer\'s write stands', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const w = world({ failFirst: new Set(['acct-bob']), down: new Set(['acct-bot']) });
    const r = await w.ann('POST', '/v1/calendar/events', { summary: 'Retro', start: '2026-12-05T15:00:00Z', end: '2026-12-05T16:00:00Z', attendees: [{ email: ADDR('bob') }, { email: ADDR('bot') }] });
    expect(r.s).toBe(201);
    expect(w.calls.filter((c) => c.to === 'acct-bob')).toHaveLength(2);
    expect(w.calls.filter((c) => c.to === 'acct-bot')).toHaveLength(2);
    expect((await w.bob('GET', W)).j.events.map((e: { summary: string }) => e.summary)).toEqual(['Retro']);
    expect((await w.ann('GET', W)).j.events.map((e: { summary: string }) => e.summary)).toEqual(['Retro']);
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => /delivery/.test(l));
    expect(lines).toHaveLength(3);
    expect(lines).toEqual(expect.arrayContaining(['[calendar] REQUEST delivery 1/2 failed: a transient failure', '[calendar] REQUEST delivery 2/2 failed: object unreachable']));
    warn.mockRestore();
  });
});
