// Your assistant (docs/specs/agents.md §1.1): a member's own section, against a fetch that answers the assistant's routes.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDTO } from '@flow/shared';
import { Assistant } from './Assistant';

const org: WorkspaceDTO = {
  id: 'o1', slug: 'acme', name: 'Acme', createdBy: 'u-ann', createdAt: '2026-01-01T00:00:00.000Z', sidebarColor: 'violet', avatarUrl: null, googleSelfRegisterDomain: null, role: 'member',
};
let calls: { method: string; path: string; body?: unknown }[];

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    const method = init?.method ?? 'GET';
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
    const bare = path.split('?')[0] ?? '';
    if (bare === '/v1/me') return json({ id: 'u-ann', displayName: 'Ann' });
    if (bare.endsWith('/members')) return json({ members: [{ userId: 'u-ada', displayName: 'Ada', kind: 'personal_agent', agentRuntime: 'hosted', sponsorId: 'u-ann', address: 'ada@acme.test', isAgent: true }] });
    if (bare === '/v1/workspaces/o1/assistant/definition') return json({ definition: method === 'PUT' ? { name: body.name, instructions: body.instructions, updatedAt: null } : { name: 'Ann’s assistant', instructions: '', updatedAt: null } });
    if (bare === '/v1/workspaces/o1/assistant/senders') return json({ senders: method === 'PUT' ? body.senders : [] });
    if (bare === '/v1/workspaces/o1/assistant/model') return json({ settings: { provider: 'default', builtIn: true, agents: false, anthropicModel: 'claude-sonnet-5-5', openaiModel: 'gpt-6.1-sol', openrouterModel: '', anthropicKey: null, openaiKey: null, openrouterKey: null, braveKey: null } });
    if (bare === '/v1/workspaces/o1/assistant/avatar' && method === 'PUT') return json({ avatarUrl: body.preset ? `/agent-avatars/${body.preset}.svg` : null });
    return json({ ok: true });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><Assistant org={org} /></QueryClientProvider>);

describe('Your assistant', () => {
  it('names the assistant, with its address shown, in the organization the bar has', async () => {
    mount();
    const name = (await screen.findByTestId('assistant-name')) as HTMLInputElement;
    await waitFor(() => expect(name.value).toBe('Ann’s assistant'));
    await screen.findByText('Its address: ada@acme.test');
    fireEvent.change(name, { target: { value: 'Ada' } });
    fireEvent.click(screen.getByTestId('assistant-save'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.path === '/v1/workspaces/o1/assistant/definition' && (c.body as { name: string }).name === 'Ada')).toBe(true));
  });

  it('gives it a preset picture, from the eight', async () => {
    mount();
    fireEvent.click(await screen.findByTestId('assistant-picture-mint'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.path === '/v1/workspaces/o1/assistant/avatar' && (c.body as { preset: string }).preset === 'mint')).toBe(true));
    expect(within(screen.getByTestId('card-assistant-picture')).getAllByRole('radio')).toHaveLength(8);
  });

  it('starts with nobody allowed to mail it, and saves the senders', async () => {
    mount();
    const box = (await screen.findByTestId('assistant-allowlist')) as HTMLTextAreaElement;
    expect(box.value).toBe('');
    fireEvent.change(box, { target: { value: 'ann@acme.test\npat@partner.example' } });
    fireEvent.click(screen.getByTestId('assistant-allowlist-save'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.path === '/v1/workspaces/o1/assistant/senders' && JSON.stringify((c.body as { senders: string[] }).senders) === '["ann@acme.test","pat@partner.example"]')).toBe(true));
  });

  it('says what it runs on: the organization’s model, set in Agents', async () => {
    mount();
    expect((await screen.findByTestId('assistant-runs-on')).textContent).toBe('The built-in model');
    expect(screen.queryByTestId('assistant-provider')).toBeNull();
  });
});
