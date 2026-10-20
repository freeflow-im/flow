// The Android shell's bridge (docs/design/ANDROID.md): boot snapshot plus the
// FlowShell plugin, folded into the desktop bridge shape.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { androidBridge, type ShellBoot } from './hostAndroid';
import { __setHost, getHost, isDesktop } from './host';

function shell(overrides: Partial<ShellBoot> = {}) {
  const calls: string[] = [];
  let deepLink: ((d: { url: string }) => void) | null = null;
  const plugin = {
    secretSet: async (o: { key: string; value: string }) => { calls.push(`set ${o.key}=${o.value}`); },
    secretDelete: async (o: { key: string }) => { calls.push(`delete ${o.key}`); },
    openExternal: async (o: { url: string }) => { calls.push(`open ${o.url}`); },
    addListener: async (_e: 'deepLink', cb: (d: { url: string }) => void) => { deepLink = cb; return { remove: async () => { deepLink = null; } }; },
  };
  const boot: ShellBoot = {
    info: { platform: 'android', version: '0.1.0', profile: null, defaultServerOrigin: 'https://flow.example.com' },
    secrets: { 'flow.token': 't1' },
    secretsAvailable: true,
    launchUrl: null,
    ...overrides,
  };
  const win = { flowShellBoot: boot, Capacitor: { Plugins: { FlowShell: plugin } } };
  return { win, calls, fire: (url: string) => deepLink?.({ url }), hasListener: () => deepLink !== null };
}

beforeEach(() => __setHost(null));
afterEach(() => { vi.unstubAllGlobals(); __setHost(null); });

describe('androidBridge', () => {
  it('is null outside the shell: no boot object, or no plugin', () => {
    expect(androidBridge({})).toBeNull();
    expect(androidBridge({ flowShellBoot: shell().win.flowShellBoot })).toBeNull();
    expect(androidBridge(undefined)).toBeNull();
  });

  it('carries the info block and the credential snapshot, and writes through to the store', () => {
    const s = shell();
    const b = androidBridge(s.win)!;
    expect(b.info).toEqual({ platform: 'android', version: '0.1.0', profile: null, defaultServerOrigin: 'https://flow.example.com' });
    expect(b.secrets.available).toBe(true);
    expect(b.secrets.get('flow.token')).toBe('t1');
    b.secrets.set('flow.cred.x', 't2');
    expect(b.secrets.get('flow.cred.x')).toBe('t2');
    b.secrets.delete('flow.token');
    expect(b.secrets.get('flow.token')).toBeNull();
    expect(s.calls).toEqual(['set flow.cred.x=t2', 'delete flow.token']);
  });

  it('is memory-only when the shell could not open its store', () => {
    expect(androidBridge(shell({ secretsAvailable: false }).win)!.secrets.available).toBe(false);
  });

  it('opens external links through the shell', () => {
    const s = shell();
    androidBridge(s.win)!.links.openExternal('https://accounts.google.com/x');
    expect(s.calls).toEqual(['open https://accounts.google.com/x']);
  });

  it('replays the launch link to the first listener, then forwards plugin events', async () => {
    const s = shell({ launchUrl: 'flow://signin?code=cold' });
    const seen: string[] = [];
    const off = androidBridge(s.win)!.links.onDeepLink((url) => seen.push(url));
    await Promise.resolve();
    expect(seen).toEqual(['flow://signin?code=cold']);
    await Promise.resolve();
    s.fire('flow://invite/tok');
    expect(seen).toEqual(['flow://signin?code=cold', 'flow://invite/tok']);
    off();
    await Promise.resolve();
    await Promise.resolve();
    expect(s.hasListener()).toBe(false);
  });

  it('is what getHost adopts: a desktop-class host on the android platform', () => {
    vi.stubGlobal('window', shell().win);
    const host = getHost();
    expect(isDesktop()).toBe(true);
    expect(host.platform).toBe('android');
    expect(host.defaultServerOrigin).toBe('https://flow.example.com');
    expect(host.allowsInsecureLoopback).toBe(false);
    expect(host.secrets.get('flow.token')).toBe('t1');
  });

  it('prefers a desktop bridge when both are somehow present', () => {
    const s = shell();
    vi.stubGlobal('window', { ...s.win, flowDesktop: { ...androidBridge(s.win)!, info: { platform: 'linux', version: '1', profile: null, defaultServerOrigin: 'https://d' } } });
    expect(getHost().platform).toBe('linux');
  });
});
