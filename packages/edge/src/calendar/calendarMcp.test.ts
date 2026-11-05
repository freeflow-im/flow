// The suite's /mcp lists the Calendar tools by calendar:read and calendar:write, beside Docs' and Mail's, and nothing a
// scope does not allow; where the Worker has no Calendar, none. Listing tools needs no files, so the hub is a stand-in.
import { describe, expect, it } from 'vitest';
import { handleMcp, mcpAccess } from '../docs/plugin/server/worker.ts';
import type { FileHub } from '../docs/plugin/server/files.ts';

const hub = { forUser: () => ({ hub: {} }) } as unknown as FileHub;
const mail = async () => Response.json({ accounts: [] });
const calendar = async (path: string) => (path.endsWith('/calendars') ? Response.json({ calendars: [] }) : Response.json({ accounts: [] }));

async function rpc(scope: string, method: string, params: Record<string, unknown> = {}, withCalendar = true) {
  const req = new Request('https://app.test/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const res = await handleMcp(req, hub, { userId: 'u1', email: 'u1@test', orgId: 'o1', scope, endpoint: '/mcp', origin: 'https://app.test' }, mail, withCalendar ? calendar : undefined);
  return (await res.json()) as { result?: { tools?: { name: string; annotations?: { destructiveHint?: boolean } }[]; content?: { text: string }[]; isError?: boolean; instructions?: string } };
}
const CAL = ['list_calendars', 'list_events', 'get_event', 'find_free_time', 'create_event', 'update_event', 'delete_event', 'respond_to_event'];
const listed = async (scope: string, withCalendar = true) => ((await rpc(scope, 'tools/list', {}, withCalendar)).result?.tools ?? []).map((t) => t.name).filter((n) => CAL.includes(n));

describe('/mcp Calendar tools by scope', () => {
  it('lists the reading tools for calendar:read, all of them for calendar:write, none without a scope or a Calendar', async () => {
    expect(await listed('files:read files:write mail:read')).toEqual([]);
    expect(await listed('calendar:read')).toEqual(['list_calendars', 'list_events', 'get_event', 'find_free_time']);
    expect(await listed('calendar:read calendar:write')).toEqual(CAL);
    expect(await listed('calendar:read calendar:write', false)).toEqual([]);
    const tools = (await rpc('calendar:write', 'tools/list')).result?.tools ?? [];
    expect(tools.find((t) => t.name === 'delete_event')?.annotations?.destructiveHint).toBe(true);
  }, 60_000);

  it('refuses a tool the scopes do not allow, runs one they do, and speaks of Calendar in the instructions', async () => {
    const r = await rpc('calendar:read', 'tools/call', { name: 'create_event', arguments: { summary: 'x', start: '2026-11-05', end: '2026-11-06' } });
    expect(r.result?.isError ?? true).toBe(true);
    const ok = await rpc('calendar:read', 'tools/call', { name: 'list_calendars', arguments: {} });
    expect(JSON.parse(ok.result!.content![0]!.text)).toMatchObject({ calendars: [], note: expect.stringMatching(/app\.test\/calendar/) });
    expect(mcpAccess('calendar:read', true, true)).toMatchObject({ files: 'none', mail: [] });
    const init = await rpc('calendar:read', 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(init.result?.instructions).toMatch(/Calendar:/);
  }, 60_000);
});
