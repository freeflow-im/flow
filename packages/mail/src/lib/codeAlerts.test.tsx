import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mailApi, type CodeAlert, type MailAccount } from '../api';
import type { SuiteAlert } from '@flow/suite-bar';
import { useCodeAlerts } from './codeAlerts';

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

let cards: SuiteAlert[] = [];
const onCopy = vi.fn(), onShow = vi.fn();
function Page({ accounts, onOpen }: { accounts: MailAccount[]; onOpen: (...a: unknown[]) => void }) {
  cards = useCodeAlerts(accounts, { onOpen, onCopy, onShow });
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
  cards = [];
  onCopy.mockClear();
  onShow.mockClear();
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
    expect(FakeNotification.made[0]!.options.requireInteraction).toBe(true);
    FakeNotification.made[0]!.onclick!();
    expect(onOpen).toHaveBeenCalledWith({ account: 'a1', folder: 'INBOX', uid: 7 }, expect.objectContaining({ code: '482-913' }));
    cleanup();
    show([account()]); // another tab, or the page again: already notified
    await flush();
    expect(FakeNotification.made).toHaveLength(1);
  });

  it('asks nothing for an account with the setting off', async () => {
    const asked = vi.spyOn(mailApi, 'codeAlerts').mockResolvedValue([alert()]);
    show([account({ codeAlerts: false })]);
    await flush();
    expect(asked).not.toHaveBeenCalled();
    expect(FakeNotification.made).toHaveLength(0);
    expect(cards).toEqual([]);
  });

  it('shows the card without desktop permission; Copy code and Open message use it up', async () => {
    FakeNotification.permission = 'denied';
    vi.spyOn(mailApi, 'codeAlerts').mockResolvedValue([alert()]);
    show([account()]);
    await flush();
    expect(FakeNotification.made).toHaveLength(0);
    expect(cards.map((c) => [c.kind, c.title, c.lines[0], c.actions.map((x) => x.label)])).toEqual([['Sign-in code', '482-913', 'Acme: Your sign-in code', ['Copy code', 'Open message']]]);
    act(() => cards[0]!.actions[0]!.onClick!());
    expect(onCopy).toHaveBeenCalledWith(expect.objectContaining({ code: '482-913' }));
    expect(cards).toEqual([]);
  });

  it('skips a code found too long ago', async () => {
    vi.spyOn(mailApi, 'codeAlerts').mockResolvedValue([alert({ foundAt: Date.now() - 11 * 60_000 })]);
    show([account()]);
    await flush();
    expect(FakeNotification.made).toHaveLength(0);
    expect(cards).toEqual([]);
  });
});
