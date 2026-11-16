import { describe, expect, it } from 'vitest';
import type { CalendarEvent } from '../api';
import { todayCalls } from './today';

const ev = (id: string, start: string, end: string, more: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id, summary: id, start, end, allDay: false, status: 'confirmed', ...more,
});
const MEET = 'Join with FreeFlow Meet: https://app.freeflow.im/meet/kqd-wmzt-fra';

describe('Meet’s Today list', () => {
  it('lists the calls not yet over, earliest first, with their kind; skips the rest', () => {
    const now = new Date('2026-11-16T15:00:00Z');
    const calls = todayCalls(
      [
        ev('later', '2026-11-16T17:00:00Z', '2026-11-16T17:30:00Z', { location: 'https://us06web.zoom.us/j/832' }),
        ev('running', '2026-11-16T14:30:00Z', '2026-11-16T15:30:00Z', { description: MEET }),
        ev('over', '2026-11-16T09:00:00Z', '2026-11-16T10:00:00Z', { description: MEET }),
        ev('no call', '2026-11-16T18:00:00Z', '2026-11-16T19:00:00Z', { location: 'Room 4' }),
        ev('cancelled', '2026-11-16T18:00:00Z', '2026-11-16T19:00:00Z', { description: MEET, status: 'cancelled' }),
        ev('all day', '2026-11-16T00:00:00Z', '2026-11-17T00:00:00Z', { description: MEET, allDay: true }),
      ],
      now,
    );
    expect(calls.map((c) => [c.id, c.kind, c.now])).toEqual([
      ['running', 'FreeFlow Meet', true],
      ['later', 'Zoom', false],
    ]);
  });
});
