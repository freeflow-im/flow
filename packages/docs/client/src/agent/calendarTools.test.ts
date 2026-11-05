import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmationFor, deleteCalendarEvent, deleteEventQuestion } from './clientTools.ts';
import { toolLabel } from './describe.ts';

// The Calendar tools the Docs assistant has on the hosted suite: delete_event runs here after the user confirms it, and
// Calendar's own view tools are refused; the labels say what was done.
describe('Calendar tools in Docs', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks before delete_event, by its scope', () => {
    expect(confirmationFor({ id: 't', name: 'delete_event', input: { id: 'c:u', scope: 'following' } }, null)).toBe('Delete this event and the events after it in the series?');
    expect(deleteEventQuestion({ scope: 'this' }, 'Gym')).toBe('Delete “Gym” from your calendar?');
  });

  it('deletes through /v1/calendar, and says when Calendar is not there', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { calls.push(`${init.method} ${url}`); return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } }); });
    expect(JSON.parse(await deleteCalendarEvent({ id: 'c:u:20261105T170000Z', scope: 'this' }))).toEqual({ deleted: 'c:u:20261105T170000Z', scope: 'this' });
    expect(calls).toEqual(['DELETE /v1/calendar/events/c%3Au%3A20261105T170000Z?scope=this']);
    vi.stubGlobal('fetch', async () => new Response('Not Found', { status: 404, headers: { 'content-type': 'text/html' } }));
    await expect(deleteCalendarEvent({ id: 'c:u' })).rejects.toThrow(/not available here/);
  });

  it('labels the Calendar tools', () => {
    expect(toolLabel('create_event', { summary: 'Lunch', start: '2026-11-05T12:00:00', attendees: ['Bo <bo@x.test>', 'cy@x.test'] })).toBe('Created “Lunch” Thu, Nov 5, 12:00 PM, invited Bo and cy');
    expect(toolLabel('find_free_time', { attendees: ['a@x.test', 'b@x.test', 'c@x.test'] })).toBe('Found free time with a, b and 1 more');
    expect(toolLabel('respond_to_event', { response: 'declined' })).toBe('Declined an invitation');
    expect(toolLabel('delete_event', { scope: 'all' })).toBe('Deleted a repeating event');
  });
});
