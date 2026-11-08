// Scheduling between accounts (platform.md §3.5, phase 4.2; calendar.md §16): the iTIP rules of RFC 5546 with the
// transport replaced by an object call. The organizer's Calendar object sends REQUEST and CANCEL to each attendee's object
// (`receiveItip`), an attendee's object sends REPLY back; attendees outside the platform get the same messages by mail
// (imip.ts). What this file decides, and tests against RFC 5546's examples (itip.test.ts):
//   - who may do what: only the organizer on record sends REQUEST, ADD and CANCEL; only an attendee sends REPLY, and a
//     REPLY changes that attendee's PARTSTAT and nothing else;
//   - message order (§2.1.5): a higher SEQUENCE wins, then a later DTSTAMP; an older message is ignored;
//   - what is stored: an invitation without METHOD with the attendee's own answer and reminders kept across updates; a
//     cancellation as STATUS:CANCELLED (kept on the calendar, shown struck through) or one occurrence taken off;
//   - the attendees' accounts on the organizer's copy (`X-FLOW-ACCOUNT` on their ATTENDEE lines, and on the ORGANIZER line).
// Pure: object.ts does the calls and the writes.
import ICAL from 'ical.js';
import { deleteFromEvent, masterOf, parseCalendar, parseObject, recurrenceIdsOf, respondTo, vevents, type Response } from './ical';

type Component = InstanceType<typeof ICAL.Component>;
type Property = InstanceType<typeof ICAL.Property>;

export type ItipMethodIn = 'REQUEST' | 'CANCEL' | 'REPLY' | 'ADD';
export const ITIP_METHODS: ItipMethodIn[] = ['REQUEST', 'CANCEL', 'REPLY', 'ADD'];
/** The parameter naming a platform account on an ATTENDEE or ORGANIZER line. */
export const ACCOUNT_PARAM = 'x-flow-account';

const mailto = (v: unknown) => (typeof v === 'string' ? v.replace(/^mailto:/i, '').trim().toLowerCase() : '');
const accountOf = (p: Property) => { const v = p.getFirstParameter(ACCOUNT_PARAM); return typeof v === 'string' && v ? v : null; };

/** What the rules look at in one object (or message) about one UID: its master's (or first VEVENT's) ordering and people. */
export interface ItipSummary {
  method: string | null;
  uid: string;
  sequence: number;
  /** DTSTAMP in ms (0 when there is none). */
  dtstamp: number;
  organizer: { email: string; accountId: string | null } | null;
  attendees: { email: string; accountId: string | null; partstat: string }[];
}

const stampMs = (ev: Component, name: string) => {
  const v = ev.getFirstPropertyValue(name) as { toJSDate?: () => Date } | null;
  return v && typeof v.toJSDate === 'function' ? v.toJSDate().getTime() : 0;
};

/** The summary of an object's or a message's event (the UID given, else the first one in it); null when there is none. */
export function summaryOf(raw: string, uid?: string): ItipSummary | null {
  let vcal: Component;
  try {
    vcal = parseCalendar(raw);
  } catch {
    return null;
  }
  const id = uid ?? (vcal.getFirstSubcomponent('vevent')?.getFirstPropertyValue('uid') as string | undefined);
  if (!id) return null;
  const ev = masterOf(vcal, id) ?? vevents(vcal, id)[0];
  if (!ev) return null;
  const org = ev.getFirstProperty('organizer');
  const orgEmail = org ? mailto(org.getFirstValue()) : '';
  return {
    method: String(vcal.getFirstPropertyValue('method') ?? '').trim().toUpperCase() || null,
    uid: id,
    sequence: Number(ev.getFirstPropertyValue('sequence') ?? 0) || 0,
    dtstamp: stampMs(ev, 'dtstamp'),
    organizer: orgEmail ? { email: orgEmail, accountId: accountOf(org!) } : null,
    attendees: ev.getAllProperties('attendee').map((p) => ({ email: mailto(p.getFirstValue()), accountId: accountOf(p), partstat: String(p.getFirstParameter('partstat') ?? 'NEEDS-ACTION').toUpperCase() })).filter((a) => a.email.includes('@')),
  };
}

/** RFC 5546 §2.1.5: which of two versions of an event is newer, by SEQUENCE and then DTSTAMP. 1: `a` is, -1: `b` is, 0: the same. */
export function order(a: Pick<ItipSummary, 'sequence' | 'dtstamp'>, b: Pick<ItipSummary, 'sequence' | 'dtstamp'>): -1 | 0 | 1 {
  if (a.sequence !== b.sequence) return a.sequence > b.sequence ? 1 : -1;
  if (a.dtstamp !== b.dtstamp) return a.dtstamp > b.dtstamp ? 1 : -1;
  return 0;
}

export type Decision =
  | { action: 'create' | 'update' | 'cancel' | 'add' | 'reply' }
  | { action: 'ignore'; reason: string }
  | { action: 'refuse'; code: 'not_organizer' | 'not_attendee' | 'bad_request'; message: string };

const isFrom = (who: { email: string; accountId: string | null } | null, from: { email: string; accountId: string }) =>
  !!who && who.email === from.email.toLowerCase() && (!who.accountId || who.accountId === from.accountId);

/**
 * What a received message does to the copy here (`stored`, null when there is none), RFC 5546 §3.2 with the sender known
 * (`from`: the account whose object called). `me`: this account's addresses.
 * - REQUEST (§3.2.2), ADD (§3.2.4), CANCEL (§3.2.5): only from the event's organizer, who must also be the organizer on
 *   record; never to the organizer's own copy. A REQUEST with no copy here makes one; with one, it replaces it when newer.
 *   A CANCEL or ADD with no copy here is ignored (nothing to cancel; an ADD needs a REFRESH, which is not offered).
 * - REPLY (§3.2.3): only to the organizer's copy, from one of its attendees, about themself; one for an older SEQUENCE than
 *   the copy's is ignored (it answered a version since changed).
 */
export function decide(method: ItipMethodIn, incoming: ItipSummary, stored: ItipSummary | null, from: { email: string; accountId: string }, me: Set<string>): Decision {
  if (incoming.method && incoming.method !== method) return { action: 'refuse', code: 'bad_request', message: `the message says METHOD:${incoming.method}, not ${method}` };
  if (stored && stored.uid !== incoming.uid) return { action: 'refuse', code: 'bad_request', message: 'not the same event' };
  if (method === 'REPLY') {
    if (!stored) return { action: 'ignore', reason: 'no such event here' };
    if (!stored.organizer || !me.has(stored.organizer.email)) return { action: 'refuse', code: 'not_organizer', message: 'a reply goes to the organizer' };
    const replier = from.email.toLowerCase();
    if (!stored.attendees.some((a) => a.email === replier)) return { action: 'refuse', code: 'not_attendee', message: 'the sender is not invited to this event' };
    const line = incoming.attendees.find((a) => a.email === replier);
    if (!line) return { action: 'refuse', code: 'not_attendee', message: 'a reply carries its sender\'s own answer' };
    if (incoming.attendees.some((a) => a.email !== replier)) return { action: 'refuse', code: 'not_attendee', message: 'a reply may only answer for its sender' };
    if (!['ACCEPTED', 'DECLINED', 'TENTATIVE'].includes(line.partstat)) return { action: 'refuse', code: 'bad_request', message: 'a reply accepts, declines or answers tentatively' };
    if (incoming.sequence < stored.sequence) return { action: 'ignore', reason: 'the reply answers an older version of the event' };
    return { action: 'reply' };
  }
  if (!incoming.organizer || !isFrom(incoming.organizer, from)) return { action: 'refuse', code: 'not_organizer', message: 'only the organizer sends invitations, updates and cancellations' };
  if (stored) {
    if (stored.organizer && me.has(stored.organizer.email)) return { action: 'refuse', code: 'not_organizer', message: 'this account organizes the event' };
    if (!isFrom(stored.organizer, from)) return { action: 'refuse', code: 'not_organizer', message: 'only the organizer on record changes the event' };
  }
  if (method === 'REQUEST') {
    if (!stored) return { action: 'create' };
    return order(incoming, stored) > 0 ? { action: 'update' } : { action: 'ignore', reason: 'an older or the same version of the event' };
  }
  if (!stored) return { action: 'ignore', reason: method === 'CANCEL' ? 'nothing to cancel here' : 'no series here to add to' };
  if (method === 'CANCEL') return order(incoming, stored) >= 0 ? { action: 'cancel' } : { action: 'ignore', reason: 'an older cancellation' };
  return order(incoming, stored) >= 0 ? { action: 'add' } : { action: 'ignore', reason: 'an older version of the series' };
}

/** A VEVENT's RECURRENCE-ID as text (its value and zone), '' for a master or a plain event. */
const ridKey = (ev: Component) => {
  const p = ev.getFirstProperty('recurrence-id');
  return p ? `${String(p.getFirstParameter('tzid') ?? '')}|${String(p.getFirstValue())}` : '';
};
const clone = (out: Component, e: Component) => { const c = new ICAL.Component(JSON.parse(JSON.stringify(e.toJSON())), out); out.addSubcomponent(c); return c; };

/**
 * A REQUEST (or ADD) as the attendee's copy stores it: no METHOD, only its UID's VEVENTs, and per VEVENT the attendee's own
 * PARTSTAT and reminders from the copy there (`stored`: the same RECURRENCE-ID's, else the master's; NEEDS-ACTION and
 * none for a new one), RSVP gone. An ADD keeps the stored VEVENTs the message does not carry.
 */
export function acceptRequest(stored: string | null, ics: string, uid: string, me: Set<string>, opts: { add?: boolean } = {}): string {
  const msg = parseCalendar(ics);
  const out = new ICAL.Component('vcalendar');
  for (const p of msg.getAllProperties()) if (p.name !== 'method') out.addProperty(new ICAL.Property(JSON.parse(JSON.stringify(p.toJSON()))));
  for (const z of msg.getAllSubcomponents('vtimezone')) clone(out, z);
  const old = stored ? parseCalendar(stored) : null;
  const oldByRid = new Map((old ? vevents(old, uid) : []).map((e) => [ridKey(e), e]));
  const oldMaster = oldByRid.get('') ?? null;
  const incoming = vevents(msg, uid);
  if (opts.add && old) {
    const carried = new Set(incoming.map(ridKey));
    for (const z of old.getAllSubcomponents('vtimezone')) if (!out.getAllSubcomponents('vtimezone').some((x) => x.getFirstPropertyValue('tzid') === z.getFirstPropertyValue('tzid'))) clone(out, z);
    for (const e of vevents(old, uid)) if (!carried.has(ridKey(e))) clone(out, e);
  }
  for (const e of incoming) {
    const c = clone(out, e);
    const before = oldByRid.get(ridKey(e)) ?? oldMaster;
    const myOld = before?.getAllProperties('attendee').find((p) => me.has(mailto(p.getFirstValue())));
    for (const p of c.getAllProperties('attendee')) {
      if (!me.has(mailto(p.getFirstValue()))) continue;
      p.setParameter('partstat', String(myOld?.getFirstParameter('partstat') ?? 'NEEDS-ACTION').toUpperCase());
      p.removeParameter('rsvp');
    }
    for (const a of c.getAllSubcomponents('valarm')) c.removeSubcomponent(a);
    for (const a of before?.getAllSubcomponents('valarm') ?? []) clone(c, a);
  }
  return out.toString();
}

/**
 * A CANCEL on the attendee's copy: of the whole event, every VEVENT STATUS:CANCELLED with the message's SEQUENCE and
 * DTSTAMP (the event stays, shown struck through); of one occurrence (the message's VEVENT has a RECURRENCE-ID), that
 * occurrence taken off the series. Null when nothing is left of the copy.
 */
export function acceptCancel(stored: string, ics: string, uid: string, now: number): string | null {
  const msg = parseCalendar(ics);
  const cancelled = vevents(msg, uid);
  const one = cancelled.length === 1 && cancelled[0]!.getFirstProperty('recurrence-id') ? parseObject(ics, { me: new Set(), zone: 'UTC' }).find((r) => r.uid === uid && r.rid) : null;
  if (one) return deleteFromEvent(stored, uid, one.rid, 'this', { me: [], organizer: null, displayName: '', zone: 'UTC', now });
  const vcal = parseCalendar(stored);
  const src = masterOf(msg, uid) ?? cancelled[0];
  for (const ev of vevents(vcal, uid)) {
    ev.removeAllProperties('status');
    ev.addPropertyWithValue('status', 'CANCELLED');
    for (const name of ['sequence', 'dtstamp']) {
      const v = src?.getFirstProperty(name);
      if (!v) continue;
      ev.removeAllProperties(name);
      ev.addProperty(new ICAL.Property(JSON.parse(JSON.stringify(v.toJSON()))));
    }
  }
  return vcal.toString();
}

/**
 * A REPLY on the organizer's copy: only the replier's PARTSTAT (and the message's COMMENT) changes, on the series or on the
 * one occurrence the reply names (`respondTo`, with the replier as "me"). Answers the new text, the answer and its occurrence.
 */
export function acceptReply(stored: string, ics: string, uid: string, replier: string, now: number): { raw: string; response: Exclude<Response, 'needs-action'>; rid: number } {
  const email = replier.toLowerCase();
  const rows = recurrenceIdsOf(ics, uid);
  // The series' answer when the reply carries the master, else the one occurrence's.
  const row = rows.find((r) => !r.rid) ?? rows[0];
  const partstat = row?.partstats.get(email);
  const response = partstat === 'ACCEPTED' ? 'accepted' : partstat === 'DECLINED' ? 'declined' : partstat === 'TENTATIVE' ? 'tentative' : null;
  if (!row || !response) throw new Error('the reply carries no answer');
  const raw = respondTo(stored, uid, row.rid, response, row.comment ?? undefined, { me: [email], organizer: null, displayName: '', zone: 'UTC', now });
  return { raw, response, rid: row.rid };
}

/** An address resolved through the directory: a platform account of the organization, or null for one outside it. */
export interface ResolvedAttendee { accountId: string; name: string | null }

/**
 * The organizer's copy with its people marked: `X-FLOW-ACCOUNT` on each ATTENDEE line whose address is an account of the
 * organization (and its CN filled from the account when the line has none), removed from those that are not, and on the
 * ORGANIZER line the organizer's own account. Every VEVENT of the UID.
 */
export function markAccounts(raw: string, uid: string, resolved: Map<string, ResolvedAttendee | null>, organizer: { email: string; accountId: string }): string {
  const vcal = parseCalendar(raw);
  for (const ev of vevents(vcal, uid)) {
    for (const p of ev.getAllProperties('attendee')) {
      const email = mailto(p.getFirstValue());
      const r = email === organizer.email ? { accountId: organizer.accountId, name: null } : resolved.get(email);
      if (r) {
        p.setParameter(ACCOUNT_PARAM, r.accountId);
        if (r.name && !p.getFirstParameter('cn')) p.setParameter('cn', r.name);
      } else p.removeParameter(ACCOUNT_PARAM);
    }
    const o = ev.getFirstProperty('organizer');
    if (o && mailto(o.getFirstValue()) === organizer.email) o.setParameter(ACCOUNT_PARAM, organizer.accountId);
  }
  return vcal.toString();
}

/** The platform attendees of an object's event (marked by `markAccounts`), each once, by address; never `self`. */
export function platformAttendees(raw: string | null, uid: string, self: string): Map<string, { accountId: string; name: string | null }> {
  const out = new Map<string, { accountId: string; name: string | null }>();
  if (!raw) return out;
  for (const ev of vevents(parseCalendar(raw), uid)) {
    for (const p of ev.getAllProperties('attendee')) {
      const email = mailto(p.getFirstValue()), accountId = accountOf(p);
      if (!accountId || accountId === self || out.has(email)) continue;
      const cn = p.getFirstParameter('cn');
      out.set(email, { accountId, name: cn ? String(cn) : null });
    }
  }
  return out;
}

/** The ATTENDEE addresses of an object's event, lower case, each once. */
export function attendeeAddresses(raw: string, uid: string): string[] {
  return [...new Set(vevents(parseCalendar(raw), uid).flatMap((ev) => ev.getAllProperties('attendee').map((p) => mailto(p.getFirstValue())).filter((e) => e.includes('@'))))];
}

/** The METHOD a message says, upper case, or null. */
export function methodOf(ics: string): string | null {
  try {
    return String(parseCalendar(ics).getFirstPropertyValue('method') ?? '').trim().toUpperCase() || null;
  } catch {
    return null;
  }
}
