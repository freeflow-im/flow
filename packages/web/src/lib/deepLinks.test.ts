import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __dispatchDeepLink, awaitHandoffCallback, awaitSignInCode, parseDeepLink } from './deepLinks';

// The suite runs under Node: the only piece of `window` the dispatcher needs
// is an event target for the `flow:deeplink` event the app listens to.
const win = new EventTarget();
vi.stubGlobal('window', win);

describe('parseDeepLink', () => {
  it('tells a bare sign-in code from a PKCE callback', () => {
    expect(parseDeepLink('flow://signin?code=abc')).toEqual({ kind: 'signin-code', code: 'abc' });
    expect(parseDeepLink('flow://signin?code=abc&state=s1&operationId=op1')).toEqual({ kind: 'handoff-callback', code: 'abc', state: 's1', operationId: 'op1' });
    // A callback missing half its binding is not a callback, and a code is required.
    expect(parseDeepLink('flow://signin?code=abc&state=s1')).toEqual({ kind: 'signin-code', code: 'abc' });
    expect(parseDeepLink('flow://signin')).toEqual({ kind: 'unknown', url: 'flow://signin' });
  });
  it('parses invites, and refuses other schemes and shapes', () => {
    expect(parseDeepLink('flow://invite/tok_123-x')).toEqual({ kind: 'invite', token: 'tok_123-x' });
    expect(parseDeepLink('flow://invite/')).toEqual({ kind: 'unknown', url: 'flow://invite/' });
    expect(parseDeepLink('flow://slack/connected?operationId=op9')).toEqual({ kind: 'unknown', url: 'flow://slack/connected?operationId=op9' });
    expect(parseDeepLink('https://app.freeflow.im/invite/tok')).toEqual({ kind: 'unknown', url: 'https://app.freeflow.im/invite/tok' });
    expect(parseDeepLink('flow://signin/extra?code=abc')).toEqual({ kind: 'unknown', url: 'flow://signin/extra?code=abc' });
    expect(parseDeepLink('not a url')).toEqual({ kind: 'unknown', url: 'not a url' });
  });
});

describe('dispatch', () => {
  let events: unknown[];
  let listener: (e: Event) => void;
  beforeEach(() => {
    events = [];
    listener = (e) => events.push((e as CustomEvent).detail);
    win.addEventListener('flow:deeplink', listener);
  });
  afterEach(() => {
    win.removeEventListener('flow:deeplink', listener);
    vi.useRealTimers();
  });

  it('hands a PKCE callback to the operation that is waiting for it, and drops one nobody is', () => {
    const controller = new AbortController();
    const pending = awaitHandoffCallback('op1', 's1', controller.signal);
    // Wrong binding: not claimed, and not surfaced to the app either.
    __dispatchDeepLink('flow://signin?code=other&state=s2&operationId=op1');
    __dispatchDeepLink('flow://signin?code=mine&state=s1&operationId=op1');
    expect(events).toEqual([]);
    return expect(pending).resolves.toEqual({ code: 'mine' });
  });

  it('lets a Google flow claim the next bare code, and otherwise raises it to the app', async () => {
    __dispatchDeepLink('flow://signin?code=unsolicited');
    expect(events).toEqual([{ kind: 'signin-code', code: 'unsolicited' }]);
    const controller = new AbortController();
    const pending = awaitSignInCode(controller.signal);
    __dispatchDeepLink('flow://signin?code=claimed');
    await expect(pending).resolves.toEqual({ code: 'claimed' });
    expect(events).toHaveLength(1);
  });

  it('raises invites to the app and rejects a waiter on abort', async () => {
    __dispatchDeepLink('flow://invite/tok');
    expect(events).toEqual([{ kind: 'invite', token: 'tok' }]);
    const controller = new AbortController();
    const pending = awaitSignInCode(controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('canceled');
    // The aborted waiter no longer claims anything.
    __dispatchDeepLink('flow://signin?code=late');
    expect(events).toEqual([{ kind: 'invite', token: 'tok' }, { kind: 'signin-code', code: 'late' }]);
  });
});
