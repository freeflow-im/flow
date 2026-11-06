// The tabs' badges: "N new" and the newest message on a tab that is not open; nothing on the open one.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabStatus } from '../api';
import { InboxTabs } from './InboxTabs';

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const newest = (subject: string, name: string): TabStatus['newest'] => ({ uid: 9, folder: 'INBOX', messageId: null, from: { name, address: 'x@y.test' }, to: [], cc: [], subject, snippet: '', date: '2026-11-04T00:00:00Z', seen: false, flagged: false, answered: false, hasAttachments: false, size: 1 });

describe('InboxTabs', () => {
  it('badges the tabs that are not open with what is new, and names the newest message', () => {
    const status = {
      primary: { category: 'primary' as const, total: 50, unread: 10, new: 3, newest: newest('Lunch?', 'Ann') },
      promotions: { category: 'promotions' as const, total: 5, unread: 2, new: 2, newest: newest('Coming soon: The Brex Fall Release', 'Brex') },
      updates: { category: 'updates' as const, total: 5, unread: 0, new: 0, newest: newest('Your receipt', 'Shop') },
    };
    act(() => root.render(createElement(InboxTabs, { tabs: ['primary', 'promotions', 'updates'], active: 'primary', status, onChange: vi.fn() })));
    const tabs = [...host.querySelectorAll('[role=tab]')].map((t) => t.textContent);
    expect(tabs[0]).toBe('Primary');
    expect(tabs[1]).toBe('Promotions2 newBrex — Coming soon: The Brex Fall Release');
    expect(tabs[2]).toBe('Updates');
  });
});
