import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CalendarInfo, EventOccurrence } from '../api';
import { EventCard } from './EventPopover';

afterEach(cleanup);

const event = {
  id: 'e1', eventId: 'e1', calendarId: 'c1', summary: 'Sprint planning', start: '2026-11-16T17:30:00Z', end: '2026-11-16T18:00:00Z',
  allDay: false, status: 'confirmed', attendees: [], reminders: [], recurring: false,
} as unknown as EventOccurrence;
const calendar = { id: 'c1', name: 'Work', color: '#1a73e8', access: 'owner' } as unknown as CalendarInfo;

describe('EventCard (the side panel\'s event card)', () => {
  it('names the edit button as asked, and leaves out delete when it is not offered', () => {
    const edits: string[] = [];
    render(
      <QueryClientProvider client={new QueryClient()}>
        <EventCard event={event} calendar={calendar} editLabel="Edit in Calendar" onClose={() => {}} onEdit={() => edits.push('edit')} onRespond={() => {}} />
      </QueryClientProvider>,
    );
    expect(screen.getByText('Sprint planning')).toBeTruthy();
    expect(screen.queryByLabelText('Delete event')).toBeNull();
    fireEvent.click(screen.getByLabelText('Edit in Calendar'));
    expect(edits).toEqual(['edit']);
  });
});
