import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mailApi, type CodeAlert, type MailAccount } from '../api';
import { useCodeAlertNotifications } from './codeAlerts';

class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static made: FakeNotification[] = [];
  static requestPermission = vi.fn();
  onclick: (() => void) | null = null;
  title: string;
  options: NotificationOptions;
  constructor(title: string, options: NotificationOptions) { this.title = title; this.options = options; FakeNotification.made.push(this); }
  close() {}
}

const account = (over: Partial<MailAccount> = {}): MailAccount => ({
  id: 'a1', email: 'me@x.com', displayName: 'Me', imap: { host: 'h', port: 993, secure: true }, smtp: { host: 'h', port: 465, secure: true }, status: 'ok', tabs: [], ...over,
} as MailAccount);
const alert = (over: Partial<CodeAlert> = {}): CodeAlert => ({ key: 'id:<a@x>', code: '482-913', folder: 'INBOX', uid: 7, from: 'Acme', subject: 'Your sign-in code', foundAt: Date.now(), ...over });

function Page({ accounts, onOpen }: { accounts: MailAccount[]; onOpen: (...a: unknown[]) => void }) {
  useCodeAlertNotifications(accounts, onOpen);
  return null;
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let roots: Root[] = [];
const show = (accounts: MailAccount[], onOpen = vi.fn()) => {
  const root = createRoot(document.body.appendChild(document.createElement('div')));
  roots.push(root);
  act(() => root.render(<QueryClientProvider client={new QueryClient()}><Page accounts={accounts} onOpen={onOpen} /></QueryClientProvider>));
};
const cleanup = () => { for (const r of roots) act(() => r.unmount()); roots = []; document.body.innerHTML = ''; };
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  localStorage.clear();
  FakeNotification.permission = 'granted';
  FakeNotification.made = [];
  vi.stubGlobal('Notification', FakeNotification);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('code alert notifications', () => {
  it('shows a new code once, and its click opens the message', async () => {
    vi.spyOn(mailApi, 'codeAlerts').mockResolvedValue([alert()]);
    const onOpen = vi.fn();
    show([account()], onOpen);
    await flush();
    expect(FakeNotification.made.map((n) => n.title)).toEqual(['Code 482-913']);
    expect(FakeNotification.made[0]!.options.body).toContain('Acme: Your sign-in code');
    FakeNotification.made[0]!.onclick!();
    expect(onOpen).toHaveBeenCalledWith({ account: 'a1', folder: 'INBOX', uid: 7 }, expect.objectContaining({ code: '482-913' }));
    cleanup();
    show([account()]); // another tab, or the page again: already notified
    await flush();
    expect(FakeNotification.made).toHaveLength(1);
  });

  it('asks nothing for an account with the setting off, or without permission', async () => {
    const asked = vi.spyOn(mailApi, 'codeAlerts').mockResolvedValue([alert()]);
    show([account({ codeAlerts: false })]);
    await flush();
    cleanup();
    FakeNotification.permission = 'denied';
    show([account()]);
    await flush();
    expect(asked).not.toHaveBeenCalled();
    expect(FakeNotification.made).toHaveLength(0);
  });

  it('skips a code found too long ago', async () => {
    vi.spyOn(mailApi, 'codeAlerts').mockResolvedValue([alert({ foundAt: Date.now() - 11 * 60_000 })]);
    show([account()]);
    await flush();
    expect(FakeNotification.made).toHaveLength(0);
  });
});
