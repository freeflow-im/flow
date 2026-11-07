// The agent's calendar (platform.md §7, phase 4.2): the turn an invitation starts (`invitationPrompt`), and three tools
// on the `flow` MCP server — list_my_events, get_event, respond_to_event — calling /v1/calendar/* as the agent's account
// in the organization the bridge serves (`?workspace=`). Kept apart from mcp-server.ts so the suite runs them against a
// fake server.
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
];
export const CALENDAR_TOOL_NAMES = new Set(CALENDAR_TOOLS.map((t) => t.name));

interface Person { name: string | null; email: string; response?: string }
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
      default:
        return { text: `unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    return { text: `${name} failed: ${(err as Error).message}`, isError: true };
  }
}
