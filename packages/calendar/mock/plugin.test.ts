import { describe, expect, it } from 'vitest';
import type { EventOccurrence } from '../src/api';
import { createMockApi } from './plugin';

const week = () => { const s = new Date(); s.setHours(0, 0, 0, 0); s.setDate(s.getDate() - ((s.getDay() + 6) % 7)); const e = new Date(s); e.setDate(s.getDate() + 7); return { from: s.toISOString(), to: e.toISOString() }; };

describe('the mock calendar API', () => {
  it('lists the sample week, a repeating standup with one occurrence skipped and one moved', async () => {
    const api = createMockApi();
    const { from, to } = week();
    const r = await api('GET', new URL(`http://mock/v1/calendar/events?from=${from}&to=${to}`), undefined);
    const standups = (r.json as { events: EventOccurrence[] }).events.filter((e) => e.eventId === 'work:standup');
    expect(standups).toHaveLength(2);
    expect(standups.some((s) => s.summary.startsWith('Standup (late'))).toBe(true);
  });

  it('moves one occurrence, splits a series and deletes, and starts empty when asked', async () => {
    const api = createMockApi();
    const { from, to } = week();
    const list = async () => ((await api('GET', new URL(`http://mock/v1/calendar/events?from=${from}&to=${to}`), undefined)).json as { events: EventOccurrence[] }).events;
    const gym = (await list()).filter((e) => e.eventId === 'personal:gym');
    expect(gym).toHaveLength(3);
    const second = gym[1]!;
    await api('PATCH', new URL(`http://mock/v1/calendar/events/${encodeURIComponent(second.id)}`), { start: new Date(Date.parse(second.start) + 3_600_000).toISOString(), scope: 'following' });
    const after = (await list()).filter((e) => e.summary === 'Gym');
    expect(after.map((e) => e.eventId === 'personal:gym')).toEqual([true, false, false]);
    await api('DELETE', new URL(`http://mock/v1/calendar/events/${encodeURIComponent(gym[0]!.id)}?scope=this`), undefined);
    expect((await list()).filter((e) => e.eventId === 'personal:gym')).toHaveLength(0);
    const empty = createMockApi(true);
    expect((await empty('GET', new URL('http://mock/v1/calendar/accounts'), undefined)).json).toEqual({ accounts: [] });
    await expect(empty('POST', new URL('http://mock/v1/calendar/accounts'), { email: 'a@b.c', displayName: '', password: 'wrong' })).rejects.toThrow(/refused/);
  });

  it('connects a Google account by the skipped consent, with a read-only holidays calendar, and returns there', async () => {
    const api = createMockApi(true);
    const r = await api('GET', new URL('http://mock/v1/calendar/google/start?return=http%3A%2F%2Flocalhost%3A5186%2Fcalendar%2F'), undefined);
    const back = new URL((r.json as { url: string }).url);
    expect(back.origin + back.pathname).toBe('http://localhost:5186/calendar/');
    const id = back.searchParams.get('connected');
    const cals = ((await api('GET', new URL('http://mock/v1/calendar/calendars'), undefined)).json as { calendars: { accountId: string; role: string; isDefault: boolean }[] }).calendars;
    expect(cals.filter((c) => c.accountId === id).map((c) => [c.role, c.isDefault])).toEqual([['owner', true], ['reader', false]]);
    const denied = await api('GET', new URL('http://mock/v1/calendar/google/start?email=denied%40gmail.com'), undefined);
    expect((denied.json as { url: string }).url).toContain('error=access_denied');
  });
});

