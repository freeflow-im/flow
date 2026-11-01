import type Anthropic from '@anthropic-ai/sdk';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentContext, AgentEvent, AgentTurnRequest } from '../shared/agent/protocol.ts';
import type { ModelCall } from './agent/agent.ts';
import { PROMPT_WITHOUT_JOBS } from './agent/prompt.ts';
import { resetSearchRateLimit, runServerTool, TOOL_DEFS_WITHOUT_JOBS, validateToolInput } from './agent/tools.ts';
import { imageCandidates } from './agent/llmSearch.ts';
import { buildApp } from './app.ts';
import { mailbox, signUp } from './testing.ts';

const box = mailbox();
import type { SheetStore } from './sheets.ts';
import type { FileStore } from './files.ts';
import type { ImageStore } from './images.ts';
import { resolver } from './webFetch.ts';
import { webImportName } from './importFile.ts';
import { closePdfReaders } from './pdfMarkdown.ts';

type Params = Parameters<ModelCall>[0];
type Block = Anthropic.Beta.BetaContentBlock;

// A scripted model: each call takes the next reply and records the request it was given.
const replies: ((p: Params) => { content: Block[]; stop_reason?: Anthropic.Beta.BetaStopReason })[] = [];
const requests: Params[] = [];
const fakeModel: ModelCall = async (params, { onText }) => {
  requests.push(structuredClone(params));
  const next = replies.shift();
  if (!next) throw new Error('No scripted reply left');
  const { content, stop_reason } = next(params);
  for (const b of content) if (b.type === 'text') onText(b.text);
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5-5',
    content,
    stop_reason: stop_reason ?? (content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'),
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  } as unknown as Anthropic.Beta.BetaMessage;
};

const text = (t: string): Block => ({ type: 'text', text: t, citations: null }) as Block;
const toolUse = (id: string, name: string, input: unknown): Block => ({ type: 'tool_use', id, name, input }) as Block;

let dir: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let cookie: string;
const launchedJobs: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'sheetsweb-agent-test-'));
  app = await buildApp({
    dataDir: dir,
    sendMail: box.send,
    agent: { model: fakeModel },
    launchJob: (job) => {
      launchedJobs.push(job.id);
      return process.pid;
    },
  });
  cookie = (await signUp(app, box, 'agent@x.com')).cookie;
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  replies.length = 0;
  requests.length = 0;
  await app.inject({ method: 'POST', url: '/api/agent/reset', headers: { cookie } });
});

async function turn(body: AgentTurnRequest): Promise<AgentEvent[]> {
  const res = await app.inject({ method: 'POST', url: '/api/agent/turn', headers: { cookie }, payload: body });
  expect(res.statusCode).toBe(200);
  return res.payload
    .split('\n\n')
    .filter((c) => c.startsWith('data: '))
    .map((c) => JSON.parse(c.slice(6)) as AgentEvent);
}

const home = { page: 'home' } as const;

describe('agent', () => {
  it('requires sign-in', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/agent/turn', payload: { message: 'hi', context: home } });
    expect(res.statusCode).toBe(401);
  });

  it('streams a text reply and keeps the conversation', async () => {
    replies.push(() => ({ content: [text('Hello! ')] }));
    const events = await turn({ message: 'Hi there', context: home });
    expect(events).toEqual([{ type: 'text', text: 'Hello! ' }, { type: 'done' }]);

    // The context block goes in front of the message; the transcript hides it.
    const sent = requests[0].messages[0];
    expect(sent.role).toBe('user');
    expect(JSON.stringify(sent.content)).toContain('<app_context>');
    expect(requests[0].model).toBe('claude-sonnet-5-5');

    const res = await app.inject({ method: 'GET', url: '/api/agent', headers: { cookie } });
    expect(res.json().items).toEqual([
      { kind: 'user', text: 'Hi there' },
      { kind: 'assistant', text: 'Hello! ' },
    ]);

    // Follow-up messages append to the same history.
    replies.push(() => ({ content: [text('Again.')] }));
    await turn({ message: 'And again', context: home });
    expect(requests[1].messages).toHaveLength(3);
  });

  it('keeps a chat for each file and one for the home page', async () => {
    const sheet = (await app.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload: { title: 'Chat sheet' } })).json().sheet as { id: string };
    const onSheet: AgentContext = { page: 'sheet', sheetId: sheet.id, title: 'Chat sheet', tabs: ['Sheet1'], activeTab: 'Sheet1', selection: ['A1'] };
    const chat = async (scope?: string) => (await app.inject({ method: 'GET', url: `/api/agent${scope ? `?scope=${scope}` : ''}`, headers: { cookie } })).json() as { items: { text?: string }[]; title: string | null };

    replies.push(() => ({ content: [text('On the home page.')] }));
    await turn({ message: 'Home question', context: home });
    replies.push(() => ({ content: [text('On the sheet.')] }));
    await turn({ message: 'Sheet question', context: onSheet });

    // Each chat has only its own messages, and the model only saw the sheet's.
    expect(requests[1].messages).toHaveLength(1);
    expect((await chat()).items.map((i) => i.text)).toEqual(['Home question', 'On the home page.']);
    expect(await chat(sheet.id)).toEqual({ items: [{ kind: 'user', text: 'Sheet question' }, { kind: 'assistant', text: 'On the sheet.' }], title: 'Chat sheet' });
    expect((await chat()).title).toBeNull();

    // A turn stays in the chat it was sent from, though the page it is on has moved on.
    replies.push(() => ({ content: [text('Still the sheet’s.')] }));
    await turn({ message: 'Follow-up', context: home, scope: sheet.id });
    expect((await chat(sheet.id)).items.map((i) => i.text)).toEqual(['Sheet question', 'On the sheet.', 'Follow-up', 'Still the sheet’s.']);
    expect((await chat()).items).toHaveLength(2);

    // New chat starts over in that chat only.
    await app.inject({ method: 'POST', url: '/api/agent/reset', headers: { cookie }, payload: { scope: sheet.id } });
    expect((await chat(sheet.id)).items).toEqual([]);
    expect((await chat()).items).toHaveLength(2);

    expect((await app.inject({ method: 'GET', url: '/api/agent?scope=../x', headers: { cookie } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/agent/turn', headers: { cookie }, payload: { message: 'x', context: home, scope: 'a b' } })).statusCode).toBe(400);
  });

  it('runs account tools on the server and feeds the results back', async () => {
    await app.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload: { title: 'Budget 2026' } });
    await app.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload: { title: 'Recipes' } });
    replies.push(() => ({ content: [toolUse('t1', 'list_sheets', { query: 'budget' })] }));
    replies.push(() => ({ content: [text('Found it.')] }));

    const events = await turn({ message: 'Find my budget', context: home });
    expect(events.map((e) => e.type)).toEqual(['tool_start', 'tool_end', 'text', 'done']);

    const results = requests[1].messages[2].content as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(results[0].tool_use_id).toBe('t1');
    const listed = JSON.parse(String(results[0].content));
    expect(listed.sheets.map((s: { title: string }) => s.title)).toEqual(['Budget 2026']);
  });

  it('pauses for browser tools and resumes with their results', async () => {
    replies.push(() => ({ content: [text('Let me look.'), toolUse('c1', 'get_sheet_overview', {}), toolUse('s1', 'list_sheets', {})] }));
    const events = await turn({ message: 'What is here?', context: home });
    expect(events.at(-1)).toEqual({ type: 'client_tools', calls: [{ id: 'c1', name: 'get_sheet_overview', input: {} }] });
    expect(events.some((e) => e.type === 'done')).toBe(false);

    replies.push(() => ({ content: [text('It has one tab.')] }));
    const resumed = await turn({ context: home, toolResults: [{ id: 'c1', content: '{"tabs":[]}' }] });
    expect(resumed.at(-1)).toEqual({ type: 'done' });

    // Results go back in call order: the browser's result and the server tool's result together.
    const results = requests[1].messages[2].content as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(results.map((r) => r.tool_use_id)).toEqual(['c1', 's1']);
    expect(results[0].content).toBe('{"tabs":[]}');
  });

  it('reports interrupted browser tools when the user sends a new message instead', async () => {
    replies.push(() => ({ content: [toolUse('c1', 'read_range', { range: 'A1:B2' })] }));
    await turn({ message: 'Read it', context: home });

    replies.push(() => ({ content: [text('OK, never mind.')] }));
    await turn({ message: 'Actually, stop', context: home });
    const content = requests[1].messages[2].content as { type: string; is_error?: boolean; text?: string }[];
    expect(content[0]).toMatchObject({ type: 'tool_result', is_error: true });
    expect(content.at(-1)).toMatchObject({ type: 'text', text: 'Actually, stop' });
  });

  it('rejects invalid tool input without running or forwarding it', async () => {
    replies.push(() => ({ content: [toolUse('c1', 'write_range', { start: 'A1' })] }));
    replies.push(() => ({ content: [text('Fixed.')] }));
    const events = await turn({ message: 'Write', context: home });
    expect(events.some((e) => e.type === 'client_tools')).toBe(false);
    const results = requests[1].messages[2].content as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(results[0]).toMatchObject({ is_error: true });
    expect(String(results[0].content)).toContain('rows');
  });

  it('sends the open spreadsheet as context and keeps read_other_sheet off it', async () => {
    const { sheet } = (await app.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload: { title: 'Open one' } })).json();
    const context: AgentContext = { page: 'sheet', sheetId: sheet.id, title: 'Open one', tabs: ['Sheet1'], activeTab: 'Sheet1', selection: ['B2:C4'] };
    replies.push(() => ({ content: [toolUse('s1', 'read_other_sheet', { sheet_id: sheet.id })] }));
    replies.push(() => ({ content: [text('ok')] }));
    await turn({ message: 'Sum the selection', context });
    expect(JSON.stringify(requests[0].messages[0].content)).toContain('Selection: B2:C4');
    const results = requests[1].messages[2].content as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(results[0]).toMatchObject({ is_error: true });
  });

  it('reads another spreadsheet with computed values', async () => {
    const { sheet } = (await app.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload: { title: 'Numbers' } })).json();
    const workbook = {
      version: 1,
      tabs: [{ id: 't', name: 'Data', rows: 10, cols: 5, cells: { A1: { v: '2' }, A2: { v: '3' }, A3: { v: '=A1*A2' } }, colWidths: {}, rowHeights: {} }],
    };
    await app.inject({ method: 'PUT', url: `/api/sheets/${sheet.id}`, headers: { cookie }, payload: { workbook } });
    replies.push(() => ({ content: [toolUse('s1', 'read_other_sheet', { sheet_id: sheet.id, range: 'Data!A1:A3' })] }));
    replies.push(() => ({ content: [text('6')] }));
    await turn({ message: 'What is A3 in Numbers?', context: home });
    const results = requests[1].messages[2].content as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(JSON.parse(String(results[0].content)).values).toEqual([['2'], ['3'], ['6']]);
  });

  it('creates a presentation with slides on the server and lists it', async () => {
    replies.push(() => ({
      content: [
        toolUse('d1', 'create_deck', {
          title: 'Q3 review',
          theme: 'ocean',
          slides: [
            { title: 'Q3 review', subtitle: 'October 2026' },
            { title: 'Highlights', body: ['Revenue up 12%', 'Churn down'] },
          ],
        }),
      ],
    }));
    replies.push(() => ({ content: [toolUse('d2', 'list_decks', { query: 'q3' })] }));
    replies.push(() => ({ content: [text('Done.')] }));
    const events = await turn({ message: 'Make a deck', context: home });
    expect(events.map((e) => e.type)).toEqual(['tool_start', 'tool_end', 'tool_start', 'tool_end', 'text', 'done']);

    const created = JSON.parse(String((requests[1].messages[2].content as Anthropic.Beta.BetaToolResultBlockParam[])[0].content)) as { id: string; slide_count: number };
    expect(created.slide_count).toBe(2);
    const listed = JSON.parse(String((requests[2].messages[4].content as Anthropic.Beta.BetaToolResultBlockParam[])[0].content)) as { decks: { id: string; title: string }[] };
    expect(listed.decks).toEqual([expect.objectContaining({ id: created.id, title: 'Q3 review' })]);

    const res = await app.inject({ method: 'GET', url: `/api/decks/${created.id}`, headers: { cookie } });
    const { deck } = res.json();
    expect(deck.theme).toBe('ocean');
    expect(deck.slides[0].layout).toBe('title');
    expect(deck.slides[1].layout).toBe('title-body');

    // The deck context is accepted and rendered for the model.
    replies.push(() => ({ content: [text('On slide 2.')] }));
    await turn({ message: 'Where am I?', context: { page: 'deck', deckId: created.id, title: 'Q3 review', slideCount: 2, currentSlide: 2, selectedElements: [] } });
    expect(JSON.stringify(requests[3].messages.at(-1)!.content)).toContain('Current slide: 2');
  });

  it('starts over on reset', async () => {
    replies.push(() => ({ content: [text('Hi')] }));
    await turn({ message: 'Hello', context: home });
    await app.inject({ method: 'POST', url: '/api/agent/reset', headers: { cookie } });
    const res = await app.inject({ method: 'GET', url: '/api/agent', headers: { cookie } });
    expect(res.json().items).toEqual([]);
  });

  it('sends attached images to the model and shows them in the transcript', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
    replies.push(() => ({ content: [text('A tiny PNG.')] }));
    const events = await turn({ message: 'what is this?', context: home, images: [{ mediaType: 'image/png', data: png }] });
    expect(events.some((e) => e.type === 'done')).toBe(true);
    const content = requests[0].messages.at(-1)!.content as { type: string; source?: { media_type: string; data: string } }[];
    expect(content.map((b) => b.type)).toEqual(['text', 'image', 'text']);
    expect(content[1].source).toMatchObject({ type: 'base64', media_type: 'image/png', data: png });
    const items = (await app.inject({ method: 'GET', url: '/api/agent', headers: { cookie } })).json().items as { kind: string; text?: string; images?: string[] }[];
    expect(items[0]).toMatchObject({ kind: 'user', text: 'what is this?', images: [`data:image/png;base64,${png}`] });

    // An image alone is a message too; bad media types and too many images are refused.
    replies.push(() => ({ content: [text('ok')] }));
    await turn({ context: home, images: [{ mediaType: 'image/png', data: png }] });
    expect((requests[1].messages.at(-1)!.content as { type: string; text?: string }[]).at(-1)!.text).toBe('See the attached image.');

    // A stored address travels to the model (so it can place the picture) but stays out of the transcript.
    replies.push(() => ({ content: [text('Placed.')] }));
    const url = '/api/images/12345678-1234-1234-1234-123456789abc';
    await turn({ message: 'put this on slide 2', context: home, images: [{ mediaType: 'image/png', data: png, url }] });
    const blocks = requests[2].messages.at(-1)!.content as { type: string; text?: string }[];
    expect(blocks.map((b) => b.type)).toEqual(['text', 'image', 'text', 'text']);
    expect(blocks[2].text).toContain(`Attached image 1 is stored at ${url}`);
    const transcript = (await app.inject({ method: 'GET', url: '/api/agent', headers: { cookie } })).json().items as { kind: string; text?: string }[];
    expect(transcript.filter((i) => i.kind === 'user').map((i) => i.text)).toEqual(['what is this?', 'See the attached image.', 'put this on slide 2']);
    expect(JSON.stringify(transcript)).not.toContain('attached_images');
    expect((await app.inject({ method: 'POST', url: '/api/agent/turn', headers: { cookie }, payload: { context: home, images: [{ mediaType: 'image/png', data: png, url: 'https://evil.example/x.png' }] } })).statusCode).toBe(400);
    let res = await app.inject({ method: 'POST', url: '/api/agent/turn', headers: { cookie }, payload: { context: home, images: [{ mediaType: 'image/svg+xml', data: png }] } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'POST', url: '/api/agent/turn', headers: { cookie }, payload: { context: home, images: Array(5).fill({ mediaType: 'image/png', data: png }) } });
    expect(res.statusCode).toBe(400);
  });

  it('validates the request before streaming', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/agent/turn', headers: { cookie }, payload: { context: home } });
    expect(res.statusCode).toBe(400);
  });

  it('queues a research task with the open spreadsheet, as a job the worker runs', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload: { title: 'Companies' } });
    const sheetId = (created.json() as { sheet: { id: string } }).sheet.id;
    let res = await app.inject({ method: 'POST', url: '/api/agent/jobs', headers: { cookie }, payload: { kind: 'research', title: 'Revenue lookup', spec: 'Find the 2025 revenue of each company in column A.', sheetId: 'nope' } });
    expect(res.statusCode).toBe(404);
    res = await app.inject({ method: 'POST', url: '/api/agent/jobs', headers: { cookie }, payload: { kind: 'research', title: 'Revenue lookup', spec: 'Find the 2025 revenue of each company in column A.', sheetId } });
    expect(res.statusCode).toBe(200);
    const { job } = res.json() as { job: { id: string; kind: string; sheetId: string; status: string } };
    expect(job).toMatchObject({ kind: 'research', sheetId, status: 'queued' });
    // Research is never revertable, and it blocks the queue like any job.
    expect((await app.inject({ method: 'POST', url: `/api/agent/jobs/${job.id}/revert`, headers: { cookie } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/agent/jobs', headers: { cookie }, payload: { title: 'Another', spec: 'Something else entirely.' } })).statusCode).toBe(409);
    // Clear it so the next test starts with an empty queue: a turn starts it, and the stub launcher runs nothing.
    replies.push(() => ({ content: [text('ok')] }));
    await turn({ message: 'hi', context: home });
    expect(launchedJobs).toEqual([job.id]);
    launchedJobs.length = 0;
    const { db } = await import('./db.ts').then((m) => ({ db: m.openDb(path.join(dir, 'app.db')) }));
    db.prepare("UPDATE agent_jobs SET status = 'done' WHERE id = ?").run(job.id);
    db.close();
  });

  it('offers the background jobs in the hosted app only', async () => {
    replies.push(() => ({ content: [text('Hi.')] }));
    await turn({ message: 'hello', context: home });
    const names = (requests[0].tools ?? []).map((t) => ('name' in t ? t.name : ''));
    expect(names).toEqual(expect.arrayContaining(['request_app_change', 'request_research']));
    expect(JSON.stringify(requests[0].system)).toContain('request_app_change');
    // The desktop app (jobs: false) has no checkout to change: neither the tools nor the prompt mention them.
    expect(TOOL_DEFS_WITHOUT_JOBS.map((t) => t.name)).not.toContain('request_app_change');
    expect(TOOL_DEFS_WITHOUT_JOBS.map((t) => t.name)).not.toContain('request_research');
    expect(TOOL_DEFS_WITHOUT_JOBS.length).toBe(names.length - 2);
    expect(PROMPT_WITHOUT_JOBS).not.toMatch(/request_app_change|request_research|Improving the app/);
    expect(PROMPT_WITHOUT_JOBS).toContain('Replying:');
  });

  it('queues an app change and starts it after the turn ends', async () => {
    replies.push(() => ({ content: [toolUse('t1', 'request_app_change', { title: 'Add set_filter_values', spec: 'Let the assistant set which values a filter column shows.' })] }));
    const events = await turn({ message: 'add a tool to set filter criteria', context: home });
    // request_app_change runs in the browser (so the user can confirm there); the server does not run it.
    expect(events.find((e) => e.type === 'client_tools')).toMatchObject({ calls: [{ name: 'request_app_change' }] });
    expect(launchedJobs).toEqual([]);

    const created = await app.inject({ method: 'POST', url: '/api/agent/jobs', headers: { cookie }, payload: { title: 'Add set_filter_values', spec: 'Let the assistant set which values a filter column shows.' } });
    expect(created.statusCode).toBe(200);
    const { job } = created.json() as { job: { id: string; status: string; acknowledged: boolean } };
    expect(job.status).toBe('queued');
    const dup = await app.inject({ method: 'POST', url: '/api/agent/jobs', headers: { cookie }, payload: { title: 'Another', spec: 'Something else entirely.' } });
    expect(dup.statusCode).toBe(409);
    expect(launchedJobs).toEqual([]); // not started mid-turn

    replies.push(() => ({ content: [text('Working on it.')] }));
    await turn({ context: home, toolResults: [{ id: 't1', content: JSON.stringify({ job_id: job.id, status: 'queued' }) }] });
    expect(launchedJobs).toEqual([job.id]);

    const latest = await app.inject({ method: 'GET', url: '/api/agent/jobs/latest', headers: { cookie } });
    expect(latest.json()).toMatchObject({ job: { id: job.id, status: 'starting', acknowledged: false } });
    const ack = await app.inject({ method: 'POST', url: `/api/agent/jobs/${job.id}/ack`, headers: { cookie } });
    expect(ack.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/agent/jobs/latest', headers: { cookie } })).json()).toMatchObject({ job: { acknowledged: true } });

    // The change history lists it with who asked; a running change cannot be reverted.
    const list = (await app.inject({ method: 'GET', url: '/api/agent/jobs', headers: { cookie } })).json() as { jobs: { id: string; requestedBy: string }[] };
    expect(list.jobs[0].id).toBe(job.id); // newest first
    expect(list.jobs[0].requestedBy).toBe('agent@x.com');
    expect((await app.inject({ method: 'POST', url: `/api/agent/jobs/${job.id}/revert`, headers: { cookie } })).statusCode).toBe(400);
  });
});

describe('web and image search tools', () => {
  const env = { userId: 'search-user', sheets: {} as SheetStore, context: home };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  beforeEach(() => {
    resetSearchRateLimit();
    vi.stubEnv('BRAVE_SEARCH_API_KEY', 'test-key');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('returns web results as plain text', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      json({
        web: {
          results: [
            { title: 'Eat a <strong>Peach</strong>', url: 'https://en.wikipedia.org/wiki/Eat_a_Peach', description: 'An album &amp; more' },
            { title: 'bad', url: 'javascript:x' },
          ],
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const out = JSON.parse(await runServerTool('web_search', { query: 'Eat a Peach', max_results: 3 }, env));
    expect(out.results).toEqual([{ title: 'Eat a Peach', url: 'https://en.wikipedia.org/wiki/Eat_a_Peach', snippet: 'An album & more' }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/web/search?q=Eat+a+Peach&count=3');
    expect((init?.headers as Record<string, string>)['X-Subscription-Token']).toBe('test-key');
  });

  it('returns only directly loadable images, hotlink-friendly hosts first', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('api.search.brave.com')) {
          return json({
            results: [
              { title: 'Cover (blog)', url: 'https://blog.example.com/p', properties: { url: 'https://blog.example.com/cover.jpg', width: 500, height: 500 } },
              { title: 'Cover (wiki)', url: 'https://en.wikipedia.org/wiki/Eat_a_Peach', properties: { url: 'https://upload.wikimedia.org/a/Eat_a_Peach.png', width: 300, height: 300 } },
              { title: 'Broken', url: 'https://x.example.com', properties: { url: 'https://x.example.com/missing.jpg' } },
              { title: 'Not an image file', url: 'https://y.example.com', properties: { url: 'https://y.example.com/page.html' } },
              { title: 'Internal', url: 'http://10.0.0.1', properties: { url: 'http://10.0.0.1/a.png' } },
            ],
          });
        }
        if (url.includes('missing')) return new Response(null, { status: 404 });
        return new Response(null, { status: 200, headers: { 'content-type': url.endsWith('.png') ? 'image/png' : 'image/jpeg' } });
      }),
    );
    const out = JSON.parse(await runServerTool('image_search', { query: 'Allman Brothers Band Eat a Peach album cover' }, env));
    expect(out.results).toEqual([
      { title: 'Cover (wiki)', image_url: 'https://upload.wikimedia.org/a/Eat_a_Peach.png', source_page_url: 'https://en.wikipedia.org/wiki/Eat_a_Peach', width: 300, height: 300 },
      { title: 'Cover (blog)', image_url: 'https://blog.example.com/cover.jpg', source_page_url: 'https://blog.example.com/p', width: 500, height: 500 },
    ]);
  });

  it('uses the user’s own Brave key before the server’s', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json({ web: { results: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    await runServerTool('web_search', { query: 'q' }, { ...env, search: { braveKey: 'user-key' } }).catch(() => {});
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>)['X-Subscription-Token']).toBe('user-key');
  });

  it('searches with the model provider’s own web search without a Brave key', async () => {
    vi.stubEnv('BRAVE_SEARCH_API_KEY', '');
    const provider = {
      name: 'Anthropic',
      web: vi.fn(async () => [
        { title: 'IBM <b>logo</b>', url: 'https://en.wikipedia.org/wiki/IBM', snippet: 'The logo' },
        { title: 'dup', url: 'https://en.wikipedia.org/wiki/IBM', snippet: '' },
        { title: 'bad', url: 'javascript:x', snippet: '' },
      ]),
      images: vi.fn(async () => [
        { title: 'IBM logo', image_url: 'https://upload.wikimedia.org/a/IBM_logo.png', source_page_url: 'https://commons.wikimedia.org/wiki/File:IBM_logo.svg' },
        { title: 'Page', image_url: 'https://example.com/ibm', source_page_url: null },
        { title: 'Gone', image_url: 'https://example.com/missing.png', source_page_url: null },
      ]),
    };
    const fetchMock = vi.fn(async (url: string) => (url.includes('missing') ? new Response(null, { status: 404 }) : new Response(null, { status: 200, headers: { 'content-type': 'image/png' } })));
    vi.stubGlobal('fetch', fetchMock);
    const withProvider = { ...env, search: { braveKey: null, provider } };

    const web = JSON.parse(await runServerTool('web_search', { query: 'IBM logo' }, withProvider));
    expect(web.results).toEqual([{ title: 'IBM logo', url: 'https://en.wikipedia.org/wiki/IBM', snippet: 'The logo' }]);
    const images = JSON.parse(await runServerTool('image_search', { query: 'IBM logo', max_results: 3 }, withProvider));
    expect(images.results).toEqual([
      { title: 'IBM logo', image_url: 'https://upload.wikimedia.org/a/IBM_logo.png', source_page_url: 'https://commons.wikimedia.org/wiki/File:IBM_logo.svg', width: null, height: null },
    ]);
    expect(provider.images).toHaveBeenCalledWith('IBM logo', 3);
    expect(fetchMock.mock.calls.every(([u]) => !String(u).includes('api.search.brave.com'))).toBe(true);

    provider.web.mockRejectedValueOnce(new Error('overloaded'));
    await expect(runServerTool('web_search', { query: 'q' }, withProvider)).rejects.toThrow(/Anthropic's web search failed \(overloaded\)/);
  });

  it('reads the image candidates out of a model’s answer', () => {
    expect(imageCandidates('Here they are:\n[{"title":"A","image_url":"https://x.org/a.png","source_page_url":"https://x.org"},{"title":"B"},3]\nDone.')).toEqual([
      { title: 'A', image_url: 'https://x.org/a.png', source_page_url: 'https://x.org' },
    ]);
    expect(imageCandidates('none found')).toEqual([]);
    expect(imageCandidates('[not json]')).toEqual([]);
  });

  it('reports empty results, API errors, a missing key and the rate limit clearly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ results: [] })));
    await expect(runServerTool('image_search', { query: 'zzz' }, env)).rejects.toThrow(/No loadable .* images found/);
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 500)));
    await expect(runServerTool('web_search', { query: 'zzz' }, env)).rejects.toThrow(/HTTP 500/);
    vi.stubEnv('BRAVE_SEARCH_API_KEY', '');
    await expect(runServerTool('web_search', { query: 'zzz' }, env)).rejects.toThrow(/not set up/);

    resetSearchRateLimit();
    for (let i = 0; i < 20; i++) await runServerTool('web_search', { query: 'q' }, env).catch(() => {});
    await expect(runServerTool('web_search', { query: 'q' }, env)).rejects.toThrow(/rate limit/);
  });

  it('imports a file from a web address into the user’s files', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20, 1)]);
    const created: { filename: string; type: string; size: number }[] = [];
    const csvs: { title: string; csv: string }[] = [];
    const files = { create: async (_owner: string, filename: string, type: string, data: Buffer) => (created.push({ filename, type, size: data.length }), { id: `f${created.length}`, filename, type, size: data.length, createdAt: '2026-01-01', url: '', downloadUrl: '' }) } as unknown as FileStore;
    const markdowns: { title: string; text: string }[] = [];
    const sheets = {
      createCsv: async (_owner: string, title: string, csv: string) => (csvs.push({ title, csv }), { id: 's1', kind: 'sheet', title, updatedAt: '', createdAt: '' }),
      createMarkdown: async (_owner: string, title: string, doc: { text: string }) => (markdowns.push({ title, text: doc.text }), { id: 'm1', kind: 'markdown', title, updatedAt: '', createdAt: '' }),
    } as unknown as SheetStore;
    // A picture pasted into the chat is stored for the user already; only its owner's lookup finds it.
    const pasted = path.join(mkdtempSync(path.join(tmpdir(), 'pasted-')), 'img');
    writeFileSync(pasted, png);
    const pastedId = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const images = { get: (owner: string, id: string) => (owner === 'import-user' && id === pastedId ? { file: pasted, type: 'image/png' } : null) } as unknown as ImageStore;
    const env = { userId: 'import-user', sheets, images, files, context: home };
    const realLookup = resolver.lookup;
    resolver.lookup = async (host) => (host === 'intranet.example.com' ? ['192.168.1.20'] : ['93.184.216.34']);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url === 'https://cdn.example.com/dogs/golden.png') return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } });
        if (url === 'https://cdn.example.com/photo?id=3') return new Response(new Uint8Array(png));
        if (url === 'https://data.example.com/sales.csv') return new Response('a,b\n1,2\n');
        if (url === 'https://docs.example.com/README.md') return new Response('---\nname: x\n---\n\n# Read me\n');
        if (url === 'https://cdn.example.com/notes.txt') return new Response('just some words');
        return new Response('gone', { status: 404 });
      }),
    );
    try {
      expect(JSON.parse(await runServerTool('import_file', { url: 'https://cdn.example.com/dogs/golden.png' }, env))).toMatchObject({ imported: true, kind: 'file', file_id: 'f1', filename: 'golden.png', type: 'image/png', size: 28, note: expect.stringContaining('view_image') });
      // An address without a file name: the title names the picture, and its bytes give the type.
      expect(JSON.parse(await runServerTool('import_file', { url: 'https://cdn.example.com/photo?id=3', title: 'Golden retriever' }, env))).toMatchObject({ filename: 'Golden retriever.png' });
      expect(webImportName('IMG_8392.JPG', 'Golden retriever')).toBe('Golden retriever.JPG');
      expect(webImportName('sales.csv', 'Q3/Q4 sales.csv')).toBe('Q3_Q4 sales.csv');
      expect(webImportName('', ' ')).toBeUndefined();
      expect(created.map((c) => c.type)).toEqual(['image/png', 'image/png']);
      expect(JSON.parse(await runServerTool('import_file', { url: 'https://data.example.com/sales.csv', title: 'Sales' }, env))).toMatchObject({ kind: 'spreadsheet', sheet_id: 's1', title: 'Sales', note: expect.stringContaining('open_sheet') });
      expect(csvs).toEqual([{ title: 'Sales', csv: 'a,b\n1,2\n' }]);
      // A Markdown file stays Markdown, text as it was, titled by its first heading.
      expect(JSON.parse(await runServerTool('import_file', { url: 'https://docs.example.com/README.md' }, env))).toMatchObject({ kind: 'Markdown document', doc_id: 'm1', title: 'Read me', note: expect.stringContaining('open_doc') });
      expect(markdowns).toEqual([{ title: 'Read me', text: '---\nname: x\n---\n\n# Read me\n' }]);
      // A pasted picture is read from the user's stored images, not fetched, and named by its title.
      const before = (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
      expect(JSON.parse(await runServerTool('import_file', { url: `/api/images/${pastedId}`, title: 'Man holding a tabby cat' }, env))).toMatchObject({ imported: true, kind: 'file', filename: 'Man holding a tabby cat.png', type: 'image/png', size: 28 });
      expect(JSON.parse(await runServerTool('import_file', { url: `http://localhost:5173/api/images/${pastedId}` }, env))).toMatchObject({ filename: 'image.png' });
      expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(before);
      await expect(runServerTool('import_file', { url: `/api/images/${pastedId}` }, { ...env, userId: 'someone-else' })).rejects.toThrow(/no stored picture/);
      await expect(runServerTool('import_file', { url: '/api/images/11111111-2222-3333-4444-555555555555' }, env)).rejects.toThrow(/no stored picture/);
      // Problems come back as something to tell the user.
      // Plain text of any other kind is stored as it is.
      expect(JSON.parse(await runServerTool('import_file', { url: 'https://cdn.example.com/notes.txt' }, env))).toMatchObject({ imported: true, kind: 'file', filename: 'notes.txt', type: 'text/plain' });
      await expect(runServerTool('import_file', { url: 'https://cdn.example.com/missing.png' }, env)).rejects.toThrow(/\(404\)/);
      await expect(runServerTool('import_file', { url: 'https://intranet.example.com/a.png' }, env)).rejects.toThrow(/public internet/);
      await expect(runServerTool('import_file', { url: 'http://169.254.169.254/latest' }, env)).rejects.toThrow(/public internet/);
      await expect(runServerTool('import_file', { url: 'https://cdn.example.com/dogs/golden.png' }, { ...env, files: undefined })).rejects.toThrow(/cannot be imported here/);
    } finally {
      resolver.lookup = realLookup;
    }
    expect(validateToolInput('import_file', { url: '' }).ok).toBe(false);
    expect(validateToolInput('import_file', { url: 'https://x.example.com/a.png', title: 'A' }).ok).toBe(true);
  });

  it('validates the inputs', () => {
    expect(validateToolInput('web_search', { query: 'x', max_results: 11 }).ok).toBe(false);
    expect(validateToolInput('image_search', { query: '' }).ok).toBe(false);
    expect(validateToolInput('image_search', { query: 'x', max_results: 10 }).ok).toBe(true);
  });
});

describe('convert_pdf tool', () => {
  afterAll(closePdfReaders);

  it('makes a Markdown document of the open PDF, beside it', async () => {
    const report = path.join(import.meta.dirname, 'fixtures', 'report.pdf');
    const stored = (id: string, filename: string, type: string) => ({ meta: { id, filename, type, folder: 'Reports', size: 1, createdAt: '', url: '', downloadUrl: '' }, file: report });
    const files = { get: (owner: string, id: string) => (owner !== 'pdf-user' ? null : id === 'p1' ? stored('p1', 'Q3 Report.pdf', 'application/pdf') : id === 'h1' ? stored('h1', 'page.html', 'text/html') : null) } as unknown as FileStore;
    const made: { title: string; text: string; folder: string }[] = [];
    const sheets = { createMarkdown: async (_owner: string, title: string, doc: { text: string }, folder: string) => (made.push({ title, text: doc.text, folder }), { id: 'm1', kind: 'markdown', title, folder, updatedAt: '', createdAt: '' }) } as unknown as SheetStore;
    const onFile: AgentContext = { page: 'file', fileId: 'p1', filename: 'Q3 Report.pdf', type: 'application/pdf', size: 1 };
    const env = { userId: 'pdf-user', sheets, files, context: onFile };

    const out = JSON.parse(await runServerTool('convert_pdf', {}, env));
    expect(out).toMatchObject({ converted: true, doc_id: 'm1', kind: 'markdown', title: 'Q3 Report', pages: 2 });
    expect(made).toEqual([{ title: 'Q3 Report', text: expect.stringMatching(/^# Quarterly Report\n/), folder: 'Reports' }]);
    await expect(runServerTool('convert_pdf', { file_id: 'h1' }, env)).rejects.toThrow(/not a PDF/);
    await expect(runServerTool('convert_pdf', { file_id: 'nope' }, env)).rejects.toThrow(/no file nope/);
    await expect(runServerTool('convert_pdf', {}, { ...env, context: home })).rejects.toThrow(/Give file_id/);
    await expect(runServerTool('convert_pdf', {}, { ...env, files: undefined })).rejects.toThrow(/cannot be converted here/);
  });
});

describe('app context', () => {

  it('gives a message typed at the cursor the document and the cursor\'s place in it', async () => {
    const { renderContext, stripContext } = await import('./agent/prompt.ts');
    const base = { page: 'doc' as const, docId: 'd1', title: 'Plan', blockCount: 2, cursorBlock: 2 };
    expect(renderContext(base)).not.toContain('<document>');
    const text = renderContext({ ...base, inline: { document: '[1] # Plan\n\n[2] Ship it.', before: 'Ship ', after: 'it.' } });
    expect(text).toContain('<document>\n[1] # Plan\n\n[2] Ship it.\n</document>');
    expect(text).toContain('Text just before the cursor in its block: "Ship "');
    expect(text).toContain('The whole document is below');
    expect(stripContext(text)).toBeNull();
    const part = renderContext({ ...base, selectedText: 'Ship', inline: { document: '[2] Ship it.', showing: [2, 2], selectionBlocks: [2, 2] } });
    expect(part).toContain('The selection is in block 2.');
    expect(part).toContain('only blocks 2 to 2');
    const deck = { page: 'deck' as const, deckId: 'k1', title: 'Pitch', slideCount: 1, currentSlide: 1, selectedElements: ['e1'] };
    expect(renderContext(deck)).not.toContain('<deck>');
    const slide = renderContext({ ...deck, inline: { deck: 'Theme: dark\n{"slide":1}', selectedText: 'Agenda' } });
    expect(slide).toContain('<deck>\nTheme: dark\n{"slide":1}\n</deck>');
    expect(slide).toContain('Text selected inside that element when the user opened the prompt: "Agenda"');
    expect(renderContext({ ...deck, inline: { deck: '' } })).toContain('mean the selected element.');
    expect(renderContext({ ...deck, selectedElements: [], inline: { deck: '', showing: [3, 5] } })).toMatch(/mean the current slide\..*only slides 3 to 5/s);
    // The browser sends this, so a malformed one must not break the turn.
    expect(renderContext({ ...base, inline: { document: 5, showing: ['x'] } as never })).toContain('<document>\n\n</document>');
  });
  it('tells the assistant which stored file is open, and whether it can be read and edited', async () => {
    const { renderContext } = await import('./agent/prompt.ts');
    const page = renderContext({ page: 'file', fileId: 'f1', filename: 'index.html', type: 'text/html', size: 250_000 });
    expect(page).toContain('Open file: "index.html" (id f1), text/html, 250000 bytes');
    expect(page).toContain('read_file with this id returns its text, and edit_file changes it.');
    expect(renderContext({ page: 'file', fileId: 'f2', filename: 'clip.mp4', type: 'video/mp4', size: 10 })).toContain('read_file and edit_file cannot work on it');
    expect(renderContext({ page: 'file', fileId: 'f3', filename: 'logo.png', type: 'image/png', size: 10 })).toContain('view_image with this id shows it to you, transform_image makes exact edits to it');
    const boxed = renderContext({ page: 'file', fileId: 'f3', filename: 'logo.png', type: 'image/png', size: 10, selectedRegion: { x: 500, y: 250, width: 1000, height: 500, imageWidth: 2000, imageHeight: 1000 } });
    expect(boxed).toContain('1000×500 pixels with its top left corner at x 500, y 250, in the 2000×1000 picture');
    expect(boxed).toContain('from 25% to 75% of the width and from 25% to 75% of the height');
    // A region only means something on a picture, and a nonsense one is left out.
    expect(renderContext({ page: 'file', fileId: 'f1', filename: 'index.html', type: 'text/html', size: 1, selectedRegion: { x: 0, y: 0, width: 5, height: 5, imageWidth: 10, imageHeight: 10 } })).not.toContain('Selected region');
    expect(renderContext({ page: 'file', fileId: 'f3', filename: 'logo.png', type: 'image/png', size: 10, selectedRegion: { x: 0, y: 0, width: 5, height: 5, imageWidth: 0, imageHeight: 10 } })).not.toContain('Selected region');
    const picked = renderContext({ page: 'file', fileId: 'f1', filename: 'index.html', type: 'text/html', size: 250, selectedElement: '<h1 class="title">Hi</h1>' });
    expect(picked).toContain('Selected element');
    expect(picked).toContain(JSON.stringify('<h1 class="title">Hi</h1>'));
    expect(page).not.toContain('Selected element');
  });
});
