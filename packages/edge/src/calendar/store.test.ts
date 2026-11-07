import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { DAY_MS, LONG_MS, deleteFromEvent, editEvent, newEvent } from './ical';
import { CalendarStore, deleteEventsSql, dueSql, eventsOfUidSql, etagsSql, exceptionsSql, objectByUidSql, objectsSql, seriesSql, singlesSql, type Sql } from './store';

/** The object's SqlStorage, on node:sqlite (as cache.test.ts does for Mail). */
function memory(): Sql & { db: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  return {
    db,
    exec(query, ...bindings) {
      const statement = db.prepare(query);
      const rows = /^\s*(SELECT|WITH)/i.test(query) || /RETURNING/i.test(query) ? statement.all(...(bindings as never[])) : (statement.run(...(bindings as never[])), []);
      return { toArray: () => rows as never };
    },
  };
}
const at = (iso: string) => Date.parse(iso);
const ME = new Set(['ann@example.com']);
const ctx = { me: ['ann@example.com'], organizer: 'ann@example.com', displayName: 'Ann', zone: 'UTC', now: at('2026-11-01T00:00:00Z') };
const opts = { me: ME, zone: 'UTC' };

function calendarRow(sql: Sql, id: string) {
  sql.exec(`INSERT INTO calendars (id, account_id, href, name, created_at) VALUES (?, 'acct', ?, ?, 0)`, id, `https://dav.example.com/${id}/`, id);
}

/** A production-sized calendar: 10k events over ten years to April 2026 (1k of them recurring, half of those ended), and their objects. */
function bigStore() {
  const sql = memory();
  const store = new CalendarStore(sql);
  store.init();
  for (const c of ['work', 'home']) calendarRow(sql, c);
  const ins = sql.db.prepare(`INSERT INTO events (id, calendar_id, uid, href, etag, rid, kind, start_utc, end_utc, recur_until, status, search, data, rules) VALUES (?, ?, ?, ?, 'e', ?, ?, ?, ?, ?, 'confirmed', ?, '{}', ?)`);
  const obj = sql.db.prepare(`INSERT INTO objects (calendar_id, href, uid, etag, raw) VALUES (?, ?, ?, 'e', '')`);
  const base = at('2016-01-01T00:00:00Z');
  sql.db.exec('BEGIN');
  for (let i = 0; i < 10_000; i++) {
    const cal = i % 2 ? 'work' : 'home', uid = `u${i}`, href = `https://dav.example.com/${cal}/${uid}.ics`;
    const start = base + i * 9 * 3_600_000;
    const recurring = i % 10 === 0;
    const rules = recurring ? JSON.stringify({ start: { y: 2017, mo: 1, d: 2, h: 9, mi: 0, s: 0 }, form: { kind: 'utc' }, durationMs: 3_600_000, rrules: ['FREQ=WEEKLY'], rdates: [], exdates: [] }) : null;
    ins.run(`${cal}:${uid}`, cal, uid, href, 0, recurring ? 1 : 0, start, start + 3_600_000, recurring ? (i % 20 === 0 ? 8.64e15 : start + 30 * DAY_MS) : start + 3_600_000, `meeting ${i}`, rules);
    obj.run(cal, href, uid);
    if (i % 50 === 0) ins.run(`${cal}:${uid}:x`, cal, uid, href, start + 7 * DAY_MS, 0, start + 7 * DAY_MS, start + 7 * DAY_MS + 3_600_000, start + 7 * DAY_MS + 3_600_000, `meeting ${i}`, null);
  }
  sql.db.exec('COMMIT');
  sql.db.exec('ANALYZE');
  return { sql, store };
}

const plan = (sql: Sql & { db: DatabaseSync }, query: string, ...params: unknown[]) => sql.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...(params as never[])).map((r) => String(r.detail));
const scans = (details: string[]) => details.filter((d) => /^SCAN (events|objects)\b/.test(d) || /USE TEMP B-TREE FOR GROUP BY/.test(d));

describe('the window and sync queries, on a production-sized table', () => {
  const { sql, store } = bigStore();
  const ids = JSON.stringify(['work', 'home']);
  const from = at('2026-11-02T00:00:00Z'), to = at('2026-11-09T00:00:00Z');

  it('lists single events by the window index, never a scan', () => {
    for (const like of [false, true]) {
      const p = plan(sql, singlesSql(like), ids, from - LONG_MS, to, from, ...(like ? ['%x%'] : []), ids, to, from, ...(like ? ['%x%'] : []))
      expect(p.filter((d) => /SEARCH events USING INDEX events_window \(calendar_id=\? AND kind=\? AND start_utc>\? AND start_utc<\?\)/.test(d))).toHaveLength(1);
      expect(p.some((d) => /SEARCH events USING INDEX events_window \(calendar_id=\? AND kind=\? AND start_utc<\?\)/.test(d))).toBe(true);
      expect(scans(p)).toEqual([]);
    }
  });

  it('finds the series still going by recur_until, and the exceptions of a window by their rid', () => {
    const p = plan(sql, seriesSql(true), ids, from, to, '%x%')
    expect(p.some((d) => /SEARCH events USING INDEX events_series \((calendar_id=\?|ANY\(calendar_id\)) AND kind=\? AND recur_until>\?\)/.test(d))).toBe(true);
    expect(scans(p)).toEqual([]);
    const e = plan(sql, exceptionsSql, ids, from - 3_600_000, to);
    expect(e.some((d) => /SEARCH events USING INDEX events_rid \((calendar_id=\?|ANY\(calendar_id\)) AND rid>\? AND rid<\?\)/.test(d))).toBe(true);
    expect(scans(e)).toEqual([]);
  });

  it('reads and writes one object and its events by key', () => {
    expect(plan(sql, etagsSql, 'work').some((d) => /SEARCH objects USING COVERING INDEX objects_etag \(calendar_id=\?\)/.test(d))).toBe(true);
    expect(plan(sql, objectByUidSql, 'work', 'u1').some((d) => /SEARCH objects USING INDEX objects_uid \(calendar_id=\? AND uid=\?\)/.test(d))).toBe(true);
    expect(plan(sql, eventsOfUidSql, 'work', 'u1').some((d) => /SEARCH events USING INDEX events_uid \(calendar_id=\? AND uid=\?\)/.test(d))).toBe(true);
    expect(plan(sql, objectsSql, 'work').some((d) => /SEARCH objects USING INDEX sqlite_autoindex_objects_1 \(calendar_id=\?\)/.test(d))).toBe(true);
    expect(plan(sql, deleteEventsSql, 'work', 'h').some((d) => /SEARCH events USING INDEX events_href \(calendar_id=\? AND href=\?\)/.test(d))).toBe(true);
    // The calendars table holds a person's few dozen calendars: a scan of it is the plan, and it joins nothing.
    expect(plan(sql, dueSql, 0).every((d) => !/events|objects/.test(d))).toBe(true);
  });

  it('lists a week of it, every series expanded, quickly', () => {
    const t0 = performance.now();
    const week = store.list(['work', 'home'], from, to);
    const ms = performance.now() - t0;
    // 500 weekly series still going: one occurrence each this week, plus the single events of the week (none so late).
    expect(week.filter((o) => o.recurring)).toHaveLength(500);
    expect(ms).toBeLessThan(1500);
    const searched = store.list(['work', 'home'], from, to, 'meeting 10');
    expect(searched.length).toBeGreaterThan(0);
    expect(searched.every((o) => o.eventId.startsWith('work:u10') || o.eventId.startsWith('home:u10'))).toBe(true);
  });
});

describe('CalendarStore', () => {
  function small() {
    const sql = memory();
    const store = new CalendarStore(sql);
    store.init();
    calendarRow(sql, 'c1');
    return store;
  }
  const weekly = newEvent('w', { summary: 'Weekly', start: '2026-11-02T09:00:00Z', end: '2026-11-02T10:00:00Z', timezone: 'UTC', recurrence: ['RRULE:FREQ=WEEKLY'] }, ctx);

  it('lists plain, all-day and long events, a series with an exception, a cancelled one and an EXDATE', () => {
    const store = small();
    store.putObject('c1', 'https://dav/c1/a.ics', '"a"', newEvent('a', { summary: 'Lunch', start: '2026-11-04T12:00:00Z', end: '2026-11-04T13:00:00Z', timezone: 'UTC' }, ctx), opts);
    store.putObject('c1', 'https://dav/c1/d.ics', '"d"', newEvent('d', { summary: 'Off', start: '2026-11-05', end: '2026-11-06', allDay: true }, ctx), opts);
    store.putObject('c1', 'https://dav/c1/l.ics', '"l"', newEvent('l', { summary: 'Sabbatical', start: '2026-09-01', end: '2027-01-01', allDay: true }, ctx), opts);
    const series = weekly.replace('END:VEVENT\r\nEND:VCALENDAR', 'EXDATE:20261116T090000Z\r\nEND:VEVENT\r\n'
      + 'BEGIN:VEVENT\r\nUID:w\r\nDTSTAMP:20261101T000000Z\r\nRECURRENCE-ID:20261109T090000Z\r\nDTSTART:20261109T150000Z\r\nDTEND:20261109T160000Z\r\nSUMMARY:Weekly (later)\r\nEND:VEVENT\r\n'
      + 'BEGIN:VEVENT\r\nUID:w\r\nDTSTAMP:20261101T000000Z\r\nRECURRENCE-ID:20261123T090000Z\r\nDTSTART:20261123T090000Z\r\nDTEND:20261123T100000Z\r\nSTATUS:CANCELLED\r\nSUMMARY:Weekly\r\nEND:VEVENT\r\nEND:VCALENDAR');
    store.putObject('c1', 'https://dav/c1/w.ics', '"w"', series, opts);
    const list = store.list(['c1'], at('2026-11-01T00:00:00Z'), at('2026-12-01T00:00:00Z'));
    expect(list.map((o) => [o.summary, o.start])).toEqual([
      ['Sabbatical', '2026-09-01'],
      ['Weekly', '2026-11-02T09:00:00.000Z'],
      ['Lunch', '2026-11-04T12:00:00.000Z'],
      ['Off', '2026-11-05'],
      ['Weekly (later)', '2026-11-09T15:00:00.000Z'],
      ['Weekly', '2026-11-30T09:00:00.000Z'],
    ]);
    const later = list.find((o) => o.summary === 'Weekly (later)')!;
    expect(later).toMatchObject({ id: 'c1:w:20261109T090000Z', eventId: 'c1:w', recurring: true, recurrenceId: '20261109T090000Z', etag: '"w"' });
    expect(list[1]).toMatchObject({ id: 'c1:w:20261102T090000Z', recurrence: ['RRULE:FREQ=WEEKLY', 'EXDATE:20261116T090000Z'] });
    expect(store.list(['c1'], at('2026-11-01T00:00:00Z'), at('2026-12-01T00:00:00Z'), 'lunch').map((o) => o.summary)).toEqual(['Lunch']);
  });

  it('finds a series, an occurrence of it, an exception, and nothing for a time it does not occur', () => {
    const store = small();
    store.putObject('c1', 'https://dav/c1/w.ics', '"w"', weekly, opts);
    expect(store.find('c1', 'w', null)?.event).toMatchObject({ id: 'c1:w', start: '2026-11-02T09:00:00.000Z' });
    expect(store.find('c1', 'w', at('2026-11-16T09:00:00Z'))?.event).toMatchObject({ id: 'c1:w:20261116T090000Z', start: '2026-11-16T09:00:00.000Z' });
    expect(store.find('c1', 'w', at('2026-11-16T10:00:00Z'))).toBeNull();
    expect(store.find('c1', 'nope', null)).toBeNull();
  });

  it('replaces an object\'s rows when it changes, and a UID moved to another href', () => {
    const store = small();
    store.putObject('c1', 'https://dav/c1/w.ics', '"1"', weekly, opts);
    store.putObject('c1', 'https://dav/c1/w2.ics', '"2"', weekly.replace('SUMMARY:Weekly', 'SUMMARY:Renamed'), opts);
    expect(store.etags('c1')).toEqual(new Map([['https://dav/c1/w2.ics', '"2"']]));
    expect(store.find('c1', 'w', null)?.event.summary).toBe('Renamed');
    store.deleteObject('c1', 'https://dav/c1/w2.ics');
    expect(store.list(['c1'], at('2026-11-01T00:00:00Z'), at('2026-12-01T00:00:00Z'))).toEqual([]);
  });

  it('keeps one default calendar, never a read-only one', () => {
    const sql = memory();
    const store = new CalendarStore(sql);
    store.init();
    calendarRow(sql, 'a');
    calendarRow(sql, 'b');
    sql.exec(`UPDATE calendars SET role = 'reader' WHERE id = 'a'`);
    store.ensureDefault();
    expect(store.calendars().filter((c) => c.is_default).map((c) => c.id)).toEqual(['b']);
    store.ensureDefault('a');
    expect(store.calendars().filter((c) => c.is_default).map((c) => c.id)).toEqual(['b']);
    // A calendar shared by someone else (a writer) is not chosen over one's own.
    calendarRow(sql, 'c');
    sql.exec(`UPDATE calendars SET role = 'writer', is_default = 0 WHERE id = 'b'`);
    store.ensureDefault();
    expect(store.calendars().filter((c) => c.is_default).map((c) => c.id)).toEqual(['c']);
  });

  it('keeps the calendars as the server lists them, the owner address of a shared one, and reparses when it changes', () => {
    const sql = memory();
    const store = new CalendarStore(sql);
    store.init();
    store.init();
    sql.exec(`INSERT INTO accounts (id, email, display_name, server, secret, key_id, created_at) VALUES ('a', 'me@gmail.com', 'Me', '{}', x'00', 'k', 0)`);
    const remote = (owner: string | null) => [
      { href: 'https://g/caldav/v2/me%40gmail.com/events/', name: 'Me', color: null, timezone: null, role: 'owner' as const, supportsSync: true, ctag: null, ownerAddress: 'me@gmail.com' },
      { href: 'https://g/caldav/v2/work%40corp.test/events/', name: 'Work', color: '#ff0000', timezone: null, role: 'reader' as const, supportsSync: true, ctag: null, ownerAddress: owner },
    ];
    store.applyCalendars('a', remote('work@corp.test'), ['#111111']);
    const work = store.calendars().find((c) => c.name === 'Work')!;
    expect(work).toMatchObject({ owner_address: 'work@corp.test', reparse: 0, role: 'reader', server_color: '#ff0000' });
    const series = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:s\r\nDTSTART:20261105T160000Z\r\nDTEND:20261105T163000Z\r\nATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:boss@corp.test\r\nEND:VEVENT\r\nEND:VCALENDAR';
    store.putObject(work.id, 'https://g/w/s.ics', '"1"', series, { me: new Set(['me@gmail.com', 'work@corp.test']), zone: 'UTC' });
    expect(store.find(work.id, 's', null)?.event.myResponse).toBeUndefined();
    store.applyCalendars('a', remote('boss@corp.test'), ['#111111']);
    expect(store.calendar(work.id)).toMatchObject({ owner_address: 'boss@corp.test', reparse: 1 });
    expect(store.reparse(work.id, { me: new Set(['me@gmail.com', 'boss@corp.test']), zone: 'UTC' })).toBe(1);
    expect(store.find(work.id, 's', null)?.event.myResponse).toBe('needs-action');
    expect(store.calendar(work.id)?.reparse).toBe(0);
    store.applyCalendars('a', remote('boss@corp.test').slice(0, 1), ['#111111']);
    expect(store.calendars().map((c) => c.name)).toEqual(['Me']);
  });
});

describe('native calendars (phase 4.1): the store is the server', () => {
  function native() {
    const sql = memory();
    const store = new CalendarStore(sql);
    store.init();
    const cal = store.ensureNative({ accountId: 'acct-ann', email: 'Ann@Acme.freeflow.im', displayName: 'Ann' })!;
    return { sql, store, cal };
  }
  const href = (cal: { href: string }, uid: string) => `${cal.href}/${uid}.ics`;
  const W = [at('2026-11-01T00:00:00Z'), at('2026-12-01T00:00:00Z')] as const;

  it('makes one native account and its default calendar on first use, once', () => {
    const { sql, store, cal } = native();
    expect(cal).toMatchObject({ name: 'Calendar', href: `native:${cal.id}`, is_default: 1, supports_sync: 0, role: 'owner' });
    expect(cal.id).toMatch(/^n\.acct-ann\.[a-f0-9]{12}$/);
    expect(sql.exec("SELECT kind, email, display_name, server FROM accounts").toArray()).toEqual([{ kind: 'native', email: 'ann@acme.freeflow.im', display_name: 'Ann', server: '' }]);
    expect(store.ensureNative({ accountId: 'acct-ann', email: 'x@y', displayName: 'X' })).toBeNull();
    expect(store.calendars()).toHaveLength(1);
    // Not the default when the person already has one.
    const other = memory();
    const s2 = new CalendarStore(other);
    s2.init();
    calendarRow(other, 'c1');
    other.exec('UPDATE calendars SET is_default = 1');
    expect(s2.ensureNative({ accountId: 'acct-bo', email: 'bo@x', displayName: '' })?.is_default).toBe(0);
  });

  it('creates, updates with an If-Match check, and deletes, indexing what it wrote', () => {
    const { store, cal } = native();
    const raw = newEvent('lunch', { summary: 'Lunch', start: '2026-11-04T12:00:00Z', end: '2026-11-04T13:00:00Z', timezone: 'UTC' }, ctx);
    const made = store.putNative(cal.id, href(cal, 'lunch'), raw, null, opts);
    expect(made).toEqual({ etag: expect.stringMatching(/^"1-[0-9a-f]{8}"$/), uid: 'lunch' });
    expect(() => store.putNative(cal.id, href(cal, 'lunch'), raw, null, opts)).toThrow(/look again/);
    expect(store.list([cal.id], ...W).map((o) => [o.summary, o.start, o.etag])).toEqual([['Lunch', '2026-11-04T12:00:00.000Z', made.etag]]);
    const moved = editEvent(raw, 'lunch', 0, 'all', { start: '2026-11-04T13:00:00Z', end: '2026-11-04T14:00:00Z' }, ctx, () => 'x').raw;
    expect(moved).toMatch(/SEQUENCE:1/);
    expect(() => store.putNative(cal.id, href(cal, 'lunch'), moved, '"9-00000000"', opts)).toThrow(/changed since/);
    const updated = store.putNative(cal.id, href(cal, 'lunch'), moved, made.etag, opts);
    expect(updated.etag).toMatch(/^"2-/);
    expect(store.find(cal.id, 'lunch', null)?.event).toMatchObject({ start: '2026-11-04T13:00:00.000Z', etag: updated.etag });
    expect(() => store.deleteNative(cal.id, href(cal, 'lunch'), made.etag)).toThrow(/changed/);
    expect(store.deleteNative(cal.id, href(cal, 'lunch'), updated.etag).uid).toBe('lunch');
    expect(store.list([cal.id], ...W)).toEqual([]);
    expect(() => store.deleteNative(cal.id, href(cal, 'lunch'), null)).toThrow(/no such event/);
  });

  it('applies the recurrence scopes to the stored text and expands what was written', () => {
    const { store, cal } = native();
    const raw = newEvent('r', { summary: 'Review', start: '2026-11-09T15:00:00Z', end: '2026-11-09T16:00:00Z', timezone: 'UTC', recurrence: ['RRULE:FREQ=DAILY;COUNT=10'] }, ctx);
    let etag = store.putNative(cal.id, href(cal, 'r'), raw, null, opts).etag;
    const list = () => store.list([cal.id], ...W).map((o) => o.start.slice(5, 16));
    expect(list()).toHaveLength(10);
    // this: an exception on the 11th
    let stored = store.objectByUid(cal.id, 'r')!.raw;
    etag = store.putNative(cal.id, href(cal, 'r'), editEvent(stored, 'r', at('2026-11-11T15:00:00Z'), 'this', { start: '2026-11-11T17:00:00Z', end: '2026-11-11T18:00:00Z' }, ctx, () => 'x').raw, etag, opts).etag;
    expect(list()).toContain('11-11T17:00');
    // following: a new series from the 14th, the old one ended with UNTIL
    stored = store.objectByUid(cal.id, 'r')!.raw;
    const split = editEvent(stored, 'r', at('2026-11-14T15:00:00Z'), 'following', { start: '2026-11-14T14:00:00Z', end: '2026-11-14T15:00:00Z' }, ctx, () => 'r2');
    store.putNative(cal.id, href(cal, 'r2'), split.created!.raw, null, opts);
    etag = store.putNative(cal.id, href(cal, 'r'), split.raw, etag, opts).etag;
    expect(store.objectByUid(cal.id, 'r')!.raw).toMatch(/UNTIL=/);
    expect(list().filter((d) => d >= '11-14')).toEqual(['11-14T14:00', '11-15T14:00', '11-16T14:00', '11-17T14:00', '11-18T14:00']);
    // this, deleted: an EXDATE; all: the series gone
    stored = store.objectByUid(cal.id, 'r')!.raw;
    etag = store.putNative(cal.id, href(cal, 'r'), deleteFromEvent(stored, 'r', at('2026-11-10T15:00:00Z'), 'this', ctx)!, etag, opts).etag;
    expect(list()).not.toContain('11-10T15:00');
    expect(list().filter((d) => d < '11-14')).toEqual(['11-09T15:00', '11-11T17:00', '11-12T15:00', '11-13T15:00']);
    expect(deleteFromEvent(store.objectByUid(cal.id, 'r')!.raw, 'r', 0, 'all', ctx)).toBeNull();
    store.deleteNative(cal.id, href(cal, 'r'), etag);
    expect(list()).toHaveLength(5);
  });
});
