// Push registration in the Android shell (ANDROID.md phase 3): channels,
// token → connection, teardown at sign-out.
import { describe, expect, it } from 'vitest';
import { ANDROID_NOTIFICATION_CHANNELS, androidChannelForKind } from '@flow/shared';
import { disablePush, enablePush, pushPlugin, type PushPlugin, type PushRuntime } from './pushAndroid';

function fakePlugin(receive = 'granted') {
  const log: string[] = [];
  let onToken: ((t: { value: string }) => void) | null = null;
  const plugin: PushPlugin = {
    requestPermissions: async () => { log.push('permissions'); return { receive }; },
    register: async () => { log.push('register'); },
    createChannel: async (c) => { log.push(`channel ${c.id}`); },
    addListener: async (_e, cb) => { onToken = cb; return { remove: async () => { onToken = null; log.push('removed'); } }; },
  };
  return { plugin, log, token: (v: string) => onToken?.({ value: v }), listening: () => onToken !== null };
}

function fakeRuntime(provider = 'flow') {
  const store = new Map<string, string>();
  const calls: string[] = [];
  const runtime: PushRuntime = {
    connectionId: 'conn-1234567890abcdef',
    provider,
    read: (k) => store.get(k) ?? null,
    write: (k, v) => { if (v === null) store.delete(k); else store.set(k, v); },
    api: async <T,>(method: string, path: string, body?: unknown) => { calls.push(`${method} ${path} ${body ? JSON.stringify(body) : ''}`.trim()); return {} as T; },
  };
  return { runtime, calls, store };
}

describe('the channel list is the one the server driver names', () => {
  it('has a channel for every kind and the default', () => {
    const ids = new Set(ANDROID_NOTIFICATION_CHANNELS.map((c) => c.id));
    for (const kind of [0, 1, 2, 3, 4, 5]) expect(ids.has(androidChannelForKind(kind))).toBe(true);
    expect(ids.has(androidChannelForKind(99))).toBe(true);
    expect(androidChannelForKind('1')).toBe('dms');
    expect(androidChannelForKind(undefined)).toBe('general');
  });
});

describe('enablePush', () => {
  it('creates the channels, asks, registers, and posts the token to the connection with its routing id', async () => {
    const p = fakePlugin();
    const r = fakeRuntime();
    const off = await enablePush(r.runtime, p.plugin);
    expect(p.log.filter((l) => l.startsWith('channel'))).toHaveLength(ANDROID_NOTIFICATION_CHANNELS.length);
    expect(p.log.slice(-2)).toEqual(['permissions', 'register']);
    p.token('fcm-token-1');
    await Promise.resolve();
    expect(r.store.get('pushToken')).toBe('fcm-token-1');
    expect(r.calls).toEqual(['POST /v1/me/devices {"token":"fcm-token-1","platform":"android","routingId":"conn-1234567890abcdef","badgeMode":"omit"}']);
    off();
    await Promise.resolve();
    expect(p.listening()).toBe(false);
  });

  it('does nothing when permission is refused, outside the shell, or for a non-Flow connection', async () => {
    const denied = fakePlugin('denied');
    const r = fakeRuntime();
    await enablePush(r.runtime, denied.plugin);
    expect(denied.log).not.toContain('register');
    await enablePush(r.runtime, null);
    const slack = fakePlugin();
    await enablePush(fakeRuntime('slack').runtime, slack.plugin);
    expect(slack.log).toEqual([]);
    expect(r.calls).toEqual([]);
  });
});

describe('disablePush', () => {
  it('unregisters the stored token for this connection, once', async () => {
    const r = fakeRuntime();
    r.store.set('pushToken', 'fcm-token-1');
    await disablePush(r.runtime);
    await disablePush(r.runtime);
    expect(r.calls).toEqual(['DELETE /v1/me/devices/fcm-token-1?routingId=conn-1234567890abcdef']);
    expect(r.store.has('pushToken')).toBe(false);
  });
});

describe('pushPlugin', () => {
  it('is null without the injected runtime or a usable plugin', () => {
    expect(pushPlugin(undefined)).toBeNull();
    expect(pushPlugin({})).toBeNull();
    expect(pushPlugin({ Capacitor: { Plugins: { PushNotifications: {} } } })).toBeNull();
    expect(pushPlugin({ Capacitor: { Plugins: { PushNotifications: fakePlugin().plugin } } })).not.toBeNull();
  });
});
