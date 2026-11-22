// The meet app's tools (docs/specs/platform.md §5.4), written from their implementations by the Worker's registry test
// (packages/edge/src/registry/registry.test.ts): run it with UPDATE_TOOL_DEFINITIONS=1 after changing a tool, not this file.
import type { ToolDefinition } from '../tools.js';

export const MEET_TOOLS: ToolDefinition[] = [
  {"name":"create_meeting","app":"meet","kind":"server","doors":["mcp"],"scopes":["meet:write"],"description":"Makes a FreeFlow Meet room in the organization and returns its link, which anyone with it can open to join (people outside the organization type a name). To put the room on a calendar event, add event_line as the last line of the event's description with create_event or update_event: FreeFlow Calendar shows it as the event's Join button.","input":{"type":"object","properties":{"title":{"description":"The meeting’s title, such as the event’s. Defaults to the user’s name.","type":"string","maxLength":200}},"$schema":"http://json-schema.org/draft-07/schema#"}},
  {"name":"list_live_meetings","app":"meet","kind":"server","doors":["mcp"],"scopes":["meet:read"],"description":"The FreeFlow Meet meetings of the organization with people in them now: title, link, when the session started, and who is there.","input":{"type":"object","properties":{},"$schema":"http://json-schema.org/draft-07/schema#"}},
];
