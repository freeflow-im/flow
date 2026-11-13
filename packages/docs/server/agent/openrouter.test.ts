import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import type { ModelCall } from './agent.ts';
import { checkOpenRouterKey, fromOpenRouter, toOpenRouterRequest } from './openrouter.ts';

type Params = Parameters<ModelCall>[0];

describe('OpenRouter translation', () => {
  const params: Params = {
    model: 'claude-sonnet-5-5',
    max_tokens: 32000,
    betas: ['server-side-fallback-2026-07-01'],
    output_config: { effort: 'medium' },
    system: [{ type: 'text', text: 'You are the assistant.' }],
    tools: [
      { type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' },
      { name: 'list_files', description: 'List', input_schema: { type: 'object', properties: {} } },
      { name: 'add_chart', description: 'Chart', input_schema: { type: 'object', properties: {} }, defer_loading: true },
    ],
    cache_control: { type: 'ephemeral' },
    messages: [{ role: 'user', content: 'Chart it' }],
    ...({ fallbacks: 'default' } as object),
  } as Params;

  it('sends the Claude request as it is, but for the model, Anthropic-only options and the tool search', () => {
    const req = toOpenRouterRequest(params, 'openai/gpt-5.2') as Params & { fallbacks?: unknown };
    expect(req.model).toBe('openai/gpt-5.2');
    // OpenRouter refuses `fallbacks: "default"` ("expected array"); betas are Anthropic's.
    expect(req.fallbacks).toBeUndefined();
    expect(req.betas).toBeUndefined();
    expect(req.tools).toEqual([{ type: 'openrouter:tool_search' }, params.tools![1], params.tools![2]]);
    expect(req.system).toBe(params.system);
    expect(req.output_config).toEqual({ effort: 'medium' });
    expect(req.cache_control).toEqual({ type: 'ephemeral' });
    expect(req.messages).toEqual(params.messages);
  });

  it('marks the thinking in a reply as OpenRouter\'s, and leaves the rest', () => {
    const reply = {
      id: 'gen-1',
      content: [
        { type: 'server_tool_use', id: 'call_1', name: 'openrouter:tool_search', input: { query: 'chart' } },
        { type: 'openrouter_tool_search_result', tool_use_id: 'call_1', content: { matches: [{ tool_id: 'add_chart' }] } },
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'redacted_thinking', data: 'openrouter-data' },
        { type: 'tool_use', id: 'call_2', name: 'add_chart', input: {} },
      ],
      stop_reason: 'tool_use',
    } as unknown as Anthropic.Beta.BetaMessage;
    const out = fromOpenRouter(reply);
    expect(out.content).toEqual([
      reply.content[0],
      reply.content[1],
      { type: 'thinking', thinking: '', signature: 'openrouter:sig' },
      { type: 'redacted_thinking', data: 'openrouter:openrouter-data' },
      reply.content[4],
    ]);
    expect(out.stop_reason).toBe('tool_use');
  });

  it('checks a key and a model that can call tools before they are saved', async () => {
    const fake = (keyStatus: number) =>
      (async (url: string) =>
        String(url).endsWith('/key')
          ? new Response('{}', { status: keyStatus })
          : Response.json({ data: [{ id: 'good/model', supported_parameters: ['tools'] }, { id: 'chat/only', supported_parameters: ['temperature'] }] })) as unknown as typeof fetch;
    await expect(checkOpenRouterKey('k', 'good/model', fake(200))).resolves.toBeUndefined();
    await expect(checkOpenRouterKey('k', 'good/model', fake(401))).rejects.toThrow(/did not accept/);
    await expect(checkOpenRouterKey('k', 'no/such', fake(200))).rejects.toThrow(/has no model/);
    await expect(checkOpenRouterKey('k', 'chat/only', fake(200))).rejects.toThrow(/cannot call tools/);
  });
});
