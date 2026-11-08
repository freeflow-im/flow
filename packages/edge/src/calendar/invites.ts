// Invitations across Mail and Calendar (docs/specs/calendar.md §14). An invitation is a message with a `text/calendar`
// part (or an `.ics` file): Mail's card asks `POST /v1/calendar/invites` what it is (this object reads the part from the
// person's Mail object by binding, parses it, and says whether the event is on a calendar already, as Google and iCloud
// put invitations there before the mail is read), and answers it (`invites/respond`: the PARTSTAT set on the calendar's
// copy, or the event put on the chosen calendar with it) or removes a cancelled one (`invites/cancel`).
//
// The answer reaches the organizer the calendar server's way when it schedules (Google, iCloud, Fastmail), and by email
// (iMIP, imip.ts) from the mail account the invitation came to when it does not (Radicale). The other way round, an event
// with guests made, changed or deleted here on such a calendar sends its invitation, update or cancellation by email from
// the mail account with the calendar's address (`notify`); with none, nothing is sent and the answer says so.
//
// The Calendar object implements the two ports (its calendars and its writes; the Mail object), so invites.test.ts runs
// all of this against a fake Mail and an in-memory store.
import { deleteFromEvent, guestsOf, isoOf, itipReply, itipRequest, organizerOf, parseInvitation, parseObject, respondTo, ridText, sequenceOf, storedInvitation, type Attendee, type EventData, type Invitation, type ParsedEvent, type Response, type WriteContext } from './ical';
import { cancelMail, replyMail, requestMail, whenText, type CalendarMail } from './imip';
import { InviteBody, InviteRespondBody, badRequest, calendarError, messageOf, notFound, parse } from './rules';
import type { CalendarRow, CalendarStore, ObjectRow } from './store';

export interface MailIdentity { id: string; email: string; displayName: string }
/** The person's Mail object, as invitations use it. */
export interface InviteMail {
  identities(): Promise<MailIdentity[]>;
  part(accountId: string, folder: string, uid: number, index: number): Promise<{ content: Uint8Array; mimeType: string; filename: string }>;
  send(accountId: string, mail: CalendarMail): Promise<void>;
}
/** The Calendar object, as invitations use it: its store, who "me" is, which servers schedule, and its writes (server first, then the cache). */
export interface InviteCalendars {
  readonly store: CalendarStore;
  /** The person's own addresses on one calendar (its account's and its owner's), or on all of them. */
  me(calendarId?: string): Set<string>;
  /** Whether the calendar's server sends and processes invitations itself (Google, or a CalDAV server with a scheduling outbox). */
  schedules(calendarId: string): boolean;
  calendars(): { id: string; name: string; color: string; isDefault: boolean; role: string }[];
  put(calendarId: string, href: string, raw: string, etag: string | null): Promise<void>;
  remove(calendarId: string, href: string, etag: string | null): Promise<void>;
  hrefFor(calendarId: string, uid: string): string;
  now(): number;
  /**
   * A REPLY to an event the person organizes on a native calendar, applied there (the replier's PARTSTAT, itip.ts): true
   * when it changed the copy. Absent where nothing applies replies (the copy is the server's, which records them itself).
   */
  applyReply?(ics: string, replier: string): Promise<boolean>;
}

/** The event an invitation is about, as Mail's card shows it (EventOccurrence's fields that make sense before it is on a calendar). */
export interface InviteEvent {
  uid: string; summary: string; location: string | null; description: string | null; start: string; end: string; allDay: boolean; timezone: string | null;
  status: EventData['status']; organizer: Attendee | null; attendees: Attendee[]; myResponse?: Response; recurrence: string[]; recurrenceId?: string;
  conference?: { url: string; label: string }; sequence: number;
}
export interface InviteAnswer {
  action: 'request' | 'cancel' | 'reply';
  event: InviteEvent;
  /** The event (or the occurrence) on one of the person's calendars, as it stands there; null when it is not on one. */
  onCalendar: { calendarId: string; id: string; eventId: string; myResponse: Response | null; cancelled: boolean } | null;
  /** A REPLY: who answered, and how. */
  reply?: { name: string | null; email: string; response: Response };
  /** The person organized it (a REPLY to them, or their own invitation). */
  organizerIsMe: boolean;
  /** A REPLY to an event on one of the person's native calendars: the answer is now on it. */
  replyApplied?: true;
  /** The calendars an invitation can go on. */
  calendars: { id: string; name: string; color: string; isDefault: boolean }[];
}
/** How an answer reached the organizer: the server's own scheduling, an email, nothing to send (no organizer, or the person's own), or an email that failed. */
export type Replied = { replied: 'server' | 'email' | 'none' } | { replied: 'failed'; replyError: string };
/** An organizer's messages to the guests (iMIP): sent, or not (no mail account with the calendar's address, or it failed) and why. */
export interface Notified { invitationsSent: boolean; invitationsNote?: string }

/** The largest invitation read. */
const MAX_PART_BYTES = 512 * 1024;
const CALENDAR_TYPES = /^(text\/calendar|application\/ics|text\/x-vcalendar)$/i;
export const isCalendarPart = (mimeType: string, filename: string) => CALENDAR_TYPES.test(mimeType.split(';')[0]!.trim()) || /\.ics$/i.test(filename);

function inviteEvent(p: ParsedEvent): InviteEvent {
  const d = p.data;
  return {
    uid: p.uid, summary: d.summary, location: d.location, description: d.description, start: isoOf(p.startUtc, d.allDay), end: isoOf(p.endUtc, d.allDay), allDay: d.allDay,
    timezone: d.timezone, status: d.status, organizer: d.organizer, attendees: d.attendees, ...(d.myResponse ? { myResponse: d.myResponse } : {}), recurrence: d.recurrence,
    ...(p.rid ? { recurrenceId: ridText(p.rid, d.allDay) } : {}), ...(d.conference ? { conference: d.conference } : {}), sequence: d.sequence,
  };
}
const whenOf = (p: ParsedEvent) => whenText(p.startUtc, p.endUtc, p.data.allDay, p.data.timezone);
/** An object's event as a row (its master, else its first), for the text of a message about it. */
const mainRow = (raw: string, uid: string): ParsedEvent | null => {
  const rows = parseObject(raw, { me: new Set(), zone: 'UTC' }).filter((r) => r.uid === uid);
  return rows.find((r) => !r.rid) ?? rows[0] ?? null;
};
const combine = (a: Notified | null, b: Notified | null): Notified | null => {
  if (!a || !b) return a ?? b;
  const note = [a.invitationsNote, b.invitationsNote].filter(Boolean).join(' ');
  return { invitationsSent: a.invitationsSent && b.invitationsSent, ...(note ? { invitationsNote: note } : {}) };
};

interface Loaded { identity: MailIdentity; text: string; inv: Invitation; me: Set<string> }

export class Invites {
  constructor(private readonly cal: InviteCalendars, private readonly mail: InviteMail | null) {}

  private mailOrFail(): InviteMail {
    if (!this.mail) throw calendarError(503, 'mail_unavailable', 'Mail is not available here');
    return this.mail;
  }

  /** The message's invitation part, read from Mail and parsed, with who "me" is (the calendars' addresses and the mail account's). */
  private async load(b: { account: string; messageId: Parameters<typeof messageOf>[0]['messageId']; part: number }): Promise<Loaded> {
    const where = messageOf(b);
    const mail = this.mailOrFail();
    const identity = (await mail.identities()).find((i) => i.id === b.account);
    if (!identity) throw notFound('no such mail account');
    const part = await mail.part(b.account, where.folder, where.uid, b.part);
    if (!isCalendarPart(part.mimeType, part.filename)) throw badRequest('this attachment is not an invitation');
    if (part.content.length > MAX_PART_BYTES) throw badRequest('the invitation is too large to read');
    const text = new TextDecoder('utf-8').decode(part.content);
    const me = new Set([...this.cal.me(), identity.email.toLowerCase()]);
    return { identity, text, inv: parseInvitation(text, { me, zone: 'UTC' }), me };
  }

  /** The person's copy of an event, by UID: a calendar they can write to first. */
  private find(uid: string): { calendar: CalendarRow; obj: ObjectRow } | null {
    const cals = this.cal.store.calendars().sort((a, b) => Number(a.role === 'reader') - Number(b.role === 'reader'));
    for (const c of cals) {
      const obj = this.cal.store.objectByUid(c.id, uid);
      if (obj) return { calendar: c, obj };
    }
    return null;
  }

  private answer({ inv, me }: Loaded): InviteAnswer {
    const found = this.find(inv.uid);
    let onCalendar: InviteAnswer['onCalendar'] = null;
    if (found) {
      const f = this.cal.store.find(found.calendar.id, inv.uid, inv.main.rid || null);
      if (f) onCalendar = { calendarId: found.calendar.id, id: f.event.id, eventId: f.event.eventId, myResponse: f.event.myResponse ?? null, cancelled: f.event.status === 'cancelled' };
    }
    const organizer = inv.main.data.organizer;
    return {
      action: inv.method.toLowerCase() as InviteAnswer['action'],
      event: inviteEvent(inv.main),
      onCalendar,
      ...(inv.replier ? { reply: { name: inv.replier.name, email: inv.replier.email, response: inv.replier.response } } : {}),
      organizerIsMe: !!organizer && me.has(organizer.email),
      calendars: this.cal.calendars().filter((c) => c.role !== 'reader').map(({ id, name, color, isDefault }) => ({ id, name, color, isDefault })),
    };
  }

  /** `POST /v1/calendar/invites`: what the invitation is, and where it stands on the person's calendars. */
  async read(body: unknown): Promise<InviteAnswer> {
    const loaded = await this.load(parse(InviteBody, body));
    // A REPLY from outside the platform to an event the person organizes on a native calendar: the answer goes on it.
    const { inv, text } = loaded;
    const applied = inv.method === 'REPLY' && inv.replier && this.cal.applyReply ? await this.cal.applyReply(text, inv.replier.email).catch(() => false) : false;
    return { ...this.answer(loaded), ...(applied ? { replyApplied: true as const } : {}) };
  }

  /**
   * `POST /v1/calendar/invites/respond`: the person's answer. On a calendar already: its PARTSTAT there (on a server that does
   * not schedule, a newer invitation, by SEQUENCE, replaces the copy first). Else the event goes on the calendar asked for
   * (or the default one) with the answer. Then the organizer is told: by the server, or by email from this mail account.
   */
  async respond(body: unknown): Promise<InviteAnswer & Replied> {
    const b = parse(InviteRespondBody, body);
    const loaded = await this.load(b);
    const { inv, text, identity, me } = loaded;
    if (inv.method !== 'REQUEST') throw badRequest(`this is a ${inv.method === 'CANCEL' ? 'cancellation' : 'reply'}, not an invitation to answer`);
    const now = this.cal.now();
    const meList = [...me];
    const fallback = { email: identity.email, name: identity.displayName };
    const found = this.find(inv.uid);
    let calendarId: string, written: string;
    if (found && found.calendar.role !== 'reader') {
      calendarId = found.calendar.id;
      const base = found.obj.raw;
      if (!this.cal.schedules(calendarId) && inv.sequence > sequenceOf(base, inv.uid)) written = storedInvitation(text, inv.uid, b.response, { me: meList, fallback, now });
      else {
        const ctx: WriteContext = { me: meList, organizer: null, displayName: identity.displayName, zone: found.calendar.timezone ?? 'UTC', now };
        try {
          written = respondTo(base, inv.uid, inv.main.rid, b.response, undefined, ctx);
        } catch {
          // The copy on the calendar does not list the person (invited by a list's address): they are added with the answer.
          written = storedInvitation(base, inv.uid, b.response, { me: meList, fallback, now });
        }
      }
      await this.cal.put(calendarId, found.obj.href, written, found.obj.etag);
    } else {
      const writable = this.cal.calendars().filter((c) => c.role !== 'reader');
      const target = b.calendarId ? writable.find((c) => c.id === b.calendarId) : (writable.find((c) => c.isDefault) ?? writable[0]);
      if (!target) throw b.calendarId ? badRequest('calendarId: not a calendar you can write to') : badRequest('connect a calendar first');
      calendarId = target.id;
      written = storedInvitation(text, inv.uid, b.response, { me: meList, fallback, now });
      await this.cal.put(calendarId, this.cal.hrefFor(calendarId, inv.uid), written, null);
    }
    const replied = await this.reply(calendarId, identity, written, inv.uid, inv.main.rid, b.response, me);
    return { ...this.answer(loaded), ...replied };
  }

  /** `POST /v1/calendar/invites/cancel`: a cancelled event (or the one occurrence a cancellation names) taken off the calendar it is on. */
  async cancel(body: unknown): Promise<InviteAnswer & { removed: boolean }> {
    const loaded = await this.load(parse(InviteBody, body));
    const { inv, identity, me } = loaded;
    if (inv.method !== 'CANCEL') throw badRequest('this is not a cancellation');
    const found = this.find(inv.uid);
    if (!found || found.calendar.role === 'reader' || !this.cal.store.find(found.calendar.id, inv.uid, inv.main.rid || null)) return { ...this.answer(loaded), removed: false };
    const { calendar: c, obj } = found;
    const raw = inv.main.rid ? deleteFromEvent(obj.raw, inv.uid, inv.main.rid, 'this', { me: [...me], organizer: null, displayName: identity.displayName, zone: c.timezone ?? 'UTC', now: this.cal.now() }) : null;
    if (raw === null) await this.cal.remove(c.id, obj.href, obj.etag);
    else await this.cal.put(c.id, obj.href, raw, obj.etag);
    return { ...this.answer(loaded), removed: true };
  }

  /** The person's mail account that sends as one of their addresses on a calendar. */
  private async sender(me: Set<string>): Promise<MailIdentity | null> {
    if (!this.mail) return null;
    const ids = await this.mail.identities().catch(() => [] as MailIdentity[]);
    return ids.find((i) => me.has(i.email.toLowerCase())) ?? null;
  }

  /** Tells the organizer an answer by email, unless the server schedules, there is nobody to tell, or the organizer is the person. */
  private async reply(calendarId: string, identity: MailIdentity | null, written: string, uid: string, rid: number, response: Exclude<Response, 'needs-action'>, me: Set<string>): Promise<Replied> {
    if (this.cal.schedules(calendarId)) return { replied: 'server' };
    const organizer = organizerOf(written, uid);
    if (!organizer || me.has(organizer)) return { replied: 'none' };
    const from = identity ?? (await this.sender(me));
    if (!from || !this.mail) return { replied: 'failed', replyError: 'No mail account in Mail sends as this calendar\'s address, so the organizer was not told.' };
    const main = mainRow(written, uid);
    const row = rid ? parseObject(written, { me: new Set(), zone: 'UTC' }).find((r) => r.uid === uid && r.rid === rid) ?? main : main;
    const organizerRow = main?.data.organizer;
    try {
      const ics = itipReply(written, uid, rid, { me: [...me], now: this.cal.now() });
      await this.mail.send(from.id, replyMail({ me: { name: from.displayName, email: from.email }, organizer: { name: organizerRow?.name ?? null, email: organizer }, response, summary: main?.data.summary ?? '', when: row ? whenOf(row) : '', ics }));
      return { replied: 'email' };
    } catch (err) {
      return { replied: 'failed', replyError: (err as Error).message.slice(0, 300) };
    }
  }

  /** An RSVP made in Calendar (`events/:id/respond`) on a calendar whose server does not schedule: the organizer told by email. */
  async replied(calendarId: string, written: string, uid: string, rid: number, response: Exclude<Response, 'needs-action'>): Promise<Replied> {
    return this.reply(calendarId, null, written, uid, rid, response, this.cal.me(calendarId));
  }

  /**
   * After the person changed an event they organize, with guests, on a calendar whose server does not schedule: the guests
   * told by email. `before` and `after` are the object's text either side of the write (null: it did not exist, or is gone).
   * A new or changed event is a REQUEST to its guests (and a CANCEL to any taken off it); a deleted one a CANCEL; one
   * occurrence deleted (`cancelRid`) a CANCEL of that occurrence. Null when there was nobody to tell. `only` keeps the
   * guests to email (a native calendar's: those outside the platform, the rest being scheduled by object call).
   */
  async notify(calendarId: string, uid: string, before: string | null, after: string | null, opts: { cancelRid?: number; only?: (email: string) => boolean } = {}): Promise<Notified | null> {
    if (this.cal.schedules(calendarId)) return null;
    const ref = after ?? before;
    if (!ref) return null;
    const me = this.cal.me(calendarId);
    const meList = [...me];
    const organizer = organizerOf(ref, uid);
    if (!organizer || !me.has(organizer)) return null;
    const now = this.cal.now();
    const ctx = { now, zone: 'UTC' };
    const keep = (g: { email: string }) => !opts.only || opts.only(g.email);
    const was = before ? guestsOf(before, uid, meList).filter(keep) : [];
    const is = after ? guestsOf(after, uid, meList).filter(keep) : [];
    const gone = after && !opts.cancelRid ? was.filter((g) => !is.some((x) => x.email === g.email)) : [];
    const anyone = opts.cancelRid || !after ? was.length > 0 : is.length > 0 || gone.length > 0;
    if (!anyone) return null;
    const sender = await this.sender(me);
    if (!sender || !this.mail) return { invitationsSent: false, invitationsNote: `No mail account in Mail sends as ${organizer}, so the guests were not emailed.` };
    const main = mainRow(ref, uid);
    const summary = main?.data.summary ?? '';
    const when = main ? whenOf(main) : '';
    const from = { name: sender.displayName, email: sender.email };
    const out: CalendarMail[] = [];
    if (opts.cancelRid && before) {
      const occurrence = main ? whenText(opts.cancelRid, opts.cancelRid + (main.endUtc - main.startUtc), main.data.allDay, main.data.timezone) : when;
      out.push(cancelMail({ organizer: from, to: was, summary, when: occurrence, ics: itipRequest(before, uid, 'CANCEL', ctx, opts.cancelRid) }));
    } else if (after) {
      if (is.length) out.push(requestMail({ organizer: from, to: is, summary, when, location: main?.data.location ?? null, description: main?.data.description ?? null, update: !!before, ics: itipRequest(after, uid, 'REQUEST', ctx) }));
      if (gone.length && before) out.push(cancelMail({ organizer: from, to: gone, summary, when, ics: itipRequest(before, uid, 'CANCEL', ctx) }));
    } else if (before) {
      out.push(cancelMail({ organizer: from, to: was, summary, when, ics: itipRequest(before, uid, 'CANCEL', ctx) }));
    }
    try {
      for (const m of out) await this.mail.send(sender.id, m);
      return { invitationsSent: true };
    } catch (err) {
      return { invitationsSent: false, invitationsNote: `The guests could not be emailed: ${(err as Error).message.slice(0, 200)}` };
    }
  }

  /** Two notifications as one (a series split in two). */
  static combine = combine;
}

