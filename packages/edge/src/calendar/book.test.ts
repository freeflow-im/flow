// The guest scheduler end to end on one Calendar object (docs/specs/guest-scheduler.md): the owner turns the page on, a
// guest reads it through the public route (routes/book.ts) and books, the event lands on the owner's native calendar with
// the guest invited and mailed, a second guest is refused the same slot, the guest moves and cancels by their own link.
// The directory and the event log are stand-ins; the clock is fixed (Date only, so timers still run).
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishInput } from '../events/core';
import type { CallerContext } from '../org/routes/compat';
import { bookRoutes } from '../routes/book';
import { Calendar } from './object';

const toBinding = (v: unknown): SQLInputValue => (v instanceof ArrayBuffer ? new Uint8Array(v) : (v as SQLInputValue));
const LA = 'America/Los_Angeles';
// Thursday 12 November 2026, 08:00 in Los Angeles.
const NOW = Date.parse('2026-11-12T16:00:00Z');

function world() {
  const published: PublishInput[] = [];
  const links = new Map<string, { accountId: string; kind: string }>();
  const directory = {
    call: async (m: string, a: unknown[]) => {
      if (m === 'setBookingLink') {
        for (const [h, l] of links) if (l.accountId === a[0] && l.kind === 'page') links.delete(h);
        if (a[1]) links.set(String(a[1]), { accountId: String(a[0]), kind: 'page' });
        return { ok: true, value: null };
      }
      if (m === 'addBookingManageLink') { links.set(String(a[1]), { accountId: String(a[0]), kind: 'manage' }); return { ok: true, value: null }; }
      if (m === 'bookingOwner') { const l = links.get(String(a[0])); return { ok: true, value: l && l.kind === (a[1] ?? 'page') ? l.accountId : null }; }
      return { ok: true, value: null };
    },
  };
  const env: Record<string, unknown> = {
    CALENDAR_ALARM: 'off', WEB_URL_BASE: 'https://app.test',
    EVENTS: { idFromName: (n: string) => n, get: () => ({ publish: async (e: PublishInput) => { published.push(e); return { seq: published.length, id: 'e' }; } }) },
    DIRECTORY: { idFromName: (n: string) => n, get: () => directory },
  };
  const db = new DatabaseSync(':memory:');
  const exec = (query: string, ...bindings: unknown[]) => {
    const statement = db.prepare(query);
    const values = bindings.map(toBinding);
    const rows = statement.columns().length ? (statement.all(...values) as Record<string, unknown>[]) : (statement.run(...values), []);
    return { toArray: () => rows, one: () => rows[0] };
  };
  const ctx = { storage: { sql: { exec, databaseSize: 0 }, getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} }, id: {}, waitUntil: () => {} };
  const cal = new Calendar(ctx as never, env as never);
  env.CALENDAR = { idFromName: (n: string) => n, get: () => cal };
  const caller = {
    user: { id: 'u-ann' }, token: null, authKind: 'session', ip: '', organizationId: 'org-1',
    account: { id: 'acct-ann', principalId: 'u-ann', organizationId: 'org-1', address: 'ann@acme.freeflow.im', displayName: 'Ann Lee' },
  } as unknown as CallerContext;
  const owner = async (method: string, path: string, body?: unknown) => {
    const res = await cal.handle(new Request(`https://edge.test${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) }), caller);
    return { s: res.status, j: (await res.json()) as Record<string, any> };
  };
  const guest = async (method: string, path: string, body?: unknown, ip = '203.0.113.7') => {
    const res = await bookRoutes.request(`https://app.test${path}`, { method, headers: { 'cf-connecting-ip': ip, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, env as never);
    return { s: res.status, j: (await res.json()) as Record<string, any>, h: res.headers };
  };
  return { cal, published, links, owner, guest };
}

let mails: string[];
beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  mails = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => { if (String(line).startsWith('[mail]')) mails.push(String(line)); });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function turnedOn(w: ReturnType<typeof world>, patch: Record<string, unknown> = {}) {
  const r = await w.owner('PATCH', `/v1/calendar/scheduler?tz=${encodeURIComponent(LA)}`, { enabled: true, title: '30 Minute Meet', durations: [30, 60], location: { kind: 'text', value: 'https://meet.example/ann' }, ...patch });
  expect(r.s).toBe(200);
  return r.j as { token: string; url: string; page: Record<string, any> };
}

describe('the guest scheduler', () => {
  it('starts off with the defaults, and turning it on makes a readable link', async () => {
    const w = world();
    const r = await w.owner('GET', `/v1/calendar/scheduler?tz=${encodeURIComponent(LA)}`);
    expect(r.j).toMatchObject({ token: null, url: null, page: { enabled: false, durations: [30], timezone: LA, weekly: { mon: [[540, 1020]], sat: [] }, minNoticeMin: 240, horizonDays: 60 } });
    const on = await turnedOn(w);
    expect(on.token).toMatch(/^[0-9a-hjkmnp-tv-z]{4}-[0-9a-hjkmnp-tv-z]{4}-[0-9a-hjkmnp-tv-z]{4}$/);
    expect(on.url).toBe(`https://app.test/calendar/book/${on.token}`);
    expect([...w.links.values()]).toEqual([{ accountId: 'acct-ann', kind: 'page' }]);
    // Saving again keeps the link; a range that ends before it starts is refused.
    expect((await w.owner('PATCH', '/v1/calendar/scheduler', { title: 'Chat' })).j.token).toBe(on.token);
    expect((await w.owner('PATCH', '/v1/calendar/scheduler', { weekly: { mon: [[600, 500]] } })).s).toBe(400);
  });

  it('shows the page and its open days without anything private, in any case of the token', async () => {
    const w = world();
    const { token } = await turnedOn(w);
    let r = await w.guest('GET', `/v1/book/${token.toUpperCase().replace(/-/g, '')}`);
    expect(r.s).toBe(200);
    expect(r.h.get('cache-control')).toBe('no-store');
    expect(r.j.page).toMatchObject({ ownerName: 'Ann Lee', title: '30 Minute Meet', durations: [30, 60], defaultDuration: 30, location: { kind: 'link', label: null }, ownerTimezone: LA });
    expect(JSON.stringify(r.j)).not.toContain('meet.example');
    expect(JSON.stringify(r.j)).not.toMatch(/ann@|acct-|org-1/);
    r = await w.guest('GET', `/v1/book/${token}/days?month=2026-11&duration=30&tz=${encodeURIComponent(LA)}`);
    // From today (Thursday 12th, 08:00 + 4 hours' notice) on weekdays.
    expect(r.j.days).toEqual(['2026-11-12', '2026-11-13', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-30']);
    r = await w.guest('GET', `/v1/book/${token}/slots?date=2026-11-12&duration=60&tz=${encodeURIComponent(LA)}`);
    expect(r.j.slots[0]).toBe('2026-11-12T20:00:00.000Z');
    expect(r.j.slots.at(-1)).toBe('2026-11-13T00:00:00.000Z');
    expect((await w.guest('GET', `/v1/book/${token}/days?month=2026-11&duration=45`)).s).toBe(400);
  });

  it('is the same 404 for an unknown token, a malformed one, a page turned off and an old link', async () => {
    const w = world();
    const { token } = await turnedOn(w);
    const nope = await w.guest('GET', '/v1/book/zzzz-zzzz-zzzz');
    expect(nope.s).toBe(404);
    expect((await w.guest('GET', '/v1/book/not-a-token')).j).toEqual(nope.j);
    expect((await w.guest('GET', '/v1/book/m/short')).j).toEqual(nope.j);
    await w.owner('PATCH', '/v1/calendar/scheduler', { enabled: false });
    expect((await w.guest('GET', `/v1/book/${token}`)).j).toEqual(nope.j);
    await w.owner('PATCH', '/v1/calendar/scheduler', { enabled: true });
    const rotated = (await w.owner('POST', '/v1/calendar/scheduler/rotate')).j.token as string;
    expect(rotated).not.toBe(token);
    expect((await w.guest('GET', `/v1/book/${token}`)).s).toBe(404);
    expect((await w.guest('GET', `/v1/book/${rotated}`)).s).toBe(200);
  });

  it('books a slot onto the owner\'s calendar, mails the guest the invitation and link, and refuses the slot twice', async () => {
    const w = world();
    const { token } = await turnedOn(w);
    const start = '2026-11-16T17:00:00.000Z'; // Monday 9:00 in Los Angeles
    let r = await w.guest('POST', `/v1/book/${token}`, { start, duration: 30, name: 'Bo Guest', email: 'Bo@Example.com', note: 'About the launch', tz: 'Europe/London' });
    expect(r.s).toBe(201);
    expect(r.j.booking).toMatchObject({ status: 'booked', start, end: '2026-11-16T17:30:00.000Z', duration: 30, guestName: 'Bo Guest', timezone: 'Europe/London', canCancel: true, canReschedule: true });
    expect(r.j.manageUrl).toMatch(/^https:\/\/app\.test\/calendar\/book\/m\/[A-Za-z0-9_-]{22}$/);

    // On Ann's calendar, with the guest invited.
    const ev = (await w.owner('GET', '/v1/calendar/events?from=2026-11-16T00:00:00Z&to=2026-11-17T00:00:00Z')).j.events;
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ summary: '30 Minute Meet: Bo Guest', location: 'https://meet.example/ann', start });
    expect(ev[0].attendees.map((a: { email: string }) => a.email)).toContain('bo@example.com');
    expect(ev[0].description).toContain('About the launch');
    // The guest reads the description in the invitation: their own link, and nothing written to the owner.
    expect(ev[0].description).toContain(`Cancel or reschedule: ${r.j.manageUrl}`);
    expect(ev[0].description).toContain("Booked through Ann Lee's booking page.");
    expect(ev[0].description).not.toMatch(/your booking page|bo@example/);

    // No mailbox sends as Ann here, so the guest's mail carries the invitation, with their own link, in their zone.
    expect(mails).toHaveLength(1);
    expect(mails[0]).toContain('to=bo@example.com');
    expect(mails[0]).toContain('reply_to=ann@acme.freeflow.im');
    expect(mails[0]).toContain('attachments=invite.ics');
    expect(mails[0]).toContain(r.j.manageUrl);
    expect(mails[0]).toContain('5:00 PM');
    expect(w.published.find((e) => e.type === 'calendar.booked')).toMatchObject({ audience: 'account:acct-ann', data: { action: 'booked', guest: { name: 'Bo Guest', email: 'bo@example.com' } } });

    // The slot is gone: the day's list no longer has it, and booking it again is 409 with fresh starts.
    const slots = (await w.guest('GET', `/v1/book/${token}/slots?date=2026-11-16&duration=30&tz=${encodeURIComponent(LA)}`)).j.slots;
    expect(slots).not.toContain(start);
    r = await w.guest('POST', `/v1/book/${token}`, { start, duration: 30, name: 'Cy', email: 'cy@example.com' }, '198.51.100.1');
    expect(r.s).toBe(409);
    expect(r.j.error.code).toBe('slot_taken');
    expect(r.j.slots[0]).toBe('2026-11-16T17:30:00.000Z');
    // A start off the grid, a length not offered, the hidden field filled: refused.
    expect((await w.guest('POST', `/v1/book/${token}`, { start: '2026-11-16T17:10:00Z', duration: 30, name: 'Cy', email: 'cy@example.com' }, '198.51.100.1')).s).toBe(409);
    expect((await w.guest('POST', `/v1/book/${token}`, { start: '2026-11-16T18:00:00Z', duration: 45, name: 'Cy', email: 'cy@example.com' }, '198.51.100.1')).s).toBe(400);
    expect((await w.guest('POST', `/v1/book/${token}`, { start: '2026-11-16T18:00:00Z', duration: 30, name: 'Cy', email: 'cy@example.com', website: 'x' }, '198.51.100.1')).s).toBe(400);
  });

  it('moves the same meeting and then cancels it by the guest\'s own link, which outlives a new page link', async () => {
    const w = world();
    const { token } = await turnedOn(w);
    const booked = (await w.guest('POST', `/v1/book/${token}`, { start: '2026-11-16T17:00:00.000Z', duration: 30, name: 'Bo', email: 'bo@example.com', tz: LA })).j;
    const manage = String(booked.manageUrl).split('/').pop()!;
    await w.owner('POST', '/v1/calendar/scheduler/rotate');

    let r = await w.guest('GET', `/v1/book/m/${manage}`);
    expect(r.j.booking).toMatchObject({ status: 'booked', canReschedule: true });
    // The booking's own time counts as free while it is moved.
    r = await w.guest('GET', `/v1/book/m/${manage}/slots?date=2026-11-16&duration=30&tz=${encodeURIComponent(LA)}`);
    expect(r.j.slots).toContain('2026-11-16T17:00:00.000Z');

    const before = (await w.owner('GET', '/v1/calendar/events?from=2026-11-16T00:00:00Z&to=2026-11-18T00:00:00Z')).j.events[0];
    r = await w.guest('POST', `/v1/book/m/${manage}/reschedule`, { start: '2026-11-17T18:00:00.000Z', duration: 60, tz: LA });
    expect(r.s).toBe(200);
    expect(r.j.booking).toMatchObject({ start: '2026-11-17T18:00:00.000Z', end: '2026-11-17T19:00:00.000Z', duration: 60 });
    const events = (await w.owner('GET', '/v1/calendar/events?from=2026-11-16T00:00:00Z&to=2026-11-18T00:00:00Z')).j.events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventId: before.eventId, start: '2026-11-17T18:00:00.000Z', end: '2026-11-17T19:00:00.000Z' });
    expect(mails.at(-1)).toContain('subject="Moved: 30 Minute Meet with Ann Lee"');
    expect(mails.at(-1)).toContain('attachments=invite.ics');

    r = await w.guest('POST', `/v1/book/m/${manage}/cancel`);
    expect(r.j.booking).toMatchObject({ status: 'cancelled', canCancel: false, canReschedule: false });
    expect((await w.owner('GET', '/v1/calendar/events?from=2026-11-16T00:00:00Z&to=2026-11-18T00:00:00Z')).j.events).toHaveLength(0);
    expect(mails.at(-1)).toContain('subject="Cancelled: 30 Minute Meet with Ann Lee"');
    expect(mails.at(-1)).toContain('attachments=cancel.ics');
    expect(w.published.filter((e) => e.type === 'calendar.booked').map((e) => (e.data as { action: string }).action)).toEqual(['booked', 'moved', 'cancelled']);
    // Cancelled stays cancelled: moving it is refused, cancelling again changes nothing.
    expect((await w.guest('POST', `/v1/book/m/${manage}/reschedule`, { start: '2026-11-18T18:00:00.000Z', duration: 30 })).j.error.code).toBe('cannot_reschedule');
    expect((await w.guest('POST', `/v1/book/m/${manage}/cancel`, undefined, '192.0.2.9')).j.booking.status).toBe('cancelled');
  });

  it('keeps the most bookings a day and the owner\'s list of bookings', async () => {
    const w = world();
    const { token } = await turnedOn(w, { maxPerDay: 1 });
    expect((await w.guest('POST', `/v1/book/${token}`, { start: '2026-11-16T17:00:00.000Z', duration: 30, name: 'Bo', email: 'bo@example.com' })).s).toBe(201);
    const days = (await w.guest('GET', `/v1/book/${token}/days?month=2026-11&tz=${encodeURIComponent(LA)}`)).j.days;
    expect(days).not.toContain('2026-11-16');
    expect(days).toContain('2026-11-17');
    const list = (await w.owner('GET', '/v1/calendar/scheduler/bookings')).j.bookings;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ guestName: 'Bo', guestEmail: 'bo@example.com', status: 'booked' });
  });

  it('limits bookings from one address to five an hour', async () => {
    const w = world();
    const { token } = await turnedOn(w);
    const at = (i: number) => new Date(Date.parse('2026-11-16T17:00:00Z') + i * 30 * 60_000).toISOString();
    for (let i = 0; i < 5; i++) expect((await w.guest('POST', `/v1/book/${token}`, { start: at(i), duration: 30, name: 'Bo', email: 'bo@example.com' })).s).toBe(201);
    const r = await w.guest('POST', `/v1/book/${token}`, { start: at(5), duration: 30, name: 'Bo', email: 'bo@example.com' });
    expect(r.s).toBe(429);
    expect((await w.guest('POST', `/v1/book/${token}`, { start: at(5), duration: 30, name: 'Cy', email: 'cy@example.com' }, '198.51.100.2')).s).toBe(201);
  });

  it('syncs a stale connected calendar when a guest opens the page, at most once a minute', async () => {
    const w = world();
    const { token } = await turnedOn(w);
    const sql = (w.cal as unknown as { sql: { exec: (q: string, ...a: unknown[]) => unknown } }).sql;
    sql.exec("INSERT INTO accounts (id, kind, email, display_name, server, secret, key_id, status, created_at) VALUES ('g1', 'google', 'ann@gmail.com', 'Ann', '{}', X'', '', 'ok', 0)");
    sql.exec("INSERT INTO calendars (id, account_id, href, name, created_at, last_synced) VALUES ('work', 'g1', 'https://dav.example/work/', 'Work', 0, 0)");
    const synced: string[] = [];
    (w.cal as unknown as { syncCalendar: (id: string) => Promise<void> }).syncCalendar = async (id: string) => { synced.push(id); };
    await w.guest('GET', `/v1/book/${token}`);
    await w.guest('GET', `/v1/book/${token}`);
    expect(synced).toEqual(['work']);
    vi.setSystemTime(NOW + 61_000);
    await w.guest('GET', `/v1/book/${token}`);
    expect(synced).toEqual(['work', 'work']);
  });
});
