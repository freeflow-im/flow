import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.ts';
import { mailbox, signUp } from '../testing.ts';
import type { ModelCall } from './agent.ts';
import { toInput, toMessage, toRequest } from './openai.ts';
import { SettingsError } from './settings.ts';

type Params = Parameters<ModelCall>[0];

describe('OpenAI translation', () => {
  const messages: Params['messages'] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: '<app_context>home</app_context>' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        { type: 'text', text: 'What is this?' },
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hmm', signature: 'sig' },
        { type: 'text', text: 'Let me look.' },
        { type: 'tool_use', id: 'call_1', name: 'list_sheets', input: { query: 'budget' } },
        { type: 'tool_use', id: 'call_2', name: 'get_sheet_overview', input: {} },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: '{"sheets":[]}' },
        { type: 'tool_result', tool_use_id: 'call_2', content: 'No spreadsheet is open.', is_error: true },
        { type: 'text', text: 'And now?' },
      ],
    },
  ];

  it('turns the stored history into Responses input items', () => {
    expect(toInput(messages)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: '<app_context>home</app_context>' },
          { type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,AAAA' },
          { type: 'input_text', text: 'What is this?' },
        ],
      },
      { role: 'assistant', content: 'Let me look.' },
      { type: 'function_call', call_id: 'call_1', name: 'list_sheets', arguments: '{"query":"budget"}' },
      { type: 'function_call', call_id: 'call_2', name: 'get_sheet_overview', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"sheets":[]}' },
      { type: 'function_call_output', call_id: 'call_2', output: 'Error: No spreadsheet is open.' },
      { role: 'user', content: [{ type: 'input_text', text: 'And now?' }] },
    ]);
  });

  it('builds the request from the prompt, tools and limits', () => {
    const req = toRequest(
      {
        model: 'claude-sonnet-5-5',
        max_tokens: 32000,
        system: [{ type: 'text', text: 'You are the assistant.' }],
        output_config: { effort: 'medium' },
        tools: [{ name: 'list_sheets', description: 'List spreadsheets.', input_schema: { type: 'object', properties: { query: { type: 'string' } } } }],
        messages,
      },
      'gpt-6-luna',
    );
    expect(req).toMatchObject({ model: 'gpt-6-luna', instructions: 'You are the assistant.', max_output_tokens: 32000, reasoning: { effort: 'medium' }, store: false });
    expect(req.tools).toEqual([
      { type: 'function', name: 'list_sheets', description: 'List spreadsheets.', parameters: { type: 'object', properties: { query: { type: 'string' } } }, strict: false },
    ]);
  });

  const response = (over: Partial<OpenAI.Responses.Response>) =>
    ({ id: 'resp_1', model: 'gpt-6-luna', status: 'completed', output: [], usage: { input_tokens: 12, output_tokens: 7 }, ...over }) as OpenAI.Responses.Response;

  it('turns a reply with tool calls into an assistant message', () => {
    const msg = toMessage(
      response({
        output: [
          { type: 'reasoning', id: 'rs_1', summary: [] },
          { type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Looking.', annotations: [] }] },
          { type: 'function_call', call_id: 'call_9', name: 'list_sheets', arguments: '{"query":"q"}' },
          { type: 'function_call', call_id: 'call_10', name: 'list_sheets', arguments: '{"query":' },
        ] as OpenAI.Responses.ResponseOutputItem[],
      }),
    );
    expect(msg.content).toEqual([
      { type: 'text', text: 'Looking.', citations: null },
      { type: 'tool_use', id: 'call_9', name: 'list_sheets', input: { query: 'q' } },
      { type: 'tool_use', id: 'call_10', name: 'list_sheets', input: {} },
    ]);
    expect(msg.stop_reason).toBe('tool_use');
    expect(msg.usage).toMatchObject({ input_tokens: 12, output_tokens: 7 });
  });

  it('maps how the reply ended', () => {
    const said = [{ type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hi', annotations: [] }] }] as OpenAI.Responses.ResponseOutputItem[];
    expect(toMessage(response({ output: said })).stop_reason).toBe('end_turn');
    expect(toMessage(response({ output: said, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })).stop_reason).toBe('max_tokens');
    const refusal = [{ type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'No.' }] }] as OpenAI.Responses.ResponseOutputItem[];
    expect(toMessage(response({ output: refusal })).stop_reason).toBe('refusal');
    expect(() => toMessage(response({ status: 'failed', error: { code: 'server_error', message: 'boom' } }))).toThrow('boom');
  });
});

describe('assistant settings', () => {
  const box = mailbox();
  const KEY = 'sk-proj-SECRETKEY-abcd1234';
  const calls: { provider: string; apiKey: string; model: string; params: Params }[] = [];
  let dir: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let cookie: string;

  const reply = (text: string) =>
    ({ id: 'm', type: 'message', role: 'assistant', model: 'x', content: [{ type: 'text', text, citations: null }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }) as unknown as Anthropic.Beta.BetaMessage;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'sheetsweb-settings-test-'));
    app = await buildApp({
      dataDir: dir,
      sendMail: box.send,
      agent: {
        // No calls are allowed on the server's key, so only a user's own key gets through.
        dailyRequestLimit: 0,
        model: async () => reply('from the built-in model'),
        ownModel: ({ provider, apiKey, model }) => async (params, { onText }) => {
          calls.push({ provider, apiKey, model, params });
          onText(`from ${provider}`);
          return reply(`from ${provider}`);
        },
      },
      checkAssistantKey: async (provider, apiKey) => {
        if (apiKey === 'sk-wrong') throw new SettingsError(`${provider} did not accept that API key.`);
      },
    });
    cookie = (await signUp(app, box, 'settings@x.com')).cookie;
  });

  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = async () => (await app.inject({ method: 'GET', url: '/api/settings/assistant', headers: { cookie } })).json().settings;
  const put = (payload: unknown) => app.inject({ method: 'PUT', url: '/api/settings/assistant', headers: { cookie }, payload: payload as object });
  const send = () => app.inject({ method: 'POST', url: '/api/agent/turn', headers: { cookie }, payload: { message: 'Hi', context: { page: 'home' } } });
  const fresh = {
    provider: 'default',
    builtIn: true,
    agents: false,
    anthropicModel: 'claude-sonnet-5-5',
    openaiModel: 'gpt-6.1-sol',
    openrouterModel: 'anthropic/claude-sonnet-5.5',
    anthropicKey: null,
    openaiKey: null,
    openrouterKey: null,
    braveKey: null,
  };

  it('requires sign-in and starts on the built-in model', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/settings/assistant' })).statusCode).toBe(401);
    expect(await get()).toEqual(fresh);
  });

  it('rejects a missing key, a wrong key and an unknown model without saving', async () => {
    let res = await put({ provider: 'openai', openaiModel: 'gpt-6-luna' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Enter your OpenAI API key/);
    res = await put({ provider: 'openai', openaiModel: 'gpt-6-luna', openaiKey: 'sk-wrong' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/did not accept/);
    expect((await put({ provider: 'openai', openaiModel: 'gpt-4', openaiKey: KEY })).statusCode).toBe(400);
    expect((await put({ provider: 'anthropic', anthropicModel: 'claude-2', anthropicKey: KEY })).statusCode).toBe(400);
    expect((await put({ provider: 'openrouter', openrouterModel: 'not a model', openrouterKey: KEY })).statusCode).toBe(400);
    expect(await get()).toEqual(fresh);
  });

  it('stores the key encrypted, returns it masked, and runs the assistant on it', async () => {
    const res = await put({ provider: 'openai', openaiModel: 'gpt-6-astra', openaiKey: KEY });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toMatchObject({ provider: 'openai', openaiModel: 'gpt-6-astra', openaiKey: '••••1234' });
    expect(res.body).not.toContain('SECRETKEY');
    expect(readFileSync(path.join(dir, 'app.db')).includes('SECRETKEY')).toBe(false);

    const turn = await send();
    expect(turn.statusCode).toBe(200);
    expect(turn.payload).toContain('from openai');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ provider: 'openai', apiKey: KEY, model: 'gpt-6-astra' });
    expect(calls[0].params.tools?.length).toBeGreaterThan(0);

    // Changing the model keeps the saved key.
    expect((await put({ provider: 'openai', openaiModel: 'gpt-6-luna' })).json().settings).toMatchObject({ provider: 'openai', openaiModel: 'gpt-6-luna', openaiKey: '••••1234' });
    await send();
    expect(calls[1]).toMatchObject({ apiKey: KEY, model: 'gpt-6-luna' });
  });

  it('runs on an Anthropic key with the chosen Claude model, and on any OpenRouter model', async () => {
    expect((await put({ provider: 'anthropic', anthropicModel: 'claude-opus-5-5', anthropicKey: 'sk-ant-SECRET-9999' })).statusCode).toBe(200);
    await send();
    expect(calls.at(-1)).toMatchObject({ provider: 'anthropic', apiKey: 'sk-ant-SECRET-9999', model: 'claude-opus-5-5' });
    // The Claude request names the user's model.
    expect(calls.at(-1)!.params.model).toBe('claude-opus-5-5');

    const or = await put({ provider: 'openrouter', openrouterModel: 'moonshotai/kimi-k3', openrouterKey: 'sk-or-SECRET-7777' });
    expect(or.json().settings).toMatchObject({ provider: 'openrouter', openrouterModel: 'moonshotai/kimi-k3', openrouterKey: '••••7777', anthropicKey: '••••9999', openaiKey: '••••1234' });
    await send();
    expect(calls.at(-1)).toMatchObject({ provider: 'openrouter', apiKey: 'sk-or-SECRET-7777', model: 'moonshotai/kimi-k3' });
  });

  it('goes back to the built-in model, with its daily limit, and removes the key', async () => {
    expect((await put({ provider: 'default' })).json().settings).toMatchObject({ provider: 'default', openaiKey: '••••1234' });
    const before = calls.length;
    expect((await send()).statusCode).toBe(429);
    expect(calls).toHaveLength(before);

    expect((await put({ provider: 'default', openaiKey: null })).json().settings.openaiKey).toBeNull();
    expect((await put({ provider: 'openai', openaiModel: 'gpt-6-luna' })).statusCode).toBe(400);
  });
});

describe("the desktop app's assistant", () => {
  const dirs: string[] = [];
  const reply = { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [{ type: 'text', text: 'ok', citations: null }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } as unknown as Anthropic.Beta.BetaMessage;
  const used: string[] = [];
  const open = async (settingsDir: string, env?: Record<string, string>) => {
    const folder = mkdtempSync(path.join(tmpdir(), 'sheetsweb-desk-folder-'));
    const dataDir = mkdtempSync(path.join(tmpdir(), 'sheetsweb-desk-data-'));
    dirs.push(folder, dataDir);
    return buildApp({
      dataDir,
      local: { dir: folder, settingsDir, ...(env ? { env } : {}) },
      agent: { model: async () => reply, ownModel: (c) => async () => (used.push(`${c.provider}:${c.apiKey}`), reply) },
      checkAssistantKey: async () => {},
    });
  };
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('has no model of its own: the assistant asks for a key until one is set', async () => {
    const shared = mkdtempSync(path.join(tmpdir(), 'sheetsweb-desk-settings-'));
    dirs.push(shared);
    const app = await open(shared);
    const settings = (await app.inject({ method: 'GET', url: '/api/settings/assistant' })).json().settings;
    expect(settings).toMatchObject({ provider: 'default', builtIn: false });
    const turn = await app.inject({ method: 'POST', url: '/api/agent/turn', payload: { message: 'Hi', context: { page: 'home' } } });
    expect(turn.statusCode).toBe(400);
    expect(turn.json().error).toMatch(/add your Anthropic, OpenAI or OpenRouter API key/);
    expect((await app.inject({ method: 'PUT', url: '/api/settings/assistant', payload: { provider: 'openai', openaiKey: 'sk-mine-key-mine' } })).statusCode).toBe(200);
    await app.close();

    // Another folder's server shares the settings.
    const other = await open(shared);
    expect((await other.inject({ method: 'GET', url: '/api/settings/assistant' })).json().settings).toMatchObject({ provider: 'openai', openaiKey: '••••mine' });
    await other.close();
  });

  it("uses a key from the environment on the first run, Anthropic's first, and only then", async () => {
    const shared = mkdtempSync(path.join(tmpdir(), 'sheetsweb-desk-settings-'));
    dirs.push(shared);
    const app = await open(shared, { OPENAI_API_KEY: 'sk-env-openai', ANTHROPIC_API_KEY: 'sk-ant-env-key-env' });
    expect((await app.inject({ method: 'GET', url: '/api/settings/assistant' })).json().settings).toMatchObject({ provider: 'anthropic', anthropicKey: '••••-env', openaiKey: '••••enai' });
    await app.inject({ method: 'POST', url: '/api/agent/turn', payload: { message: 'Hi', context: { page: 'home' } } });
    expect(used.at(-1)).toBe('anthropic:sk-ant-env-key-env');
    await app.inject({ method: 'PUT', url: '/api/settings/assistant', payload: { provider: 'openai' } });
    await app.close();

    // Settings exist now: a key in the environment no longer changes them.
    const again = await open(shared, { OPENROUTER_API_KEY: 'sk-or-env' });
    expect((await again.inject({ method: 'GET', url: '/api/settings/assistant' })).json().settings).toMatchObject({ provider: 'openai', openrouterKey: null });
    await again.close();
  });
});
