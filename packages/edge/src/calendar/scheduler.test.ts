import { describe, expect, it } from 'vitest';
import {
  ConfigPatch, applyPatch, busyOf, dateIn, daysWithSlots, defaultConfig, monthWindow, newPageToken, normalizePageToken, openSlots, type SchedulerConfig,
} from './scheduler';

const LA = 'America/Los_Angeles';
const at = (iso: string) => Date.parse(iso);
const times = (slots: number[], zone = LA) => slots.map((s) => new Date(s).toLocaleTimeString('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit' }));
const page = (patch: Partial<SchedulerConfig> = {}): SchedulerConfig => ({ ...defaultConfig(LA), enabled: true, ...patch });
// Monday 16 November 2026, 00:00 in Los Angeles (UTC-8).
const MON = at('2026-11-16T08:00:00Z');
const NOW = at('2026-11-01T00:00:00Z');
const dayOf = (ms: number) => [ms, ms + 24 * 3_600_000] as const;

describe('open slots', () => {
  it('offers 9:00 to 16:30 every half hour on a weekday by default, nothing at the weekend', () => {
    const [from, to] = dayOf(MON);
    const s = openSlots(page(), { now: at('2026-11-01T00:00:00Z'), from, to, duration: 30, busy: [] });
    expect(times(s)).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30']);
    const sat = MON - 2 * 24 * 3_600_000;
    expect(openSlots(page(), { now: at('2026-11-01T00:00:00Z'), from: sat, to: sat + 24 * 3_600_000, duration: 30, busy: [] })).toEqual([]);
  });

  it('fits a longer meeting inside its range and around busy time and buffers', () => {
    const [from, to] = dayOf(MON);
    const busy = busyOf([{ eventId: 'a', start: '2026-11-16T19:00:00Z', end: '2026-11-16T20:00:00Z', allDay: false, status: 'confirmed' }], LA); // 11:00–12:00
    const s = openSlots(page({ bufferAfterMin: 15, bufferBeforeMin: 15 }), { now: NOW, from, to, duration: 60, busy });
    // 10:00 would end at 11:00, inside the 15 minutes before the busy hour; 12:30 is the first start after its 15 minutes.
    expect(times(s)).toEqual(['09:00', '09:30', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00']);
    expect(times(s)).not.toContain('10:00');
  });

  it('skips free, cancelled and declined events, and blocks an all-day event in the page\'s zone', () => {
    const [from, to] = dayOf(MON);
    const occ = [
      { eventId: 'free', start: '2026-11-16T17:00:00Z', end: '2026-11-16T18:00:00Z', allDay: false, status: 'confirmed', transparent: true as const },
      { eventId: 'gone', start: '2026-11-16T17:00:00Z', end: '2026-11-16T18:00:00Z', allDay: false, status: 'cancelled' },
      { eventId: 'no', start: '2026-11-16T17:00:00Z', end: '2026-11-16T18:00:00Z', allDay: false, status: 'confirmed', myResponse: 'declined' },
    ];
    expect(openSlots(page(), { now: NOW, from, to, duration: 30, busy: busyOf(occ, LA) })).toHaveLength(16);
    const allDay = busyOf([{ eventId: 'off', start: '2026-11-16', end: '2026-11-17', allDay: true, status: 'confirmed' }], LA);
    expect(openSlots(page(), { now: NOW, from, to, duration: 30, busy: allDay })).toEqual([]);
    // Leaving one event out (a booking being moved) frees its time.
    expect(openSlots(page(), { now: NOW, from, to, duration: 30, busy: busyOf([{ eventId: 'off', start: '2026-11-16', end: '2026-11-17', allDay: true, status: 'confirmed' }], LA, 'off') })).toHaveLength(16);
  });

  it('keeps the notice, the horizon and the most bookings a day', () => {
    const [from, to] = dayOf(MON);
    // Now is 10:10 Monday; with 4 hours' notice the first start is 14:30.
    expect(times(openSlots(page(), { now: at('2026-11-16T18:10:00Z'), from, to, duration: 30, busy: [] }))[0]).toBe('14:30');
    // A horizon of one day from the Saturday before: Monday is past it.
    expect(openSlots(page({ horizonDays: 1 }), { now: at('2026-11-14T18:00:00Z'), from, to, duration: 30, busy: [] })).toEqual([]);
    expect(openSlots(page({ maxPerDay: 2 }), { now: NOW, from, to, duration: 30, busy: [], bookedOn: new Map([['2026-11-16', 2]]) })).toEqual([]);
  });

  it('splits a day with a lunch break and steps by the page\'s increment', () => {
    const [from, to] = dayOf(MON);
    const c = page({ weekly: { ...defaultConfig(LA).weekly, mon: [[9 * 60, 12 * 60], [13 * 60, 15 * 60]] }, incrementMin: 60 });
    expect(times(openSlots(c, { now: NOW, from, to, duration: 45, busy: [] }))).toEqual(['09:00', '10:00', '11:00', '13:00', '14:00']);
  });

  it('is right on the days the clocks change', () => {
    // Sunday 14 March 2027 (spring forward) and Sunday 1 November 2026 (fall back), opened for the test.
    const sundays = { ...defaultConfig(LA).weekly, sun: [[9 * 60, 11 * 60]] as [number, number][] };
    for (const day of ['2027-03-14', '2026-11-01']) {
      const now = at(`${day}T00:00:00Z`) - 7 * 24 * 3_600_000;
      const [from, to] = monthWindow(day.slice(0, 7), LA);
      const s = openSlots(page({ weekly: sundays }), { now, from, to, duration: 60, busy: [] }).filter((x) => dateIn(x, LA) === day);
      expect(times(s)).toEqual(['09:00', '09:30', '10:00']);
    }
  });

  it('groups by the guest\'s date, where the owner\'s day crosses midnight', () => {
    // Owner in Los Angeles, guest in Tokyo (17 hours ahead): Monday 9:00–17:00 there is Tuesday 2:00–10:00 in Tokyo.
    const [from, to] = monthWindow('2026-11', 'Asia/Tokyo');
    const s = openSlots(page({ weekly: { ...defaultConfig(LA).weekly, tue: [], wed: [], thu: [], fri: [] } }), { now: at('2026-11-01T00:00:00Z'), from, to, duration: 30, busy: [] });
    expect(daysWithSlots(s, 'Asia/Tokyo')).toEqual(['2026-11-03', '2026-11-10', '2026-11-17', '2026-11-24']);
    expect(daysWithSlots(s, LA)).toEqual(['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23']);
  });
});

describe('the settings', () => {
  it('sorts lengths, keeps the default among them, and refuses overlapping or empty ranges', () => {
    const c = applyPatch(defaultConfig(LA), ConfigPatch.parse({ durations: [60, 30, 45] }));
    expect(c.durations).toEqual([30, 45, 60]);
    expect(c.defaultDuration).toBe(30);
    expect(applyPatch(defaultConfig(LA), ConfigPatch.parse({ durations: [45, 60] })).defaultDuration).toBe(45);
    expect(() => ConfigPatch.parse({ durations: [20] })).toThrow();
    expect(() => applyPatch(defaultConfig(LA), ConfigPatch.parse({ weekly: { mon: [[600, 540]] } }))).toThrow(/end after/);
    expect(() => applyPatch(defaultConfig(LA), ConfigPatch.parse({ weekly: { mon: [[540, 720], [700, 800]] } }))).toThrow(/overlap/);
    expect(() => applyPatch(defaultConfig(LA), ConfigPatch.parse({ timezone: 'Mars/Olympus' }))).toThrow(/time zone/);
    expect(() => applyPatch(defaultConfig(LA), ConfigPatch.parse({ location: { kind: 'text', value: ' ' } }))).toThrow(/location/);
    expect(() => ConfigPatch.parse({ owner: 'x' })).toThrow();
  });
});

describe('the page token', () => {
  it('is three groups of four, and reads back in any case, without dashes, with look-alike letters', () => {
    const t = newPageToken();
    expect(t).toMatch(/^[0-9a-hjkmnp-tv-z]{4}-[0-9a-hjkmnp-tv-z]{4}-[0-9a-hjkmnp-tv-z]{4}$/);
    expect(normalizePageToken(t.toUpperCase())).toBe(t.replace(/-/g, ''));
    expect(normalizePageToken('k7mq x3vd p9tr')).toBe('k7mqx3vdp9tr');
    expect(normalizePageToken('k7mq-x3vd-p9tO')).toBe('k7mqx3vdp9t0');
    expect(normalizePageToken('k7mq-x3vd-p9tl')).toBe('k7mqx3vdp9t1');
    expect(normalizePageToken('k7mq-x3vd-p9u1')).toBeNull();
    expect(normalizePageToken('short')).toBeNull();
  });
});
