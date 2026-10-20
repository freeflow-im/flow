import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowDesktopBridge } from '@flow/shared';
import { __setHost, getHost, isDesktop } from './host';

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

function bridge(defaultServerOrigin: string): FlowDesktopBridge {
  const secrets = new Map<string, string>();
  return {
    info: { platform: 'darwin', version: '0.0.0', profile: 'alice', defaultServerOrigin },
    secrets: { available: true, get: k => secrets.get(k) ?? null, set: (k, v) => void secrets.set(k, v), delete: k => void secrets.delete(k) },
    links: { openExternal: () => {}, onDeepLink: () => () => {} },
    window: { isFocused: () => true, onFocusChange: () => () => {}, setTitle: () => {} },
    zoom: { get: () => 0, set: () => {} },
    notifications: { show: () => {}, onClick: () => () => {}, clearDelivered: () => {} },
    badge: { set: () => {} },
  };
}

beforeEach(() => { store.clear(); __setHost(null); });
afterEach(() => { vi.unstubAllGlobals(); __setHost(null); });

describe('getHost', () => {
  it('is the browser host when no bridge is present: localStorage credentials, page origin as the server', () => {
    vi.stubGlobal('window', {});
    const host = getHost();
    expect(isDesktop()).toBe(false);
    expect(host.defaultServerOrigin).toBeNull();
    expect(host.allowsInsecureLoopback).toBe(false);
    host.secrets.set('flow.token', 't1');
    expect(store.get('flow.token')).toBe('t1');
    host.secrets.delete('flow.token');
    expect(host.secrets.get('flow.token')).toBeNull();
  });

  it('adopts the bridge when the desktop shell exposes one, and keeps credentials out of localStorage', () => {
    vi.stubGlobal('window', { flowDesktop: bridge('https://app.freeflow.im') });
    const host = getHost();
    expect(isDesktop()).toBe(true);
    expect(host.platform).toBe('darwin');
    expect(host.profile).toBe('alice');
    expect(host.defaultServerOrigin).toBe('https://app.freeflow.im');
    expect(host.allowsInsecureLoopback).toBe(false);
    host.secrets.set('flow.token', 't1');
    expect(host.secrets.get('flow.token')).toBe('t1');
    expect(store.has('flow.token')).toBe(false);
  });

  it('reports no back button in a browser or on a desktop bridge without one', () => {
    vi.stubGlobal('window', {});
    const off = getHost().back.onBack(() => true);
    expect(typeof off).toBe('function');
    __setHost(null);
    vi.stubGlobal('window', { flowDesktop: bridge('https://app.freeflow.im') });
    expect(typeof getHost().back.onBack(() => true)).toBe('function');
  });

  it('allows plaintext loopback only for a build baked against a loopback server', () => {
    vi.stubGlobal('window', { flowDesktop: bridge('http://127.0.0.1:8787') });
    expect(getHost().allowsInsecureLoopback).toBe(true);
  });
});
