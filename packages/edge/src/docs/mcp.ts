// Docs' side of the suite's MCP endpoint (docs/specs/suite-mcp.md §3.3), inside an organization's Docs object. The suite's
// server runs in the Worker (mcp/suite.ts) and calls this object for each Docs tool (Docs.runMcpTool): the plugin's tools
// (plugin/server/mcp.ts) on this object's own stores, as the caller, without ChatGPT's app. Also the uploads that
// upload_file's address takes (handleMcpImport), and a file another app's tool puts in Docs (importDocsFile).
import { docsContext } from '@flow/docs/server/runtime/workerd/context.ts';
import { FileHub, importLimit, ToolError, type FileHubOptions } from '@flow/docs/plugin/server/files.ts';
import { createMcpServer } from '@flow/docs/plugin/server/mcp.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { docsToolOptions, mcpAccess, suiteMcpVersion, type McpRequestCaller } from '../mcp/suite.ts';

export type { McpRequestCaller } from '../mcp/suite.ts';
export { mcpAccess, suiteInstructions, suiteMcpVersion } from '../mcp/suite.ts';

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
export function mirrorUser(userId: string, email: string): void {
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

/**
 * One Docs tool, as `caller`, for the suite's server in the Worker (mcp/suite.ts): the plugin's server on this object's
 * stores, asked over an in-memory connection, so the tool's input is checked and its result shaped as on /mcp. The token's
 * scopes are checked here too.
 */
export async function runDocsTool(hub: FileHub, caller: McpRequestCaller, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const version = suiteMcpVersion(caller.endpoint);
  if (!version) return { content: [{ type: 'text', text: 'Not found.' }], isError: true };
  if (!mcpAccess(caller.scope, false).docs.has(name)) return { content: [{ type: 'text', text: `${name} is not allowed for this connection.` }], isError: true };
  mirrorUser(caller.userId, caller.email);
  const mcp = createMcpServer(hub.forUser(caller.userId, caller.orgId), docsToolOptions(version, caller));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'freeflow-suite', version: '1' });
  await mcp.connect(a);
  await client.connect(b);
  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    void client.close();
    void mcp.close();
  }
}

/** A file put in the caller's Docs from another app (save_mail_attachment_to_docs). */
export async function importDocsFile(hub: FileHub, caller: Pick<McpRequestCaller, 'userId' | 'email' | 'orgId'>, bytes: Uint8Array, filename: string): Promise<{ file: Record<string, unknown>; warnings: string[] }> {
  mirrorUser(caller.userId, caller.email);
  const r = await hub.forUser(caller.userId, caller.orgId).importFile(Buffer.from(bytes), filename, undefined);
  return { file: r.file as unknown as Record<string, unknown>, warnings: r.warnings };
}
