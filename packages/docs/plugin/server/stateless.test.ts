import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { adaptTransport, discoverResult, isDiscover, isStateless, presentAsSdkVersion, SDK_VERSION, STATELESS_VERSION } from './stateless.ts';

const info = { name: 'docs', version: '1' };

describe('MCP 2026-07-28 compatibility', () => {
  it('answers server/discover with the capabilities and both versions', () => {
    const body = { jsonrpc: '2.0', id: 'd', method: 'server/discover', params: { _meta: {} } };
    expect(isDiscover(body)).toBe(true);
    expect(isDiscover({ method: 'tools/list' })).toBe(false);
    const r = discoverResult(body, info, { tools: {} }, 'hi');
    expect(r.id).toBe('d');
    expect(r.result).toMatchObject({ resultType: 'complete', supportedVersions: [STATELESS_VERSION, SDK_VERSION], capabilities: { tools: {} }, serverInfo: info, instructions: 'hi', cacheScope: 'private' });
  });

  it('presents the new protocol version to the SDK as the one it supports, in both header views', () => {
    const req = new IncomingMessage(new Socket());
    req.headers['mcp-protocol-version'] = STATELESS_VERSION;
    req.rawHeaders.push('MCP-Protocol-Version', STATELESS_VERSION, 'Accept', 'application/json');
    presentAsSdkVersion(req);
    expect(req.headers['mcp-protocol-version']).toBe(SDK_VERSION);
    expect(req.rawHeaders).toEqual(['MCP-Protocol-Version', SDK_VERSION, 'Accept', 'application/json']);
  });

  it('adds resultType, cache hints and serverInfo to lists and resource reads only', async () => {
    const sent: unknown[] = [];
    const fake = { send: async (m: unknown) => void sent.push(m) } as unknown as Parameters<typeof adaptTransport>[0];
    const t = adaptTransport(fake, info);
    await t.send({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
    await t.send({ jsonrpc: '2.0', id: 2, result: { content: [], _meta: { x: 1 } } });
    await t.send({ jsonrpc: '2.0', id: 3, error: { code: -1, message: 'no' } });
    await t.send({ jsonrpc: '2.0', id: 4, result: { contents: [{ uri: 'ui://x', text: '<p>' }] } });
    expect(sent[3]).toMatchObject({ result: { resultType: 'complete', ttlMs: 60_000, cacheScope: 'private', contents: [{ uri: 'ui://x' }] } });
    expect(sent[0]).toMatchObject({ result: { resultType: 'complete', ttlMs: 60_000, cacheScope: 'private', tools: [], _meta: { 'io.modelcontextprotocol/serverInfo': info } } });
    expect(sent[1]).toEqual({ jsonrpc: '2.0', id: 2, result: { content: [], _meta: { x: 1 } } });
    expect((sent[1] as { result: Record<string, unknown> }).result).not.toHaveProperty('ttlMs');
    expect(sent[2]).toEqual({ jsonrpc: '2.0', id: 3, error: { code: -1, message: 'no' } });
  });
  it('gives every result resultType for a request in the newer protocol', async () => {
    const req = { headers: { 'mcp-protocol-version': STATELESS_VERSION }, rawHeaders: [] } as unknown as Parameters<typeof isStateless>[0];
    const old = { headers: { 'mcp-protocol-version': SDK_VERSION }, rawHeaders: [] } as unknown as Parameters<typeof isStateless>[0];
    expect(isStateless(req, undefined)).toBe(true);
    expect(isStateless(old, { method: 'tools/call', params: {} })).toBe(false);
    expect(isStateless(old, { method: 'tools/call', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': STATELESS_VERSION } } })).toBe(true);

    const sent: unknown[] = [];
    const fake = { send: async (m: unknown) => void sent.push(m) } as unknown as Parameters<typeof adaptTransport>[0];
    const t = adaptTransport(fake, info, true);
    await t.send({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'hi' }] } });
    await t.send({ jsonrpc: '2.0', id: 2, error: { code: -1, message: 'no' } });
    expect(sent[0]).toEqual({ jsonrpc: '2.0', id: 1, result: { resultType: 'complete', content: [{ type: 'text', text: 'hi' }] } });
    expect(sent[1]).toEqual({ jsonrpc: '2.0', id: 2, error: { code: -1, message: 'no' } });
  });
});
