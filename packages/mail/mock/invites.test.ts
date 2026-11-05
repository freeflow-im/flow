import { describe, expect, it } from 'vitest';
import { createMockApi } from './plugin';

describe('the mock\'s invitations', () => {
  it('reads the invitation and the cancellation in the sample inbox, answers and removes', async () => {
    const api = createMockApi();
    const call = async (method: string, path: string, body?: unknown) => (await api(method, new URL(path, 'http://mock'), body)).json as Record<string, never>;
    const { messages } = (await call('GET', '/v1/mail/accounts/acc_ann/messages?folder=INBOX&limit=100')) as unknown as { messages: { uid: number; subject: string }[] };
    const uidOf = (s: string) => messages.find((m) => m.subject === s)!.uid;
    const ref = (s: string) => ({ account: 'acc_ann', messageId: { folder: 'INBOX', uid: uidOf(s) }, part: 0 });
    const invite = await call('POST', '/v1/calendar/invites', ref('Invitation: Q3 planning'));
    expect(invite).toMatchObject({ action: 'request', onCalendar: null, event: { summary: 'Q3 planning', location: 'Room 4', recurrence: ['RRULE:FREQ=WEEKLY;COUNT=6'], conference: { label: 'Google Meet' } } });
    expect((invite.event as unknown as { attendees: { self?: true }[] }).attendees.filter((a) => a.self)).toHaveLength(1);
    expect(await call('POST', '/v1/calendar/invites/respond', { ...ref('Invitation: Q3 planning'), response: 'accepted' })).toMatchObject({ replied: 'server', onCalendar: { myResponse: 'accepted' } });
    expect(await call('POST', '/v1/calendar/invites', ref('Cancelled event: Vendor call'))).toMatchObject({ action: 'cancel', onCalendar: { calendarId: 'work' } });
    expect(await call('POST', '/v1/calendar/invites/cancel', ref('Cancelled event: Vendor call'))).toMatchObject({ removed: true, onCalendar: null });
  });
});
