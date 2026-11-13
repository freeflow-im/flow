import { describe, expect, it } from 'vitest';
import type { Attendee, EventOccurrence } from '../api';
import { conferenceOf, descriptionText, dialIn, groupPin, labelFor, linkify, shownDescription } from './conference';
import { cardWhen, guestName, guestSummary, orderedGuests } from './format';

const FENCE = '-::~:~::~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~::~:~::-';
const MEET = [FENCE, 'Join with Google Meet: https://meet.google.com/gvq-yykt-idt', 'Or dial: (US) +1 413-752-4874 PIN: 522324683#',
  'More phone numbers: https://tel.meet/gvq-yykt-idt?pin=3144435762968&hs=7', '', 'Learn more about Meet at: https://support.google.com/a/users/answer/9282720', '', 'Please do not edit this section.', FENCE].join('\n');
const ZOOM = ['Agenda: the pilot.', '', 'Join Zoom Meeting', 'https://us02web.zoom.us/j/81234567890?pwd=abc', '', 'Meeting ID: 812 3456 7890', 'Passcode: 4321', '', '---', '', 'One tap mobile',
  '+16699006833,,81234567890#,,,,*4321# US (San Jose)', '+13462487799,,81234567890#,,,,*4321# US (Houston)', '', 'Dial by your location', '        +1 669 900 6833 US (San Jose)', '', 'Meeting ID: 812 3456 7890', 'Passcode: 4321',
  'Find your local number: https://us02web.zoom.us/u/kd1234', '', 'Thanks, Ann'].join('\n');
const base = { conference: undefined, location: null } as Pick<EventOccurrence, 'conference' | 'description' | 'location'>;

describe('the video call', () => {
  it('reads Google Meet\'s block: the link, the dial-in with its PIN in threes, more numbers; and takes it out of the description', () => {
    const c = conferenceOf({ ...base, description: MEET, conference: { url: 'https://meet.google.com/gvq-yykt-idt', label: 'Google Meet' } })!;
    expect(c).toEqual({
      url: 'https://meet.google.com/gvq-yykt-idt', label: 'Join with Google Meet', shown: 'meet.google.com/gvq-yykt-idt',
      dialIn: { text: '(US) +1 413-752-4874 PIN: 522 324 683#', tel: 'tel:+14137524874,,522324683%23', pin: '522 324 683#' },
      morePhones: 'https://tel.meet/gvq-yykt-idt?pin=3144435762968&hs=7',
    });
    expect(shownDescription(MEET)).toBeNull();
    expect(shownDescription(`Bring the numbers.\n\n${MEET}`)).toBe('Bring the numbers.');
  });

  it('reads Zoom\'s invitation text and keeps what was written around it', () => {
    const c = conferenceOf({ ...base, description: ZOOM })!;
    expect(c).toMatchObject({ url: 'https://us02web.zoom.us/j/81234567890?pwd=abc', label: 'Join Zoom Meeting', shown: 'us02web.zoom.us/j/81234567890', meetingId: '812 3456 7890', passcode: '4321', morePhones: 'https://us02web.zoom.us/u/kd1234' });
    expect(c.dialIn?.tel).toBe('tel:+16699006833,,81234567890%23');
    expect(shownDescription(ZOOM)).toBe('Agenda: the pilot.\n\nThanks, Ann');
  });

  it('names the provider by the link, and has nothing to say without one', () => {
    expect(labelFor('https://teams.microsoft.com/l/meetup-join/x')).toBe('Join Microsoft Teams meeting');
    expect(labelFor('https://whereby.com/room')).toBe('Join video call');
    expect(conferenceOf({ ...base, description: 'Lunch at noon.' })).toBeNull();
    expect(shownDescription('Lunch at noon.\n\n\n\nSee you')).toBe('Lunch at noon.\n\nSee you');
    expect(groupPin('1234#')).toBe('123 4#');
    expect(dialIn('not a number')).toBeNull();
  });

  it('reads an HTML description as text: breaks, lists, entities and links', () => {
    const zoom = 'This is a Zoom meeting. Click this link to join: <a href="https://us06web.zoom.us/j/832?pwd=Ab.1">https://us06web.zoom.us/j/832?pwd=Ab.1</a><br />Meeting ID: 832<br />Passcode: &amp;kS4^g';
    expect(descriptionText(zoom)).toBe('This is a Zoom meeting. Click this link to join: https://us06web.zoom.us/j/832?pwd=Ab.1\nMeeting ID: 832\nPasscode: &kS4^g');
    expect(descriptionText('<b>Agenda</b><ul><li>One</li><li>Two</li></ul>See <a href="https://x.test/doc">the doc</a>.')).toBe('Agenda\n• One\n• Two\nSee [the doc](https://x.test/doc).');
    expect(descriptionText('Plain <3 text, a < b')).toBe('Plain <3 text, a < b');
    const card = { description: zoom + '<br /><br />Agenda: <a href="https://x.test/doc">the doc</a>', location: null };
    expect(conferenceOf(card)).toMatchObject({ url: 'https://us06web.zoom.us/j/832?pwd=Ab.1', meetingId: '832', passcode: '&kS4^g' });
    expect(shownDescription(card.description)).toBe('Agenda: [the doc](https://x.test/doc)');
    expect(linkify('See [the doc](https://x.test/doc).')).toEqual([{ text: 'See ' }, { url: 'https://x.test/doc', label: 'the doc' }, { text: '.' }]);
  });

  it('makes links in a description clickable, leaving trailing punctuation out', () => {
    expect(linkify('Docs: https://x.test/a, and (https://y.test/b).')).toEqual([{ text: 'Docs: ' }, { url: 'https://x.test/a' }, { text: ', and (' }, { url: 'https://y.test/b' }, { text: ').' }]);
  });
});

describe('the card\'s lines', () => {
  const t = (start: string, end: string, allDay = false) => cardWhen({ start, end, allDay });
  it('says when as Google does, am/pm once when both halves share it', () => {
    expect(t('2026-11-05T18:00:00.000Z', '2026-11-05T19:00:00.000Z')).toBe('Thursday, November 5 · 1:00 – 2:00pm');
    expect(t('2026-11-05T16:30:00.000Z', '2026-11-05T17:30:00.000Z')).toBe('Thursday, November 5 · 11:30am – 12:30pm');
    expect(t('2026-11-06T04:00:00.000Z', '2026-11-06T05:00:00.000Z')).toBe('Thursday, November 5 · 11:00pm – 12:00am');
    expect(t('2026-11-06T03:00:00.000Z', '2026-11-06T07:00:00.000Z')).toBe('Nov 5, 10:00pm – Nov 6, 2:00am');
    expect(t('2026-11-05', '2026-11-06', true)).toBe('Thursday, November 5');
    expect(t('2026-11-05', '2026-11-08', true)).toBe('Nov 5 – 7, 2026');
    expect(t('2026-11-30', '2026-12-03', true)).toBe('Nov 30 – Dec 2, 2026');
    expect(t('2026-12-30', '2027-01-03', true)).toBe('Dec 30, 2026 – Jan 2, 2027');
  });

  it('puts the organizer first and the person second, and sums up the answers', () => {
    const a = (email: string, response: Attendee['response'], o: Partial<Attendee> = {}): Attendee => ({ name: null, email, role: 'required', response, ...o });
    const guests = orderedGuests({ organizer: a('raeven@corp.test', 'accepted', { name: 'Raeven Moon' }), attendees: [a('bo@corp.test', 'declined'), a('me@corp.test', 'needs-action', { self: true }), a('raeven@corp.test', 'accepted'), a('cy@corp.test', 'tentative'), a('di@corp.test', 'accepted')] });
    expect(guests.map((g) => g.email)).toEqual(['raeven@corp.test', 'me@corp.test', 'bo@corp.test', 'cy@corp.test', 'di@corp.test']);
    expect(guests[0]).toMatchObject({ organizer: true, name: 'Raeven Moon' });
    expect(guestSummary(guests)).toBe('2 yes, 1 no, 1 maybe, 1 awaiting');
    expect(guestSummary([{ response: 'accepted' }])).toBe('1 yes');
    expect(guestName({ name: 'x@corp.test', email: 'x@corp.test' })).toBeNull();
    expect(guestName({ name: 'Raeven Moon', email: 'raeven@corp.test' })).toBe('Raeven Moon');
  });
});
