// @vitest-environment happy-dom
// Channel visitors' client plumbing (docs/specs/chat-visitors.md): the link path, the name rule, the member paths the
// shared components build rewritten to the visitor's routes, the reads answered from /v1/visitor/me, and the socket's
// first frame.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VisitorMeDTO } from '@flow/shared';
import { cleanName, parseVisitPath, takesVisitors, VisitorRuntime, VisitorSocketClient, visitorAnswer, visitorCapabilities, visitorChannel, visitorPath, worksUntil } from './visitor';
import { withVisitorLabels } from '../components/MessageList';
import { buildSuggestions } from '../components/Composer';

const me: VisitorMeDTO = {
  user: { id: 'v1', displayName: 'Ann', visitor: true },
  organization: { id: 'o1', name: 'Acme', avatarUrl: null },
  channel: {
    id: 'c1', name: 'general', topic: 'Hello',
    people: [
      { userId: 'u1', displayName: 'Bob', avatarUrl: null, isAgent: false },
      { userId: 'a1', displayName: 'Helper', avatarUrl: null, isAgent: true },
      { userId: 'v1', displayName: 'Ann', avatarUrl: null, isAgent: false, visitor: true },
      { userId: 'v2', displayName: 'Cy', avatarUrl: null, isAgent: false, visitor: true },
    ],
  },
  seesFrom: '2026-11-16T10:00:00.000Z',
};

afterEach(() => vi.unstubAllGlobals());

describe('the visitor link path', () => {
  it('reads the token of /chat/visit/<token> and nothing else', () => {
    expect(parseVisitPath('/chat/visit/abcdefghijklmnop_-12')).toBe('abcdefghijklmnop_-12');
    expect(parseVisitPath('/chat/visit/abcdefghijklmnop/')).toBe('abcdefghijklmnop');
    expect(parseVisitPath('/chat/visit/short')).toBeNull();
    expect(parseVisitPath('/visit/abcdefghijklmnop')).toBeNull();
    expect(parseVisitPath('/chat/visit/abcdefghijklmnop/extra')).toBeNull();
    expect(parseVisitPath('/chat')).toBeNull();
  });

  it('takes a name of 1 to 40 characters, trimmed', () => {
    expect(cleanName('  Ann   Lee ')).toBe('Ann Lee');
    expect(cleanName('   ')).toBeNull();
    expect(cleanName('x'.repeat(40))).toBe('x'.repeat(40));
    expect(cleanName('x'.repeat(41))).toBeNull();
  });
});

describe('visitorPath', () => {
  it.each([
    ['/v1/channels/c1/messages?limit=50&before=m9', '/v1/visitor/messages?limit=50&before=m9'],
    ['/v1/messages/m1/thread?limit=200', '/v1/visitor/messages/m1/thread?limit=200'],
    ['/v1/messages/m1', '/v1/visitor/messages/m1'],
    ['/v1/messages/m1?purge=true', '/v1/visitor/messages/m1'],
    ['/v1/messages/m1/reactions/%F0%9F%91%8D', '/v1/visitor/messages/m1/reactions/%F0%9F%91%8D'],
    ['/v1/workspaces/o1/files/presign', '/v1/visitor/files/presign'],
    ['/v1/files/f1', '/v1/visitor/files/f1'],
    ['/v1/files/f1/thumb', '/v1/visitor/files/f1/thumb'],
    ['/v1/files/f1/content', '/v1/visitor/files/f1/content'],
    ['/v1/files/f1/complete', '/v1/visitor/files/f1/complete'],
    ['/v1/channels/c1/files?sort=recent', '/v1/visitor/files?sort=recent'],
    ['/v1/visitor/me', '/v1/visitor/me'],
  ])('%s → %s', (from, to) => expect(visitorPath(from)).toBe(to));

  it.each(['/v1/messages/m1/pin', '/v1/artifacts', '/v1/users/u1', '/v1/workspaces/o1/members/u1', '/v1/search?q=x', '/v1/files/f1/url'])(
    'has no visitor route for %s',
    (path) => expect(visitorPath(path)).toBeNull(),
  );
});

describe('visitorAnswer', () => {
  it('gives the roster without visitors, and the visitors on their own list', () => {
    const roster = visitorAnswer('GET', '/v1/workspaces/o1/members', me) as { members: { userId: string; isAgent: boolean }[] };
    expect(roster.members.map((m) => m.userId)).toEqual(['u1', 'a1']);
    const visitors = visitorAnswer('GET', '/v1/channels/c1/visitors', me) as { visitors: { userId: string; visitor: boolean }[] };
    expect(visitors.visitors.map((v) => v.userId)).toEqual(['v1', 'v2']);
    expect((visitorAnswer('GET', '/v1/channels/c1/members', me) as { userIds: string[] }).userIds).toEqual(['u1', 'a1']);
  });

  it('gives the one channel, the visitor as the user, and empty lists for what is closed', () => {
    const channels = visitorAnswer('GET', '/v1/workspaces/o1/channels', me) as { channels: { id: string; kind: string; isPrivate: boolean }[] };
    expect(channels.channels).toMatchObject([{ id: 'c1', kind: 'standard', isPrivate: false }]);
    expect(visitorAnswer('GET', '/v1/me', me)).toMatchObject({ id: 'v1', displayName: 'Ann', visitor: true });
    expect(visitorAnswer('GET', '/v1/channels/c1/pins', me)).toEqual({ messages: [] });
    expect(visitorAnswer('GET', '/v1/workspaces/o1/emoji', me)).toEqual({ emoji: [] });
    expect(visitorAnswer('POST', '/v1/channels/c1/read', me)).toEqual({ ok: true });
    expect(visitorAnswer('GET', '/v1/channels/c1/messages', me)).toBeUndefined();
  });
});

describe('VisitorRuntime', () => {
  it('sends the shared components’ calls to the visitor routes with the cookie, answers locally, and refuses the rest', async () => {
    const calls: { url: string; credentials: RequestCredentials | undefined; auth: string | undefined }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, credentials: init?.credentials, auth: (init?.headers as Record<string, string> | undefined)?.authorization });
      return new Response(JSON.stringify({ messages: [], hasMore: false }), { status: 200 });
    }));
    const rt = new VisitorRuntime(me, location.origin);
    await rt.api('GET', '/v1/channels/c1/messages?limit=50');
    expect(calls).toEqual([{ url: `${location.origin}/v1/visitor/messages?limit=50`, credentials: 'same-origin', auth: undefined }]);
    expect(await rt.api('GET', '/v1/workspaces/o1/members')).toMatchObject({ members: [{ userId: 'u1' }, { userId: 'a1' }] });
    await expect(rt.api('PUT', '/v1/messages/m1/pin')).rejects.toMatchObject({ status: 403 });
    expect(calls).toHaveLength(1);
    expect(await rt.fileImageUrl('f1', 'thumbnail')).toBe(`${location.origin}/v1/visitor/files/f1/thumb`);
    expect(await rt.blobUrl('/v1/files/f1')).toBe(`${location.origin}/v1/visitor/files/f1`);
  });

  it('reads the people afresh after setMe', () => {
    const rt = new VisitorRuntime(me, location.origin);
    rt.setMe({ ...me, channel: { ...me.channel, people: [] } });
    return expect(rt.api('GET', '/v1/channels/c1/visitors')).resolves.toEqual({ visitors: [] });
  });
});

describe('visitor capabilities', () => {
  it('keep messages, threads, reactions and files, and close pins, search, agents and the rest', () => {
    const caps = visitorCapabilities();
    for (const name of ['send', 'threads', 'reactions', 'files', 'edit', 'delete'] as const) expect(caps[name].state).toBe('supported');
    for (const name of ['pins', 'search', 'agents', 'artifacts', 'scheduledMessages', 'channelManagement', 'huddles'] as const) expect(caps[name].state).toBe('unavailable');
  });
});

describe('the visitor socket', () => {
  it('opens /v1/visitor/ws and proves itself with {op: visitor}', () => {
    const sent: string[] = [];
    let opened: { url: string; onopen?: () => void } | null = null;
    class FakeSocket {
      static OPEN = 1;
      readyState = 0;
      onopen?: () => void;
      constructor(public url: string) { opened = this; }
      send(data: string) { sent.push(data); }
      close() {}
    }
    vi.stubGlobal('WebSocket', FakeSocket);
    const client = new VisitorSocketClient({ onEvent: () => {}, onStatus: () => {} }, 'https://flow.test');
    client.start();
    expect(opened!.url).toBe('wss://flow.test/v1/visitor/ws');
    opened!.onopen?.();
    expect(JSON.parse(sent[0]!)).toEqual({ op: 'visitor' });
    client.stop();
  });
});

describe('the Visitor label', () => {
  it('follows a visitor’s name in mentions, and only a visitor’s', () => {
    const names = { u1: 'Bob', v2: 'Cy' };
    const people = { u1: { userId: 'u1' }, v2: { userId: 'v2', visitor: true } } as never;
    expect(withVisitorLabels(names, people)).toEqual({ u1: 'Bob', v2: 'Cy (Visitor)' });
    expect(withVisitorLabels(names, { u1: { userId: 'u1' } } as never)).toBe(names);
  });

  it('marks visitors in the mention picker, which offers a visitor no groups', () => {
    const people = [{ userId: 'u1', displayName: 'Bob' }, { userId: 'v2', displayName: 'Beth', visitor: true }];
    expect(buildSuggestions('@b', people).map((s) => s.label)).toEqual(['@Bob', '@Beth (Visitor)']);
    expect(buildSuggestions('@', people, { groups: false }).map((s) => s.label)).toEqual(['@Bob', '@Beth (Visitor)']);
    expect(buildSuggestions('@', people).map((s) => s.label)).toContain('@channel');
  });
});

describe('worksUntil', () => {
  it('says today, tomorrow, or the day', () => {
    const now = new Date(2026, 10, 16, 15, 0);
    expect(worksUntil(new Date(2026, 10, 16, 18, 0).toISOString(), now)).toMatch(/^today /);
    expect(worksUntil(new Date(2026, 10, 17, 15, 40).toISOString(), now)).toMatch(/^tomorrow /);
    expect(worksUntil(new Date(2026, 10, 19, 9, 0).toISOString(), now)).not.toMatch(/^(today|tomorrow)/);
  });
});

describe('a meeting chat’s visitors (Meet guests)', () => {
  it('has visitors in a public channel or a meeting chat, never a private channel or a DM', () => {
    expect(takesVisitors({ kind: 'standard', isPrivate: false })).toBe(true);
    expect(takesVisitors({ kind: 'meeting', isPrivate: true })).toBe(true);
    expect(takesVisitors({ kind: 'standard', isPrivate: true })).toBe(false);
    expect(takesVisitors({ kind: 'dm', isPrivate: true })).toBe(false);
    expect(takesVisitors(undefined)).toBe(false);
  });

  it('gives a guest their meeting chat as a meeting channel, named by the meeting', () => {
    const guest: VisitorMeDTO = { ...me, channel: { ...me.channel, meeting: { code: 'kqd-wmzt-fra', title: 'Weekly sync' } } };
    const c = visitorChannel(guest);
    expect(c.kind).toBe('meeting');
    expect(c.isPrivate).toBe(true);
    expect(c.name).toBeNull();
    expect(c.meeting).toEqual({ code: 'kqd-wmzt-fra', title: 'Weekly sync' });
    expect(visitorChannel(me).kind).toBe('standard');
  });
});
