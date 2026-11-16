// A member's addresses (platform.md §3.2): the main one, the others with Make main and Remove (not the mailbox's own),
// and Add address on the domains that have mail for people.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountAddressesDTO, AccountDTO, WorkspaceDTO } from '@flow/shared';
import { AddressesModal } from './Addresses';

const org: WorkspaceDTO = {
  id: 'o1', slug: 'acme', name: 'Acme', createdBy: 'u1', createdAt: '2026-01-01T00:00:00.000Z', sidebarColor: 'violet', avatarUrl: null, googleSelfRegisterDomain: null, role: 'owner',
};
const account: AccountDTO = { id: 'a1', principalId: 'u', organizationId: 'o1', address: 'ann@acme.test', displayName: 'Ann', role: 'member', kind: 'native', state: 'active', hosted: true, createdAt: '' };

let calls: { method: string; path: string; body: unknown }[];
let state: AccountAddressesDTO;

beforeEach(() => {
  calls = [];
  state = { address: 'ann@acme.test', others: [{ address: 'ann.old@acme.test', removable: false }, { address: 'sales@acme.test', removable: true }], domains: ['acme.test'] };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    const method = init?.method ?? 'GET';
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (path.endsWith('/addresses') && method === 'POST') {
      state = { ...state, others: [...state.others, { address: (body as { address: string }).address, removable: true }] };
      return json(state, 201);
    }
    if (path.includes('/addresses/') && method === 'DELETE') {
      state = { ...state, others: state.others.filter((o) => !path.endsWith(encodeURIComponent(o.address))) };
      return json(state);
    }
    if (path.endsWith('/address') && method === 'PUT') {
      const to = (body as { address: string }).address;
      state = { ...state, address: to, others: [...state.others.filter((o) => o.address !== to), { address: state.address!, removable: true }] };
      return json({ account: { ...account, address: to }, addresses: state, moved: { messages: 3 } });
    }
    if (path.endsWith('/addresses')) return json(state);
    return json({});
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = (onChanged = vi.fn()) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AddressesModal org={org} account={account} name="Ann" onClose={() => {}} onChanged={onChanged} />
    </QueryClientProvider>,
  );
  return onChanged;
};

describe('Addresses', () => {
  it('lists the main address and the others; the mailbox address cannot be removed', async () => {
    show();
    expect((await screen.findByTestId('address-main')).textContent).toContain('ann@acme.test');
    expect(within(screen.getByTestId('address-other-ann.old@acme.test')).queryByText('Remove')).toBeNull();
    expect(screen.getByTestId('address-remove-sales@acme.test')).toBeTruthy();
  });

  it('adds an address on the one domain the directory offers', async () => {
    const onChanged = show();
    fireEvent.change(await screen.findByTestId('address-add-local'), { target: { value: 'Info' } });
    // One domain to add on: no domain picker.
    expect(screen.queryByTestId('address-add-domain')).toBeNull();
    fireEvent.click(screen.getByTestId('address-add'));
    await screen.findByTestId('address-other-info@acme.test');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ address: 'info@acme.test' });
    expect(onChanged).toHaveBeenCalled();
  });

  it('makes another address the main one, and removes an alias', async () => {
    show();
    fireEvent.click(await screen.findByTestId('address-use-sales@acme.test'));
    await waitFor(() => expect(screen.getByTestId('address-main').textContent).toContain('sales@acme.test'));
    expect(screen.getByTestId('addresses-note').textContent).toContain('Moved to a new mailbox at sales@acme.test, with its 3 messages');
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({ path: '/v1/workspaces/o1/accounts/a1/address', body: { address: 'sales@acme.test' } });
    fireEvent.click(screen.getByTestId('address-remove-ann@acme.test'));
    await waitFor(() => expect(screen.queryByTestId('address-other-ann@acme.test')).toBeNull());
  });
});
