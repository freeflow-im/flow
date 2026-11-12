// Event log (docs/specs/workspace-admin.md §3.6), against a fetch that answers the suite's API: newest first with names for
// the actor, the agent acted through and who asked; the filters; paging older; the envelope on a click.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountDTO, PlatformEvent, WorkspaceDTO, WorkspaceMemberDTO } from '@flow/shared';
import { EventLog } from './EventLog';

const org: WorkspaceDTO = {
  id: 'o1', slug: 'acme', name: 'Acme', createdBy: 'u-ann', createdAt: '2026-01-01T00:00:00.000Z', sidebarColor: 'violet', avatarUrl: null, googleSelfRegisterDomain: null, role: 'owner',
};
const member = (name: string, extra: Partial<WorkspaceMemberDTO> = {}): WorkspaceMemberDTO => ({
  userId: `u-${name.toLowerCase()}`, displayName: name, email: `${name.toLowerCase()}@example.com`, avatarUrl: null, statusEmoji: '', statusText: '', title: '',
  isAgent: false, isBot: false, sponsorId: null, privacyMode: false, role: 'member', joinedAt: '2026-01-01T00:00:00.000Z', ...extra,
});
const account = (name: string, extra: Partial<AccountDTO> = {}): AccountDTO => ({
  id: `a-${name.toLowerCase()}`, principalId: `u-${name.toLowerCase()}`, organizationId: 'o1', address: `${name.toLowerCase()}@acme.freeflow.im`, displayName: name,
  role: 'member', kind: 'native', state: 'active', hosted: true, createdAt: '', ...extra,
});
const event = (seq: number, type: string, extra: Partial<PlatformEvent> = {}): PlatformEvent => ({
  id: `e${seq}`, seq, type, organizationId: 'o1', actor: 'a-ann', depth: 0, ts: '2026-11-11T10:00:00.000Z', data: { n: seq }, ...extra,
});
let calls: string[];
beforeEach(() => {
  calls = [];
  // jsdom has no IntersectionObserver: this one says the list's end is in sight as soon as it is watched.
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private cb: (entries: { isIntersecting: boolean }[]) => void) {}
    observe() { setTimeout(() => this.cb([{ isIntersecting: true }]), 0); }
    disconnect() {}
  });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname + input.search : input.url;
    calls.push(path);
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path.endsWith('/members')) return json({ members: [member('Ann', { role: 'owner' }), member('Bob'), member('Omni', { isAgent: true, sponsorId: 'u-ann' })] });
    if (path.endsWith('/accounts')) return json({ accounts: [account('Ann', { role: 'owner' }), account('Bob'), account('Omni', { sponsorId: 'u-ann', agentMode: 'shared' }), account('Claude', { kind: 'personal_agent', address: null, sponsorId: 'u-ann', agentMode: 'personal' })] });
    if (path.endsWith('/channels')) return json({ channels: [{ id: 'c1', workspaceId: 'o1', name: 'general', kind: 'standard', topic: null, isPrivate: false, createdBy: 'u-ann', createdAt: '' }] });
    if (path.startsWith('/v1/events?')) {
      const q = new URL(`http://x${path}`).searchParams;
      if (q.get('before') === '0') return json({ events: [event(56, 'chat.message.created', { actor: 'a-omni', invokedBy: 'a-bob', channelId: 'c1' }), event(55, 'docs.file.changed', { actor: 'a-ann', via: 'u-claude', ref: { organizationId: 'o1', app: 'docs', kind: 'sheet', id: 's1' } }), ...Array.from({ length: 48 }, (_, i) => event(54 - i, 'chat.reaction.added'))], next: 7 });
      return json({ events: [event(6, 'mail.received', { actor: null })], next: 6 });
    }
    return json({ ok: true });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><EventLog org={org} /></QueryClientProvider>);

describe('the Event log section', () => {
  it('lists events newest first, naming the actor, the agent acted through and who asked', async () => {
    mount();
    const first = await screen.findByTestId('event-e56');
    expect(first.textContent).toContain('chat.message.created');
    expect(first.textContent).toContain('Omni 🤖');
    expect(first.textContent).toContain('asked by Bob');
    expect(first.textContent).toContain('#general');
    const second = screen.getByTestId('event-e55');
    expect(second.textContent).toContain('Ann');
    expect(second.textContent).toContain('via Claude');
    expect(second.textContent).toContain('docs/sheet');
    expect(screen.getByTestId('events-count').textContent).toBe('50 events');
    fireEvent.click(first);
    expect(screen.getByTestId('event-detail-e56').textContent).toContain('"n": 56');
    expect(screen.getByTestId('event-detail-e56').textContent).toContain('invoked by account');
  });

  it('reads older events as the list is scrolled to its end, and a filter starts over with the query', async () => {
    mount();
    await screen.findByTestId('event-e56');
    // No click: the end of the list comes into sight and the next page is read.
    await screen.findByTestId('event-e6');
    expect(screen.queryByTestId('events-older')).toBeNull();
    expect(screen.getByTestId('events-count').textContent).toBe('51 events');
    expect(calls.some((c) => c.includes('before=7'))).toBe(true);
    fireEvent.change(screen.getByTestId('events-types'), { target: { value: 'calendar.*' } });
    fireEvent.click(screen.getByTestId('events-apply'));
    await waitFor(() => expect(calls.some((c) => c.includes('types=calendar.*') && c.includes('before=0'))).toBe(true));
  });
});
