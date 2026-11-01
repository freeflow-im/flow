import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import type { ModelCall } from './agent.ts';
import { checkOpenRouterKey, fromChatCompletion, toChatRequest } from './openrouter.ts';

type Params = Parameters<ModelCall>[0];

describe('OpenRouter translation', () => {
  const params = {
    model: 'claude-sonnet-5-5',
    max_tokens: 1000,
    system: [{ type: 'text', text: 'Be helpful.' }],
    tools: [{ name: 'list_sheets', description: 'List them', input_schema: { type: 'object', properties: {} } }],
    messages: [
      { role: 'user', content: 'Find my budget' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm', signature: 'sig' },
          { type: 'text', text: 'Looking.' },
          { type: 'tool_use', id: 'call_1', name: 'list_sheets', input: { query: 'budget' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: '[]' }] },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'text', text: 'Here is a picture.' },
        ],
      },
    ],
  } as unknown as Params;

  it('sends chat messages: system first, tool calls and their results, pictures with their text', () => {
    const req = toChatRequest(params, 'moonshotai/kimi-k3');
    expect(req.model).toBe('moonshotai/kimi-k3');
    expect(req.tools).toEqual([{ type: 'function', function: { name: 'list_sheets', description: 'List them', parameters: { type: 'object', properties: {} } } }]);
    expect(req.messages).toEqual([
      { role: 'system', content: 'Be helpful.' },
      { role: 'user', content: 'Find my budget' },
      { role: 'assistant', content: 'Looking.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_sheets', arguments: '{"query":"budget"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '[]' },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          { type: 'text', text: 'Here is a picture.' },
        ],
      },
    ]);
  });

  it('reads the reply back as a Claude message', () => {
    const res = {
      id: 'r1',
      model: 'moonshotai/kimi-k3',
      choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: 'On it.', refusal: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'list_sheets', arguments: '{"query":"x"}' } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    } as unknown as OpenAI.Chat.ChatCompletion;
    const msg: Anthropic.Beta.BetaMessage = fromChatCompletion(res);
    expect(msg.content).toEqual([
      { type: 'text', text: 'On it.', citations: null },
      { type: 'tool_use', id: 't1', name: 'list_sheets', input: { query: 'x' } },
    ]);
    expect(msg.stop_reason).toBe('tool_use');
    expect(msg.usage).toMatchObject({ input_tokens: 10, output_tokens: 5 });
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
