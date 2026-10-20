// The hardware-back handler stack the Android shell consults, and the main
// pane's rule (ANDROID.md phase 1).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backAction, handleBack, installBackBridge, registerBackHandler, resetBackHandlersForTests } from './hardwareBack';

beforeEach(() => resetBackHandlersForTests());
afterEach(() => vi.unstubAllGlobals());

describe('hardware back handlers', () => {
  it('reports nothing consumed when no view has anything to close', () => {
    expect(handleBack()).toBe(false);
  });

  it('runs newest-first and stops at the first handler that consumes the press', () => {
    const calls: string[] = [];
    registerBackHandler(() => { calls.push('channel'); return true; });
    registerBackHandler(() => { calls.push('thread'); return true; });
    expect(handleBack()).toBe(true);
    expect(calls).toEqual(['thread']);
  });

  it('falls through a handler that declines', () => {
    const calls: string[] = [];
    registerBackHandler(() => { calls.push('channel'); return true; });
    registerBackHandler(() => { calls.push('modal'); return false; });
    expect(handleBack()).toBe(true);
    expect(calls).toEqual(['modal', 'channel']);
  });

  it('unregisters cleanly and is idempotent per handler', () => {
    const h = vi.fn(() => true);
    const off = registerBackHandler(h);
    registerBackHandler(h); // duplicate registration is a no-op
    expect(handleBack()).toBe(true);
    expect(h).toHaveBeenCalledTimes(1);
    off();
    off(); // second unregister is harmless
    expect(handleBack()).toBe(false);
  });

  it('exposes the bridge the activity calls', () => {
    const target: { __flowBack?: () => boolean } = {};
    installBackBridge(target);
    expect(target.__flowBack!()).toBe(false);
    registerBackHandler(() => true);
    expect(target.__flowBack!()).toBe(true);
  });
});

describe('backAction — thread → panel → drawer → leave', () => {
  const base = { threadOpen: false, panelOpen: false, isMobile: true, drawerOpen: false };

  it('closes an open thread first', () => {
    expect(backAction({ ...base, threadOpen: true, panelOpen: true })).toBe('close-thread');
  });

  it('then a side panel', () => {
    expect(backAction({ ...base, panelOpen: true })).toBe('close-panel');
  });

  it('then opens the drawer on a phone-sized layout', () => {
    expect(backAction(base)).toBe('open-drawer');
  });

  it('leaves the app once the drawer is showing — the next press goes to the OS', () => {
    expect(backAction({ ...base, drawerOpen: true })).toBe('leave');
  });

  it('never opens the drawer on a wide layout, where the sidebar is always visible', () => {
    expect(backAction({ ...base, isMobile: false })).toBe('leave');
  });
});
