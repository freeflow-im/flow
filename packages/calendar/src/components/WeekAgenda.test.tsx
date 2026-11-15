import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CalendarInfo, EventOccurrence } from '../api';
import { panelTitle } from '../PanelApp';
import { eventsOfDay, WeekAgenda } from './WeekAgenda';

afterEach(cleanup);

const ev = (id: string, summary: string, start: string, end: string, allDay = false, extra: Partial<EventOccurrence> = {}) =>
  ({ id, eventId: id, calendarId: 'c1', summary, start, end, allDay, status: 'confirmed', attendees: [], ...extra }) as unknown as EventOccurrence;
const cals = [{ id: 'c1', color: '#1a73e8', hidden: false }, { id: 'c2', color: '#d50000', hidden: true }] as unknown as CalendarInfo[];
const local = (s: string) => new Date(s).toISOString();

describe('WeekAgenda (the side panel\'s week)', () => {
  const sun = new Date(2026, 10, 8);
  const occurrences = [
    ev('a', 'Standup', local('2026-11-09T09:00'), local('2026-11-09T09:30')),
    ev('b', 'Q4 planning', '2026-11-11', '2026-11-12', true),
    ev('c', 'Investor update', local('2026-11-11T11:00'), local('2026-11-11T12:00')),
    ev('d', 'Offsite', local('2026-11-12T20:00'), local('2026-11-13T02:00')),
    ev('e', 'Hidden', local('2026-11-10T10:00'), local('2026-11-10T11:00'), false, { calendarId: 'c2' }),
    ev('f', 'Cancelled', local('2026-11-10T12:00'), local('2026-11-10T13:00'), false, { status: 'cancelled' }),
  ];

  it('puts each day\'s events in order, all-day first, and an overnight event on both days', () => {
    expect(eventsOfDay(occurrences, new Date(2026, 10, 11)).map((o) => o.summary)).toEqual(['Q4 planning', 'Investor update']);
    expect(eventsOfDay(occurrences, new Date(2026, 10, 12)).map((o) => o.summary)).toEqual(['Offsite']);
    expect(eventsOfDay(occurrences, new Date(2026, 10, 13)).map((o) => o.summary)).toEqual(['Offsite']);
    expect(eventsOfDay(occurrences, new Date(2026, 10, 10)).map((o) => o.summary)).toEqual(['Hidden']);
  });

  it('draws the seven days, an empty one as Nothing scheduled, leaves out hidden calendars, and opens a card', () => {
    const opened: string[] = [];
    render(<WeekAgenda start={sun} occurrences={occurrences} calendars={cals} onOpen={(o) => opened.push(o.id)} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(7);
    expect(screen.getAllByText('Nothing scheduled').length).toBe(3);
    expect(screen.queryByText('Hidden')).toBeNull();
    expect(screen.getByText('9 – 9:30 AM')).toBeTruthy();
    expect(screen.getByText('From 8 PM')).toBeTruthy();
    expect(screen.getByText('Until 2 AM')).toBeTruthy();
    fireEvent.click(screen.getByText('Investor update'));
    expect(opened).toEqual(['c']);
  });

  it('titles the panel short, with the year only when it is not this one', () => {
    const today = new Date(2026, 10, 14);
    expect(panelTitle('week', new Date(2026, 10, 10), today)).toBe('Nov 8 – 14');
    expect(panelTitle('week', new Date(2026, 10, 30), today)).toBe('Nov 29 – Dec 5');
    expect(panelTitle('day', new Date(2026, 10, 13), today)).toBe('Fri, Nov 13');
    expect(panelTitle('day', new Date(2027, 0, 4), today)).toBe('Mon, Jan 4, 2027');
  });
});
