// Meet's tools (docs/specs/suite-mcp.md §5): at /mcp an agent makes a meeting room and sees the meetings happening now;
// an agent that was sent to a meeting saves its Notes of it (save_meeting_notes, at /mcp and in a hosted agent's turns,
// which its "Meeting notes" automation calls: assistant/meetingWake.ts). They run in the Org object (Org.mcpMeet) as the
// caller: the person a personal agent acts for (with `via` naming the agent), or the shared agent. A room on an event is
// one line of its description (`Join with FreeFlow Meet: <link>`, packages/calendar/src/lib/meet.ts), which every calendar
// shows and FreeFlow Calendar reads back as its Join button. An agent joins a meeting only when a person sends it.
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
  {
    name: 'save_meeting_notes',
    title: 'Save your meeting notes',
    description: 'Saves your notes of a meeting you were sent to (Markdown) as a document in the meeting\'s folder in Docs, owned by the person who sent you, and links it in the meeting\'s chat. meeting_id and session_id are in the meet.ended event. Returns the document\'s link and doc_id.',
    shape: {
      meeting_id: z.string().min(1).max(100).describe('The meeting, from meet.ended (meetingId).'),
      session_id: z.string().max(100).optional().describe('The session, from meet.ended (sessionId). Defaults to the last one you were in.'),
      notes: z.string().min(1).max(100_000).describe('The notes, in Markdown.'),
    },
    scopes: ['meet:write'],
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    doors: ['mcp', 'assistant'],
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
  }, 'doors' in t ? [...t.doors] : ['mcp']);
}

/** The server's instructions for Meet (suite.ts), when the token has a Meet tool. */
export const MEET_INSTRUCTIONS =
  `Meet: video meetings in FreeFlow Meet. create_meeting makes a room and returns its link; to give a calendar event a room, put its event_line ("${MEET_LINE} <link>") as the last line of the event's description. You join a meeting only when a person sends you; save_meeting_notes saves your notes of a meeting you were in.`;
