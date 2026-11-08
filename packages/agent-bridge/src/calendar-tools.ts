// The agent's calendar (platform.md §7, phases 4.2 and 4.3): the turn an invitation starts (`invitationPrompt`), and five
// tools on the `flow` MCP server — list_my_events, get_event, respond_to_event, find_free_time, create_event — calling
// /v1/calendar/* as the agent's account in the organization the bridge serves (`?workspace=`), so an agent can propose and
// book a meeting from a DM. Kept apart from mcp-server.ts so the suite runs them against a fake server.
import type { CalendarInvitedEventData } from '@flow/shared';
import type { FlowApi } from './api.js';

export const CALENDAR_TOOLS = [
  {
    name: 'list_my_events',
    description:
      'List the events on your own calendars between two times (at most three months apart): id, when, title, organizer and your answer. Invitations you have not answered show "needs-action".',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start of the window, an ISO time, e.g. 2026-12-01T00:00:00Z.' },
        to: { type: 'string', description: 'End of the window, an ISO time.' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'get_event',
    description: 'Read one event on your calendar by id (from list_my_events or an invitation): when, where, description, organizer, every attendee and their answer.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The event id.' } }, required: ['id'] },
  },
  {
    name: 'respond_to_event',
    description:
      'Answer an invitation on your calendar: accepted, declined or tentative, with an optional comment for the organizer. The organizer sees your answer at once.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The event id.' },
        response: { type: 'string', enum: ['accepted', 'declined', 'tentative'] },
        comment: { type: 'string', description: 'Optional note to the organizer.' },
      },
      required: ['id', 'response'],
    },
  },
  {
    name: 'find_free_time',
    description:
      'Find times when you and the attendees are all free for a meeting, between two times (at most 31 days apart), within working hours (09:00-17:00 Monday to Friday in timezone, UTC unless given). Members of the organization are checked on their calendars (busy times only); anyone whose calendar cannot be seen is listed as unknown. Longest free stretches first; a meeting fits anywhere inside one. Use it before proposing a time.',
    inputSchema: {
      type: 'object',
      properties: {
        duration_minutes: { type: 'number', description: 'How long the meeting is, in minutes.' },
        from: { type: 'string', description: 'The earliest start, an ISO time.' },
        to: { type: 'string', description: 'The latest end, an ISO time.' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'Email addresses of the others who should be free, e.g. ann@acme.freeflow.im.' },
        timezone: { type: 'string', description: 'The IANA time zone working hours are in, e.g. America/New_York. Defaults to UTC.' },
        working_hours: { type: 'string', description: 'HH:MM-HH:MM (default 09:00-17:00, Monday to Friday), or "any" for any time of any day.' },
      },
      required: ['duration_minutes', 'from', 'to'],
    },
  },
  {
    name: 'create_event',
    description:
      'Book an event on your calendar and invite people by email address: members of the organization get it on their calendars at once and answer it there; anyone else is emailed an invitation where that is possible. Check find_free_time first, and say what you booked.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'The title.' },
        start: { type: 'string', description: 'When it starts, an ISO time with a zone, e.g. 2026-12-03T15:00:00Z.' },
        end: { type: 'string', description: 'When it ends, an ISO time.' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'Who to invite: "name@example.com" or "Name <name@example.com>".' },
        location: { type: 'string', description: 'Where: an address or a link.' },
        description: { type: 'string', description: 'Notes, plain text.' },
      },
      required: ['summary', 'start', 'end'],
    },
  },
];
export const CALENDAR_TOOL_NAMES = new Set(CALENDAR_TOOLS.map((t) => t.name));

interface Person { name: string | null; email: string; response?: string; self?: true; accountId?: string }
interface EventView {
  id: string; summary: string; start: string; end: string; allDay: boolean; location?: string | null; description?: string | null;
  status?: string; organizer?: Person | null; attendees?: Person[]; myResponse?: string; recurring?: boolean;
}

/** When an event is, for a line or a prompt: "Thu, Dec 3, 2026, 15:00–16:00 UTC", or the day for an all-day one. */
export function whenOf(start: string, end: string, allDay: boolean): string {
  const day = (d: Date) => new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(d);
  const s = new Date(start), e = new Date(end);
  if (Number.isNaN(s.getTime())) return start;
  if (allDay) return `${day(s)} (all day)`;
  const time = (d: Date) => d.toISOString().slice(11, 16);
  return day(s) === day(e) ? `${day(s)}, ${time(s)}–${time(e)} UTC` : `${day(s)} ${time(s)} – ${day(e)} ${time(e)} UTC`;
}
const who = (p: Person | null | undefined) => (p ? (p.name ? `${p.name} <${p.email}>` : p.email) : 'someone');

/** What the agent is asked when it is invited (the turn in the DM with the organizer, or the sponsor). */
export function invitationPrompt(d: CalendarInvitedEventData): string {
  const by = d.organizer ? `${d.organizer.name ? `${d.organizer.name} ` : ''}<${d.organizer.email}>` : 'someone';
  return `You were invited to "${d.summary || 'an event'}" on ${whenOf(d.start, d.end, d.allDay)} by ${by}. ` +
    'Decide whether to accept, decline or answer tentatively, and respond with the `respond_to_event` tool ' +
    `(event id ${d.eventId}); you may ask a question in this DM first. get_event shows its details.`;
}

const line = (e: EventView) =>
  `${e.id}  ${whenOf(e.start, e.end, e.allDay)}  ${e.summary || '(no title)'}${e.status === 'cancelled' ? ' (cancelled)' : ''}` +
  `${e.organizer ? `  organizer ${who(e.organizer)}` : ''}${e.myResponse ? `  [your answer: ${e.myResponse}]` : ''}`;

export type CalendarApi = Pick<FlowApi, 'calendar'>;

const DAY = 86_400_000;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
/** "Name <a@b.c>" or "a@b.c" as the API's attendee, or null for something that is not an address. */
function personOf(s: string): { email: string; name?: string } | null {
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(s);
  const email = (m ? m[2]! : s).trim().toLowerCase();
  const name = m?.[1]?.trim();
  return EMAIL.test(email) ? { email, ...(name ? { name } : {}) } : null;
}

/** How far `zone`'s wall clock is ahead of UTC at instant `t`. */
function offsetMs(t: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(t));
  const n = (k: string) => Number(parts.find((p) => p.type === k)?.value);
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - Math.floor(t / 1000) * 1000;
}
/** The instant a wall-clock time in `zone` names. */
function wallToUtc(y: number, mo: number, d: number, h: number, mi: number, zone: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const t = guess - offsetMs(guess, zone);
  return guess - offsetMs(t, zone);
}

/**
 * The free stretches of at least `durationMs` in [from, to) that no busy interval covers, within `hours` (wall-clock minutes
 * from midnight, Monday to Friday) in `zone`, or at any time when `hours` is null: longest first, then earliest.
 */
export function freeStretches(busy: [number, number][], from: number, to: number, durationMs: number, hours: [number, number] | null, zone: string): [number, number][] {
  const merged: [number, number][] = [];
  for (const [a, b] of busy.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])) {
    const last = merged.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const windows: [number, number][] = [];
  if (!hours) windows.push([from, to]);
  else {
    const first = new Date(from + offsetMs(from, zone));
    for (let d = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate()); ; d += DAY) {
      const day = new Date(d), y = day.getUTCFullYear(), mo = day.getUTCMonth() + 1, dd = day.getUTCDate();
      const start = wallToUtc(y, mo, dd, Math.floor(hours[0] / 60), hours[0] % 60, zone);
      if (start >= to) break;
      if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
      const a = Math.max(start, from), b = Math.min(wallToUtc(y, mo, dd, Math.floor(hours[1] / 60), hours[1] % 60, zone), to);
      if (b > a) windows.push([a, b]);
    }
  }
  const out: [number, number][] = [];
  for (const [ws, we] of windows) {
    let at = ws;
    for (const [bs, be] of merged) {
      if (be <= at || bs >= we) continue;
      if (bs - at >= durationMs) out.push([at, bs]);
      at = Math.max(at, be);
    }
    if (we - at >= durationMs) out.push([at, we]);
  }
  return out.sort((x, y) => (y[1] - y[0]) - (x[1] - x[0]) || x[0] - y[0]);
}

interface FreeBusy { busy: { email: string; intervals: [string, string][]; source?: string }[]; unknown: string[] }

/** One of CALENDAR_TOOLS, as the agent, in its organization: the text for the agent, and whether it is an error. */
export async function calendarTool(api: CalendarApi, workspaceId: string, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  if (!workspaceId) return { text: `${name} needs a workspace (FLOW_WORKSPACE_ID is not set)`, isError: true };
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  try {
    switch (name) {
      case 'list_my_events': {
        const from = String(args.from ?? '').trim(), to = String(args.to ?? '').trim();
        if (!from || !to) return { text: 'list_my_events needs from and to (ISO times)', isError: true };
        const r = await api.calendar<{ events: EventView[] }>('GET', `events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, workspaceId);
        return { text: r.events.length ? r.events.map(line).join('\n') : 'no events in that window', isError: false };
      }
      case 'get_event': {
        if (!id) return { text: 'get_event needs an id', isError: true };
        const { event: e } = await api.calendar<{ event: EventView }>('GET', `events/${encodeURIComponent(id)}`, workspaceId);
        const rows = [
          line(e),
          ...(e.location ? [`where: ${e.location}`] : []),
          ...(e.description ? [`description: ${e.description.slice(0, 2000)}`] : []),
          ...(e.attendees?.length ? [`attendees: ${e.attendees.map((a) => `${who(a)} (${a.response ?? 'needs-action'})`).join(', ')}`] : []),
        ];
        return { text: rows.join('\n'), isError: false };
      }
      case 'respond_to_event': {
        const response = String(args.response ?? '');
        if (!id || !['accepted', 'declined', 'tentative'].includes(response)) return { text: 'respond_to_event needs an id and a response: accepted, declined or tentative', isError: true };
        const comment = typeof args.comment === 'string' && args.comment.trim() ? args.comment.trim().slice(0, 2000) : undefined;
        const r = await api.calendar<{ event: EventView; replied?: string; replyError?: string }>('POST', `events/${encodeURIComponent(id)}/respond`, workspaceId, { response, ...(comment ? { comment } : {}) });
        const told = r.replied === 'failed' ? ` — but the organizer was not told: ${r.replyError ?? 'unknown error'}` : r.replied === 'none' ? '' : ' — the organizer has your answer';
        return { text: `answered ${response} to "${r.event.summary}"${told}`, isError: r.replied === 'failed' };
      }
      case 'find_free_time': {
        const minutes = Number(args.duration_minutes), from = Date.parse(String(args.from ?? '')), to = Date.parse(String(args.to ?? ''));
        if (!(minutes >= 5 && minutes <= 1440) || Number.isNaN(from) || Number.isNaN(to) || to <= from) return { text: 'find_free_time needs duration_minutes (5 to 1440) and from before to (ISO times)', isError: true };
        if (to - from > 31 * DAY) return { text: 'find_free_time looks at most 31 days at a time; ask in parts', isError: true };
        const zone = typeof args.timezone === 'string' && args.timezone.trim() ? args.timezone.trim() : 'UTC';
        try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); } catch { return { text: `timezone: "${zone.slice(0, 60)}" is not an IANA time zone`, isError: true }; }
        const wh = typeof args.working_hours === 'string' ? args.working_hours.trim() : '';
        const m = /^(\d\d):(\d\d)-(\d\d):(\d\d)$/.exec(wh);
        if (wh && wh !== 'any' && !m) return { text: 'working_hours: HH:MM-HH:MM, or "any"', isError: true };
        const hours: [number, number] | null = wh === 'any' ? null : m ? [Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])] : [9 * 60, 17 * 60];
        const others = (Array.isArray(args.attendees) ? args.attendees : []).map((a) => personOf(String(a)));
        if (others.some((p) => !p)) return { text: 'attendees: each one an email address', isError: true };
        const window = { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
        // The agent's own busy time (no addresses: the server answers for the caller), and the attendees'.
        const [mine, theirs] = await Promise.all([
          api.calendar<FreeBusy>('POST', 'freebusy', workspaceId, { emails: [], ...window }),
          others.length ? api.calendar<FreeBusy>('POST', 'freebusy', workspaceId, { emails: [...new Set(others.map((p) => p!.email))], ...window }) : Promise.resolve<FreeBusy>({ busy: [], unknown: [] }),
        ]);
        const busy = [...mine.busy, ...theirs.busy].flatMap((b) => b.intervals.map(([a, z]) => [Date.parse(a), Date.parse(z)] as [number, number]));
        const slots = freeStretches(busy, from, to, minutes * 60_000, hours, zone).slice(0, 10);
        const iso = (t: number) => new Date(t).toISOString().replace(':00.000Z', 'Z');
        const rows = [
          ...(slots.length ? slots.map(([a, b]) => `${iso(a)} – ${iso(b)} (${Math.round((b - a) / 60_000)} min)`) : ['no free time of that length in the window']),
          `working hours: ${hours ? `${wh && wh !== 'any' ? wh : '09:00-17:00'} Mon-Fri ${zone}` : 'any time'}`,
          ...(theirs.busy.length ? [`checked: ${theirs.busy.map((b) => b.email).join(', ')}`] : []),
          ...(theirs.unknown.length ? [`unknown (their calendars cannot be seen; say so when proposing a time): ${theirs.unknown.join(', ')}`] : []),
        ];
        return { text: rows.join('\n'), isError: false };
      }
      case 'create_event': {
        const summary = String(args.summary ?? '').trim(), start = String(args.start ?? '').trim(), end = String(args.end ?? '').trim();
        if (!summary || !start || !end) return { text: 'create_event needs summary, start and end', isError: true };
        const attendees = (Array.isArray(args.attendees) ? args.attendees : []).map((a) => personOf(String(a)));
        if (attendees.some((p) => !p)) return { text: 'attendees: each one "name@example.com" or "Name <name@example.com>"', isError: true };
        const body = {
          summary, start, end,
          ...(attendees.length ? { attendees } : {}),
          ...(typeof args.location === 'string' && args.location.trim() ? { location: args.location.trim().slice(0, 2000) } : {}),
          ...(typeof args.description === 'string' && args.description.trim() ? { description: args.description.slice(0, 32_000) } : {}),
        };
        const r = await api.calendar<{ event: EventView & { calendarId?: string }; invitationsSent?: boolean; invitationsNote?: string }>('POST', 'events', workspaceId, body);
        const e = r.event;
        const guests = (e.attendees ?? []).filter((a) => !a.self && a.email !== e.organizer?.email);
        const members = guests.filter((a) => a.accountId).map((a) => a.email), outside = guests.filter((a) => !a.accountId).map((a) => a.email);
        const rows = [
          `created ${line(e)}`,
          ...(members.length ? [`on their calendars now: ${members.join(', ')}`] : []),
          ...(outside.length ? [r.invitationsSent === false ? `not emailed: ${outside.join(', ')}${r.invitationsNote ? ` (${r.invitationsNote})` : ''}` : `emailed an invitation: ${outside.join(', ')}`] : []),
        ];
        return { text: rows.join('\n'), isError: false };
      }
      default:
        return { text: `unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    return { text: `${name} failed: ${(err as Error).message}`, isError: true };
  }
}
