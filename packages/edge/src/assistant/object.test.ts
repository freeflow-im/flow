// The Assistant object (platform.md §5.5) over node:sqlite, with a scripted model and a stand-in Docs object: a turn whose
// server tool runs through the registry against Docs over HTTP, a browser tool paused and resumed, the open app's browser
// tools by the turn's page, one assistant across Docs' and Mail's chats, settings, the owner guard, and the one-time move
// from the Docs objects (routes/admin.ts' moveAssistantRows), run twice.
import { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AccountDTO, MailApprovalDTO } from '@flow/shared';
import type { ModelCall } from '@flow/docs/server/agent/agent.ts';
import type { AgentEvent } from '@flow/docs/shared/agent/protocol.ts';
import { moveAssistantRows } from '../routes/admin';
import { Assistant, type AssistantEnv, type DocsCaller } from './object';
import { MAIL_TOOLS, type MailToolContext } from '../imap/mailTools';

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
  /** The admin agent's calls into the Worker's routes, with their token and `via`. */
  workerCalls: { method: string; path: string; auth: string | null; via: string }[] = [];
  protected override async workerFetch(req: Request, via: string): Promise<Response> {
    const url = new URL(req.url);
    this.workerCalls.push({ method: req.method, path: url.pathname + url.search, auth: req.headers.get('authorization'), via });
    return Response.json({ members: [{ userId: 'u-bob', displayName: 'Bob', role: 'member', kind: 'native', isAgent: false }] });
  }
  protected override model(): ModelCall { return (params, opts) => this.script(params, opts); }
  protected override keyChecks() { return { key: async () => {}, search: async () => null }; }
}

const ACCOUNT = { id: 'acct-1', principalId: 'user-1', organizationId: 'org-1', state: 'active', role: 'member', address: 'ann@acme.test', displayName: 'Ann' } as unknown as AccountDTO;
const CALLER = { user: { id: 'user-1' }, token: 't', authKind: 'session', ip: '', organizationId: 'org-1', account: ACCOUNT } as never;
const DOCS_CALLER: DocsCaller = { userId: 'user-1', email: 'ann@acme.test', token: 't', ip: '', accountId: 'acct-1', channelIds: ['ch-1'] };

// The object loads its agent code in its constructor (agentLib.ts), and the runtime holds requests until that is done:
// here the first object's load is waited for once, before any test.
const loading: Promise<unknown>[] = [];
beforeAll(async () => {
  assistant('warm-up');
  await Promise.all(loading);
});

function assistant(name = 'acct-1', env: AssistantEnv = {}) {
  const ctx = { storage: storage(), id: { toString: () => name, name }, waitUntil: () => {}, blockConcurrencyWhile: (fn: () => Promise<unknown>) => loading.push(fn()) };
  return new TestAssistant(ctx as never, { FLOW_DATA_KEY: 'test-data-key', FLOW_WEB_URL: 'https://app.test', ANTHROPIC_API_KEY: 'test-platform-key', ...env });
}

async function events(res: Response): Promise<AgentEvent[]> {
  const text = await res.text();
  return text.split('\n\n').filter((s) => s.startsWith('data: ')).map((s) => JSON.parse(s.slice(6)) as AgentEvent);
}
const req = (method: string, path: string, body?: unknown) =>
  new Request(`https://app.test${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });

/** The model, scripted for the admin agent: admin_list_members, then its result read back. Records each request's tools. */
function scriptedAdmin(seen: string[][]): ModelCall {
  return async (params, { onText }) => {
    seen.push((params.tools ?? []).map((t) => (t as { name: string }).name));
    const result = lastUser(params).find((b) => b.type === 'tool_result');
    if (result) {
      const text = `Found: ${String(result.content)}`;
      onText(text);
      return message([{ type: 'text', text }], 'end_turn') as never;
    }
    if (!(params.tools ?? []).some((t) => (t as { name: string }).name === 'admin_list_members')) { onText('No.'); return message([{ type: 'text', text: 'No.' }], 'end_turn') as never; }
    return message([{ type: 'tool_use', id: 'tu_members', name: 'admin_list_members', input: {} }], 'tool_use') as never;
  };
}

describe('the admin agent (agents.md §1.4)', () => {
  const CARL = { id: 'acct-carl', principalId: 'u-carl', organizationId: 'org-1', state: 'active', role: 'member', address: null, displayName: 'Carl', agentMode: 'shared', agentRuntime: 'hosted', agentRole: 'admin' } as unknown as AccountDTO;
  const CARL_DOCS: DocsCaller = { userId: 'u-carl', email: '', token: '', ip: '', accountId: 'acct-carl', channelIds: [] };
  const asked = (by: string | null) => ({ user: { id: 'u-carl', isAgent: true }, token: 'admin-token', authKind: 'agent', ip: '', organizationId: 'org-1', account: CARL, ...(by ? { invokedBy: by } : {}) }) as never;

  it('runs a panel turn with the admin tools, calling the routes with the asking admin\'s token, via the agent', async () => {
    const seen: string[][] = [];
    const a = assistant('acct-carl');
    await a.adopt(CARL, 'Carl', 'admin');
    a.script = scriptedAdmin(seen);
    const ev = await events(await a.handle(req('POST', '/api/agent/turn', { message: 'Who is here?', context: { page: 'home' }, workspace: 'org-1' }), asked('acct-scott'), CARL_DOCS, 'Carl', { conversationUser: 'u-scott' }));
    expect(ev.map((e) => e.type)).toEqual(['tool_start', 'tool_end', 'text', 'done']);
    expect((ev[2] as { text: string }).text).toContain('Bob');
    expect(seen[0]).toContain('admin_remove_member');
    expect(a.workerCalls).toEqual([{ method: 'GET', path: '/v1/workspaces/org-1/members?all=1', auth: 'Bearer admin-token', via: 'u-carl' }]);
  });

  it('offers no admin tools to another agent, or when the browser claims them', async () => {
    const seen: string[][] = [];
    const a = assistant('acct-carl');
    await a.adopt({ ...CARL, agentRole: undefined } as never, 'Omni');
    a.script = scriptedAdmin(seen);
    await events(await a.handle(req('POST', '/api/agent/turn', { message: 'Who is here?', context: { page: 'home', admin: true }, workspace: 'org-1' }), asked('acct-scott'), CARL_DOCS, 'Omni', { conversationUser: 'u-scott' }));
    expect(seen[0]!.some((n) => n.startsWith('admin_'))).toBe(false);
    expect(a.workerCalls).toEqual([]);
  });

  it('offers none in a turn no person asked for', async () => {
    const seen: string[][] = [];
    const a = assistant('acct-carl');
    await a.adopt(CARL, 'Carl', 'admin');
    a.script = scriptedAdmin(seen);
    await events(await a.handle(req('POST', '/api/agent/turn', { message: 'Who is here?', context: { page: 'home' }, workspace: 'org-1' }), asked(null), CARL_DOCS, 'Carl', { conversationUser: 'u-scott' }));
    expect(seen[0]!.some((n) => n.startsWith('admin_'))).toBe(false);
  });
});

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

describe('the assistant’s own mailbox (agents.md §1.1)', () => {
  const ADA = { id: 'acct-ada', principalId: 'ada', organizationId: 'org-1', state: 'active', role: 'member', address: 'ada@acme.test', displayName: 'Ada', kind: 'personal_agent', agentMode: 'personal', sponsorId: 'user-1' } as unknown as AccountDTO;
  const users: Record<string, unknown> = { ada: { id: 'ada', email: 'agent-ada@agents.flow.local', displayName: 'Ada', isAgent: true }, 'user-1': { id: 'user-1', email: 'ann@acme.test', displayName: 'Ann', isAgent: false } };
  /** Two Mail objects: Ann's (her Gmail) and Ada's (her hosted mailbox); each answers only its own account's caller. */
  function mailNs(seen: string[]) {
    const lists: Record<string, unknown[]> = {
      'acct-1': [{ id: 'gmail-1', email: 'ann@gmail.test', displayName: 'Ann', status: 'ok', tabs: [] }],
      'acct-ada': [{ id: 'hosted-ada', email: 'ada@acme.test', displayName: 'Ada', status: 'ok', tabs: [] }],
    };
    return {
      idFromName: (n: string) => n,
      get: (owner: string) => ({
        handle: async (r: Request, caller: { account: { id: string } }) => {
          const path = new URL(r.url).pathname;
          seen.push(`${owner} ${caller.account.id} ${path}`);
          if (caller.account.id !== owner) return Response.json({ error: { code: 'wrong_account' } }, { status: 500 });
          if (path === '/v1/mail/accounts') return Response.json({ accounts: lists[owner] });
          return Response.json({ messages: [{ uid: 7, subject: `In ${owner}` }], next: null });
        },
      }),
    };
  }

  it('lists the assistant’s own mailbox beside the person’s, marked yours, reads it as the assistant, and names its address in the prompt', async () => {
    const seen: string[] = [];
    const a = assistant('acct-1', {
      DIRECTORY: { idFromName: (n: string) => n, get: () => ({ call: async (m: string, args: unknown[]) => ({ ok: true, value: m === 'getUser' ? users[args[0] as string] : m === 'accountById' ? (args[0] === 'acct-ada' ? ADA : ACCOUNT) : null }) }) },
      MAIL: mailNs(seen),
    } as unknown as AssistantEnv);
    const systems: string[] = [];
    a.script = async (params, { onText }) => { systems.push(JSON.stringify(params.system)); onText('ok'); return message([{ type: 'text', text: 'ok' }], 'end_turn') as never; };
    await events(await a.handle(req('POST', '/api/agent/turn', { message: 'Can you see your own inbox?', context: { page: 'home' }, workspace: 'org-1' }), CALLER, DOCS_CALLER, 'Ada', { agentAccountId: 'acct-ada', agentMode: 'personal' }));
    expect(systems[0]).toContain('your own email address, ada@acme.test');
    // The mail tools' context, as a turn of Ann's assistant gets it (the turn runs as Ann).
    const ctx = (a as unknown as { mailContext(scope: string, who: unknown): MailToolContext }).mailContext('home', { caller: CALLER, docs: DOCS_CALLER });
    const list = MAIL_TOOLS.find((t) => t.name === 'list_mail_accounts')!;
    const listed = (await list.run(ctx as never, {})) as { accounts: { email: string; yours?: boolean }[] };
    expect(listed.accounts).toEqual([expect.objectContaining({ email: 'ann@gmail.test' }), expect.objectContaining({ email: 'ada@acme.test', yours: true })]);
    expect(listed.accounts[0]).not.toHaveProperty('yours');
    // A request for Ada's account goes to her Mail object, as her account; Ann's to Ann's.
    await ctx.mail('/v1/mail/accounts/hosted-ada/messages?folder=INBOX');
    await ctx.mail('/v1/mail/accounts/gmail-1/messages?folder=INBOX');
    expect(seen).toContain('acct-ada acct-ada /v1/mail/accounts/hosted-ada/messages');
    expect(seen).toContain('acct-1 acct-1 /v1/mail/accounts/gmail-1/messages');
    expect(seen.some((l) => l.startsWith('acct-ada acct-1') || l.startsWith('acct-1 acct-ada'))).toBe(false);
  });

  it('tells an assistant with no address nothing about a mailbox', async () => {
    const a = assistant('acct-1', {
      DIRECTORY: { idFromName: (n: string) => n, get: () => ({ call: async (m: string) => ({ ok: true, value: m === 'accountById' ? { ...ADA, address: null } : null }) }) },
    } as unknown as AssistantEnv);
    const systems: string[] = [];
    a.script = async (params, { onText }) => { systems.push(JSON.stringify(params.system)); onText('hi'); return message([{ type: 'text', text: 'hi' }], 'end_turn') as never; };
    await events(await a.handle(req('POST', '/api/agent/turn', { message: 'Hi', context: { page: 'home' } }), CALLER, DOCS_CALLER, 'Ada', { agentAccountId: 'acct-ada', agentMode: 'personal' }));
    expect(systems[0]).not.toContain('your own email address');
  });
});

describe('incoming email wakes the assistant through its subscription (decision_log 2026-11-17, R-B)', () => {
  const ADA = { id: 'acct-ada', principalId: 'ada', organizationId: 'org-1', state: 'active', role: 'member', address: 'ada@acme.test', displayName: 'Ada', kind: 'personal_agent', agentMode: 'personal', sponsorId: 'user-1' } as unknown as AccountDTO;
  const users: Record<string, unknown> = { ada: { id: 'ada', email: 'agent-ada@agents.flow.local', displayName: 'Ada', isAgent: true }, 'user-1': { id: 'user-1', email: 'ann@acme.test', displayName: 'Ann', isAgent: false, timezone: 'UTC' } };
  const runtime = { runtimeKey: 'acct-1', agentId: 'ada', agentAccountId: 'acct-ada', mode: 'personal' as const, organizationId: 'org-1', sponsorId: 'user-1', sponsorAccountId: 'acct-1' };
  function env() {
    const subs = new Map<string, Record<string, unknown>>();
    const mailed: Record<string, unknown>[] = [];
    const steps: { step: string; opts?: Record<string, unknown> }[] = [];
    let n = 0;
    return {
      subs, mailed, steps,
      env: {
        DIRECTORY: { idFromName: (x: string) => x, get: () => ({ call: async (m: string, args: unknown[]) => ({ ok: true, value: m === 'getUser' ? users[args[0] as string] : m === 'accountById' ? (args[0] === 'acct-ada' ? ADA : ACCOUNT) : null }) }) },
        ORG: { idFromName: (x: string) => x, get: () => ({ channelIdsOf: async () => [] }) },
        EVENTS: {
          idFromName: (x: string) => x,
          get: () => ({
            getSubscription: async (id: string) => subs.get(id) ?? null,
            createSubscription: async (sub: Record<string, unknown>) => { const made = { ...sub, id: `sub-${++n}` }; subs.set(made.id, made); return made; },
            deleteSubscription: async (id: string) => subs.delete(id),
            jobTrigger: async (_id: string, agent: string) => (agent === 'acct-ada' ? { id: 'e1', seq: 1, type: 'mail.received', ref: { organizationId: 'org-1', app: 'mail', kind: 'message', id: 'hosted-ada:INBOX:4' } } : null),
            jobStep: async (id: string, _a: string, step: string, opts?: Record<string, unknown>) => { steps.push({ step, opts }); return { id, state: step === 'ack' ? 'running' : 'done' }; },
          }),
        },
        MAIL: {
          idFromName: (x: string) => x,
          get: (owner: string) => ({
            handle: async (r: Request, caller: { account: { id: string } }) => {
              const path = new URL(r.url).pathname;
              if (owner !== 'acct-ada' || caller.account.id !== 'acct-ada') return Response.json({ accounts: [] });
              if (path === '/v1/mail/accounts') return Response.json({ accounts: [{ id: 'hosted-ada', email: 'ada@acme.test', displayName: 'Ada', status: 'ok', tabs: [] }] });
              if (path === '/v1/mail/accounts/hosted-ada/messages/4') {
                return Response.json({ message: { from: { name: 'Ann', address: 'ann@acme.test' }, to: [], cc: [], bcc: [], replyTo: [], subject: 'Plan my week', date: '2026-11-17T08:00:00Z', folder: 'INBOX', seen: false, flagged: false, messageId: '<m4@acme.test>', text: 'What is on my plate?', html: null, attachments: [] } });
              }
              return Response.json({ error: 'not found' }, { status: 404 });
            },
            sendAsAssistant: async (p: Record<string, unknown>) => { mailed.push(p); return { ok: true }; },
          }),
        },
      } as unknown as AssistantEnv,
    };
  }
  const put = (a: TestAssistant, body: unknown) => a.handle(req('PUT', '/api/agent/mail-allowlist', body), CALLER, DOCS_CALLER, 'Ada', { agentAccountId: 'acct-ada', agentMode: 'personal' });

  it('keeps one answering subscription while answering is on and a sender is allowed, and none otherwise', async () => {
    const e = env();
    const a = assistant('acct-1', e.env);
    await put(a, { senders: ['ann@acme.test'] });
    expect(e.subs.size).toBe(0);
    await put(a, { autoReply: true });
    expect([...e.subs.values()]).toEqual([expect.objectContaining({ consumer: 'acct-ada', owner: 'acct-1', createdBy: 'acct-1', delivery: 'wake', filter: { types: ['mail.received'], consumerOwn: true }, action: expect.objectContaining({ reply: 'mail' }) })]);
    // Asked again (the mailbox's check, every few minutes): the same one stays.
    expect(await a.syncMailWake({ organizationId: 'org-1', agentAccountId: 'acct-ada' })).toBe('on');
    expect(e.subs.size).toBe(1);
    // The sponsor deleted it from their Automations list: answering turns off, and the next check does not make it again.
    e.subs.clear();
    expect(await a.syncMailWake({ organizationId: 'org-1', agentAccountId: 'acct-ada' })).toBe('off');
    expect(await a.mailAutoReply()).toBe(false);
    expect(await a.syncMailWake({ organizationId: 'org-1', agentAccountId: 'acct-ada' })).toBe('off');
    expect(e.subs.size).toBe(0);
    await put(a, { autoReply: true });
    expect(e.subs.size).toBe(1);
    await put(a, { autoReply: false });
    expect(e.subs.size).toBe(0);
  });

  it('runs the job as a headless turn with every tool, and mails the answer back to the sender, in the thread', async () => {
    const e = env();
    const a = assistant('acct-1', e.env);
    await put(a, { senders: ['ann@acme.test'], autoReply: true });
    const sub = [...e.subs.values()][0]!;
    const seen: { tools: string[]; text: string }[] = [];
    a.script = async (params, { onText }) => {
      seen.push({ tools: (params.tools ?? []).map((t) => (t as { name: string }).name), text: lastUser(params).filter((b) => b.type === 'text').map((b) => String(b.text)).join('\n') });
      onText('Tuesday: the budget review.');
      return message([{ type: 'text', text: 'Tuesday: the budget review.' }], 'end_turn') as never;
    };
    const job = { id: 'job-m1', subscriptionId: sub.id, agent: 'acct-ada', eventId: 'e1', eventSeq: 1, prompt: (sub.action as { prompt: string }).prompt, state: 'queued', attempts: 0, depth: 1, createdAt: '', updatedAt: '' } as never;
    await a.wake({ organizationId: 'org-1', job, runtime });
    // Every tool it may use, Chat's among them (Ada once said "Chat access isn't available here").
    expect(seen[0]!.tools).toEqual(expect.arrayContaining(['list_channels', 'send_message', 'read_messages', 'search_mail', 'insert_content']));
    expect(seen[0]!.text).toContain('From: ann@acme.test (a sender Ann allows)');
    expect(seen[0]!.text).toContain('What is on my plate?');
    expect(e.mailed).toEqual([{ to: 'ann@acme.test', subject: 'Re: Plan my week', text: 'Tuesday: the budget review.', inReplyTo: '<m4@acme.test>' }]);
    expect(e.steps.at(-1)).toMatchObject({ step: 'done', opts: { ok: true } });
    // Its conversation is the sender's, kept across their emails.
    const convs = (a as unknown as { sql: { exec(q: string): { toArray(): { user_id: string }[] } } }).sql.exec('SELECT user_id FROM agent_conversations').toArray().map((r) => r.user_id);
    expect(convs).toContain('mail:ann@acme.test');
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
        EVENTS: { idFromName: (n: string) => n, get: () => ({
          jobStep: async (job: string, _agent: string, step: string, opts?: unknown) => { steps.push({ job, step, opts }); return { id: job, state: step === 'ack' ? 'running' : 'done' }; },
          jobBrief: async (job: string) => (job === 'job-1' ? 'An automation woke you: "s". It fired for this event: …\n\nSummarize: hello' : null),
        }) },
      } as unknown as AssistantEnv,
    };
  }

  it('acks the job, runs the prompt as the shared agent, posts the answer in the channel as the agent, caused by the job, and steps it done', async () => {
    const e = env();
    const a = assistant('acct-omni', e.env);
    const systems: string[] = [];
    const asked: string[] = [];
    a.script = async (params, { onText }) => {
      systems.push(JSON.stringify(params.system));
      asked.push(JSON.stringify(params.messages));
      onText('Hello was said.');
      return message([{ type: 'text', text: 'Hello was said.' }], 'end_turn') as never;
    };
    await a.setDefinition({ name: 'Omni', instructions: 'Keep it short.' });
    await a.wake({ organizationId: 'org-1', job: job('job-1'), runtime: { runtimeKey: 'acct-omni', agentId: 'omni', agentAccountId: 'acct-omni', mode: 'shared', organizationId: 'org-1', sponsorId: 'user-1', sponsorAccountId: 'acct-1' } });
    expect(e.steps.map((s) => s.step)).toEqual(['ack', 'done']);
    expect(e.steps[1]!.opts).toMatchObject({ ok: true, note: 'Hello was said.' });
    expect(e.posted).toEqual([{ ownerAccountId: 'acct-omni', channelId: 'ch-1', body: 'Hello was said.', clientMsgId: 'job-1', depth: 2, causedBy: 'job-1' }]);
    expect(systems[0]).toContain('Keep it short.');
    // The turn runs the brief (the automation and its event), not the bare prompt.
    expect(asked[0]).toContain('An automation woke you');
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

  it('starts each job of a subscription in a new conversation: an earlier run’s answer is not replayed', async () => {
    const e = env();
    const a = assistant('acct-1', e.env);
    const seen: number[] = [];
    a.script = async (params, { onText }) => {
      seen.push((params.messages as unknown[]).length);
      onText('I could not reach your mail.');
      return message([{ type: 'text', text: 'I could not reach your mail.' }], 'end_turn') as never;
    };
    const runtime = { runtimeKey: 'acct-1', agentId: 'asst', agentAccountId: 'acct-asst', mode: 'personal' as const, organizationId: 'org-1', sponsorId: 'user-1', sponsorAccountId: 'acct-1' };
    await a.wake({ organizationId: 'org-1', job: job('job-4', { agent: 'acct-asst' }), runtime });
    await a.wake({ organizationId: 'org-1', job: job('job-5', { agent: 'acct-asst' }), runtime });
    // Each run's model call sees only its own prompt, not the run before it.
    expect(seen).toEqual([1, 1]);
  });
});

describe('every turn with no page open runs its tools (decision_log 2026-11-17)', () => {
  const users: Record<string, unknown> = { 'user-1': { id: 'user-1', email: 'ann@acme.test', displayName: 'Ann', isAgent: false, timezone: 'UTC' } };
  const runtime = { runtimeKey: 'acct-1', agentId: 'asst', agentAccountId: 'acct-asst', mode: 'personal' as const, organizationId: 'org-1', sponsorId: 'user-1', sponsorAccountId: 'acct-1' };
  const job = (id: string) => ({ id, subscriptionId: 'sub-9', agent: 'acct-asst', eventId: 'e1', eventSeq: 1, prompt: 'Summarize #general into the notes doc.', channelId: 'ch-1', state: 'queued', attempts: 0, depth: 1, createdAt: '', updatedAt: '' }) as never;
  function env() {
    const chat: Record<string, unknown>[] = [];
    const mcp: { body: { method: string; params: { name: string; arguments: Record<string, unknown> } }; caller: Record<string, unknown> }[] = [];
    const posted: Record<string, unknown>[] = [];
    return {
      chat, mcp, posted,
      env: {
        DIRECTORY: { idFromName: (n: string) => n, get: () => ({ call: async (m: string, args: unknown[]) => ({ ok: true, value: m === 'getUser' ? users[args[0] as string] : m === 'accountById' ? ACCOUNT : null }) }) },
        ORG: {
          idFromName: (n: string) => n,
          get: () => ({
            channelIdsOf: async () => ['ch-1'],
            postAutomation: async (p: Record<string, unknown>) => { posted.push(p); return 'm1'; },
            assistantChat: async (p: Record<string, unknown>) => { chat.push(p); return [{ id: 'm-7', from: 'Bob', at: '2026-11-17T09:00:00Z', text: 'Ship it Friday.' }]; },
          }),
        },
        DOCS: {
          idFromName: (n: string) => n,
          get: () => ({
            mcp: async (req: Request, caller: Record<string, unknown>) => {
              const body = (await req.json()) as (typeof mcp)[number]['body'];
              mcp.push({ body, caller });
              return Response.json({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ doc_id: 'd0c000000001', inserted: 1 }) }] } });
            },
          }),
        },
        EVENTS: { idFromName: (n: string) => n, get: () => ({ jobStep: async (id: string, _a: string, step: string) => ({ id, state: step === 'ack' ? 'running' : 'done' }) }) },
      } as unknown as AssistantEnv,
    };
  }

  it('runs an automation’s Chat and Docs calls itself, with real results, and refuses a page-only tool with the reason', async () => {
    const e = env();
    const a = assistant('acct-1', e.env);
    const seen: { tools: string[]; results: Block[] }[] = [];
    a.script = async (params, { onText }) => {
      const results = lastUser(params).filter((b) => b.type === 'tool_result');
      seen.push({ tools: (params.tools ?? []).map((t) => (t as { name: string }).name), results });
      if (!results.length) return message([{ type: 'tool_use', id: 'tu-read', name: 'read_messages', input: { channelId: 'ch-gen' } }], 'tool_use') as never;
      if (results[0]!.tool_use_id === 'tu-read') {
        return message([
          { type: 'tool_use', id: 'tu-ins', name: 'insert_content', input: { doc_id: 'd0c000000001', markdown: 'Ship it Friday.' } },
          { type: 'tool_use', id: 'tu-open', name: 'open_doc', input: { doc_id: 'd0c000000001' } },
        ], 'tool_use') as never;
      }
      onText('Added the summary.');
      return message([{ type: 'text', text: 'Added the summary.' }], 'end_turn') as never;
    };
    await a.wake({ organizationId: 'org-1', job: job('job-r1'), runtime });
    // The turn was offered Chat's tools and Docs' editing tools, with no page.
    expect(seen[0]!.tools).toEqual(expect.arrayContaining(['list_channels', 'read_messages', 'send_message', 'insert_content', 'write_range', 'search_mail']));
    expect(seen[0]!.tools).not.toContain('open_doc');
    // read_messages ran through the Org object as the assistant (its sponsor's reach), and its result went back.
    expect(e.chat).toEqual([expect.objectContaining({ agentUserId: 'asst', op: 'read', channelId: 'ch-gen' })]);
    expect(String(seen[1]!.results[0]!.content)).toContain('Ship it Friday.');
    // insert_content ran headless in the Docs object's /mcp door, as the sponsor via the assistant.
    expect(e.mcp).toHaveLength(1);
    expect(e.mcp[0]!.body).toMatchObject({ method: 'tools/call', params: { name: 'insert_content', arguments: { doc_id: 'd0c000000001' } } });
    expect(e.mcp[0]!.caller).toMatchObject({ userId: 'user-1', orgId: 'org-1', via: 'asst', scope: 'files:read files:write' });
    const [ins, open] = seen[2]!.results;
    expect(String(ins!.content)).toContain('"inserted":1');
    expect(open).toMatchObject({ is_error: true });
    expect(String(open!.content)).toMatch(/open_doc works on a page open in the app/);
    // The answer is posted in the job's channel.
    expect(e.posted).toEqual([expect.objectContaining({ channelId: 'ch-1', body: 'Added the summary.', causedBy: 'job-r1' })]);
  });

  it('gives a shared agent asked in Chat its Chat tools, with its own reach', async () => {
    const e = env();
    const omniUsers: Record<string, unknown> = { omni: { id: 'omni', email: 'omni@agents.flow.local', displayName: 'Omni', isAgent: true } };
    const OMNI = { id: 'acct-omni', principalId: 'omni', organizationId: 'org-1', state: 'active', role: 'member', displayName: 'Omni', kind: 'native', agentMode: 'shared' } as unknown as AccountDTO;
    const shared: Record<string, unknown>[] = [];
    const env2 = {
      ...e.env,
      DIRECTORY: { idFromName: (n: string) => n, get: () => ({ call: async (m: string, args: unknown[]) => ({ ok: true, value: m === 'getUser' ? omniUsers[args[0] as string] : m === 'accountById' ? OMNI : null }) }) },
      ORG: { idFromName: (n: string) => n, get: () => ({ channelIdsOf: async () => ['ch-1'], agentTyping: async () => undefined, assistantChat: async (p: Record<string, unknown>) => { e.chat.push(p); return []; }, postAsSharedAgent: async (p: Record<string, unknown>) => { shared.push(p); return 'm1'; } }) },
    } as unknown as AssistantEnv;
    const a = assistant('acct-omni', env2);
    a.script = async (params, { onText }) => {
      if (!lastUser(params).some((b) => b.type === 'tool_result')) return message([{ type: 'tool_use', id: 'tu-ch', name: 'list_channels', input: {} }], 'tool_use') as never;
      onText('You have no channels in common with me.');
      return message([{ type: 'text', text: 'You have no channels in common with me.' }], 'end_turn') as never;
    };
    const omniRuntime = { runtimeKey: 'acct-omni', agentId: 'omni', agentAccountId: 'acct-omni', mode: 'shared' as const, organizationId: 'org-1', sponsorId: 'user-1', sponsorAccountId: 'acct-1' };
    await a.sharedChatTurn({ organizationId: 'org-1', runtime: omniRuntime, askerUserId: 'user-1', askerAccountId: 'acct-1', channelId: 'ch-1', threadRootId: null, messageId: 'msg-s1', prompt: 'Which channels are you in?', audience: 'private' });
    expect(e.chat).toEqual([expect.objectContaining({ agentUserId: 'omni', op: 'channels' })]);
    expect(shared).toEqual([expect.objectContaining({ body: 'You have no channels in common with me.', invokedBy: 'acct-1' })]);
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

describe('a person’s assistant in Chat posts elsewhere at once, with no approval (operator ruling 2026-11-17, R-C)', () => {
  const users: Record<string, unknown> = { 'user-1': { id: 'user-1', email: 'ann@acme.test', displayName: 'Ann', isAgent: false, timezone: 'UTC' } };
  const runtime = { runtimeKey: 'acct-1', agentId: 'asst', agentAccountId: 'acct-asst', mode: 'personal' as const, organizationId: 'org-1', sponsorId: 'user-1', sponsorAccountId: 'acct-1' };
  const DM = 'dm-1';
  function env() {
    const posted: { channelId: string; body: string; clientMsgId: string; threadRootId: string | null }[] = [];
    const posts: Record<string, unknown>[] = [];
    const automation: Record<string, unknown>[] = [];
    let next = 0;
    return {
      posted, posts, automation,
      env: {
        DIRECTORY: { idFromName: (n: string) => n, get: () => ({ call: async (m: string, args: unknown[]) => ({ ok: true, value: m === 'getUser' ? users[args[0] as string] : m === 'accountById' ? ACCOUNT : null }) }) },
        ORG: {
          idFromName: (n: string) => n,
          get: () => ({
            channelIdsOf: async () => [DM, 'ch-gen'],
            agentTyping: async () => undefined,
            postAsAssistant: async (p: { channelId: string; body: string; clientMsgId: string; threadRootId: string | null }) => { posted.push(p); return `m${++next}`; },
            postAutomation: async (p: Record<string, unknown>) => { automation.push(p); return 'm-auto'; },
            assistantChat: async (p: { op: string; channelId?: string }) => {
              if (p.op === 'channels') return [{ id: 'ch-gen', name: 'general', private: false, assistantIsMember: false }];
              if (p.op === 'read') return [{ id: 'm-1', from: 'Bob', at: '2026-11-17T09:00:00Z', text: 'Standup moved to 10.' }];
              throw new Error('No such channel among the ones the user is in. list_channels lists them.');
            },
            assistantPost: async (p: Record<string, unknown>) => { posts.push(p); return { messageId: 'm-gen', joined: true, channel: 'general' }; },
          }),
        },
        EVENTS: { idFromName: (n: string) => n, get: () => ({ jobStep: async (id: string, _a: string, step: string) => ({ id, state: step === 'ack' ? 'running' : 'done' }) }) },
      } as unknown as AssistantEnv,
    };
  }
  /** The model: lists the channels (or reads one), posts, and reads back each result; records what each request offered. */
  function poster(seen: { tools: { name: string; defer?: boolean }[]; results: Block[] }[], first: 'list_channels' | 'read_messages' = 'list_channels'): ModelCall {
    return async (params, { onText }) => {
      const results = lastUser(params).filter((b) => b.type === 'tool_result');
      seen.push({ tools: (params.tools ?? []).map((t) => ({ name: (t as { name: string }).name, defer: (t as { defer_loading?: boolean }).defer_loading })), results });
      const said = (text: string) => { onText(text); return message([{ type: 'text', text }], 'end_turn') as never; };
      const last = results.at(-1);
      if (!last) return message([{ type: 'tool_use', id: 'tu-first', name: first, input: first === 'read_messages' ? { channelId: 'ch-gen' } : {} }], 'tool_use') as never;
      if (last.tool_use_id === 'tu-first') return message([{ type: 'tool_use', id: 'tu-post', name: 'send_message', input: { channelId: 'ch-gen', text: 'Standup moved to 10.' } }], 'tool_use') as never;
      return said(`Outcome: ${String(last.content)}`);
    };
  }
  const ask = (a: TestAssistant, audience: 'private' | 'shared' = 'private', messageId = 'msg-1') =>
    a.chatTurn({ organizationId: 'org-1', runtime, channelId: DM, threadRootId: null, messageId, prompt: 'Ann asked: post "Standup moved to 10." in #general', audience });

  it('runs the Chat tools itself and posts in #general at once, as the assistant, with no card', async () => {
    const e = env();
    const a = assistant('acct-1', e.env);
    const seen: { tools: { name: string; defer?: boolean }[]; results: Block[] }[] = [];
    a.script = poster(seen);
    await ask(a);
    // The Chat tools are offered in a Chat turn, loaded up front.
    const offered = seen[0]!.tools;
    for (const name of ['list_channels', 'read_messages', 'send_message']) expect(offered.find((t) => t.name === name)?.defer, name).toBeFalsy();
    expect(offered.find((t) => t.name === 'leave_channel')?.defer).toBe(true);
    // No page is open: Docs' editing tools are there headless (found by search), the ones that only show a page are not.
    expect(offered.find((t) => t.name === 'write_range')?.defer).toBe(true);
    expect(offered.some((t) => t.name === 'open_sheet' || t.name === 'render_slide')).toBe(false);
    // list_channels ran here, through the Org object, and its result went back to the model.
    expect(String(seen[1]!.results[0]!.content)).toContain('"name":"general"');
    // send_message posted at once; the model heard so, and its answer is the only message in the DM.
    expect(e.posts).toEqual([{ agentUserId: 'asst', channelId: 'ch-gen', threadRootId: null, body: 'Standup moved to 10.', clientMsgId: 'assistant-post:tu-post' }]);
    expect(e.posted).toEqual([expect.objectContaining({ channelId: DM, body: 'Outcome: Posted in #general, after joining it.' })]);
    expect(e.posted.some((p) => /React ✅|card:/.test(`${p.body} ${p.clientMsgId}`))).toBe(false);
  });

  it('posts at once where others read too (a mention in a channel)', async () => {
    const e = env();
    const a = assistant('acct-1', e.env);
    a.script = poster([]);
    await ask(a, 'shared');
    expect(e.posts).toHaveLength(1);
    expect(e.posted.at(-1)!.body).toBe('Outcome: Posted in #general, after joining it.');
  });

  it('lets an automation read a channel and post, with real results, the post stamped with the job (loop safety)', async () => {
    const e = env();
    const a = assistant('acct-1', e.env);
    const seen: { tools: { name: string }[]; results: Block[] }[] = [];
    a.script = poster(seen as never, 'read_messages');
    const job = { id: 'job-p1', subscriptionId: 'sub-p', agent: 'acct-asst', eventId: 'e1', eventSeq: 1, prompt: 'Repost the newest message of #general.', channelId: DM, state: 'queued', attempts: 0, depth: 1, createdAt: '', updatedAt: '' } as never;
    await a.wake({ organizationId: 'org-1', job, runtime });
    expect(String(seen[1]!.results[0]!.content)).toContain('Standup moved to 10.');
    expect(e.posts).toEqual([expect.objectContaining({ agentUserId: 'asst', channelId: 'ch-gen', body: 'Standup moved to 10.', depth: 2, causedBy: 'job-p1' })]);
    expect(e.automation).toEqual([expect.objectContaining({ channelId: DM, body: 'Outcome: Posted in #general, after joining it.', causedBy: 'job-p1' })]);
  });
});

describe('email waits for the person’s click (decision_log 2026-11-17, mailApprovals.ts)', () => {
  const ADA = { id: 'acct-ada', principalId: 'ada', organizationId: 'org-1', state: 'active', role: 'member', address: 'ada@acme.test', displayName: 'Ada', kind: 'personal_agent', agentMode: 'personal', sponsorId: 'user-1' } as unknown as AccountDTO;
  const users: Record<string, unknown> = { ada: { id: 'ada', email: 'agent-ada@agents.flow.local', displayName: 'Ada', isAgent: true }, 'user-1': { id: 'user-1', email: 'ann@acme.test', displayName: 'Ann', isAgent: false, timezone: 'UTC' } };
  const runtime = { runtimeKey: 'acct-1', agentId: 'ada', agentAccountId: 'acct-ada', mode: 'personal' as const, organizationId: 'org-1', sponsorId: 'user-1', sponsorAccountId: 'acct-1' };
  function env(opts: { noAccount?: boolean } = {}) {
    const sent: { path: string; body: Record<string, unknown> }[] = [];
    const notes: { agentUserId: string; personUserId: string; text: string }[] = [];
    const results: string[] = [];
    const logged: Record<string, unknown>[] = [];
    return {
      sent, notes, results, logged,
      env: {
        DIRECTORY: { idFromName: (x: string) => x, get: () => ({ call: async (m: string, args: unknown[]) => ({ ok: true, value: m === 'getUser' ? users[args[0] as string] : m === 'accountById' ? (args[0] === 'acct-ada' ? ADA : ACCOUNT) : null }) }) },
        ORG: { idFromName: (x: string) => x, get: () => ({ channelIdsOf: async () => [], postAutomation: async () => 'm1', agentDmNotice: async (p: { agentUserId: string; personUserId: string; text: string }) => { notes.push(p); } }) },
        EVENTS: { idFromName: (x: string) => x, get: () => ({ jobStep: async (id: string, _a: string, step: string) => ({ id, state: step === 'ack' ? 'running' : 'done' }), jobTrigger: async () => null, publish: async (ev: Record<string, unknown>) => { logged.push(ev); return { seq: logged.length, id: 'e' }; } }) },
        MAIL: {
          idFromName: (x: string) => x,
          get: (owner: string) => ({
            handle: async (r: Request, caller: { account: { id: string } }) => {
              const path = new URL(r.url).pathname;
              if (owner !== 'acct-1' || caller.account.id !== 'acct-1') return Response.json({ accounts: [] });
              if (path === '/v1/mail/accounts') return Response.json({ accounts: opts.noAccount ? [] : [{ id: 'gmail-1', email: 'ann@gmail.test', displayName: 'Ann', status: 'ok', tabs: [] }] });
              if (path === '/v1/mail/accounts/gmail-1/send' && r.method === 'POST') { sent.push({ path, body: (await r.json()) as Record<string, unknown> }); return Response.json({ messageId: '<sent-1@gmail.test>' }); }
              return Response.json({ error: 'not found' }, { status: 404 });
            },
          }),
        },
      } as unknown as AssistantEnv,
    };
  }
  /** The model: send_email to someone outside, then what the tool said, back as text. */
  const scripted = (results: string[], input: Record<string, unknown> = { to: ['Zoe <zoe@outside.example>'], subject: 'Lunch', body: 'Shall we meet **Friday**?' }): ModelCall => async (_params, { onText }) => {
    const result = lastUser(_params).find((b) => b.type === 'tool_result');
    if (result) { results.push(String(typeof result.content === 'string' ? result.content : JSON.stringify(result.content))); onText('It is waiting for you.'); return message([{ type: 'text', text: 'It is waiting for you.' }], 'end_turn') as never; }
    return message([{ type: 'tool_use', id: 'tu_send', name: 'send_email', input }], 'tool_use') as never;
  };
  const AGENT_CALLER = { ...(CALLER as object), authKind: 'agent', via: 'ada' } as never;

  it('keeps the email waiting, sends nothing until the person clicks Send message, and sends it once', async () => {
    const e = env();
    const a = assistant('acct-1', e.env);
    a.script = scripted(e.results);
    await events(await a.handle(req('POST', '/api/agent/turn', { message: 'Email Zoe about lunch', context: { page: 'home' }, workspace: 'org-1' }), CALLER, DOCS_CALLER, 'Ada', { agentAccountId: 'acct-ada', agentMode: 'personal' }));
    expect(e.results[0]).toContain('"waiting_for_approval":true');
    expect(e.sent).toEqual([]);
    // Live in the panel: the card is the tool's row; no note in Chat.
    expect(e.notes).toEqual([]);
    const list = (await (await a.handle(req('GET', '/api/agent/mail-approvals'), CALLER, DOCS_CALLER)).json()) as { approvals: MailApprovalDTO[] };
    expect(list.approvals).toEqual([expect.objectContaining({ state: 'waiting', agentName: 'Ada', from: 'ann@gmail.test', fromAgent: false, to: ['Zoe <zoe@outside.example>'], subject: 'Lunch', body: 'Shall we meet **Friday**?' })]);
    const id = list.approvals[0]!.id;
    // An agent (or an app's token) cannot approve it: only the person, signed in.
    expect((await a.handle(req('POST', `/api/agent/mail-approvals/${id}/send`), AGENT_CALLER, DOCS_CALLER)).status).toBe(403);
    expect(e.sent).toEqual([]);
    const res = await a.handle(req('POST', `/api/agent/mail-approvals/${id}/send`), CALLER, DOCS_CALLER);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { approval: MailApprovalDTO }).approval.state).toBe('sent');
    expect(e.sent).toHaveLength(1);
    // The log says the person sent it with their click (no via), whom to and the subject.
    expect(e.logged).toEqual([expect.objectContaining({ type: 'mail.sent', actor: 'acct-1', audience: 'account:acct-1', data: expect.objectContaining({ to: ['Zoe <zoe@outside.example>'], subject: 'Lunch', approval: 'click', how: 'send_email' }) })]);
    expect(e.logged[0]).not.toHaveProperty('via');
    expect(e.sent[0]!.body).toMatchObject({ to: [{ name: 'Zoe', address: 'zoe@outside.example' }], subject: 'Lunch' });
    expect(String(e.sent[0]!.body.html)).toContain('<strong>Friday</strong>');
    // A second click sends nothing.
    expect((await a.handle(req('POST', `/api/agent/mail-approvals/${id}/send`), CALLER, DOCS_CALLER)).status).toBe(409);
    expect(e.sent).toHaveLength(1);
    expect(((await (await a.handle(req('GET', '/api/agent/mail-approvals'), CALLER, DOCS_CALLER)).json()) as { approvals: unknown[] }).approvals).toEqual([]);
  });

  it('tells the person in their DM with the agent when no page runs the turn, and discards on their click', async () => {
    const e = env();
    const a = assistant('acct-1', e.env);
    a.script = scripted(e.results);
    const job = { id: 'job-e1', subscriptionId: 'sub-1', agent: 'acct-ada', eventId: 'e1', eventSeq: 1, prompt: 'Email Zoe about lunch', state: 'queued', attempts: 0, depth: 1, createdAt: '', updatedAt: '' } as never;
    await a.wake({ organizationId: 'org-1', job, runtime });
    expect(e.results[0]).toContain('"waiting_for_approval":true');
    expect(e.sent).toEqual([]);
    expect(e.notes).toHaveLength(1);
    expect(e.notes[0]).toMatchObject({ agentUserId: 'ada', personUserId: 'user-1' });
    expect(e.notes[0]!.text).toContain('**To:** Zoe <zoe@outside.example>');
    expect(e.notes[0]!.text).toMatch(/\[Review and send\]\(https:\/\/app\.test\/home\/\?email-approval=[0-9a-f-]+&workspace=org-1\)/);
    const id = /email-approval=([0-9a-f-]+)/.exec(e.notes[0]!.text)![1]!;
    expect((await a.handle(req('POST', `/api/agent/mail-approvals/${id}/discard`), CALLER, DOCS_CALLER)).status).toBe(200);
    expect((await a.handle(req('POST', `/api/agent/mail-approvals/${id}/send`), CALLER, DOCS_CALLER)).status).toBe(409);
    expect(e.sent).toEqual([]);
  });

  it('sends email to the person themself at once, with no click', async () => {
    const e = env();
    const a = assistant('acct-1', e.env);
    a.script = scripted(e.results, { to: ['ann@gmail.test'], subject: 'Your summary', body: 'Here it is.' });
    await events(await a.handle(req('POST', '/api/agent/turn', { message: 'Email me a summary', context: { page: 'home' }, workspace: 'org-1' }), CALLER, DOCS_CALLER, 'Ada', { agentAccountId: 'acct-ada', agentMode: 'personal' }));
    expect(e.results[0]).toContain('"sent":true');
    expect(e.sent).toHaveLength(1);
    expect(e.logged).toEqual([expect.objectContaining({ type: 'mail.sent', data: expect.objectContaining({ approval: 'self', subject: 'Your summary' }) })]);
    expect(e.sent[0]!.body).toMatchObject({ to: [{ address: 'ann@gmail.test' }], subject: 'Your summary' });
    expect(((await (await a.handle(req('GET', '/api/agent/mail-approvals'), CALLER, DOCS_CALLER)).json()) as { approvals: unknown[] }).approvals).toEqual([]);
  });

  it('with no mail account, sends from FreeFlow in the person’s name after the click', async () => {
    const e = env({ noAccount: true });
    const a = assistant('acct-1', e.env);
    a.script = scripted(e.results);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await events(await a.handle(req('POST', '/api/agent/turn', { message: 'Email Zoe about lunch', context: { page: 'home' }, workspace: 'org-1' }), CALLER, DOCS_CALLER, 'Ada', { agentAccountId: 'acct-ada', agentMode: 'personal' }));
    const list = (await (await a.handle(req('GET', '/api/agent/mail-approvals'), CALLER, DOCS_CALLER)).json()) as { approvals: MailApprovalDTO[] };
    expect(list.approvals).toEqual([expect.objectContaining({ state: 'waiting', from: 'Ann via FreeFlow', to: ['Zoe <zoe@outside.example>'] })]);
    expect(log.mock.calls.some((c) => String(c[0]).startsWith('[mail] to=zoe@outside.example'))).toBe(false);
    const res = await a.handle(req('POST', `/api/agent/mail-approvals/${list.approvals[0]!.id}/send`), CALLER, DOCS_CALLER);
    expect(res.status).toBe(200);
    // No EMAIL_API_TOKEN here: the message is printed instead of sent, as named, with Reply-To the person.
    expect(log.mock.calls.some((c) => /^\[mail\] to=zoe@outside\.example subject="Lunch" reply_to=ann@acme\.test/.test(String(c[0])))).toBe(true);
    log.mockRestore();
  });
});
