import { describe, expect, it } from 'vitest';
import type { CalendarInfo, EventOccurrence } from '../api';
import { alsoOnNote, mergeByUid } from './merge';
import { guestMark } from './sharing';

const cal = (id: string, owner?: string, hidden = false): CalendarInfo => ({
  id, accountId: owner ? `shared:${owner}` : 'acct-bob', name: id, color: '#039be5', timezone: null, role: owner ? 'reader' : 'owner',
  hidden, isDefault: false, syncedAt: '', ...(owner ? { shared: { ownerAccountId: owner, role: 'viewer' as const, principal: 'account:acct-bob' } } : {}),
} as CalendarInfo);
const occ = (calendarId: string, uid: string): EventOccurrence => ({ id: `${calendarId}:${uid}`, eventId: `${calendarId}:${uid}`, calendarId, summary: uid, location: null, description: null, start: '2026-11-05T17:00:00.000Z', end: '2026-11-05T18:00:00.000Z', allDay: false, timezone: null, recurring: false, status: 'confirmed', organizer: null, attendees: [], etag: '"1"', updated: '', reminders: [] });

const BOB = 'n.acct-bob.aaaaaaaaaaaa', ANN = 'n.acct-ann.bbbbbbbbbbbb', CAL = 'n.acct-cal.cccccccccccc';
const name = (a: string) => ({ 'acct-ann': 'Ann', 'acct-cal': 'Cal' })[a] ?? 'Someone';

describe('merging events by UID', () => {
  it("the person's own copy wins over a shared calendar's, listed in either order, and the card says where else it is", () => {
    const cals = [cal(BOB), cal(ANN, 'acct-ann')];
    const out = mergeByUid([occ(ANN, 'plan'), occ(BOB, 'plan'), occ(ANN, 'solo')], cals);
    expect(out.map((o) => o.id).sort()).toEqual([`${ANN}:solo`, `${BOB}:plan`]);
    const mine = out.find((o) => o.calendarId === BOB)!;
    expect(alsoOnNote(mine, cals, name)).toBe("Also on Ann's calendar");
    expect(alsoOnNote(out.find((o) => o.calendarId === ANN)!, cals, name)).toBeNull();
  });
  it('on two shared calendars the first is kept', () => {
    const cals = [cal(ANN, 'acct-ann'), cal(CAL, 'acct-cal')];
    const out = mergeByUid([occ(ANN, 'x'), occ(CAL, 'x')], cals);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ calendarId: ANN, alsoOn: [CAL] });
  });
  it('a hidden calendar does not claim the event, so the shared copy shows', () => {
    const out = mergeByUid([occ(BOB, 'p'), occ(ANN, 'p')], [cal(BOB, undefined, true), cal(ANN, 'acct-ann')]);
    expect(out.find((o) => o.calendarId === ANN)?.alsoOn).toBeUndefined();
    expect(out).toHaveLength(2);
  });
  it('occurrences of one series on different dates stay apart', () => {
    expect(mergeByUid([occ(BOB, 's:2026-11-05'), occ(BOB, 's:2026-11-12')], [cal(BOB)])).toHaveLength(2);
  });
});

describe('the guest list mark', () => {
  const members = [{ accountId: 'acct-ann', isAgent: false }, { accountId: 'acct-bot', isAgent: true }];
  it('an agent is "agent", a person "member", an address "outside"; nothing on a connected calendar', () => {
    expect(guestMark({ calendarId: BOB }, { accountId: 'acct-bot' }, members)).toBe('agent');
    expect(guestMark({ calendarId: BOB }, { accountId: 'acct-ann' }, members)).toBe('member');
    expect(guestMark({ calendarId: BOB }, {}, members)).toBe('outside');
    expect(guestMark({ calendarId: 'g@example.com' }, { accountId: 'acct-bot' }, members)).toBeNull();
  });
});
