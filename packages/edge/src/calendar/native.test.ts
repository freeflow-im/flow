// Native calendars on the Calendar object itself (phase 4.1): the writes published into the organization's event log, and
// grants (the owner, a viewer who cannot write, an editor who can, a manager's sharing, a revoke that leaves not_found),
// over node:sqlite with a stand-in object state and stand-in Events and Org objects.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { PublishInput } from '../events/core';
import type { CallerContext } from '../org/routes/compat';
import { sharedOwnerOf } from '../routes/calendar';
import { Calendar } from './object';
import { nativeCalendarId, nativeOwnerOf, routeOf } from './rules';

const toBinding = (v: unknown): SQLInputValue => (v instanceof ArrayBuffer ? new Uint8Array(v) : (v as SQLInputValue));

function calendarObject() {
  const db = new DatabaseSync(':memory:');
  const exec = (query: string, ...bindings: unknown[]) => {
    const statement = db.prepare(query);
    const values = bindings.map(toBinding);
    const rows = statement.columns().length ? (statement.all(...values) as Record<string, unknown>[]) : (statement.run(...values), []);
    return { toArray: () => rows, one: () => rows[0] };
  };
  const published: PublishInput[] = [];
  const shares: { op: 'record' | 'revoke'; input: Record<string, unknown> }[] = [];
  const env = {
    CALENDAR_ALARM: 'off', WEB_URL_BASE: 'https://app.test',
    EVENTS: { idFromName: (n: string) => n, get: () => ({ publish: async (e: PublishInput) => { published.push(e); return { seq: published.length, id: 'e' }; } }) },
    ORG: { idFromName: (n: string) => n, get: () => ({ recordShare: async (input: Record<string, unknown>) => void shares.push({ op: 'record', input }), revokeShare: async (input: Record<string, unknown>) => void shares.push({ op: 'revoke', input }) }) },
  };
  const ctx = { storage: { sql: { exec, databaseSize: 0 }, getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} }, id: {}, waitUntil: () => {} };
  return { cal: new Calendar(ctx as never, env as never), published, shares };
}

const callerOf = (id: string, org = 'org-1') => ({
  user: { id: `u-${id}` }, token: null, authKind: 'session', ip: '', organizationId: org,
  account: { id: `acct-${id}`, principalId: `u-${id}`, organizationId: org, address: `${id}@acme.freeflow.im`, displayName: id[0]!.toUpperCase() + id.slice(1) },
}) as unknown as CallerContext;
const ANN = callerOf('ann'), BOB = callerOf('bob');

async function call(fn: (r: Request) => Promise<Response>, method: string, path: string, body?: unknown) {
  const res = await fn(new Request(`https://edge.test${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) }));
  return { s: res.status, j: (await res.json()) as Record<string, any> };
}

describe('native calendars on the Calendar object', () => {
  it('gives the owner a default calendar, and publishes added, updated and cancelled', async () => {
    const { cal, published } = calendarObject();
    const ann = (m: string, p: string, b?: unknown) => call((r) => cal.handle(r, ANN), m, p, b);
    let r = await ann('GET', '/v1/calendar/calendars');
    const mine = r.j.calendars[0];
    expect(r.j.calendars).toHaveLength(1);
    expect(mine).toMatchObject({ name: 'Calendar', isDefault: true, role: 'owner' });
    expect((await ann('GET', '/v1/calendar/accounts')).j.accounts).toEqual([{ id: mine.accountId, kind: 'native', email: 'ann@acme.freeflow.im', displayName: 'Ann', status: 'ok' }]);
    r = await ann('POST', '/v1/calendar/events', { summary: 'Lunch', start: '2026-11-05T12:00:00Z', end: '2026-11-05T13:00:00Z', attendees: [{ email: 'someone@else.test' }] });
    expect(r.s).toBe(201);
    const ev = r.j.event;
    expect(ev).toMatchObject({ calendarId: mine.id, summary: 'Lunch' });
    // An attendee outside the platform is emailed (phase 4.2): with no mail account here, the answer says it was not.
    expect(r.j).toMatchObject({ invitationsSent: false, invitationsNote: expect.stringMatching(/No mail account/) });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: 'calendar.event.added', organizationId: 'org-1', actor: 'acct-ann',
      ref: { organizationId: 'org-1', app: 'calendar', kind: 'event', id: ev.eventId },
      audience: `ref:org-1/calendar/calendar/${mine.id}`,
      data: { calendarId: mine.id, eventId: ev.eventId, summary: 'Lunch', start: '2026-11-05T12:00:00.000Z', end: '2026-11-05T13:00:00.000Z', allDay: false, ownerAccountId: 'acct-ann', url: `https://app.test/calendar/week/2026-11-05?event=${encodeURIComponent(ev.eventId)}` },
    });
    r = await ann('PATCH', `/v1/calendar/events/${encodeURIComponent(ev.id)}`, { summary: 'Stale', etag: '"0-0"' });
    expect(r.s).toBe(409);
    r = await ann('PATCH', `/v1/calendar/events/${encodeURIComponent(ev.id)}`, { summary: 'Long lunch', etag: ev.etag });
    expect(r.j.event).toMatchObject({ summary: 'Long lunch' });
    expect(r.j.event.etag).not.toBe(ev.etag);
    r = await ann('DELETE', `/v1/calendar/events/${encodeURIComponent(ev.id)}`);
    expect(r.j).toMatchObject({ ok: true, invitationsSent: false });
    expect(published.map((e) => [e.type, (e.data as { summary: string }).summary])).toEqual([['calendar.event.added', 'Lunch'], ['calendar.event.updated', 'Long lunch'], ['calendar.event.cancelled', 'Long lunch']]);
    expect(cal.busy(Date.parse('2026-11-01T00:00:00Z'), Date.parse('2026-11-30T00:00:00Z'))).toEqual([]);
  });

  it('lets a reader in by grants: none is not_found, a viewer reads, an editor writes, a revoke ends it', async () => {
    const { cal, shares, published } = calendarObject();
    const ann = (m: string, p: string, b?: unknown) => call((r) => cal.handle(r, ANN), m, p, b);
    const bob = (m: string, p: string, b?: unknown, channels: string[] = []) => call((r) => cal.handleShared(r, BOB, channels), m, p, b);
    const id = (await ann('GET', '/v1/calendar/calendars')).j.calendars[0].id as string;
    await ann('POST', '/v1/calendar/events', { summary: 'Planning', start: '2026-11-05T15:00:00Z', end: '2026-11-05T16:00:00Z' });
    const W = `/v1/calendar/events?from=2026-11-01T00:00:00Z&to=2026-11-30T00:00:00Z&calendars=${id}`;
    expect((await bob('GET', W)).s).toBe(404);
    expect((await bob('GET', '/v1/calendar/accounts')).s).toBe(404);
    expect((await bob('PUT', `/v1/calendar/calendars/${id}/grants`, { principal: 'account:acct-bob', role: 'manager' })).s).toBe(404);

    let r = await ann('PUT', `/v1/calendar/calendars/${id}/grants`, { principal: 'account:acct-bob', role: 'viewer' });
    expect(r.j).toMatchObject({ role: 'owner', grants: [{ objectKind: 'calendar', objectId: id, principal: 'account:acct-bob', role: 'viewer', grantedBy: 'acct-ann' }] });
    expect(shares).toEqual([{ op: 'record', input: { ref: `org-1/calendar/calendar/${id}`, principal: 'account:acct-bob', role: 'viewer', grantedBy: 'acct-ann', title: 'Calendar', kind: 'calendar' } }]);
    expect((await ann('PUT', `/v1/calendar/calendars/${id}/grants`, { principal: 'link:abc', role: 'viewer' })).j.error.code).toBe('not_supported');

    r = await bob('GET', W);
    expect(r.s).toBe(200);
    expect(r.j.events.map((e: { summary: string }) => e.summary)).toEqual(['Planning']);
    expect((await bob('GET', `/v1/calendar/events/${encodeURIComponent(r.j.events[0].id)}`)).j.event.summary).toBe('Planning');
    expect((await bob('GET', `/v1/calendar/calendars/${id}/grants`)).j.role).toBe('viewer');
    expect((await bob('POST', '/v1/calendar/events', { calendarId: id, summary: 'Mine', start: '2026-11-06T15:00:00Z', end: '2026-11-06T16:00:00Z' })).s).toBe(403);
    expect((await bob('PATCH', `/v1/calendar/events/${encodeURIComponent(r.j.events[0].id)}`, { summary: 'x' })).s).toBe(403);
    expect(cal.sharedCalendars(BOB, [], [id, 'n.acct-ann.000000000000'])).toEqual([{ id, name: 'Calendar', color: expect.any(String), role: 'viewer' }]);

    await ann('PUT', `/v1/calendar/calendars/${id}/grants`, { principal: 'account:acct-bob', role: 'editor' });
    r = await bob('POST', '/v1/calendar/events', { calendarId: id, summary: 'Mine', start: '2026-11-06T15:00:00Z', end: '2026-11-06T16:00:00Z' });
    expect(r.s).toBe(201);
    expect(published.at(-1)).toMatchObject({ type: 'calendar.event.added', actor: 'acct-bob', data: { ownerAccountId: 'acct-ann', summary: 'Mine' } });
    expect((await bob('PUT', `/v1/calendar/calendars/${id}/grants`, { principal: 'org', role: 'viewer' })).s).toBe(403);
    expect(cal.busy(Date.parse('2026-11-01T00:00:00Z'), Date.parse('2026-11-30T00:00:00Z'))).toEqual([['2026-11-05T15:00:00.000Z', '2026-11-05T16:00:00.000Z'], ['2026-11-06T15:00:00.000Z', '2026-11-06T16:00:00.000Z']]);

    // Someone of another organization is never a reader.
    expect((await call((q) => cal.handleShared(q, callerOf('bob', 'org-2'), []), 'GET', W)).s).toBe(404);

    r = await ann('DELETE', `/v1/calendar/calendars/${id}/grants/${encodeURIComponent('account:acct-bob')}`);
    expect(r.j.grants).toEqual([]);
    expect(shares.at(-1)).toEqual({ op: 'revoke', input: { ref: `org-1/calendar/calendar/${id}`, principal: 'account:acct-bob', revokedBy: 'acct-ann' } });
    expect((await bob('GET', W)).s).toBe(404);

    // A channel the reader is in; a manager shares on.
    await ann('PUT', `/v1/calendar/calendars/${id}/grants`, { principal: 'channel:ch-1', role: 'manager' });
    expect((await bob('GET', W)).s).toBe(404);
    expect((await bob('GET', W, undefined, ['ch-1'])).j.events).toHaveLength(2);
    expect((await bob('PUT', `/v1/calendar/calendars/${id}/grants`, { principal: 'org', role: 'viewer' }, ['ch-1'])).j.role).toBe('manager');
  });
});

describe('finding the owner of a shared calendar (routes/calendar.ts)', () => {
  const ANNS = nativeCalendarId('0190a1b2-0000-7000-8000-00000000000a');
  const req = (method: string, path: string, body?: unknown) => new Request(`https://edge.test${path}`, { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
  it('reads the id from the path, the calendars query or the body, and leaves the caller\'s own alone', async () => {
    const owner = nativeOwnerOf(ANNS);
    expect(owner).toBe('0190a1b2-0000-7000-8000-00000000000a');
    expect(nativeOwnerOf('3f1c-uuid-of-a-caldav-calendar')).toBeNull();
    expect(await sharedOwnerOf(req('GET', `/v1/calendar/events/${encodeURIComponent(`${ANNS}:uid-1`)}`), 'me')).toBe(owner);
    expect(await sharedOwnerOf(req('GET', `/v1/calendar/events?from=a&to=b&calendars=mine,${ANNS}`), 'me')).toBe(owner);
    expect(await sharedOwnerOf(req('PUT', `/v1/calendar/calendars/${ANNS}/grants`), 'me')).toBe(owner);
    expect(await sharedOwnerOf(req('POST', '/v1/calendar/events', { calendarId: ANNS }), 'me')).toBe(owner);
    expect(await sharedOwnerOf(req('POST', '/v1/calendar/events', { calendarId: ANNS }), owner!)).toBeNull();
    expect(await sharedOwnerOf(req('GET', '/v1/calendar/calendars'), 'me')).toBeNull();
  });
  it('keeps principals out of the timing line', () => {
    expect(routeOf('DELETE', `https://edge.test/v1/calendar/calendars/${ANNS}/grants/account:abc`)).toBe('DELETE /v1/calendar/calendars/:id/grants/:principal');
  });
});
