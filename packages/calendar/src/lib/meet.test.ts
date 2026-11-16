import { describe, expect, it } from 'vitest';
import { conferenceOf, shownDescription } from './conference';
import { meetLinkIn, withMeetLink, withoutMeetLink } from './meet';

const URL = 'https://app.freeflow.im/meet/kqd-wmzt-fra';
const base = { conference: undefined, location: null, description: null } as const;

describe('FreeFlow Meet on an event', () => {
  it('writes the link as one line at the end of the description, and takes it out again', () => {
    const d = withMeetLink('Agenda: the plan.', URL);
    expect(d).toBe(`Agenda: the plan.\n\nJoin with FreeFlow Meet: ${URL}`);
    expect(meetLinkIn(d)).toBe(URL);
    expect(withoutMeetLink(d)).toBe('Agenda: the plan.');
    expect(withMeetLink('', URL)).toBe(`Join with FreeFlow Meet: ${URL}`);
    expect(meetLinkIn('Join with FreeFlow Meet: https://example.com/other')).toBeNull();
  });

  it('is the card’s Join button, and its line is not shown twice in the description', () => {
    const call = conferenceOf({ ...base, description: withMeetLink('Bring notes.', URL) });
    expect(call).toMatchObject({ url: URL, label: 'Join with FreeFlow Meet', shown: 'app.freeflow.im/meet/kqd-wmzt-fra' });
    expect(shownDescription(withMeetLink('Bring notes.', URL))).toBe('Bring notes.');
  });

  it('a Meet link alone in the location is one too', () => {
    expect(conferenceOf({ ...base, location: URL })).toMatchObject({ url: URL, label: 'Join with FreeFlow Meet' });
    expect(conferenceOf({ ...base, location: 'https://meet.google.com/abc-defg-hij' })).toBeNull();
  });
});
