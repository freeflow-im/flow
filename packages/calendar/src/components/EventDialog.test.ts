import { describe, expect, it } from 'vitest';
import type { EventOccurrence } from '../api';
import { draftOf, inputOf, newDraft, patchOf } from './EventDialog';

const occ: EventOccurrence = {
  id: 'c:u:20261105T170000Z', eventId: 'c:u', calendarId: 'c', summary: 'Lunch', location: 'Cafe', description: null, start: '2026-11-05T17:00:00.000Z', end: '2026-11-05T18:00:00.000Z',
  allDay: false, timezone: 'America/New_York', recurring: true, recurrenceId: '20261105T170000Z', status: 'confirmed', organizer: null, attendees: [], etag: '"1"', updated: '', reminders: [10], recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH'],
};

describe('the edit dialog\'s drafts', () => {
  it('makes a new event from a selection, all-day ending the day after its last', () => {
    const d = newDraft(new Date(2026, 10, 5), new Date(2026, 10, 7), true, 'c');
    expect(inputOf(d)).toMatchObject({ start: '2026-11-05', end: '2026-11-07', allDay: true, calendarId: 'c' });
    const t = newDraft(new Date(2026, 10, 5, 9), new Date(2026, 10, 5, 10), false, 'c', 'Standup');
    expect(inputOf(t)).toMatchObject({ summary: 'Standup', start: '2026-11-05T09:00', end: '2026-11-05T10:00', timezone: 'America/New_York', reminders: [{ minutes: 10 }] });
  });

  it('reads an occurrence in its zone, and sends only what changed', () => {
    const d = draftOf(occ);
    expect(d).toMatchObject({ startDate: '2026-11-05', startTime: '12:00', endTime: '13:00', timezone: 'America/New_York', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH'] });
    expect(patchOf(d, d)).toEqual({});
    expect(patchOf(d, { ...d, summary: 'Brunch' })).toEqual({ summary: 'Brunch' });
    expect(patchOf(d, { ...d, startTime: '13:00', endTime: '14:00' })).toEqual({ start: '2026-11-05T13:00', end: '2026-11-05T14:00', allDay: false, timezone: 'America/New_York' });
    expect(patchOf(d, { ...d, recurrence: [] })).toEqual({ recurrence: null });
    expect(patchOf(d, { ...d, location: '' })).toEqual({ location: null });
  });
});
