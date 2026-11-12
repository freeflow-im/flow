// Connect an agent (docs/specs/agents.md §1): the suite's MCP address and what to paste into an agent, and the agents the
// person connected, each with Disconnect, against a fetch that answers the platform's /v1 routes.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Connect, connectPrompt } from './Connect';

let calls: { method: string; path: string }[];
let agents: { id: string; name: string; mode?: 'personal' | 'shared'; origin: string; endpoint: string; connectedAt: string; organization?: string }[];
beforeEach(() => {
  calls = [];
  agents = [{ id: 'c1', name: 'Claude Desktop', mode: 'personal', origin: 'x', endpoint: 'https://app.test/mcp', connectedAt: '2026-11-11T10:00:00.000Z', organization: 'Acme' }];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    const method = init?.method ?? 'GET';
    calls.push({ method, path });
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/v1/me/agent-connections') return json({ mcpUrl: 'https://app.test/mcp', agents });
    if (method === 'DELETE' && path === '/v1/me/agent-connections/c1') { agents = []; return json({ ok: true }); }
    return json({ ok: true });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><Connect /></QueryClientProvider>);

describe('Connect an agent', () => {
  it('shows the MCP address and the instructions for the common clients', async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId('connect-url').textContent).toBe('https://app.test/mcp'));
    const prompt = screen.getByTestId('connect-prompt').textContent ?? '';
    expect(prompt).toContain('claude mcp add --transport http freeflow https://app.test/mcp');
    expect(prompt).toContain('codex mcp add freeflow --url https://app.test/mcp');
    expect(prompt).toContain('https://app.test/llms.txt');
    expect(connectPrompt('https://app.test/mcp')).toContain('mcp-remote');
  });

  it('lists the connected agents and disconnects one after a confirmation', async () => {
    mount();
    expect((await screen.findByTestId('connection-c1')).textContent).toContain('acts as you · Acme');
    fireEvent.click(screen.getByTestId('connection-disconnect-c1'));
    fireEvent.click(await screen.findByTestId('connection-disconnect-confirm-c1-yes'));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/v1/me/agent-connections/c1')).toBe(true));
    expect(await screen.findByTestId('connections-empty')).toBeTruthy();
  });
});
