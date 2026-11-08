// A schedule's `every` and its next instant, in the schedule's own timezone.
import { describe, expect, it } from 'vitest';
import { nextScheduleAt, recurrenceOf } from './schedule';

const at = (iso: string) => Date.parse(iso);

describe('schedules', () => {
  it('reads the four shapes, and nothing else', () => {
    expect(recurrenceOf('hourly')).toEqual({ type: 'hourly', minute: 0 });
    expect(recurrenceOf('daily@09:30')).toEqual({ type: 'daily', hour: 9, minute: 30 });
    expect(recurrenceOf('weekly@mon 08:00')).toEqual({ type: 'weekly', weekday: 1, hour: 8, minute: 0 });
    expect(recurrenceOf('monthly@15 07:05')).toEqual({ type: 'cron', expression: '5 7 15 * *' });
    for (const bad of ['', 'daily', 'daily@9:30', 'daily@24:00', 'weekly@FRIDAY 08:00', 'monthly@32 01:00', 'every 5 minutes']) expect(recurrenceOf(bad)).toBeNull();
  });

  it('gives the next instant after now, strictly, in the zone', () => {
    expect(nextScheduleAt('hourly', 'UTC', at('2026-11-06T10:20:00Z'))).toBe(at('2026-11-06T11:00:00Z'));
    expect(nextScheduleAt('hourly', 'UTC', at('2026-11-06T11:00:00Z'))).toBe(at('2026-11-06T12:00:00Z'));
    expect(nextScheduleAt('daily@09:00', 'America/Los_Angeles', at('2026-11-06T18:00:00Z'))).toBe(at('2026-11-07T17:00:00Z'));
    // Across the March DST change, 9:00 local moves an hour earlier in UTC.
    expect(nextScheduleAt('daily@09:00', 'America/Los_Angeles', at('2027-03-13T17:30:00Z'))).toBe(at('2027-03-14T16:00:00Z'));
    expect(nextScheduleAt('weekly@MON 08:00', 'UTC', at('2026-11-06T00:00:00Z'))).toBe(at('2026-11-09T08:00:00Z'));
    expect(nextScheduleAt('monthly@1 00:00', 'UTC', at('2026-11-06T00:00:00Z'))).toBe(at('2026-12-01T00:00:00Z'));
    expect(nextScheduleAt('daily@09:00', 'Not/AZone', 0)).toBeNull();
  });
});
