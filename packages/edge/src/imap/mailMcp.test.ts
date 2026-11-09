// The suite's /mcp (docs/plugin/server/worker.ts) lists exactly what a token's scopes allow: Docs' tools by files:read and
// files:write, the Mail tools by mail:read, mail:write and mail:send, and nothing a scope does not allow. Listing tools
// needs no files, so the hub here is a stand-in.
import { describe, expect, it } from 'vitest';
import { handleMcp, mcpAccess } from '../docs/mcp.ts';
import type { FileHub } from '@flow/docs/plugin/server/files.ts';

const hub = { forUser: () => ({ hub: {} }) } as unknown as FileHub;
const mail = async () => Response.json({ accounts: [] });

async function rpc(scope: string, method: string, params: Record<string, unknown> = {}, withMail = true) {
  const req = new Request('https://app.test/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const res = await handleMcp(req, hub, { userId: 'u1', email: 'u1@test', orgId: 'o1', scope, endpoint: '/mcp', origin: 'https://app.test' }, withMail ? mail : undefined);
  return (await res.json()) as { result?: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean }; error?: { message: string } };
}
const listed = async (scope: string, withMail = true) => ((await rpc(scope, 'tools/list', {}, withMail)).result?.tools ?? []).map((t) => t.name);

describe('/mcp tools by scope', () => {
  it('lists Docs and Mail tools by the token’s scopes', async () => {
    const old = await listed('files:read files:write');
    expect(old).toContain('write_range');
    expect(old.filter((n) => /mail/.test(n))).toEqual([]);

    const readOnly = await listed('files:read');
    expect(readOnly).toContain('read_range');
    expect(readOnly).not.toContain('write_range');

    const mailOnly = await listed('mail:read mail:write');
    expect(mailOnly).not.toContain('read_range');
    expect(mailOnly).not.toContain('list_files');
    expect(mailOnly).toEqual(expect.arrayContaining(['search_mail', 'read_mail', 'create_mail_draft', 'trash_mail']));
    expect(mailOnly).not.toContain('send_mail');
    expect(mailOnly).not.toContain('save_mail_attachment_to_docs');

    const everything = await listed('files:read files:write mail:read mail:write mail:send');
    expect(everything).toEqual(expect.arrayContaining(['write_range', 'search_mail', 'save_mail_attachment_to_docs', 'send_mail']));
    expect(new Set(everything).size).toBe(everything.length);
    // Where the Worker has no Mail, no Mail tools.
    expect((await listed('files:read files:write mail:read mail:write mail:send', false)).filter((n) => /mail/.test(n))).toEqual([]);
  }, 60_000);

  it('refuses a call to a tool the scopes do not allow', async () => {
    const r = await rpc('files:read files:write mail:read mail:write', 'tools/call', { name: 'send_mail', arguments: { to: ['a@b.test'], body: 'hi' } });
    expect(r.error?.message ?? r.result?.content?.[0]?.text).toMatch(/not found/i);
    const ok = await rpc('mail:read', 'tools/call', { name: 'list_mail_accounts', arguments: {} });
    expect(JSON.parse(ok.result!.content![0]!.text)).toMatchObject({ accounts: [] });
  }, 60_000);

  it('says in its instructions what the token can use', async () => {
    expect(mcpAccess('mail:read', true)).toMatchObject({ files: 'none' });
    expect(mcpAccess('files:write', true).files).toBe('write');
    const init = async (scope: string) => {
      const r = await rpc(scope, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } });
      return (r.result as unknown as { instructions: string }).instructions;
    };
    expect(await init('files:read files:write')).not.toMatch(/Mail:/);
    expect(await init('files:read mail:read')).toMatch(/Mail:/);
    expect(await init('mail:read')).not.toMatch(/spreadsheet/);
  }, 60_000);
});
