// The Assistant object (platform.md §5.5) over node:sqlite, with a scripted model and a stand-in Docs object: a turn whose
// server tool runs through the registry against Docs over HTTP, a browser tool paused and resumed, the open app's browser
// tools by the turn's page, one assistant across Docs' and Mail's chats, settings, the owner guard, and the one-time move
// from the Docs objects (routes/admin.ts' moveAssistantRows), run twice.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { AccountDTO } from '@flow/shared';
import type { ModelCall } from '@flow/docs/server/agent/agent.ts';
import type { AgentEvent } from '@flow/docs/shared/agent/protocol.ts';
import { moveAssistantRows } from '../routes/admin';
import { Assistant, type AssistantEnv, type DocsCaller } from './object';

type Params = Parameters<ModelCall>[0];
type Block = Record<string, unknown>;

function storage() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const exec = (query: string, ...args: unknown[]) => {
    const stmt = db.prepare(query);
    const values = args.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v)) as never[];
    if (stmt.columns().length) { const rows = stmt.all(...values); return { toArray: () => rows, rowsWritten: 0 }; }
    const r = stmt.run(...values);
    return { toArray: () => [], rowsWritten: Number(r.changes) };
  };
  return { sql: { exec }, transactionSync: <T>(fn: () => T): T => fn() };
}

/** A stand-in Docs object: the routes the Docs tools use, over a few files, recording each request and its caller. */
function fakeDocs() {
  const calls: { method: string; path: string; caller: DocsCaller; org: string }[] = [];
  const docs = [{ id: 'd0c000000001', kind: 'doc', title: 'Budget notes', updatedAt: '2026-11-06T10:00:00Z' }];
  const markdown = [{ id: 'md0000000001', kind: 'markdown', title: 'Readme', updatedAt: '2026-11-05T10:00:00Z' }];
  const handle = async (req: Request, caller: DocsCaller, org: string): Promise<Response> => {
    const url = new URL(req.url);
    calls.push({ method: req.method, path: url.pathname + url.search, caller, org });
    if (url.pathname === '/api/docs') return Response.json({ docs });
    if (url.pathname === '/api/markdown') return Response.json({ docs: markdown });
    if (url.pathname.startsWith('/api/places/')) return Response.json({ error: 'File not found' }, { status: 404 });
    return Response.json({ error: 'Not found' }, { status: 404 });
  };
  return { calls, ns: { idFromName: (n: string) => n, get: (org: string) => ({ handle: (req: Request, caller: DocsCaller) => handle(req, caller, org) }) } };
}

const message = (content: Block[], stop: string) => ({ id: 'msg', type: 'message', role: 'assistant', model: 'scripted', content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } });
const lastUser = (p: Params) => (p.messages.at(-1)?.content ?? []) as unknown as Block[];

/** The model, scripted: a tool for each request, then the tool's result read back as text. Records each request's tools. */
function scripted(seen: string[][]): ModelCall {
  return async (params, { onText }) => {
    seen.push((params.tools ?? []).map((t) => (t as { name: string }).name));
    const result = lastUser(params).find((b) => b.type === 'tool_result');
    if (result) {
      const text = `Found: ${String(result.content)}`;
      onText(text);
      return message([{ type: 'text', text }], 'end_turn') as never;
    }
    const asked = lastUser(params).filter((b) => b.type === 'text').map((b) => String(b.text)).join(' ');
    const tool = /my docs/.test(asked) ? 'list_docs' : /my files/.test(asked) ? 'list_files' : null;
    if (!tool) { onText('Hello.'); return message([{ type: 'text', text: 'Hello.' }], 'end_turn') as never; }
    return message([{ type: 'tool_use', id: `tu_${tool}`, name: tool, input: {} }], 'tool_use') as never;
  };
}

class TestAssistant extends Assistant {
  script: ModelCall = async () => { throw new Error('no script'); };
  protected override model() { return this.script; }
  protected override keyChecks() { return { key: async () => {}, search: async () => null }; }
}

const ACCOUNT = { id: 'acct-1', principalId: 'user-1', organizationId: 'org-1', state: 'active', role: 'member', address: 'ann@acme.test', displayName: 'Ann' } as unknown as AccountDTO;
const CALLER = { user: { id: 'user-1' }, token: 't', authKind: 'session', ip: '', organizationId: 'org-1', account: ACCOUNT } as never;
const DOCS_CALLER: DocsCaller = { userId: 'user-1', email: 'ann@acme.test', token: 't', ip: '', accountId: 'acct-1', channelIds: ['ch-1'] };

function assistant(name = 'acct-1', env: AssistantEnv = {}) {
  const ctx = { storage: storage(), id: { toString: () => name, name }, waitUntil: () => {} };
  return new TestAssistant(ctx as never, { FLOW_DATA_KEY: 'test-data-key', FLOW_WEB_URL: 'https://app.test', ...env });
}

async function events(res: Response): Promise<AgentEvent[]> {
  const text = await res.text();
  return text.split('\n\n').filter((s) => s.startsWith('data: ')).map((s) => JSON.parse(s.slice(6)) as AgentEvent);
}
const req = (method: string, path: string, body?: unknown) =>
  new Request(`https://app.test${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });

describe('the Assistant object', () => {
  it('runs a turn whose server tool reaches the Docs object over HTTP, through the registry, as the person', async () => {
    const docs = fakeDocs();
    const seen: string[][] = [];
    const a = assistant('acct-1', { DOCS: docs.ns as never });
    a.script = scripted(seen);
    const res = await a.handle(req('POST', '/api/agent/turn', { message: 'What are my docs?', context: { page: 'home' }, workspace: 'org-1' }), CALLER, DOCS_CALLER);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const ev = await events(res);
    expect(ev.map((e) => e.type)).toEqual(['tool_start', 'tool_end', 'text', 'done']);
    expect(ev[0]).toMatchObject({ name: 'list_docs' });
    expect(ev[1]).toMatchObject({ ok: true });
    expect((ev[2] as { text: string }).text).toContain('Budget notes');
    // My files in the account's organization, asked of that organization's Docs object as Ann (her account and channels).
    expect(docs.calls.map((c) => `${c.method} ${c.path} ${c.org}`)).toEqual(['GET /api/docs?workspace=org-1 org-1', 'GET /api/markdown?workspace=org-1 org-1']);
    expect(docs.calls[0]!.caller).toEqual(DOCS_CALLER);
    // Docs' page: its browser tools and every server tool; not Mail's.
    expect(seen[0]).toEqual(expect.arrayContaining(['list_files', 'get_sheet_overview', 'list_docs', 'search_mail', 'list_events']));
    expect(seen[0]).not.toContain('open_mail_message');
    const t = (await (await a.handle(req('GET', '/api/agent?scope=home'), CALLER, DOCS_CALLER)).json()) as { items: { kind: string; name?: string; status?: string }[]; title: null };
    expect(t.title).toBeNull();
    expect(t.items.map((i) => i.kind)).toEqual(['user', 'tool', 'assistant']);
    expect(t.items[1]).toMatchObject({ name: 'list_docs', status: 'ok' });
  });

  it('pauses for a browser tool and resumes with the browser’s result', async () => {
    const a = assistant();
    a.script = scripted([]);
    const first = await events(await a.handle(req('POST', '/api/agent/turn', { message: 'List my files', context: { page: 'home' } }), CALLER, DOCS_CALLER));
    expect(first).toEqual([{ type: 'client_tools', calls: [{ id: 'tu_list_files', name: 'list_files', input: {} }] }]);
    const second = await events(await a.handle(req('POST', '/api/agent/turn', { context: { page: 'home' }, toolResults: [{ id: 'tu_list_files', content: '[{"name":"q3.pdf"}]' }] }), CALLER, DOCS_CALLER));
    expect(second.map((e) => e.type)).toEqual(['text', 'done']);
    expect((second[0] as { text: string }).text).toContain('q3.pdf');
  });

  it('offers the open app’s browser tools by the turn’s page, and keeps Mail’s chat beside Docs’ in one assistant', async () => {
    const seen: string[][] = [];
    const a = assistant();
    a.script = scripted(seen);
    await events(await a.handle(req('POST', '/api/agent/turn', { message: 'Hi', context: { page: 'home' } }), CALLER, DOCS_CALLER));
    const mail = { page: 'mail', accountId: 'm1', account: 'ann@acme.test', folder: 'INBOX' };
    const ev = await events(await a.handle(req('POST', '/api/agent/turn?workspace=org-1', { message: 'Hi from Mail', context: mail, scope: 'mail' }), CALLER, DOCS_CALLER));
    expect(ev.at(-1)).toEqual({ type: 'done' });
    expect(seen[1]).toContain('open_mail_message');
    expect(seen[1]).not.toContain('list_files');
    const items = async (scope: string) => ((await (await a.handle(req('GET', `/api/agent?scope=${scope}`), CALLER, DOCS_CALLER)).json()) as { items: { text?: string }[] }).items;
    expect((await items('mail'))[0]?.text).toBe('Hi from Mail');
    expect((await items('home'))[0]?.text).toBe('Hi');
    // A page no app's manifest names is refused before anything runs.
    const bad = await a.handle(req('POST', '/api/agent/turn', { message: 'x', context: { page: 'nowhere' } }), CALLER, DOCS_CALLER);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'Missing context.' });
    // Reset ends the chat: the next read is empty.
    expect((await a.handle(req('POST', '/api/agent/reset', { scope: 'mail' }), CALLER, DOCS_CALLER)).status).toBe(200);
    expect(await items('mail')).toEqual([]);
  });

  it('keeps the settings, sealed with the deployment’s key, and gives Docs the OpenAI key for its owner only', async () => {
    const a = assistant();
    const get = async () => ((await (await a.handle(req('GET', '/api/settings/assistant'), CALLER, DOCS_CALLER)).json()) as { settings: Record<string, unknown> }).settings;
    expect((await get()).provider).toBe('default');
    const put = await a.handle(req('PUT', '/api/settings/assistant', { provider: 'openai', openaiKey: 'sk-test-0123456789abcdef', openaiModel: 'gpt-6.1-sol' }), CALLER, DOCS_CALLER);
    expect(put.status).toBe(200);
    expect(await get()).toMatchObject({ provider: 'openai', openaiKey: expect.stringMatching(/cdef$/) });
    expect(await a.openaiKey('user-1')).toBe('sk-test-0123456789abcdef');
    expect(await a.openaiKey('user-2')).toBeNull();
    const stored = a.exportRows({ table: 'assistant_settings' })[0]!.rows[0]!;
    expect(String(stored.openai_key)).not.toContain('sk-test');
  });

  it('refuses a caller of another account', async () => {
    const a = assistant();
    await a.handle(req('GET', '/api/agent'), CALLER, DOCS_CALLER);
    const other = { ...CALLER as object, account: { ...ACCOUNT, id: 'acct-2' } } as never;
    const res = await a.handle(req('GET', '/api/agent'), other, DOCS_CALLER);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('wrong_account');
  });
});

describe('the move from the Docs objects (moveAssistantRows)', () => {
  /** A Docs object's assistant rows as they were kept there. */
  function docsRows(rows: Record<string, Record<string, unknown>[]>) {
    return {
      assistantRows: async (table: string, offset = 0, limit = 200) => (rows[table] ?? []).slice(offset, offset + limit),
      assistantMessages: async (id: string, offset = 0, limit = 200) => (rows.agent_messages ?? []).filter((m) => m.conversation_id === id).slice(offset, offset + limit),
    };
  }
  const content = (text: string) => JSON.stringify([{ type: 'text', text }]);

  it('copies each person’s chats, settings and usage to their account’s object, once, and leaves the Docs rows', async () => {
    const acct = (id: string, org: string, user: string) => ({ id, organizationId: org, principalId: user, state: 'active' }) as unknown as AccountDTO;
    const people = [
      { userId: 'user-1', accounts: [acct('acct-1', 'org-1', 'user-1'), acct('acct-3', 'org-2', 'user-1')] },
      { userId: 'user-2', accounts: [acct('acct-2', 'org-2', 'user-2')] },
    ];
    // org-1's Docs object: Ann's home chat (two messages, ids out of order), a chat she started in org-2 (the bug of the
    // Docs client's first-organization routing), her settings and usage; and a stranger's chat, who has no account.
    const org1 = {
      agent_conversations: [
        { id: 'c1', user_id: 'user-1', created_at: '2026-11-01', ended_at: null, pending: null, driver: null, session_id: null, scope: null, workspace_id: 'org-1' },
        { id: 'c2', user_id: 'user-1', created_at: '2026-11-02', ended_at: null, pending: null, driver: null, session_id: null, scope: 'mail', workspace_id: 'org-2' },
        { id: 'c9', user_id: 'user-9', created_at: '2026-11-02', ended_at: null, pending: null, driver: null, session_id: null, scope: null, workspace_id: null },
      ],
      agent_messages: [
        { id: 7, conversation_id: 'c1', role: 'assistant', content: content('Hello Ann'), created_at: '2026-11-01' },
        { id: 3, conversation_id: 'c1', role: 'user', content: content('Hi'), created_at: '2026-11-01' },
        { id: 4, conversation_id: 'c2', role: 'user', content: content('Mail chat'), created_at: '2026-11-02' },
      ],
      assistant_settings: [{ user_id: 'user-1', provider: 'default', openai_model: 'gpt-6.1-sol', openai_key: null, openai_key_masked: null, updated_at: '2026-11-01' }],
      agent_usage: [{ user_id: 'user-1', day: '2026-11-01', requests: 3, input_tokens: 30, output_tokens: 9 }],
    };
    const objects = new Map<string, TestAssistant>();
    const target = (id: string) => objects.get(id) ?? (objects.set(id, assistant(id)), objects.get(id)!);
    const move = () => moveAssistantRows({ docs: (o) => docsRows(o === 'org-1' ? org1 : {}), assistant: (id) => target(id) as never }, people, ['org-1', 'org-2']);

    const first = await move();
    expect(first.moved).toEqual([
      { organizationId: 'org-1', userId: 'user-1', accountId: 'acct-1', conversations: 1, messages: 2, settings: 1, usage: 1, already: 0 },
      { organizationId: 'org-2', userId: 'user-1', accountId: 'acct-3', conversations: 1, messages: 1, settings: 0, usage: 0, already: 0 },
    ]);
    expect(first.skipped).toEqual([{ organizationId: 'org-1', userId: 'user-9', reason: 'no account in the organization' }]);
    // The chat reads back in its order, from Ann's account in org-1, as the panel shows it.
    const a1 = target('acct-1');
    const t = (await (await a1.handle(req('GET', '/api/agent?scope=home'), CALLER, DOCS_CALLER)).json()) as { items: { kind: string; text: string }[] };
    expect(t.items).toEqual([{ kind: 'user', text: 'Hi' }, { kind: 'assistant', text: 'Hello Ann' }]);
    expect(target('acct-3').exportRows({ table: 'agent_conversations' })[0]!.rows.map((r) => r.id)).toEqual(['c2']);

    const again = await move();
    expect(again.moved).toEqual([]);
    expect(again.skipped.map((s) => `${s.organizationId} ${s.userId} ${s.reason}`).sort()).toEqual([
      'org-1 user-1 nothing new to move',
      'org-1 user-9 no account in the organization',
      'org-2 user-1 nothing new to move',
    ]);
    expect(a1.exportRows({ table: 'agent_messages' })[0]!.rows).toHaveLength(2);
    expect(org1.agent_conversations).toHaveLength(3);
  });
});
