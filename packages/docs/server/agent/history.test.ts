import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { markOpenRouterThinking, portableHistory } from './history.ts';

type Msg = Anthropic.Beta.BetaMessageParam;
const ask: Msg = { role: 'user', content: 'Book it' };
const results: Msg = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'ok' }] };
const call = { type: 'tool_use', id: 'call', name: 'create_event', input: {} };

// The shapes each provider leaves in the stored history, as captured from the live APIs.
const claude: Msg = {
  role: 'assistant',
  content: [
    { type: 'thinking', thinking: '', signature: 'EqClaude' },
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_bm25', input: { query: 'calendar' } },
    { type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'tool_search_tool_search_result', tool_references: [{ type: 'tool_reference', tool_name: 'create_event' }] } },
    call,
  ] as Msg['content'],
};
// openai.ts stores OpenAI's search as Claude's blocks, under OpenAI's ids.
const openai: Msg = {
  role: 'assistant',
  content: [
    { type: 'server_tool_use', id: 'tsc_1', name: 'tool_search_tool_bm25', input: { paths: ['create_event'] } },
    { type: 'tool_search_tool_result', tool_use_id: 'tsc_1', content: { type: 'tool_search_tool_search_result', tool_references: [{ type: 'tool_reference', tool_name: 'create_event' }] } },
    call,
  ] as Msg['content'],
};
const openrouter: Msg = {
  role: 'assistant',
  content: markOpenRouterThinking([
    { type: 'server_tool_use', id: 'orpresearch_2', name: 'openrouter:tool_search', input: {} },
    { type: 'openrouter_tool_search_result', tool_use_id: 'orpresearch_2', content: { matches: [{ tool_id: 'create_event' }] } },
    { type: 'thinking', thinking: '', signature: 'gptsig' },
    { type: 'redacted_thinking', data: 'openrouter-d1' },
    call,
  ] as unknown[]) as Msg['content'],
};
const types = (m: Msg | undefined) => (m && typeof m.content !== 'string' ? m.content.map((b) => b.type) : []);

describe('portable history', () => {
  it('leaves a history alone for the provider that wrote it', () => {
    const fromClaude = [ask, claude, results];
    expect(portableHistory(fromClaude, 'anthropic')).toBe(fromClaude);
  });

  it('gives Claude only its own search steps and thinking', () => {
    // Anthropic refused OpenAI's and OpenRouter's search ids (srvtoolu_ pattern) and OpenRouter's thinking (signature).
    expect(types(portableHistory([ask, openai, results], 'anthropic')[1])).toEqual(['tool_use']);
    expect(types(portableHistory([ask, openrouter, results], 'anthropic')[1])).toEqual(['tool_use']);
  });

  it('gives OpenRouter its own search steps and thinking, unmarked, and none of Claude\'s', () => {
    // OpenRouter refused Claude's tool_search_tool_result block.
    expect(types(portableHistory([ask, claude, results], 'openrouter')[1])).toEqual(['tool_use']);
    expect(types(portableHistory([ask, openai, results], 'openrouter')[1])).toEqual(['tool_use']);
    const own = portableHistory([ask, openrouter, results], 'openrouter')[1]!.content as { type: string; signature?: string; data?: string }[];
    expect(own.map((b) => b.type)).toEqual(['server_tool_use', 'openrouter_tool_search_result', 'thinking', 'redacted_thinking', 'tool_use']);
    expect(own[2]!.signature).toBe('gptsig');
    expect(own[3]!.data).toBe('openrouter-d1');
  });

  it('drops an assistant message left empty', () => {
    const closing: Msg = { role: 'assistant', content: [{ type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_9', content: { type: 'tool_search_tool_result_error', error_code: 'unavailable' } }] as Msg['content'] };
    expect(portableHistory([ask, closing, { role: 'user', content: 'hi' }], 'openrouter').map((m) => m.role)).toEqual(['user', 'user']);
  });
});
