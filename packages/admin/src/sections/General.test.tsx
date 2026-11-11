// General (docs/specs/workspace-admin.md §3.1), against a fetch that answers the suite's API: the name saves with one
// PATCH, a policy saves as it changes, the owner's cards show for the owner alone, and a server refusal is shown.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDTO } from '@flow/shared';
import { General } from './General';

const org: WorkspaceDTO = {
  id: 'o1',
  slug: 'acme',
  name: 'Acme',
  createdBy: 'u1',
  createdAt: '2026-01-01T00:00:00.000Z',
  sidebarColor: 'violet',
  avatarUrl: null,
  googleSelfRegisterDomain: null,
  unfurlEnabled: true,
  unfurlDomainAllowlist: null,
  role: 'owner',
  policies: { inviteBy: 'admins', agentsBy: 'members', linkSharing: true },
};

let calls: { method: string; path: string; body: unknown }[];
let refuse: { path: RegExp; status: number; message: string } | null;

function answers(method: string, path: string): unknown {
  if (path === '/v1/me') return { id: 'u1', email: 'ann@acme.com', displayName: 'Ann', avatarUrl: null, statusEmoji: '', statusText: '' };
  if (path === '/v1/me/identities') return { identities: [] };
  if (path.endsWith('/emoji')) return { emoji: [] };
  if (path.endsWith('/join-link')) return { workspaceId: 'o1', joinUrl: method === 'DELETE' ? null : 'https://flow.test/join/acme/tok' };
  if ((path.split('?')[0] ?? '').endsWith('/members')) return { members: [{ userId: 'u1', displayName: 'Ann', email: '', avatarUrl: null, statusEmoji: '', statusText: '', title: '', isAgent: false, isBot: false, sponsorId: null, privacyMode: false, role: 'owner' }] };
  return { ...org, name: 'Acme Rockets' };
}

beforeEach(() => {
  calls = [];
  refuse = null;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    const method = init?.method ?? 'GET';
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (refuse && refuse.path.test(path)) return new Response(JSON.stringify({ error: { code: 'refused', message: refuse.message } }), { status: refuse.status, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify(answers(method, path)), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = (o: WorkspaceDTO = org) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <General org={o} />
    </QueryClientProvider>,
  );
};

describe('General', () => {
  it('saves the name with one PATCH, and only when it changed', async () => {
    show();
    const input = screen.getByTestId('name-input') as HTMLInputElement;
    const save = screen.getByTestId('name-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(input, { target: { value: '  Acme Rockets ' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH' && c.path === '/v1/workspaces/o1')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ name: 'Acme Rockets' });
  });

  it('shows the slug as the platform address, read-only', () => {
    show();
    expect(screen.getByTestId('slug').textContent).toBe('acme.freeflow.im');
  });

  it('saves a policy as it changes', async () => {
    show();
    fireEvent.change(screen.getByTestId('policy-inviteBy'), { target: { value: 'members' } });
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ policies: { inviteBy: 'members' } });
  });

  it('has no "new members join as" setting: joiners are native (ruling 6)', () => {
    show();
    expect(screen.queryByText(/join as/i)).toBeNull();
    expect(document.body.textContent).toContain('becomes a member with an address and a mailbox');
  });

  it('shows the join link with Copy, Reset and Turn off, and turns it off after a confirmation', async () => {
    show();
    await screen.findByTestId('join-link-url');
    fireEvent.click(screen.getByTestId('join-link-off'));
    fireEvent.click(screen.getByTestId('join-link-off-confirm-yes'));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/join-link'))).toBe(true));
  });

  it('shows Ownership to the owner alone, and offers Delete only to an owner alone in the organization', async () => {
    show();
    expect(screen.getByTestId('card-ownership')).toBeTruthy();
    await screen.findByTestId('delete');
    cleanup();
    show({ ...org, role: 'admin' });
    expect(screen.queryByTestId('card-ownership')).toBeNull();
  });

  it('shows the server’s refusal under the control', async () => {
    refuse = { path: /\/v1\/workspaces\/o1$/, status: 400, message: 'a name is 1 to 80 characters' };
    show();
    fireEvent.change(screen.getByTestId('name-input'), { target: { value: 'New' } });
    fireEvent.click(screen.getByTestId('name-save'));
    expect((await screen.findByTestId('name-error')).textContent).toBe('a name is 1 to 80 characters');
  });
});
