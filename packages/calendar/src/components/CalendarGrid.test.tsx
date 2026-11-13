// The month grid draws each event's time and title (FullCalendar's own content). From 2026-11-09 to 11-12 it drew empty
// chips: under React, an eventContent that returns `undefined` renders nothing; `true` asks for the default.
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CalendarInfo, EventOccurrence } from '../api';
import { CalendarGrid } from './CalendarGrid';

const cal = { id: 'c1', accountId: 'a1', name: 'Work', color: '#3b82f6', timezone: null, role: 'owner', hidden: false, isDefault: true, syncedAt: null } as CalendarInfo;
const ev = (id: string, summary: string, start: string, end: string, allDay = false) => ({
  id, eventId: id, calendarId: 'c1', summary, start, end, allDay, location: null, description: null, timezone: null, recurring: false,
  status: 'confirmed', attendees: [], organizer: null, myResponse: null, etag: '"1"', reminders: [],
}) as unknown as EventOccurrence;
const noop = () => {};

describe('the month grid', () => {
  it('shows each event\'s time and title, not an empty chip', () => {
    const { container } = render(
      <div style={{ height: 800 }}>
        <CalendarGrid view="month" date={new Date('2026-11-15T12:00:00')} weekStartsOn={0} selecting={false} calendars={[cal]}
          occurrences={[ev('c1:a', 'Gym', '2026-11-16T12:00:00Z', '2026-11-16T13:00:00Z'), ev('c1:b', 'Offsite', '2026-11-17', '2026-11-19', true)]}
          onSelect={noop} onOpen={noop} onDay={noop} onChange={noop} />
      </div>,
    );
    const chips = [...container.querySelectorAll('.fc-daygrid-event')].map((e) => e.textContent?.trim());
    expect(chips).toContain('Offsite');
    expect(chips.some((t) => t?.includes('Gym') && t.includes('7'))).toBe(true);
    expect(chips.every((t) => !!t)).toBe(true);
  });
});
