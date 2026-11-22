// The suite's /mcp server (docs/specs/suite-mcp.md §3): it says it is FreeFlow, lists Docs' tools as the plugin describes
// them by the token's scopes, and runs them in the Docs object (here a stand-in that records the calls).
import { describe, expect, it } from 'vitest';
import { TOOL_DEFINITIONS } from '@flow/shared/tools';
import { handleSuiteMcp, type DocsPort, type SuiteDeps } from './suite.ts';
import { toolsFor } from '../registry';

const calls: { name: string; args: Record<string, unknown> }[] = [];
const docs = (pdf = false): DocsPort => ({
  pdf,
  call: async (name, args) => {
    calls.push({ name, args });
    return { content: [{ type: 'text', text: `ran ${name}` }], structuredContent: { ran: name } };
  },
  importFile: async () => ({ file: {}, warnings: [] }),
});

type Tool = { name: string; description?: string; inputSchema?: unknown; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } };
async function rpc(scope: string, method: string, params: Record<string, unknown> = {}, deps: SuiteDeps = { docs: docs() }, endpoint = '/mcp') {
  const req = new Request(`https://app.test${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const res = await handleSuiteMcp(req, { userId: 'u1', email: 'u1@test', orgId: 'o1', scope, endpoint, origin: 'https://app.test' }, deps);
  return (await res.json()) as { result?: { tools?: Tool[]; content?: { type: string; text: string }[]; structuredContent?: unknown; isError?: boolean; instructions?: string; serverInfo?: { name: string; title?: string } } };
}
const names = async (scope: string, deps?: SuiteDeps) => ((await rpc(scope, 'tools/list', {}, deps)).result?.tools ?? []).map((t) => t.name);

describe('the suite’s /mcp server', () => {
  it('says it is FreeFlow, with the suite’s instructions and Docs’ section', async () => {
    const init = await rpc('files:read', 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(init.result?.serverInfo).toMatchObject({ name: 'freeflow', title: 'FreeFlow' });
    expect(init.result?.instructions).toMatch(/^FreeFlow:/);
    expect(init.result?.instructions).toMatch(/\nDocs:/);
    expect(init.result?.instructions).not.toMatch(/MCP Docs/);
  }, 60_000);

  it('lists Docs’ tools by the token’s scopes, as the registry gives them', async () => {
    const want = (scopes: string[]) => toolsFor('mcp', { scopes }).filter((t) => t.definition.app === 'docs' && t.definition.name !== 'export_pdf').map((t) => t.definition.name).sort();
    expect((await names('files:read')).sort()).toEqual(want(['files:read']));
    expect((await names('files:read files:write')).sort()).toEqual(want(['files:read', 'files:write']));
    expect(await names('files:read')).not.toContain('write_range');
    expect(await names('mail:read')).toEqual([]);
    expect(await names('files:read files:write', {})).toEqual([]);
    expect(await names('files:write', { docs: docs(true) })).toContain('export_pdf');
  }, 60_000);

  it('describes each Docs tool as its definition does, annotations included', async () => {
    const tools = (await rpc('files:read files:write', 'tools/list')).result!.tools!;
    for (const t of tools) {
      const def = TOOL_DEFINITIONS.find((d) => d.name === t.name && d.doors.includes('mcp'))!;
      expect(t.description, t.name).toBe(def.description);
    }
    expect(tools.find((t) => t.name === 'read_doc')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'delete_file')?.annotations?.destructiveHint).toBe(true);
  }, 60_000);

  it('runs a Docs tool in the Docs object, and refuses one the scopes do not allow', async () => {
    calls.length = 0;
    const r = await rpc('files:read', 'tools/call', { name: 'read_doc', arguments: { doc_id: 'd1' } });
    expect(r.result?.content?.[0]?.text).toBe('ran read_doc');
    expect(calls).toEqual([{ name: 'read_doc', args: { doc_id: 'd1' } }]);
    const no = await rpc('files:read', 'tools/call', { name: 'write_range', arguments: { range: 'A1', values: [['x']] } });
    expect(no.result?.isError ?? true).toBe(true);
    expect(calls).toHaveLength(1);
  }, 60_000);

  it('answers server/discover (2026-07-28) as FreeFlow, and 404 for a version that is not one', async () => {
    const d = await rpc('files:read', 'server/discover', { _meta: {} });
    expect(JSON.stringify(d)).toMatch(/"name":"freeflow"/);
    const req = new Request('https://app.test/mcp/v9', { method: 'POST', body: '{}' });
    expect((await handleSuiteMcp(req, { userId: 'u1', email: 'u1@test', orgId: 'o1', scope: 'files:read', endpoint: '/mcp/v9', origin: 'https://app.test' }, {})).status).toBe(404);
  }, 60_000);
});
