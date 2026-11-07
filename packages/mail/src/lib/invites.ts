// Invitations in a message (docs/specs/calendar.md §14): which part of a message is its invitation (a `text/calendar`
// part, else an `.ics` file), the card's words, and "Create event" from a thread (the suite's create intent). Pure.
import type { CreateFields } from '@flow/suite-bar/intents';
import type { Address, Attachment, InviteAnswer, InviteEvent, InviteResponse, Replied } from '../api';

/** A part that is iCalendar: `text/calendar` (with any parameters), `application/ics`, or a file named `.ics`. */
export const isCalendarFile = (a: { mimeType: string; filename: string }) => /^(text\/calendar|application\/ics|text\/x-vcalendar)$/i.test(a.mimeType.split(';')[0]!.trim()) || /\.ics$/i.test(a.filename);

/**
 * The part the card reads: the `text/calendar` one (Google and Outlook send the invitation as an alternative to the text,
 * and again as `invite.ics`), else the first `.ics` file. Null for a message with none.
 */
export function invitationPart(m: { attachments: readonly Attachment[] }): Attachment | null {
  return m.attachments.find((a) => /^text\/calendar$/i.test(a.mimeType.split(';')[0]!.trim())) ?? m.attachments.find(isCalendarFile) ?? null;
}

/** How many people the event has: its attendees, and the organizer when they are not listed among them. */
export function guestCount(e: Pick<InviteEvent, 'organizer' | 'attendees'>): number {
  const emails = new Set(e.attendees.map((a) => a.email.toLowerCase()));
  if (e.organizer) emails.add(e.organizer.email.toLowerCase());
  return emails.size;
}

export const nameOf = (p: { name: string | null; email: string } | null | undefined) => p?.name?.trim() || p?.email || 'Someone';

const SAID: Record<InviteResponse, string> = { accepted: 'Going', declined: 'Not going', tentative: 'Maybe', 'needs-action': 'Not answered yet' };
/** The person's answer as the card says it: "Going", "Not going", "Maybe". */
export const responseWord = (r: InviteResponse | null | undefined) => SAID[r ?? 'needs-action'];

const VERB: Record<InviteResponse, string> = { accepted: 'accepted', declined: 'declined', tentative: 'tentatively accepted', 'needs-action': 'has not answered' };
/** A REPLY as a line: "Ann Lee accepted". */
export const replyLine = (reply: NonNullable<InviteAnswer['reply']>) => `${nameOf(reply)} ${VERB[reply.response]}`;

/** The toast after answering: what the person said, and whether the organizer was told. */
export function answeredText(response: Exclude<InviteResponse, 'needs-action'>, r: Replied, organizer: string): string {
  const said = response === 'accepted' ? "You're going." : response === 'declined' ? 'You declined.' : 'You said maybe.';
  if (r.replied === 'email') return `${said} ${organizer} was emailed your answer.`;
  if (r.replied === 'failed') return `${said} It is on your calendar, but ${organizer} could not be told: ${r.replyError}`;
  return said;
}

/** Everyone on a thread but the person: who wrote, and who was written to, each once, in the order they came. */
export function threadPeople(messages: readonly { from: Address | null; to: Address[]; cc: Address[] }[], me: string): Address[] {
  const mine = me.toLowerCase();
  const out = new Map<string, Address>();
  for (const m of messages) {
    for (const a of [...(m.from ? [m.from] : []), ...m.to, ...m.cc]) {
      const key = a.address.toLowerCase();
      if (key && key !== mine && !out.has(key)) out.set(key, a);
    }
  }
  return [...out.values()];
}

/** "Create event" from a thread: the new event's title and guests, for the suite's `create` intent to Calendar
 * (@flow/suite-bar intents, whose address packages/calendar `lib/deeplink.ts` reads). */
export function eventFromThread(subject: string, people: readonly Address[]): CreateFields['calendar'] {
  return { title: subject, attendees: people.map((a) => ({ email: a.address, name: a.name })) };
}
