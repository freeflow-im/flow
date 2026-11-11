// Who asked for a turn rides on every request made during it (agents.md §3): `x-flow-invoked-by`, beside a wake job's `x-flow-job`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FlowApi, withInvoker } from '../src/api.js';

afterEach(() => vi.unstubAllGlobals());

describe('the API client\'s turn headers', () => {
  it('sends the asker inside a turn, keeps the job when both are set, and sends nothing outside one', async () => {
    const seen: Record<string, string>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      return new Response('{"workspaces":[]}', { headers: { 'content-type': 'application/json' } });
    }));
    const api = new FlowApi('http://flow.test', 'tok');
    await withInvoker('acct-ann', () => api.myWorkspaces());
    await withInvoker('acct-ann', () => api.withJob('job-1').myWorkspaces());
    await withInvoker(null, () => api.myWorkspaces());
    await api.myWorkspaces();
    expect(seen[0]).toMatchObject({ authorization: 'Bearer tok', 'x-flow-invoked-by': 'acct-ann' });
    expect(seen[0]).not.toHaveProperty('x-flow-job');
    expect(seen[1]).toMatchObject({ 'x-flow-job': 'job-1', 'x-flow-invoked-by': 'acct-ann' });
    expect(seen[2]).not.toHaveProperty('x-flow-invoked-by');
    expect(seen[3]).not.toHaveProperty('x-flow-invoked-by');
  });
});
