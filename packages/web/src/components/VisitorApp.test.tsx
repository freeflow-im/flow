// @vitest-environment happy-dom
// The visitor's page (docs/specs/chat-visitors.md §1.2, §1.3): a returning visitor goes straight in, a link that no
// longer works says so, the name screen joins with the Turnstile answer, and inside the channel the header says what a
// visitor sees and Leave ends the visit.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VisitorMeDTO } from '@flow/shared';
import VisitorApp from './VisitorApp';
import { LINK_GONE } from '../lib/visitor';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const me: VisitorMeDTO = {
  user: { id: 'v1', displayName: 'Ann', visitor: true },
  organization: { id: 'o1', name: 'Acme', avatarUrl: null },
  channel: { id: 'c1', name: 'general', topic: 'Say hi', people: [{ userId: 'u1', displayName: 'Bob', avatarUrl: null, isAgent: false }, { userId: 'v1', displayName: 'Ann', avatarUrl: null, isAgent: false, visitor: true }] },
  seesFrom: '2026-11-16T10:00:00.000Z',
};
const message = (id: string, userId: string, body: string, extra: Record<string, unknown> = {}) => ({
  id, channelId: 'c1', userId, threadRootId: null, clientMsgId: id, body, createdAt: '2026-11-16T10:05:00.000Z', editedAt: null, deletedAt: null,
  pinnedAt: null, pinnedBy: null, replyCount: 0, lastReplyAt: null, systemKind: null, scheduled: false, replyParticipantUserIds: [], reactions: [],
  files: [], unfurls: [], ...extra,
});

let host: HTMLDivElement;
let root: Root;
let calls: { method: string; path: string; body: unknown }[];
let signedIn: boolean;
let linkLive: boolean;

class FakeSocket {
  static OPEN = 1;
  readyState = 0;
  constructor(public url: string) {}
  send() {}
  close() {}
}

beforeEach(() => {
  calls = [];
  signedIn = false;
  linkLive = true;
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, location.origin);
    const method = init?.method ?? 'GET';
    calls.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (url.pathname === '/v1/visitor/me') return signedIn ? json(200, me) : json(401, { error: { code: 'unauthorized', message: 'your visit has ended' } });
    if (url.pathname.startsWith('/v1/visit/')) {
      if (!linkLive) return json(404, { error: { code: 'not_found', message: LINK_GONE } });
      if (method === 'POST') { signedIn = true; return json(201, me); }
      return json(200, { organization: { name: 'Acme', avatarUrl: null }, channel: { name: 'general', topic: 'Say hi' }, expiresAt: '2026-11-17T10:00:00.000Z' });
    }
    if (url.pathname === '/v1/visitor/messages') {
      return json(200, { messages: [message('m2', 'u1', 'Hi <@v1>'), message('m1', 'v1', 'Hello all', { visitor: true })], hasMore: false });
    }
    if (url.pathname === '/v1/visitor/leave') return json(200, { ok: true });
    return json(404, {});
  }));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete window.turnstile;
  vi.unstubAllGlobals();
});

const show = async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={qc}><VisitorApp token="abcdefghijklmnop" /></QueryClientProvider>));
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('the visitor page', () => {
  it('says a link that no longer works, in the spec’s words', async () => {
    linkLive = false;
    await show();
    expect(q('visitor-link-gone')?.textContent).toBe(LINK_GONE);
  });

  it('joins with a name and the Turnstile answer, then shows the channel with the visitor line', async () => {
    window.turnstile = { render: (_el, opts) => { (opts.callback as (t: string) => void)('ts-token'); return 'w1'; } };
    await show();
    expect(q('visitor-join-channel')?.textContent).toBe('# general');
    const submit = q('visitor-join-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const input = q('visitor-name') as HTMLInputElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, '  Ann ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(submit.disabled).toBe(false);
    await act(async () => { submit.click(); });
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(calls.find((c) => c.method === 'POST' && c.path.startsWith('/v1/visit/'))?.body).toEqual({ name: 'Ann', turnstile: 'ts-token' });
    expect(q('visitor-note')?.textContent).toBe('You are a visitor. You see messages from when you joined.');
  });

  it('takes a returning visitor straight in, labels visitors, and leaves', async () => {
    signedIn = true;
    await show();
    expect(calls.some((c) => c.path.startsWith('/v1/visit/'))).toBe(false);
    expect(q('channel-header')?.textContent).toContain('general');
    expect(q('message-m1')?.querySelector('[data-testid="visitor-label"]')).not.toBeNull();
    expect(q('message-m2')?.querySelector('[data-testid="visitor-label"]')).toBeNull();
    // Members' controls a visitor has no route for are not there.
    expect(host.querySelector('[data-testid^="toggle-pin-"]')).toBeNull();
    await act(async () => { q('visitor-leave')!.click(); });
    await act(async () => { q('visitor-leave-confirm')!.click(); });
    for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(calls.some((c) => c.method === 'POST' && c.path === '/v1/visitor/leave')).toBe(true);
    expect(q('visitor-ended')?.textContent).toBe('You left #general.');
  });
});
