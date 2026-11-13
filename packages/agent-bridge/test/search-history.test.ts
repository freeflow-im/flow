// search_history: the server's message search over every channel the agent can read, or one channel; against a server
// from before it (404), the old substring scan of the conversation's recent messages.
import { describe, expect, it } from 'vitest';
import type { MessageDTO } from '@flow/shared';
import { FlowApiError, type MessageSearchHit } from '../src/api.js';
import { searchHistoryTool } from '../src/mcp-server.js';

const hit = (over: Partial<MessageSearchHit> = {}): MessageSearchHit => ({
  id: 'm1', title: '#launch', snippet: 'we raise \u0002prices\u0003\nin March', author: 'u-ann', at: '2026-11-13T10:00:00.000Z', channelId: 'c1', threadRootId: null, authorName: 'Ann', ...over,
});

function api(answer: { hits: MessageSearchHit[] } | Error, messages: Partial<MessageDTO>[] = []) {
  const asked: { q: string; limit?: number }[] = [];
  const listed: string[] = [];
  return {
    asked, listed,
    searchMessages: async (_ws: string, q: string, limit?: number) => { asked.push({ q, limit }); if (answer instanceof Error) throw answer; return answer; },
    listMessages: async (channelId: string) => { listed.push(channelId); return { messages: messages as MessageDTO[], hasMore: false } as never; },
  };
}

describe('search_history', () => {
  it('asks the server, and renders each hit on one line with its words marked', async () => {
    const a = api({ hits: [hit(), hit({ id: 'm2', title: 'Direct message', threadRootId: 'm0' })] });
    const text = await searchHistoryTool(a, 'ws', 'c-default', { query: 'pricing', limit: 5 });
    expect(a.asked).toEqual([{ q: 'pricing', limit: 5 }]);
    expect(text.split('\n')).toEqual([
      '[2026-11-13T10:00:00.000Z <@u-ann> #launch msg m1] we raise «prices» in March',
      '[2026-11-13T10:00:00.000Z <@u-ann> Direct message msg m2 in thread m0] we raise «prices» in March',
    ]);
  });

  it('a channelId narrows the search to it; the conversation’s channel is not assumed', async () => {
    const a = api({ hits: [] });
    expect(await searchHistoryTool(a, 'ws', 'c-default', { query: 'pricing', channelId: 'c9' })).toBe('no matches');
    expect(a.asked[0]!.q).toBe('pricing in:c9');
    await searchHistoryTool(a, 'ws', 'c-default', { query: 'pricing' });
    expect(a.asked[1]!.q).toBe('pricing');
  });

  it('falls back to the recent messages of the conversation against a server without search', async () => {
    const a = api(new FlowApiError(404, 'not_found', 'Not Found'), [
      { id: 'x1', userId: 'u', createdAt: '2026-11-01T00:00:00.000Z', body: 'Pricing call at 3', deletedAt: null, files: [] },
      { id: 'x2', userId: 'u', createdAt: '2026-11-01T00:00:00.000Z', body: 'lunch', deletedAt: null, files: [] },
    ]);
    expect(await searchHistoryTool(a, 'ws', 'c-default', { query: 'pricing' })).toBe('[2026-11-01T00:00:00.000Z <@u> msg x1] Pricing call at 3');
    expect(a.listed).toEqual(['c-default']);
  });

  it('other errors are the caller’s, and an empty query is refused', async () => {
    await expect(searchHistoryTool(api(new FlowApiError(500, 'boom', 'boom')), 'ws', 'c', { query: 'x' })).rejects.toThrow('boom');
    expect(await searchHistoryTool(api({ hits: [] }), 'ws', 'c', { query: '  ' })).toBe('say what to search for in query');
  });
});
