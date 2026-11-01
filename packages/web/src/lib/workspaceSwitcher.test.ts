import { describe, expect, it } from 'vitest';
import { emptyRegistry, type ConnectionRegistry, type ServerConnection, type ServerSession } from './connections';
import { showsSource, switcherEntries, syncedBindings } from './workspaceSwitcher';

const connection = (connectionId: string, origin: string): ServerConnection => ({
  connectionId, provider: 'flow', origin, providerIdentity: origin, label: origin, apiVersion: 1, capabilities: {}, addedAt: '2026-09-15T00:00:00Z',
});
const session = (connectionId: string, userId: string, status: ServerSession['status'] = 'authenticated'): ServerSession => ({
  connectionId, userId, status, credentialRef: `flow.${connectionId}.token`, storageKey: connectionId, authGeneration: 0,
});

function registry(): ConnectionRegistry {
  return {
    ...emptyRegistry(),
    connections: [
      connection('home', 'https://app.freeflow.im'),
      connection('team', 'https://flow.coderbots.example'),
      connection('other', 'https://flow.example.com'),
    ],
    sessions: [session('home', 'u1'), session('team', 'u5'), session('other', 'u9')],
    bindings: [
      { connectionId: 'home', userId: 'u1', workspaceId: 'stale', name: 'Stale binding' },
      { connectionId: 'team', userId: 'u5', workspaceId: 'T1', name: 'Coderbots' },
      { connectionId: 'other', userId: 'u9', workspaceId: 'w9', name: 'Partner' },
      { connectionId: 'other', userId: 'u9', workspaceId: 'hid', name: 'Hidden', hidden: true },
    ],
  };
}

describe('switcherEntries', () => {
  it('lists other servers alongside the foreground workspaces', () => {
    const entries = switcherEntries(registry(), 'home', [{ id: 'w1', name: 'Flow Home' }]);
    expect(entries.map(e => [e.name, e.source, e.foreground])).toEqual([
      ['Flow Home', 'app.freeflow.im', true],
      ['Coderbots', 'flow.coderbots.example', false],
      ['Partner', 'flow.example.com', false],
    ]);
  });

  it('uses bindings for the foreground connection until its live list loads', () => {
    const entries = switcherEntries(registry(), 'team', undefined);
    expect(entries.find(e => e.foreground)?.name).toBe('Coderbots');
    expect(entries.map(e => e.name)).toContain('Stale binding');
  });

  it('leaves out connections that need signing in again', () => {
    const r = registry();
    r.sessions = r.sessions.map(s => s.connectionId === 'other' ? { ...s, status: 'unauthorized' } : s);
    expect(switcherEntries(r, 'home', []).map(e => e.connectionId)).toEqual(['team']);
  });

  it('carries unread counts from background sync', () => {
    const entries = switcherEntries(registry(), 'home', [], [{ connectionId: 'other', status: 'connected', unreadByWorkspace: { w9: 3 }, unread: 3 }]);
    expect(entries.find(e => e.workspaceId === 'w9')?.unread).toBe(3);
  });

  it('names the source only when workspaces come from more than one connection', () => {
    expect(showsSource(switcherEntries(registry(), 'home', [{ id: 'w1', name: 'A' }]))).toBe(true);
    const single = { ...registry(), connections: registry().connections.slice(0, 1) };
    expect(showsSource(switcherEntries(single, 'home', [{ id: 'w1', name: 'A' }, { id: 'w2', name: 'B' }]))).toBe(false);
  });
});

describe('syncedBindings', () => {
  it('records names and avatars so another connection can draw them', () => {
    const next = syncedBindings(registry(), 'home', 'u1', [{ id: 'w1', name: 'Flow Home', avatarUrl: '/v1/files/a1' }])!;
    const home = next.filter(b => b.connectionId === 'home');
    expect(home).toEqual([{ connectionId: 'home', userId: 'u1', workspaceId: 'w1', name: 'Flow Home', avatarUrl: '/v1/files/a1' }]);
    // Other connections' bindings are untouched.
    expect(next.filter(b => b.connectionId !== 'home')).toEqual(registry().bindings.filter(b => b.connectionId !== 'home'));
    const r = { ...registry(), bindings: next };
    expect(switcherEntries(r, 'team', undefined).find(e => e.workspaceId === 'w1')?.avatarUrl).toBe('/v1/files/a1');
  });

  it('keeps a hidden workspace hidden and reports no change when nothing moved', () => {
    expect(syncedBindings(registry(), 'other', 'u9', [{ id: 'w9', name: 'Partner' }, { id: 'hid', name: 'Hidden' }])).toBeNull();
    const renamed = [{ id: 'w9', name: 'Partner Co' }, { id: 'hid', name: 'Hidden' }];
    const next = syncedBindings(registry(), 'other', 'u9', renamed)!;
    expect(next.find(b => b.workspaceId === 'w9')?.name).toBe('Partner Co');
    expect(next.find(b => b.workspaceId === 'hid')?.hidden).toBe(true);
    expect(syncedBindings({ ...registry(), bindings: next }, 'other', 'u9', renamed)).toBeNull();
  });
});
