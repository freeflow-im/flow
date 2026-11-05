import { describe, expect, it } from 'vitest';
import type { Attachment } from '../api';
import { answeredText, createEventUrl, guestCount, invitationPart, isCalendarFile, replyLine, responseWord, threadPeople } from './invites';

const file = (index: number, filename: string, mimeType: string): Attachment => ({ index, filename, mimeType, size: 100, contentId: null, inline: false });

describe('the invitation part', () => {
  it('is the text/calendar part, as Google and Outlook send it, before the invite.ics file', () => {
    expect(invitationPart({ attachments: [file(0, 'invite.ics', 'application/ics'), file(1, 'attachment-2', 'text/calendar'), file(2, 'agenda.pdf', 'application/pdf')] })?.index).toBe(1);
    expect(invitationPart({ attachments: [file(0, 'agenda.pdf', 'application/pdf'), file(1, 'Meeting.ICS', 'application/octet-stream')] })?.index).toBe(1);
    expect(invitationPart({ attachments: [file(0, 'agenda.pdf', 'application/pdf')] })).toBeNull();
    expect(invitationPart({ attachments: [] })).toBeNull();
    expect(isCalendarFile({ filename: 'x', mimeType: 'text/calendar; method=REQUEST' })).toBe(true);
    expect(isCalendarFile({ filename: 'notes.txt', mimeType: 'text/plain' })).toBe(false);
  });
});

describe('the card\'s words', () => {
  it('counts the organizer among the guests once; says the answer and a reply', () => {
    const ann = { name: 'Ann Lee', email: 'ann@x.org', role: 'required' as const, response: 'accepted' as const };
    expect(guestCount({ organizer: ann, attendees: [ann, { ...ann, email: 'me@x.org', response: 'needs-action' }] })).toBe(2);
    expect(guestCount({ organizer: ann, attendees: [{ ...ann, email: 'me@x.org' }] })).toBe(2);
    expect(responseWord('accepted')).toBe('Going');
    expect(responseWord('declined')).toBe('Not going');
    expect(responseWord(null)).toBe('Not answered yet');
    expect(replyLine({ name: 'Ann Lee', email: 'ann@x.org', response: 'accepted' })).toBe('Ann Lee accepted');
    expect(replyLine({ name: null, email: 'bo@x.org', response: 'tentative' })).toBe('bo@x.org tentatively accepted');
  });

  it('the toast says whether the organizer was told', () => {
    expect(answeredText('accepted', { replied: 'email' }, 'Ann Lee')).toBe("You're going. Ann Lee was emailed your answer.");
    expect(answeredText('declined', { replied: 'server' }, 'Ann Lee')).toBe('You declined.');
    expect(answeredText('tentative', { replied: 'failed', replyError: 'SMTP is down' }, 'Ann')).toBe('You said maybe. It is on your calendar, but Ann could not be told: SMTP is down');
  });
});

describe('Create event from a thread', () => {
  it('names everyone on the thread but the person, once, and opens Calendar with them and the subject', () => {
    const people = threadPeople([
      { from: { name: 'Bob Martin', address: 'bob@acme.test' }, to: [{ name: 'Ann', address: 'ann@example.com' }], cc: [{ name: '', address: 'chen@acme.test' }] },
      { from: { name: 'Ann', address: 'Ann@Example.com' }, to: [{ name: 'Bob', address: 'BOB@acme.test' }], cc: [] },
    ], 'ann@example.com');
    expect(people.map((p) => p.address)).toEqual(['bob@acme.test', 'chen@acme.test']);
    const url = new URL(createEventUrl('Plan for Q3', people), 'https://app.freeflow.im');
    expect(url.pathname).toBe('/calendar/');
    expect(url.searchParams.get('new')).toBe('Plan for Q3');
    expect(url.searchParams.get('guests')).toBe('Bob Martin <bob@acme.test>,chen@acme.test');
    expect(new URL(createEventUrl('Hi', [{ name: 'Lee, Ann', address: 'a@x.org' }]), 'https://x').searchParams.get('guests')).toBe('Lee  Ann <a@x.org>');
  });
});
