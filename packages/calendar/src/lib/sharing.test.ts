import { afterEach, describe, expect, it, vi } from 'vitest';
import { CalendarApiError, calendarApi, setCalendarWorkspace, type SharedCalendar } from '../api';
import { toFcEvent } from './occurrences';
import { addable, asCalendar, canChange, canShare, errorText, grantLabel, guestMark, readOnlyNote } from './sharing';

const ANNS = 'n.acct-ann.0123456789ab';
const shared = (role: SharedCalendar['role']): SharedCalendar => ({ id: ANNS, name: 'Ann', color: '#039be5', role, ownerAccountId: 'acct-ann', grantedBy: 'acct-ann', url: '', principal: 'account:acct-bob' });
const occ = { id: `${ANNS}:u`, eventId: `${ANNS}:u`, calendarId: ANNS, summary: 'Plan', location: null, description: null, start: '2026-11-05T17:00:00.000Z', end: '2026-11-05T18:00:00.000Z', allDay: false, timezone: null, recurring: false, status: 'confirmed' as const, organizer: null, attendees: [], etag: '"1"', updated: '', reminders: [] };

describe('a calendar shared with the person', () => {
  it('a viewer reads only: no drag or resize, no edit, the card says so; unticked until ticked, in this browser\'s colour', () => {
    const c = asCalendar(shared('viewer'), undefined);
    expect(c).toMatchObject({ id: ANNS, role: 'reader', hidden: true, isDefault: false, shared: { ownerAccountId: 'acct-ann', role: 'viewer' } });
    expect(canChange(c)).toBe(false);
    expect(toFcEvent(occ, c).editable).toBe(false);
    expect(readOnlyNote(c)).toBe('You can view this calendar');
    expect(canShare(c)).toBe(false);
    expect(asCalendar(shared('viewer'), { shown: true, color: '#d50000' })).toMatchObject({ hidden: false, color: '#d50000' });
  });

  it('an editor changes events as usual; a manager may share it on; the owner shares their own', () => {
    const editor = asCalendar(shared('editor'), { shown: true });
    expect([canChange(editor), toFcEvent(occ, editor).editable, readOnlyNote(editor), canShare(editor)]).toEqual([true, true, null, false]);
    expect(canShare(asCalendar(shared('manager'), undefined))).toBe(true);
    const own = { ...editor, shared: undefined, role: 'owner' as const };
    expect(canShare(own)).toBe(true);
    // A connected calendar is shared on its own server, not here.
    expect(canShare({ ...own, id: 'b2c1f6d0-caldav' })).toBe(false);
  });

  it('marks guests of a native event as members or outside; nothing on a connected calendar', () => {
    expect(guestMark(occ, { accountId: 'acct-bob' })).toBe('member');
    expect(guestMark(occ, {})).toBe('outside');
    expect(guestMark({ calendarId: 'b2c1f6d0-caldav' }, {})).toBeNull();
  });

  it('names whom a grant is to, and offers the rest (not the owner, not a direct message)', () => {
    const members = [
      { userId: 'u-ann', displayName: 'Ann', email: '', isAgent: false, accountId: 'acct-ann' },
      { userId: 'u-bob', displayName: 'Bob', email: '', isAgent: false, accountId: 'acct-bob' },
      { userId: 'u-bot', displayName: 'Builder', email: '', isAgent: true, accountId: 'acct-bot' },
      { userId: 'u-old', displayName: 'Old', email: '', isAgent: false },
    ];
    const channels = [{ id: 'ch-1', name: 'sales', isPrivate: false, archivedAt: null }, { id: 'dm-1', name: null, isPrivate: true, archivedAt: null }];
    expect(['account:acct-bot', 'channel:ch-1', 'org', 'account:acct-zed'].map((principal) => grantLabel({ principal }, members, channels, 'Acme'))).toEqual(['Builder (agent)', '#sales', 'Everyone in Acme', 'A member']);
    const offer = addable([{ principal: 'account:acct-bob' }], members, channels, 'acct-ann');
    expect(offer.people.map((m) => m.displayName)).toEqual(['Builder']);
    expect(offer.rooms.map((c) => c.id)).toEqual(['ch-1']);
    expect(offer.org).toBe(true);
    expect(addable([{ principal: 'org' }], members, channels, 'acct-ann').org).toBe(false);
  });

  it('a refusal reads as the server says it', () => {
    expect(errorText(new CalendarApiError('not_organizer', 'Only the organizer can change this event; answer the invitation instead', 403))).toMatch(/Only the organizer/);
    expect(errorText(new CalendarApiError('not_a_member', 'That account is not a member of this organization', 400))).toBe('That account is not a member of this organization');
    expect(errorText(new CalendarApiError('conflict', 'x', 409))).toBe('This event changed elsewhere. Showing the latest.');
  });
});

describe('the Share dialog\'s requests', () => {
  afterEach(() => vi.unstubAllGlobals());
  const answer = { grants: [], role: 'owner' };
  function stub(status = 200, body: unknown = answer) {
    const calls: { url: string; method: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }));
    return calls;
  }

  it('reads, gives, changes and takes away a grant on the calendar, naming the organization', async () => {
    setCalendarWorkspace('org-1');
    const calls = stub();
    await calendarApi.grants(ANNS);
    await calendarApi.setGrant(ANNS, 'account:acct-bob', 'viewer');
    await calendarApi.setGrant(ANNS, 'channel:ch-1', 'editor');
    await calendarApi.setGrant(ANNS, 'org', 'manager');
    await calendarApi.removeGrant(ANNS, 'account:acct-bob');
    expect(calls).toEqual([
      { url: `/v1/calendar/calendars/${ANNS}/grants?workspace=org-1`, method: 'GET', body: undefined },
      { url: `/v1/calendar/calendars/${ANNS}/grants?workspace=org-1`, method: 'PUT', body: { principal: 'account:acct-bob', role: 'viewer' } },
      { url: `/v1/calendar/calendars/${ANNS}/grants?workspace=org-1`, method: 'PUT', body: { principal: 'channel:ch-1', role: 'editor' } },
      { url: `/v1/calendar/calendars/${ANNS}/grants?workspace=org-1`, method: 'PUT', body: { principal: 'org', role: 'manager' } },
      { url: `/v1/calendar/calendars/${ANNS}/grants/account%3Aacct-bob?workspace=org-1`, method: 'DELETE', body: undefined },
    ]);
  });

  it('a refusal carries the server\'s code and message', async () => {
    stub(400, { error: { code: 'not_a_member', message: 'That account is not a member of this organization' } });
    await expect(calendarApi.setGrant(ANNS, 'account:acct-zed', 'viewer')).rejects.toMatchObject({ code: 'not_a_member', status: 400, message: 'That account is not a member of this organization' });
  });
});
