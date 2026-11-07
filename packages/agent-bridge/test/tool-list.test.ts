// The `flow` MCP server's tool list from the suite's registry (platform.md §5.4, phase 6.2): GET /v1/tools?door=bridge at
// start, the definitions this bridge implements in the server's order, a definition without an implementation skipped
// with a log line, and the built-in list from a server that has no registry. Against a fake server.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { toolsAtDoor } from '@flow/shared/tools';
import { FlowApi } from '../src/api.js';
import { BUILT_IN_TOOLS } from '../src/mcp-server.js';
import { loadToolList, toolListFrom } from '../src/tool-list.js';

let server: http.Server | null = null;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function fake(answer: (path: string, auth: string | undefined) => { status: number; body: unknown }): Promise<{ url: string; hits: string[] }> {
  const hits: string[] = [];
  server = http.createServer((req, res) => {
    hits.push(req.url!);
    const a = answer(req.url!, req.headers.authorization);
    res.writeHead(a.status, { 'content-type': 'application/json' }).end(JSON.stringify(a.body));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, hits };
}

describe('the tool list', () => {
  it('is the built-in list when the registry is the same (the registry is written from it)', () => {
    const defs = toolsAtDoor('bridge');
    expect(defs.map((d) => d.name).sort()).toEqual(BUILT_IN_TOOLS.map((t) => t.name).sort());
    const lines: string[] = [];
    const list = toolListFrom(defs, BUILT_IN_TOOLS, (l) => lines.push(l));
    expect(lines).toEqual([]);
    for (const t of BUILT_IN_TOOLS) expect(list.find((x) => x.name === t.name)).toEqual(t);
  });

  it('reads the definitions from the server, keeps the ones it implements, and logs the rest', async () => {
    const send = toolsAtDoor('bridge').find((d) => d.name === 'send_message')!;
    const s = await fake((path, auth) => ({ status: auth === 'Bearer tok' ? 200 : 401, body: { tools: [{ ...send, description: 'Post it.' }, { name: 'brand_new_tool', description: 'Something this bridge cannot do.', input: { type: 'object' } }] } }));
    const lines: string[] = [];
    const list = await loadToolList(new FlowApi(s.url, 'tok'), BUILT_IN_TOOLS, (l) => lines.push(l));
    expect(s.hits).toEqual(['/v1/tools?door=bridge']);
    expect(list).toEqual([{ name: 'send_message', description: 'Post it.', inputSchema: send.input }]);
    expect(lines).toEqual(['flow mcp: the server defines brand_new_tool, which this bridge does not implement; skipped']);
  });

  it('keeps the built-in list when the server is older (404) or lists nothing', async () => {
    const old = await fake(() => ({ status: 404, body: { error: { code: 'not_found', message: 'not found' } } }));
    const lines: string[] = [];
    expect(await loadToolList(new FlowApi(old.url, 'tok'), BUILT_IN_TOOLS, (l) => lines.push(l))).toEqual(BUILT_IN_TOOLS);
    expect(lines[0]).toMatch(/no tool registry on the server/);
    await new Promise<void>((r) => server!.close(() => r()));
    const empty = await fake(() => ({ status: 200, body: { tools: [] } }));
    expect(await loadToolList(new FlowApi(empty.url, 'tok'), BUILT_IN_TOOLS, () => {})).toEqual(BUILT_IN_TOOLS);
  });
});
