// Meet's tools at /mcp (docs/specs/suite-mcp.md §5): an agent makes a meeting room and sees the meetings happening now.
// They run in the Org object (Org.mcpMeet) as the caller: the person a personal agent acts for, or the shared agent. A
// room on an event is one line of its description (`Join with FreeFlow Meet: <link>`, packages/calendar/src/lib/meet.ts),
// which every calendar shows and FreeFlow Calendar reads back as its Join button. The agent never joins a meeting.
import { z } from 'zod';
import { register } from '../registry';

/** What the Meet tools reach for an /mcp caller (mcp/contexts.ts). */
export interface MeetToolContext {
  /** Runs one Meet tool in the Org object, as the caller. */
  meet(tool: string, input: Record<string, unknown>): Promise<unknown>;
}

/** The line Calendar keeps a room's link in (packages/calendar/src/lib/meet.ts MEET_LINE). */
export const MEET_LINE = 'Join with FreeFlow Meet:';

export const MEET_MCP_TOOLS = [
  {
    name: 'create_meeting',
    title: 'Make a meeting room',
    description: `Makes a FreeFlow Meet room in the organization and returns its link, which anyone with it can open to join (people outside the organization type a name). To put the room on a calendar event, add event_line as the last line of the event's description with create_event or update_event: FreeFlow Calendar shows it as the event's Join button.`,
    shape: { title: z.string().max(200).optional().describe('The meeting’s title, such as the event’s. Defaults to the user’s name.') },
    scopes: ['meet:write'],
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'list_live_meetings',
    title: 'Meetings happening now',
    description: 'The FreeFlow Meet meetings of the organization with people in them now: title, link, when the session started, and who is there.',
    shape: {},
    scopes: ['meet:read'],
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
] as const;

for (const t of MEET_MCP_TOOLS) {
  register<{ meet?: MeetToolContext }>('meet', t.name, {
    run: async (ctx, input) => {
      if (!ctx.meet) throw new Error('Meet is not reachable here.');
      return ctx.meet.meet(t.name, input);
    },
    shape: t.shape,
    title: t.title,
    annotations: t.annotations,
    refusal: (e) => e instanceof Error && !/internal|fetch failed|network/i.test(e.message),
    failure: () => 'Meet could not do that just now. Try again in a moment.',
    needs: 'meet',
  }, ['mcp']);
}

/** The server's instructions for Meet (suite.ts), when the token has a Meet tool. */
export const MEET_INSTRUCTIONS =
  `Meet: video meetings in FreeFlow Meet. create_meeting makes a room and returns its link; to give a calendar event a room, put its event_line ("${MEET_LINE} <link>") as the last line of the event's description. You never join a meeting yourself.`;
