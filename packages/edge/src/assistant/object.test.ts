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
  protected override model(): ModelCall { return (params, opts) => this.script(params, opts); }
  protected override keyChecks() { return { key: async () => {}, search: async () => null }; }
}

const ACCOUNT = { id: 'acct-1', principalId: 'user-1', organizationId: 'org-1', state: 'active', role: 'member', address: 'ann@acme.test', displayName: 'Ann' } as unknown as AccountDTO;
const CALLER = { user: { id: 'user-1' }, token: 't', authKind: 'session', ip: '', organizationId: 'org-1', account: ACCOUNT } as never;
const DOCS_CALLER: DocsCaller = { userId: 'user-1', email: 'ann@acme.test', token: 't', ip: '', accountId: 'acct-1', channelIds: ['ch-1'] };

function assistant(name = 'acct-1', env: AssistantEnv = {}) {
  const ctx = { storage: storage(), id: { toString: () => name, name }, waitUntil: () => {} };
  return new TestAssistant(ctx as never, { FLOW_DATA_KEY: 'test-data-key', FLOW_WEB_URL: 'https://app.test', ANTHROPIC_API_KEY: 'test-platform-key', ...env });
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

  it('keeps the organization’s model in its `org:` object, sealed, and opens it for the runtimes (operator ruling 2026-11-11)', async () => {
    const keeper = assistant();
    expect((await keeper.orgSettings()).provider).toBe('default');
    const saved = await keeper.updateOrgSettings({ provider: 'openai', openaiKey: 'sk-test-0123456789abcdef', openaiModel: 'gpt-6.1-sol' });
    expect(saved).toMatchObject({ ok: true, settings: { provider: 'openai', openaiKey: expect.stringMatching(/cdef$/) } });
    const model = await keeper.orgModel();
    expect(model.choice).toEqual({ provider: 'openai', apiKey: 'sk-test-0123456789abcdef', model: 'gpt-6.1-sol' });
    expect(model.openaiKey).toBe('sk-test-0123456789abcdef');
    expect(model.shown.openaiKey).toMatch(/cdef$/);
    const stored = keeper.exportRows({ table: 'assistant_settings' })[0]!.rows[0]!;
    expect(stored.user_id).toBe('org');
    expect(String(stored.openai_key)).not.toContain('sk-test');
    // A bad choice comes back as an answer, not a thrown error (it crosses the object boundary).
    expect(await keeper.updateOrgSettings({ provider: 'claude-agent' })).toMatchObject({ ok: false });
  });

  it('keeps the agent’s definition, names it as the directory does by default, and puts its instructions in the prompt (agents.md §6)', async () => {
    const a = assistant('acct-1');
    let systems: string[] = [];
    a.script = async (params, { onText }) => {
      systems.push(JSON.stringify(params.system));
      onText('Hi.');
      return message([{ type: 'text', text: 'Hi.' }], 'end_turn') as never;
    };
    // The default: the name the route gives (the directory's "<name>'s assistant"), no instructions.
    let r = (await (await a.handle(req('GET', '/api/agent/definition'), CALLER, DOCS_CALLER, 'Ann’s assistant')).json()) as { definition: { name: string; instructions: string; updatedAt: string | null } };
    expect(r.definition).toEqual({ name: 'Ann’s assistant', instructions: '', updatedAt: null });
    await events(await a.handle(req('POST', '/api/agent/turn', { message: 'hello', context: { page: 'home' }, workspace: 'org-1' }), CALLER, DOCS_CALLER));
    expect(systems[0]).not.toContain('Instructions from the person');
    // It knows its name, as members see it, and not to call itself by the model's.
    expect(systems[0]).toContain('Your name is Ann’s assistant.');
    expect(systems[0]).toContain('never call yourself by the name of the model');
    // Set: the next turn's prompt carries the instructions.
    r = (await (await a.handle(req('PUT', '/api/agent/definition', { name: 'Pip', instructions: 'Answer in haiku.' }), CALLER, DOCS_CALLER)).json()) as typeof r;
    expect(r.definition).toMatchObject({ name: 'Pip', instructions: 'Answer in haiku.' });
    expect(r.definition.updatedAt).toBeTruthy();
    systems = [];
    await events(await a.handle(req('POST', '/api/agent/turn', { message: 'hello again', context: { page: 'home' }, workspace: 'org-1' }), CALLER, DOCS_CALLER));
    expect(systems[0]).toContain('Answer in haiku.');
    expect(systems[0]).toContain('Instructions from the person');
    expect(systems[0]).toContain('Your name is Pip.');
    // The name the directory gives later does not undo the one set.
    r = (await (await a.handle(req('GET', '/api/agent/definition'), CALLER, DOCS_CALLER, 'Ann’s assistant')).json()) as typeof r;
    expect(r.definition.name).toBe('Pip');
    // Bad input is refused.
    expect((await a.handle(req('PUT', '/api/agent/definition', { instructions: 7 }), CALLER, DOCS_CALLER)).status).toBe(400);
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

describe('a hosted agent’s runtime takes a wake job (agents.md §6)', () => {
  const OMNI_ACCOUNT = { id: 'acct-omni', principalId: 'omni', organizationId: 'org-1', state: 'active', role: 'member', address: 'omni@acme.test', displayName: 'Omni', kind: 'native', agentMode: 'shared', sponsorId: 'user-1' } as unknown as AccountDTO;
  const users: Record<string, unknown> = { omni: { id: 'omni', email: 'omni@agents.flow.local', displayName: 'Omni', isAgent: true, agentMode: 'shared' }, 'user-1': { id: 'user-1', email: 'ann@acme.test', displayName: 'Ann', isAgent: false } };
  const accounts: Record<string, unknown> = { 'acct-omni': OMNI_ACCOUNT, 'acct-1': ACCOUNT };
  const job = (id: string, extra: Record<string, unknown> = {}) => ({ id, subscriptionId: 'sub-1', agent: 'acct-omni', eventId: 'e1', eventSeq: 1, prompt: 'Summarize: hello', channelId: 'ch-1', state: 'queued', attempts: 0, depth: 1, createdAt: '', updatedAt: '', ...extra }) as never;
  function env() {
    const posted: Record<string, unknown>[] = [];
    const steps: { job: string; step: string; opts?: unknown }[] = [];
    return {
      posted, steps,
      env: {
        DIRECTORY: { idFromName: (n: string) => n, get: () => ({ call: async (m: string, args: unknown[]) => ({ ok: true, value: m === 'getUser' ? users[args[0] as string] : m === 'accountById' ? accounts[args[0] as string] : null }) }) },
        ORG: { idFromName: (n: string) => n, get: () => ({ channelIdsOf: async () => ['ch-1'], postAutomation: async (p: Record<string, unknown>) => { posted.push(p); return 'm1'; } }) },
        EVENTS: { idFromName: (n: string) => n, get: () => ({ jobStep: async (job: string, _agent: string, step: string, opts?: unknown) => { steps.push({ job, step, opts }); return { id: job, state: step === 'ack' ? 'running' : 'done' }; } }) },
      } as unknown as AssistantEnv,
    };
  }

  it('acks the job, runs the prompt as the shared agent, posts the answer in the channel as the agent, caused by the job, and steps it done', async () => {
    const e = env();
    const a = assistant('acct-omni', e.env);
    const systems: string[] = [];
    a.script = async (params, { onText }) => {
      systems.push(JSON.stringify(params.system));
      onText('Hello was said.');
      return message([{ type: 'text', text: 'Hello was said.' }], 'end_turn') as never;
    };
    await a.setDefinition({ name: 'Omni', instructions: 'Keep it short.' });
    await a.wake({ organizationId: 'org-1', job: job('job-1'), runtime: { runtimeKey: 'acct-omni', agentId: 'omni', agentAccountId: 'acct-omni', mode: 'shared', organizationId: 'org-1', sponsorId: 'user-1', sponsorAccountId: 'acct-1' } });
    expect(e.steps.map((s) => s.step)).toEqual(['ack', 'done']);
    expect(e.steps[1]!.opts).toMatchObject({ ok: true, note: 'Hello was said.' });
    expect(e.posted).toEqual([{ ownerAccountId: 'acct-omni', channelId: 'ch-1', body: 'Hello was said.', clientMsgId: 'job-1', depth: 2, causedBy: 'job-1' }]);
    expect(systems[0]).toContain('Keep it short.');
    // The runtime is the agent's now: a person's request for it is refused as another account's.
    expect((await a.handle(req('GET', '/api/agent?scope=home'), CALLER, DOCS_CALLER)).status).toBe(500);
  });

  it('runs a personal agent’s job as its sponsor, marked via, and reports a failed turn as a failed job', async () => {
    const e = env();
    const a = assistant('acct-1', e.env);
    a.script = async (_p, { onText }) => { onText('Done, Ann.'); return message([{ type: 'text', text: 'Done, Ann.' }], 'end_turn') as never; };
    const runtime = { runtimeKey: 'acct-1', agentId: 'asst', agentAccountId: 'acct-asst', mode: 'personal' as const, organizationId: 'org-1', sponsorId: 'user-1', sponsorAccountId: 'acct-1' };
    await a.wake({ organizationId: 'org-1', job: job('job-2', { agent: 'acct-asst' }), runtime });
    expect(e.posted).toEqual([expect.objectContaining({ ownerAccountId: 'acct-1', body: 'Done, Ann.', causedBy: 'job-2', via: 'asst' })]);
    expect(e.steps.at(-1)).toMatchObject({ step: 'done', opts: { ok: true } });
    // A turn that fails: the job fails with the reason, and nothing is posted.
    a.script = async () => { throw new Error('model down'); };
    await a.wake({ organizationId: 'org-1', job: job('job-3', { agent: 'acct-asst' }), runtime });
    expect(e.posted).toHaveLength(1);
    expect(e.steps.at(-1)).toMatchObject({ step: 'done', opts: { ok: false } });
    // The same person's panel chat is untouched: the job ran in its own conversation.
    const t = (await (await a.handle(req('GET', '/api/agent?scope=home'), CALLER, DOCS_CALLER)).json()) as { items: unknown[] };
    expect(t.items).toEqual([]);
  });
});

describe('the runtime under concurrent use (agents.md §6)', () => {
  it('keeps a running turn’s guard across a definition change: a second turn in the same conversation is still refused', async () => {
    const a = assistant('acct-1');
    let release!: () => void;
    const parked = new Promise<void>((r) => { release = r; });
    let systems: string[] = [];
    a.script = async (params, { onText }) => {
      systems.push(JSON.stringify(params.system));
      if (systems.length === 1) await parked;
      onText('ok');
      return message([{ type: 'text', text: 'ok' }], 'end_turn') as never;
    };
    const first = a.handle(req('POST', '/api/agent/turn', { message: 'one', context: { page: 'home' }, workspace: 'org-1' }), CALLER, DOCS_CALLER);
    await new Promise((r) => setTimeout(r, 10));
    expect((await a.handle(req('PUT', '/api/agent/definition', { instructions: 'Be terse.' }), CALLER, DOCS_CALLER)).status).toBe(200);
    expect((await a.handle(req('POST', '/api/agent/turn', { message: 'two', context: { page: 'home' }, workspace: 'org-1' }), CALLER, DOCS_CALLER)).status).toBe(409);
    release();
    await events(await first);
    // The next turn carries the new instructions.
    systems = [];
    await events(await a.handle(req('POST', '/api/agent/turn', { message: 'three', context: { page: 'home' }, workspace: 'org-1' }), CALLER, DOCS_CALLER));
    expect(systems[0]).toContain('Be terse.');
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

describe('a person’s assistant in Chat posts elsewhere only on its sponsor’s ✅ (agents.md §1, §1.1)', () => {
  const users: Record<string, unknown> = { 'user-1': { id: 'user-1', email: 'ann@acme.test', displayName: 'Ann', isAgent: false, timezone: 'UTC' } };
  const runtime = { runtimeKey: 'acct-1', agentId: 'asst', agentAccountId: 'acct-asst', mode: 'personal' as const, organizationId: 'org-1', sponsorId: 'user-1', sponsorAccountId: 'acct-1' };
  const DM = 'dm-1';
  function env() {
    const posted: { channelId: string; body: string; clientMsgId: string; threadRootId: string | null }[] = [];
    const posts: Record<string, unknown>[] = [];
    let next = 0;
    return {
      posted, posts,
      env: {
        DIRECTORY: { idFromName: (n: string) => n, get: () => ({ call: async (m: string, args: unknown[]) => ({ ok: true, value: m === 'getUser' ? users[args[0] as string] : m === 'accountById' ? ACCOUNT : null }) }) },
        ORG: {
          idFromName: (n: string) => n,
          get: () => ({
            channelIdsOf: async () => [DM, 'ch-gen'],
            agentTyping: async () => undefined,
            postAsAssistant: async (p: { channelId: string; body: string; clientMsgId: string; threadRootId: string | null }) => { posted.push(p); return `m${++next}`; },
            assistantChat: async (p: { op: string; channelId?: string }) => {
              if (p.op === 'channels') return [{ id: 'ch-gen', name: 'general', private: false, assistantIsMember: false }];
              if (p.channelId !== 'ch-gen') throw new Error('No such channel among the ones the user is in. list_channels lists them.');
              return { id: 'ch-gen', name: 'general', private: false, assistantIsMember: false };
            },
            assistantPost: async (p: Record<string, unknown>) => { posts.push(p); return { messageId: 'm-gen', joined: true }; },
          }),
        },
      } as unknown as AssistantEnv,
    };
  }
  /** The model: lists the channels, asks to post, and reads back each result; records what each request offered. */
  function poster(seen: { tools: { name: string; defer?: boolean }[]; results: Block[] }[]): ModelCall {
    return async (params, { onText }) => {
      const results = lastUser(params).filter((b) => b.type === 'tool_result');
      seen.push({ tools: (params.tools ?? []).map((t) => ({ name: (t as { name: string }).name, defer: (t as { defer_loading?: boolean }).defer_loading })), results });
      const said = (text: string) => { onText(text); return message([{ type: 'text', text }], 'end_turn') as never; };
      const last = results.at(-1);
      if (!last) return message([{ type: 'tool_use', id: 'tu-list', name: 'list_channels', input: {} }], 'tool_use') as never;
      if (last.tool_use_id === 'tu-list') {
        onText('I will post it in #general once you approve.');
        return message([{ type: 'text', text: 'I will post it in #general once you approve.' }, { type: 'tool_use', id: 'tu-post', name: 'send_message', input: { channelId: 'ch-gen', text: 'Standup moved to 10.' } }], 'tool_use') as never;
      }
      return said(`Outcome: ${String(last.content)}`);
    };
  }
  const ask = (a: TestAssistant, audience: 'private' | 'shared' = 'private', messageId = 'msg-1') =>
    a.chatTurn({ organizationId: 'org-1', runtime, channelId: DM, threadRootId: null, messageId, prompt: 'Ann asked: post "Standup moved to 10." in #general', audience });
  const cardOf = (e: ReturnType<typeof env>) => e.posted.findIndex((p) => p.clientMsgId === 'card:tu-post') + 1;

  it('runs the Chat tools itself, then stops at a card in the DM, and posts nothing in #general yet', async () => {
    const e = env();
    const a = assistant('acct-1', e.env);
    const seen: { tools: { name: string; defer?: boolean }[]; results: Block[] }[] = [];
    a.script = poster(seen);
    await ask(a);
    // The Chat tools are offered in a Chat turn, loaded up front; Docs' page tools are not.
    const offered = seen[0]!.tools;
    for (const name of ['list_channels', 'read_messages', 'send_message']) expect(offered.find((t) => t.name === name)?.defer, name).toBeFalsy();
    expect(offered.find((t) => t.name === 'leave_channel')?.defer).toBe(true);
    expect(offered.some((t) => t.name === 'write_range')).toBe(false);
    // list_channels ran here, through the Org object, and its result went back to the model.
    expect(String(seen[1]!.results[0]!.content)).toContain('"name":"general"');
    // The text first, then the card, both in the DM; no post anywhere else.
    expect(e.posted.map((p) => p.channelId)).toEqual([DM, DM]);
    expect(e.posted[0]!.body).toBe('I will post it in #general once you approve.');
    expect(e.posted[1]).toMatchObject({ clientMsgId: 'card:tu-post' });
    expect(e.posted[1]!.body).toContain('**Post in #general?** I am not in #general yet, so I will join it first.');
    expect(e.posted[1]!.body).toContain('> Standup moved to 10.');
    expect(e.posts).toEqual([]);
  });

  it('posts on ✅, as the assistant, and goes on with the outcome', async () => {
    const e = env();
    const a = assistant('acct-1', e.env);
    const seen: { tools: { name: string }[]; results: Block[] }[] = [];
    a.script = poster(seen as never);
    await ask(a);
    await a.chatCardAnswered({ organizationId: 'org-1', runtime, cardMessageId: `m${cardOf(e)}`, approve: true });
    expect(e.posts).toEqual([{ agentUserId: 'asst', channelId: 'ch-gen', threadRootId: null, body: 'Standup moved to 10.', clientMsgId: 'assistant-post:tu-post' }]);
    expect(e.posted.at(-1)).toMatchObject({ channelId: DM, body: 'Outcome: The user approved with ✅. Posted in #general, after joining it.' });
    // A second ✅ on the same card does nothing.
    await a.chatCardAnswered({ organizationId: 'org-1', runtime, cardMessageId: `m${cardOf(e)}`, approve: true });
    expect(e.posts).toHaveLength(1);
  });

  it('posts nothing on ❌, and tells the model so', async () => {
    const e = env();
    const a = assistant('acct-1', e.env);
    a.script = poster([]);
    await ask(a);
    await a.chatCardAnswered({ organizationId: 'org-1', runtime, cardMessageId: `m${cardOf(e)}`, approve: false });
    expect(e.posts).toEqual([]);
    expect(e.posted.at(-1)!.body).toBe('Outcome: The user declined with ❌: nothing was posted.');
  });

  it('drops a card the sponsor wrote past, and leaves no card where others read', async () => {
    const e = env();
    const a = assistant('acct-1', e.env);
    a.script = poster([]);
    await ask(a);
    const card = `m${cardOf(e)}`;
    // Ann writes again instead of answering: the turn moves on, and a late ✅ posts nothing.
    a.script = async (_p, { onText }) => { onText('OK.'); return message([{ type: 'text', text: 'OK.' }], 'end_turn') as never; };
    await ask(a, 'private', 'msg-2');
    const before = e.posted.length;
    await a.chatCardAnswered({ organizationId: 'org-1', runtime, cardMessageId: card, approve: true });
    expect(e.posts).toEqual([]);
    expect(e.posted).toHaveLength(before);
    // Asked where others read (a mention in a channel): no card, and the model is told to ask in the DM.
    const shared = env();
    const b = assistant('acct-1', shared.env);
    b.script = poster([]);
    await ask(b, 'shared');
    expect(shared.posted.some((p) => p.clientMsgId === 'card:tu-post')).toBe(false);
    expect(shared.posted.at(-1)!.body).toContain('ask you in your direct messages');
  });
});
