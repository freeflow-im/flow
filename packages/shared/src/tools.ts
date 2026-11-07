// The suite's tools, declared once (docs/specs/platform.md §5.4): what each one is called, which app it belongs to, where
// it runs, which scopes it needs, and what it is told and takes. The implementations stay in their apps (the Worker's
// registry, packages/edge/src/registry, joins the two); the three doors read this list: /mcp (a delegated token, by its
// scopes), the in-app assistant (the person, with the open app's browser tools) and the bridge's `flow` MCP (an agent
// member, over GET /v1/tools?door=bridge).
//
// The per-app lists in ./toolDefinitions are written from the implementations by the Worker's registry test
// (UPDATE_TOOL_DEFINITIONS=1 pnpm --filter @flow/edge exec vitest run src/registry), which fails when they drift apart.
// Not exported from the package's index: the clients that read the manifests do not need these schemas.
import { CALENDAR_TOOLS } from './toolDefinitions/calendar.js';
import { CHAT_TOOLS } from './toolDefinitions/chat.js';
import { DOCS_TOOLS } from './toolDefinitions/docs.js';
import { EVENTS_TOOLS } from './toolDefinitions/events.js';
import { MAIL_TOOLS } from './toolDefinitions/mail.js';

export { CALENDAR_TOOLS, CHAT_TOOLS, DOCS_TOOLS, EVENTS_TOOLS, MAIL_TOOLS };

/** Where a tool is offered: /mcp, the in-app assistant, or the bridge's `flow` MCP server. */
export const TOOL_DOORS = ['mcp', 'assistant', 'bridge'] as const;
export type ToolDoor = (typeof TOOL_DOORS)[number];

/**
 * `server`: runs in the app's object (or, at the bridge's door, in the bridge over HTTP), and is offered at its doors.
 * `browser`: runs in the open editor, against what is on screen; only the assistant has these, and only in its app.
 */
export type ToolKind = 'server' | 'browser';

/** A tool's input, as JSON Schema (an object's). */
export interface ToolInputSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolDefinition {
  name: string;
  /** The app it belongs to: a manifest's name. */
  app: string;
  kind: ToolKind;
  /**
   * The doors that offer it. A tool's name is unique at each door, not across them: the same name may be declared once
   * per door when the doors tell it differently (the assistant's create_mail_draft cannot send; the bridge's
   * get_event is the agent's own calendar).
   */
  doors: ToolDoor[];
  /** The scopes a delegated token needs for it at /mcp, every one of them. Empty where no door checks scopes. */
  scopes: string[];
  description: string;
  input: ToolInputSchema;
  /** It deletes or overwrites what cannot be easily recovered. */
  destructive?: boolean;
  /** The assistant asks the person before it runs (a browser tool's question in the open app). */
  confirm?: boolean;
  /** A browser tool that other apps' pages run too (delete_event, in Docs as in Calendar). */
  runsIn?: string[];
}

/** Every tool of the suite, app by app (Chat's first: the bridge lists them first, as it always has). */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [...CHAT_TOOLS, ...DOCS_TOOLS, ...MAIL_TOOLS, ...CALENDAR_TOOLS, ...EVENTS_TOOLS];

/** The tools offered at a door, in the list's order. */
export const toolsAtDoor = (door: ToolDoor): ToolDefinition[] => TOOL_DEFINITIONS.filter((t) => t.doors.includes(door));

/** One door's tool by name, or undefined. */
export const toolDefinition = (door: ToolDoor, name: string): ToolDefinition | undefined => TOOL_DEFINITIONS.find((t) => t.name === name && t.doors.includes(door));

/** Whether a browser tool runs on this app's page. */
export const runsInApp = (t: ToolDefinition, app: string): boolean => t.app === app || !!t.runsIn?.includes(app);

/** A scope a granted one stands in for: writing files or calendars includes reading them. */
const IMPLIED: Record<string, string[]> = { 'files:write': ['files:read'], 'calendar:write': ['calendar:read'] };

/** The scopes a token has, with the ones its scopes stand in for. */
export function grantedScopes(scopes: readonly string[]): Set<string> {
  const has = new Set(scopes);
  for (const s of scopes) for (const i of IMPLIED[s] ?? []) has.add(i);
  return has;
}

/** Whether a token with these scopes may use a tool at /mcp: every scope the tool names is granted. */
export const allowedBy = (t: ToolDefinition, granted: ReadonlySet<string>): boolean => t.scopes.every((s) => granted.has(s));
