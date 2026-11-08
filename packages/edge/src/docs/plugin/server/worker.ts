// Docs' MCP endpoint on the suite's own host (app.freeflow.im/mcp), inside an organization's Docs object. The Worker has
// already authenticated the bearer token against the directory (routes/mcp.ts): the request comes with the person, the
// organization they chose when they allowed the agent, and the scopes. The tools are the plugin's (mcp.ts) on this object's
// own stores, without ChatGPT's app (no UI resource, no app-only tools), at the newest version of the tools.
//
// Streamable HTTP POST with JSON answers, stateless, plus the 2026-07-28 protocol (stateless.ts). No GET stream: a server
// without one answers 405, which the protocol allows.
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { docsContext } from '../../runtime/context.ts';
import { FileHub, importLimit, ToolError, type FileHubOptions } from './files.ts';
import { createMcpServer, instructionsFor, MCP_VERSIONS, serverInfo, type McpVersion } from './mcp.ts';
import { MAIL_INSTRUCTIONS, MailToolError, mailToolsFor, type MailFetch, type MailTool, type MailToolContext } from '../../../imap/mailTools.ts';
import { CALENDAR_INSTRUCTIONS, CalendarToolError, calendarToolsFor, type CalendarFetch, type CalendarTool, type CalendarToolContext } from '../../../calendar/calendarTools.ts';
import { adaptTransport, discoverResult, isDiscover, SDK_VERSION, STATELESS_VERSION } from './stateless.ts';

export interface McpRequestCaller {
  userId: string;
  email: string;
  orgId: string;
  /** The person's account in `orgId` (platform.md §3.6), when the directory has one. */
  accountId?: string | null;
  scope: string;
  /** The MCP path asked for: /mcp, or a version of it (/mcp/v2). */
  endpoint: string;
  /** The public origin: links in what the tools return point at its /workspace pages. */
  origin: string;
}

/** The newest version of the tools; /mcp serves it here (the ChatGPT plugin's /mcp keeps version 1 on its own host). */
const NEWEST = Math.max(...MCP_VERSIONS) as McpVersion;

/** The version an MCP path serves on the suite's host, or null for a path that is not one. */
export function suiteMcpVersion(endpoint: string): McpVersion | null {
  if (endpoint === '/mcp') return NEWEST;
  const n = Number(/^\/mcp\/v(\d+)$/.exec(endpoint)?.[1]);
  return (MCP_VERSIONS as readonly number[]).includes(n) ? (n as McpVersion) : null;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });

/** Upload tickets kept in the object's SQLite rather than in memory: the agent's upload may come after the object slept. */
function persistTickets(hub: FileHub): void {
  const sql = () => docsContext().sql;
  const ensure = () => sql().exec('CREATE TABLE IF NOT EXISTS _mcp_tickets (ticket TEXT PRIMARY KEY, user_id TEXT NOT NULL, org_id TEXT, folder TEXT, expires_at INTEGER NOT NULL)');
  const UPLOAD_TICKET_MS = 5 * 60_000;
  hub.issueTicket = (userId: string, folder?: string, orgId?: string | null) => {
    ensure();
    const now = Date.now();
    sql().exec('DELETE FROM _mcp_tickets WHERE expires_at < ?', now);
    const ticket = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url');
    sql().exec('INSERT INTO _mcp_tickets (ticket, user_id, org_id, folder, expires_at) VALUES (?, ?, ?, ?, ?)', ticket, userId, orgId ?? null, folder || null, now + UPLOAD_TICKET_MS);
    return ticket;
  };
  hub.redeemTicket = (ticket: string | null | undefined) => {
    if (!ticket) return null;
    ensure();
    const row = sql().exec('DELETE FROM _mcp_tickets WHERE ticket = ? AND expires_at >= ? RETURNING user_id, org_id, folder', ticket, Date.now()).toArray()[0];
    return row ? { userId: row.user_id as string, ...(row.folder ? { folder: row.folder as string } : {}), ...(row.org_id ? { orgId: row.org_id as string } : {}) } : null;
  };
}

/**
 * The directory's people are mirrored into the object's `users` as they are seen (server/app.ts does the same for /api), so
 * that what the agent makes keeps its foreign key to its owner. Someone who never opened Docs in this organization has none.
 */
function mirrorUser(userId: string, email: string): void {
  try {
    docsContext().sql.exec("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, '', ?) ON CONFLICT(id) DO UPDATE SET email = excluded.email WHERE email <> excluded.email", userId, email, new Date().toISOString());
  } catch (err) {
    // Another row holds this email (an account from before the merge): reading still works, making a file will say why not.
    console.error(`mcp: could not mirror user ${userId}: ${(err as Error).message}`);
  }
}

/** The plugin's file service over an object's stores, made once per object. */
export function suiteHub(opts: FileHubOptions, appUrl: string): FileHub {
  const hub = new FileHub({ ...opts, publicUrl: null });
  hub.appUrl = appUrl;
  persistTickets(hub);
  return hub;
}

/** What a token's scopes allow on /mcp: Docs' files (to read only, or to change too), the Mail tools and the Calendar tools. */
export function mcpAccess(scope: string, mailAvailable: boolean, calendarAvailable = false): { files: 'none' | 'read' | 'write'; mail: MailTool[]; calendar: CalendarTool[] } {
  const scopes = scope.split(' ').filter(Boolean);
  const files = scopes.includes('files:write') ? 'write' : scopes.includes('files:read') ? 'read' : 'none';
  return { files, mail: mailAvailable ? mailToolsFor(scopes) : [], calendar: calendarAvailable ? calendarToolsFor(scopes) : [] };
}

/** The server's instructions for what the token can use: Docs' (when it has files), then Mail's and Calendar's (when it has them). */
export const suiteInstructions = (version: McpVersion, access: ReturnType<typeof mcpAccess>): string =>
  [access.files !== 'none' ? instructionsFor(version) : 'FreeFlow, as the user allowed this agent to use it.', access.mail.length ? MAIL_INSTRUCTIONS : '', access.calendar.length ? CALENDAR_INSTRUCTIONS : ''].filter(Boolean).join('\n');

const toolResult = (data: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data });
const toolError = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

/** The Mail tools on an MCP server, each acting on the caller's own Mail object. */
function registerMailTools(mcp: ReturnType<typeof createMcpServer>, tools: MailTool[], ctx: MailToolContext): void {
  for (const tool of tools) {
    mcp.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.shape as never, annotations: tool.annotations }, (async (args: Record<string, unknown>) => {
      try {
        return toolResult(await tool.run(ctx, args ?? {}));
      } catch (e) {
        if (e instanceof MailToolError) return toolError(e.message);
        console.error(`mcp ${tool.name}: ${(e as Error).message}`);
        return toolError('The mail server could not do that just now. Try again in a moment.');
      }
    }) as never);
  }
}

/** The Calendar tools on an MCP server, each acting on the caller's own Calendar object. */
function registerCalendarTools(mcp: ReturnType<typeof createMcpServer>, tools: CalendarTool[], ctx: CalendarToolContext): void {
  for (const tool of tools) {
    mcp.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.shape as never, annotations: tool.annotations }, (async (args: Record<string, unknown>) => {
      try {
        return toolResult(await tool.run(ctx, args ?? {}));
      } catch (e) {
        if (e instanceof CalendarToolError) return toolError(e.message);
        console.error(`mcp ${tool.name}: ${(e as Error).message}`);
        return toolError('The calendar could not do that just now. Try again in a moment.');
      }
    }) as never);
  }
}

/** One MCP request, as `caller`. `mail` and `calendar` reach the caller's own Mail and Calendar objects, where the Worker has them. */
export async function handleMcp(request: Request, hub: FileHub, caller: McpRequestCaller, mail?: MailFetch, calendar?: CalendarFetch): Promise<Response> {
  const version = suiteMcpVersion(caller.endpoint);
  if (!version) return json(404, { error: 'Not found' });
  if (request.method !== 'POST') return json(405, { error: 'This endpoint takes POST (Streamable HTTP, JSON responses); it has no GET stream.' }, { allow: 'POST' });
  const body = await request.json().catch(() => undefined);
  const info = serverInfo(version);
  const access = mcpAccess(caller.scope, !!mail, !!calendar);
  const instructions = suiteInstructions(version, access);
  // ChatGPT and newer clients speak 2026-07-28 (no initialize: server/discover); the SDK speaks 2025-11-25.
  if (isDiscover(body)) return json(200, discoverResult(body, info, { tools: { listChanged: true } }, instructions));
  const headers = new Headers(request.headers);
  const meta = body && typeof body === 'object' && !Array.isArray(body) ? (body as { params?: { _meta?: Record<string, unknown> } }).params?._meta : undefined;
  const stateless = headers.get('mcp-protocol-version') === STATELESS_VERSION || (!!meta && Object.values(meta).includes(STATELESS_VERSION));
  if (headers.get('mcp-protocol-version') === STATELESS_VERSION) headers.set('mcp-protocol-version', SDK_VERSION);
  const sdkRequest = new Request(request.url, { method: 'POST', headers, body: JSON.stringify(body ?? null) });

  mirrorUser(caller.userId, caller.email);
  const service = hub.forUser(caller.userId, caller.orgId);
  const appUrl = `${caller.origin}/workspace`;
  const mcp = createMcpServer(service, {
    bundle: () => {
      throw new Error('The ChatGPT app is not served here.');
    },
    publicUrl: null,
    level: 'tools',
    version,
    uploadUrl: `${caller.origin}/mcp/import/${encodeURIComponent(caller.orgId)}`,
    appUrl,
    instructions,
  });
  // A token without files:write gets the Docs tools that only read; one without files:read either, none of them.
  if (access.files !== 'write') {
    const tools = (mcp as unknown as { _registeredTools: Record<string, { annotations?: { readOnlyHint?: boolean }; remove(): void }> })._registeredTools;
    for (const tool of Object.values(tools)) if (access.files === 'none' || tool.annotations?.readOnlyHint !== true) tool.remove();
  }
  if (mail && access.mail.length) {
    registerMailTools(mcp, access.mail, {
      mail,
      origin: caller.origin,
      saveToDocs: async (bytes, filename) => {
        const r = await service.importFile(bytes, filename, undefined);
        return { file: r.file as unknown as Record<string, unknown>, warnings: r.warnings };
      },
    });
  }
  if (calendar && access.calendar.length) registerCalendarTools(mcp, access.calendar, { calendar, origin: caller.origin });
  const transport = adaptTransport(new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true }) as never, info, stateless) as unknown as WebStandardStreamableHTTPServerTransport;
  try {
    await mcp.connect(transport);
    return await transport.handleRequest(sdkRequest, { parsedBody: body });
  } finally {
    void transport.close();
    void mcp.close();
  }
}

/** An agent's upload (upload_file's address): the ticket in the address is the credential. */
export async function handleMcpImport(request: Request, hub: FileHub): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'POST the file’s bytes.' }, { allow: 'POST' });
  const url = new URL(request.url);
  const ticket = hub.redeemTicket(url.searchParams.get('ticket'));
  if (!ticket) return json(401, { error: 'The upload ticket is missing, used or expired. Ask for a new address with upload_file.' });
  const name = url.searchParams.get('name') ?? undefined;
  const limit = importLimit(name);
  const bytes = Buffer.from(await request.arrayBuffer());
  if (bytes.length > limit) return json(413, { error: `This file must be under ${limit / 1024 / 1024} MB.` });
  try {
    const service = hub.forUser(ticket.userId, ticket.orgId ?? null);
    const r = await service.importFile(bytes, name, url.searchParams.get('title') ?? undefined, ticket.folder);
    service.setOpen({ kind: r.file.kind, id: r.file.id });
    return json(200, r);
  } catch (e) {
    if (e instanceof ToolError) return json(400, { error: e.message });
    throw e;
  }
}
