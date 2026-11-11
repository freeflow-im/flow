// Agents (docs/specs/agents.md §2), against a fetch that answers the suite's API: shared agents from the roster with their
// sponsors, personal agents from the accounts with theirs, and removing a personal agent through its account.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountDTO, WorkspaceDTO, WorkspaceMemberDTO } from '@flow/shared';
import { Agents } from './Agents';

const org: WorkspaceDTO = {
  id: 'o1', slug: 'acme', name: 'Acme', createdBy: 'u-ann', createdAt: '2026-01-01T00:00:00.000Z', sidebarColor: 'violet', avatarUrl: null, googleSelfRegisterDomain: null, role: 'owner',
};
const member = (name: string, extra: Partial<WorkspaceMemberDTO> = {}): WorkspaceMemberDTO => ({
  userId: `u-${name.toLowerCase()}`, displayName: name, email: `${name.toLowerCase()}@example.com`, avatarUrl: null, statusEmoji: '', statusText: '', title: '',
  isAgent: false, isBot: false, sponsorId: null, privacyMode: false, role: 'member', joinedAt: '2026-01-01T00:00:00.000Z', ...extra,
});
const account = (name: string, extra: Partial<AccountDTO> = {}): AccountDTO => ({
  id: `a-${name.toLowerCase().replace(/\s+/g, '-')}`, principalId: `u-${name.toLowerCase()}`, organizationId: 'o1', address: `${name.toLowerCase()}@acme.freeflow.im`, displayName: name,
  role: 'member', kind: 'native', state: 'active', hosted: true, createdAt: '', ...extra,
});
let calls: { method: string; path: string }[];
let accounts: AccountDTO[];

beforeEach(() => {
  calls = [];
  accounts = [
    account('Ann', { role: 'owner' }),
    account('Bob'),
    account('Omni', { sponsorId: 'u-ann', agentMode: 'shared' }),
    account('Claude Desktop', { kind: 'personal_agent', address: null, hosted: false, sponsorId: 'u-bob', agentMode: 'personal' }),
    account('Cursor', { kind: 'personal_agent', address: null, hosted: false, sponsorId: 'u-ann', agentMode: 'personal', state: 'removed' }),
  ];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    const method = init?.method ?? 'GET';
    calls.push({ method, path });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (path.endsWith('/members')) return json({ members: [member('Ann', { role: 'owner' }), member('Bob'), member('Omni', { isAgent: true, sponsorId: 'u-ann', statusText: 'the team helper' })] });
    if (path.endsWith('/accounts')) return json({ accounts });
    if (method === 'DELETE' && path.includes('/accounts/')) {
      accounts = accounts.map((a) => (path.endsWith(a.id) ? { ...a, state: 'removed' } : a));
      return json({ account: accounts.find((a) => path.endsWith(a.id)) });
    }
    return json({ ok: true });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><Agents org={org} /></QueryClientProvider>);

describe('the Agents section', () => {
  it('lists shared agents with their sponsor, and personal agents with theirs, leaving removed ones out', async () => {
    mount();
    await screen.findByTestId('agent-Omni');
    expect(screen.getByTestId('agent-Omni').textContent).toContain('sponsored by Ann');
    await screen.findByTestId('personal-agent-a-claude-desktop');
    expect(screen.getByTestId('personal-agent-a-claude-desktop').textContent).toContain('Claude Desktop');
    expect(screen.getByTestId('personal-agent-a-claude-desktop').textContent).toContain('personal agent of Bob');
    expect(screen.queryByTestId('personal-agent-a-cursor')).toBeNull();
    expect(screen.queryByTestId('personal-agents-empty')).toBeNull();
  });

  it('removes a personal agent through its account, after a confirmation', async () => {
    mount();
    fireEvent.click(await screen.findByTestId('personal-agent-remove-a-claude-desktop'));
    fireEvent.click(await screen.findByTestId('personal-agent-remove-confirm-a-claude-desktop-yes'));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/v1/workspaces/o1/accounts/a-claude-desktop')).toBe(true));
    await waitFor(() => expect(screen.queryByTestId('personal-agent-a-claude-desktop')).toBeNull());
    expect(await screen.findByTestId('personal-agents-empty')).toBeTruthy();
  });
});
