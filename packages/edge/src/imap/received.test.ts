import { describe, expect, it } from 'vitest';
import { invitationIndex } from './received';

describe('the invitation in a message', () => {
  it('is the text/calendar part, else the first iCalendar file, else none', () => {
    // Google's shape: the invitation as an alternative to the text, and again as invite.ics.
    expect(invitationIndex([{ index: 0, mimeType: 'application/ics', filename: 'invite.ics' }, { index: 1, mimeType: 'text/calendar; method=REQUEST', filename: 'attachment-2' }])).toBe(1);
    expect(invitationIndex([{ index: 0, mimeType: 'application/pdf', filename: 'a.pdf' }, { index: 1, mimeType: 'application/octet-stream', filename: 'Meeting.ICS' }])).toBe(1);
    expect(invitationIndex([{ index: 0, mimeType: 'application/pdf', filename: 'a.pdf' }])).toBeNull();
    expect(invitationIndex(undefined)).toBeNull();
  });
});
