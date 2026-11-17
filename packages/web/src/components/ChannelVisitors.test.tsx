// @vitest-environment happy-dom
// What members see of channel visitors (docs/specs/chat-visitors.md §1.1, §1.4): Invite a visitor in the channel menu
// only when offered, the dialog that makes a link and lists the open ones with Turn off, and the Visitors section of the
// channel's people with Remove.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VisitorLinkDTO } from '@flow/shared';

const calls: { method: string; path: string }[] = [];
let openLinks: VisitorLinkDTO[] = [];
vi.mock('../lib/useBoundApi', () => ({
  useBoundApi: () => ({
    api: async (method: string, path: string) => {
      calls.push({ method, path });
      if (method === 'POST') return { id: 'l2', channelId: 'c1', createdBy: 'u1', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), revokedAt: null, visitorCount: 0, url: 'https://flow.test/chat/visit/tok' };
      return { ok: true };
    },
  }),
}));
vi.mock('../hooks', () => ({
  useVisitorLinks: () => ({ data: openLinks, isLoading: false }),
}));

import ChannelOverflowMenu from './ChannelOverflowMenu';
import ChannelMembersPopover from './ChannelMembersPopover';
import VisitorLinksModal from './VisitorLinksModal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  calls.length = 0;
  openLinks = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const flush = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

const menu = (onInviteVisitor?: () => void) => (
  <ChannelOverflowMenu
    artifacts={[]}
    pinCount={0}
    showOptions
    onOpenFiles={() => {}}
    onOpenPins={() => {}}
    onOpenArtifact={() => {}}
    onOpenOptions={() => {}}
    onInviteVisitor={onInviteVisitor}
    onClose={() => {}}
  />
);

describe('Invite a visitor', () => {
  it('is in the channel menu only when the channel view offers it', () => {
    act(() => root.render(menu()));
    expect(q('channel-menu-invite-visitor')).toBeNull();
    let opened = false;
    act(() => root.render(menu(() => { opened = true; })));
    act(() => q('channel-menu-invite-visitor')!.click());
    expect(opened).toBe(true);
  });

  it('makes a link on opening, shows it with Copy and when it ends, and turns an open link off', async () => {
    openLinks = [{ id: 'l1', channelId: 'c1', createdBy: 'u2', createdAt: '2026-11-16T10:00:00.000Z', expiresAt: '2026-11-17T10:00:00.000Z', revokedAt: null, visitorCount: 2 }];
    const qc = new QueryClient();
    await act(async () => root.render(
      <QueryClientProvider client={qc}><VisitorLinksModal channel={{ id: 'c1', name: 'general' }} names={{ u2: 'Bob' }} onClose={() => {}} /></QueryClientProvider>,
    ));
    await flush();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([{ method: 'POST', path: '/v1/channels/c1/visitor-links' }]);
    expect((q('visitor-link-url') as HTMLInputElement).value).toBe('https://flow.test/chat/visit/tok');
    expect(q('visitor-link-copy')?.textContent).toBe('Copy');
    expect(q('visitor-link-expiry')?.textContent).toMatch(/^Works until tomorrow /);
    expect(q('visitor-link-l1')?.textContent).toContain('Made by Bob');
    expect(q('visitor-link-l1')?.textContent).toContain('2 people came in by it');
    await act(async () => q('visitor-link-off-l1')!.click());
    expect(q('visitor-link-off-l1')?.textContent).toBe('Turn off and remove them?');
    await act(async () => q('visitor-link-off-l1')!.click());
    await flush();
    expect(calls).toContainEqual({ method: 'DELETE', path: '/v1/visitor-links/l1' });
  });
});

describe('the Visitors section of the channel’s people', () => {
  it('lists visitors with the label and removes one after a second click', async () => {
    const removed: string[] = [];
    act(() => root.render(
      <ChannelMembersPopover
        rows={[{ userId: 'u1', displayName: 'Bob', online: true }]}
        visitors={[{ userId: 'v1', displayName: 'Ann' }]}
        onSelect={() => {}}
        onRemoveVisitor={async (id) => { removed.push(id); }}
        onClose={() => {}}
      />,
    ));
    expect(q('channel-visitors-section')?.textContent).toContain('Visitors');
    expect(q('channel-visitor-Ann')?.textContent).toContain('Visitor');
    await act(async () => q('channel-visitor-remove-Ann')!.click());
    expect(q('channel-visitor-remove-Ann')?.textContent).toBe('Remove?');
    await act(async () => q('channel-visitor-remove-Ann')!.click());
    expect(removed).toEqual(['v1']);
  });

  it('has no section without visitors, and no Remove for someone who may not', () => {
    act(() => root.render(<ChannelMembersPopover rows={[]} onSelect={() => {}} onClose={() => {}} />));
    expect(q('channel-visitors-section')).toBeNull();
    act(() => root.render(<ChannelMembersPopover rows={[]} visitors={[{ userId: 'v1', displayName: 'Ann' }]} onSelect={() => {}} onClose={() => {}} />));
    expect(q('channel-visitor-remove-Ann')).toBeNull();
  });
});
