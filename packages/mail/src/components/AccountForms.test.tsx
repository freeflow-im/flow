// The account settings: a connected account can be re-passworded and removed; the organization's hosted mailbox cannot.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MailAccount } from '../api';
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
});
