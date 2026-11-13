// A person's own private agents (docs/specs/agents.md §1.3), against a fetch that answers the suite's API: the form makes a
// private agent by default, refuses past five, and the list edits and removes the others but never the assistant.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsableAgentDTO, WorkspaceDTO } from '@flow/shared';
import { CreateAgent, MyAgents } from './CreateAgent';

const org: WorkspaceDTO = {
  id: 'o1', slug: 'acme', name: 'Acme', createdBy: 'u-ann', createdAt: '2026-01-01T00:00:00.000Z', sidebarColor: 'violet', avatarUrl: null, googleSelfRegisterDomain: null, role: 'member',
};
const agent = (name: string, self = false): UsableAgentDTO => ({ id: `u-${name.toLowerCase()}`, accountId: `a-${name.toLowerCase()}`, displayName: name, mode: 'personal', self });
let calls: { method: string; path: string; body?: unknown }[];
let mine: UsableAgentDTO[];

beforeEach(() => {
  calls = [];
  mine = [agent('Ada', true), agent('Scout')];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    const method = init?.method ?? 'GET';
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/v1/workspaces/o1/agents/mine') return json({ agents: mine, limit: 5 });
    if (method === 'POST' && path === '/v1/workspaces/o1/agents/personal') {
      const made = agent((body as { name: string }).name);
      mine = [...mine, made];
      return json({ agent: made, definition: { name: made.displayName, instructions: '', updatedAt: null } }, 201);
    }
    if (method === 'POST' && path === '/v1/workspaces/o1/agents/hosted') return json({ agent: { ...agent('Omni'), mode: 'shared' }, definition: { name: 'Omni', instructions: '', updatedAt: null } }, 201);
    if (method === 'DELETE' && path.startsWith('/v1/workspaces/o1/agents/personal/')) {
      mine = mine.filter((a) => !path.endsWith(a.id));
      return json({ account: {} });
    }
    if (path.endsWith('/agents/u-scout/definition')) return json({ definition: { name: 'Scout', instructions: method === 'PUT' ? 'Updated.' : 'Research.', updatedAt: null }, mayEdit: true });
    return json({ ok: true });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
    <MyAgents org={org} />
    <CreateAgent org={org} initialAccess="private" />
  </QueryClientProvider>,
);

describe('your private agents', () => {
  it('makes a private agent by default, and lists it beside the assistant', async () => {
    mount();
    await screen.findByTestId('my-agent-Scout');
    expect(screen.getByTestId('my-agent-Ada').textContent).toContain('your assistant');
    expect((screen.getByTestId('create-agent-private') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('card-create-agent').textContent).toContain('You have 2 of 5');
    fireEvent.change(screen.getByTestId('create-agent-name'), { target: { value: 'Rex' } });
    fireEvent.change(screen.getByTestId('create-agent-instructions'), { target: { value: 'Keep notes.' } });
    fireEvent.click(screen.getByTestId('create-agent-make'));
    await screen.findByTestId('create-agent-made');
    expect(calls.find((c) => c.method === 'POST')).toEqual({ method: 'POST', path: '/v1/workspaces/o1/agents/personal', body: { name: 'Rex', instructions: 'Keep notes.' } });
    expect(screen.getByTestId('create-agent-made').textContent).toContain('Only you can ask it');
    await screen.findByTestId('my-agent-Rex');
  });

  it('makes a shared agent when Shared is picked', async () => {
    mount();
    fireEvent.click(await screen.findByTestId('create-agent-shared'));
    fireEvent.change(screen.getByTestId('create-agent-name'), { target: { value: 'Omni' } });
    fireEvent.click(screen.getByTestId('create-agent-make'));
    await screen.findByTestId('create-agent-made');
    expect(calls.find((c) => c.method === 'POST')?.path).toBe('/v1/workspaces/o1/agents/hosted');
  });

  it('stops at five private agents', async () => {
    mine = [agent('Ada', true), agent('B'), agent('C'), agent('D'), agent('E')];
    mount();
    await screen.findByTestId('create-agent-full');
    fireEvent.change(screen.getByTestId('create-agent-name'), { target: { value: 'Six' } });
    expect((screen.getByTestId('create-agent-make') as HTMLButtonElement).disabled).toBe(true);
  });

  it('edits and removes another agent, but offers no Remove for the assistant', async () => {
    mount();
    await screen.findByTestId('my-agent-Scout');
    expect(screen.queryByTestId('my-agent-remove-Ada')).toBeNull();
    fireEvent.click(screen.getByTestId('agent-instructions-Scout'));
    const text = (await screen.findByTestId('agent-instructions-text-Scout')) as HTMLTextAreaElement;
    await waitFor(() => expect(text.value).toBe('Research.'));
    fireEvent.click(screen.getByTestId('my-agent-remove-Scout'));
    fireEvent.click(await screen.findByTestId('my-agent-remove-confirm-Scout-yes'));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/v1/workspaces/o1/agents/personal/u-scout')).toBe(true));
    await waitFor(() => expect(screen.queryByTestId('my-agent-Scout')).toBeNull());
  });
});
