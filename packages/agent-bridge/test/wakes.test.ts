// An agent's wakes for itself (docs/specs/agent-self-wake.md): the bridge's schedule_wake, list_wakes and cancel_wake call
// /v1/events/wakes as the agent, and a wake answers in the conversation it was set from unless it names a channel.
import { describe, expect, it } from 'vitest';
import { FlowApiError } from '../src/api.js';
import { WAKE_TOOL_NAMES, wakeTool, type WakeApi } from '../src/wake-tools.js';

function fake(fail?: FlowApiError) {
  const calls: { method: string; path: string; workspaceId: string; body?: unknown }[] = [];
  const api: WakeApi = {
    wakes: (async (method: string, path: string, workspaceId: string, body?: unknown) => {
      calls.push({ method, path, workspaceId, ...(body !== undefined ? { body } : {}) });
      if (fail) throw fail;
      if (method === 'POST') return { wake: { id: 'w1', name: 'n', prompt: 'p', at: '2026-11-21T17:00:00.000Z', ...(body as object) } };
      if (method === 'GET') return { wakes: [] };
      return { ok: true };
    }) as WakeApi['wakes'],
  };
  return { api, calls };
}

describe('the wake tools', () => {
  it('are the three, by name', () => {
    expect([...WAKE_TOOL_NAMES]).toEqual(['schedule_wake', 'list_wakes', 'cancel_wake']);
  });

  it('set a wake in this conversation’s thread, or in the channel named', async () => {
    const f = fake();
    const here = { channelId: 'chan-1', threadRootId: 'm-root' };
    const out = await wakeTool(f.api, 'ws-1', 'schedule_wake', { prompt: 'Check the deploy', in_minutes: 20 }, here);
    expect(out.isError).toBe(false);
    expect(out.text).toContain('wake set: w1');
    expect(f.calls[0]).toEqual({ method: 'POST', path: '', workspaceId: 'ws-1', body: { prompt: 'Check the deploy', inMinutes: 20, channelId: 'chan-1', threadRootId: 'm-root' } });
    await wakeTool(f.api, 'ws-1', 'schedule_wake', { prompt: 'Remind Ann', at: '2026-11-21T09:00:00-08:00', channelId: 'chan-2' }, here);
    expect(f.calls[1]!.body).toEqual({ prompt: 'Remind Ann', at: '2026-11-21T09:00:00-08:00', channelId: 'chan-2' });
  });

  it('list and cancel, and pass the server’s refusal on', async () => {
    const f = fake();
    expect((await wakeTool(f.api, 'ws-1', 'list_wakes', {}, { channelId: 'c' })).text).toBe('no wakes waiting');
    expect(await wakeTool(f.api, 'ws-1', 'cancel_wake', { wake_id: 'w1' }, { channelId: 'c' })).toEqual({ text: 'wake w1 cancelled', isError: false });
    expect(f.calls.at(-1)).toMatchObject({ method: 'DELETE', path: 'w1' });
    const refused = fake(new FlowApiError(409, 'too_many_wakes', 'You already have 10 wakes waiting.'));
    expect(await wakeTool(refused.api, 'ws-1', 'schedule_wake', { prompt: 'x', in_minutes: 5 }, { channelId: 'c' })).toEqual({ text: 'You already have 10 wakes waiting.', isError: true });
    expect((await wakeTool(f.api, '', 'list_wakes', {}, { channelId: 'c' })).isError).toBe(true);
  });
});
