// The suite's search at /mcp (docs/specs/suite-mcp.md §6): each app the caller may read is asked at once, a slow or failing
// one is named as skipped, and the lists are merged by reciprocal rank fusion. Offered only with search:use and at least
// one app's search the token can run.
import { describe, expect, it, vi } from 'vitest';
import { fuse, suiteSearch, SOURCE_MS, type SuiteHit } from './search.ts';
import { handleSuiteMcp, type DocsPort } from './suite.ts';

const hit = (app: SuiteHit['app'], id: string, when?: string): SuiteHit => ({ app, kind: 'x', id, title: id, open: '', ...(when ? { when } : {}) });

describe('the suite’s search', () => {
  it('interleaves the sources by their own order, newer first on a tie', () => {
    const out = fuse([[hit('docs', 'd1', '2026-01-01'), hit('docs', 'd2')], [hit('chat', 'c1', '2026-11-01'), hit('chat', 'c2', '2026-10-01')]], 10);
    expect(out.map((h) => h.id)).toEqual(['c1', 'd1', 'c2', 'd2']);
    expect(fuse([[hit('docs', 'a'), hit('docs', 'b'), hit('docs', 'c')]], 2).map((h) => h.id)).toEqual(['a', 'b']);
  });

  it('asks each allowed source, only the apps named, and names one that fails or is too slow', async () => {
    vi.useFakeTimers();
    try {
      const asked: string[] = [];
      const call = async (tool: string, input: Record<string, unknown>) => {
        asked.push(tool);
        if (tool === 'search_messages') return { hits: [{ id: 'm1', channel: 'launch', channelId: 'ch1', from: 'Ben', at: '2026-11-20T10:00:00Z', text: '«ship» it' }] };
        if (tool === 'search_content') return { hits: [{ id: 'd1', kind: 'doc', title: 'Launch plan', updated_at: '2026-11-01', snippet: 'we «ship»' }] };
        if (tool === 'search_mail') return new Promise<Record<string, unknown>>(() => {});
        if (tool === 'list_events') { expect(input).toMatchObject({ q: 'ship' }); throw new Error('Calendar is down'); }
        return {};
      };
      const allowed = new Set(['search_content', 'search_messages', 'search_mail', 'list_events']);
      const running = suiteSearch({ allowed, call, now: () => Date.parse('2026-11-22T00:00:00Z') }, 'ship', undefined, 10);
      await vi.advanceTimersByTimeAsync(SOURCE_MS + 10);
      const r = await running;
      expect(asked.sort()).toEqual(['list_events', 'search_content', 'search_mail', 'search_messages']);
      expect(r.hits.map((h) => [h.app, h.id])).toEqual([['chat', 'm1'], ['docs', 'd1']]);
      expect(r.hits[0]!.open).toBe('read_messages (channelId ch1)');
      expect(r.searched.sort()).toEqual(['chat', 'docs']);
      expect(r.skipped).toEqual(expect.arrayContaining([{ app: 'mail', reason: 'no answer within 3 s' }, { app: 'calendar', reason: 'Calendar is down' }]));
      asked.length = 0;
      await suiteSearch({ allowed, call }, 'ship', ['docs'], 10);
      expect(asked).toEqual(['search_content']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is offered at /mcp with search:use and something to search, and runs Docs’ search in the Docs object', async () => {
    const calls: string[] = [];
    const docs: DocsPort = { pdf: false, call: async (name) => { calls.push(name); return { content: [{ type: 'text', text: JSON.stringify({ hits: [{ id: 'd9', kind: 'doc', title: 'Plan' }] }) }] }; }, importFile: async () => ({ file: {}, warnings: [] }) };
    const rpc = async (scope: string, method: string, params: Record<string, unknown> = {}) => {
      const req = new Request('https://app.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      return (await (await handleSuiteMcp(req, { userId: 'u1', email: 'u1@test', orgId: 'o1', scope, endpoint: '/mcp', origin: 'https://app.test' }, { docs })).json()) as { result?: { tools?: { name: string }[]; structuredContent?: { hits: SuiteHit[] } } };
    };
    const listed = async (scope: string) => ((await rpc(scope, 'tools/list')).result?.tools ?? []).some((t) => t.name === 'search');
    expect(await listed('files:read search:use')).toBe(true);
    expect(await listed('files:read')).toBe(false);
    expect(await listed('search:use')).toBe(false);
    const r = await rpc('files:read search:use', 'tools/call', { name: 'search', arguments: { query: 'plan' } });
    expect(r.result?.structuredContent?.hits).toEqual([expect.objectContaining({ app: 'docs', id: 'd9', title: 'Plan' })]);
    expect(calls).toEqual(['search_content']);
  }, 60_000);
});
