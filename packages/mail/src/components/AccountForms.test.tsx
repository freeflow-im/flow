// The account settings: a connected account can be re-passworded and removed; the organization's hosted mailbox cannot.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMailWorkspace, type MailAccount } from '../api';
import { AccountSettingsDialog } from './AccountForms';

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const server = { host: 'imap.example.com', port: 993, security: 'tls' as const };
const account = (kind: MailAccount['kind']): MailAccount => ({ id: kind!, kind, email: `${kind}@acme.test`, displayName: 'Ann', imap: server, smtp: server, status: 'ok', tabs: [] });

function open(a: MailAccount) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(AccountSettingsDialog, { accounts: [a], initialId: a.id, onClose: () => {}, onRemoved: () => {} }))));
  return document.body.textContent ?? '';
}

describe('AccountSettingsDialog', () => {
  it('offers a connected account its password, servers and removal', () => {
    const text = open(account('connected'));
    expect(document.getElementById('edit-password')).not.toBeNull();
    expect(text).toContain('Remove account');
  });

  it('keeps the hosted mailbox: no password, no servers, no removal', () => {
    const text = open(account('hosted'));
    expect(document.getElementById('edit-password')).toBeNull();
    expect(text).not.toContain('Remove account');
    expect(text).toContain("Your organization's mailbox");
  });

  it("lists the hosted mailbox's addresses; a person adds and removes their own aliases", async () => {
    setMailWorkspace('o1');
    let state = { address: 'ann@acme.test', others: [{ address: 'ann.first@acme.test', removable: false }], domains: ['acme.test'] };
    const calls: { method: string; path: string; body?: unknown }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method, path, body });
      if (method === 'POST') state = { ...state, others: [...state.others, { address: body.address, removable: true }] };
      if (method === 'DELETE') state = { ...state, others: state.others.filter((o) => !path.endsWith(encodeURIComponent(o.address))) };
      return new Response(JSON.stringify(state), { status: method === 'POST' ? 201 : 200, headers: { 'content-type': 'application/json' } });
    }));
    try {
      open(account('hosted'));
      for (let i = 0; i < 50 && !document.querySelector('[data-testid="hosted-addresses"]'); i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
      expect(document.querySelector('[data-testid="hosted-addresses"]')?.textContent).toContain('You send from ann@acme.test');
      expect(document.querySelector('[data-testid="hosted-address-remove-ann.first@acme.test"]')).toBeNull();
      const input = document.querySelector<HTMLInputElement>('[data-testid="hosted-address-local"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Sales');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="hosted-address-add"]')!.click(); await new Promise((r) => setTimeout(r, 0)); });
      expect(calls.find((c) => c.method === 'POST')).toEqual({ method: 'POST', path: '/v1/workspaces/o1/me/addresses', body: { address: 'sales@acme.test' } });
      const remove = document.querySelector<HTMLButtonElement>('[data-testid="hosted-address-remove-sales@acme.test"]')!;
      await act(async () => { remove.click(); await new Promise((r) => setTimeout(r, 0)); });
      expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/v1/workspaces/o1/me/addresses/sales%40acme.test' });
      expect(document.querySelector('[data-testid="hosted-address-sales@acme.test"]')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      setMailWorkspace(null);
    }
  });
});
