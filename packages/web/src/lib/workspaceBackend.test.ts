import { describe, expect, it } from 'vitest';
import {
  BackendError, CAPABILITY_NAMES, allSupported, canUse, capabilitiesFrom, dedupeMessages,
  limited, supported, unavailable,
} from '@flow/shared';

describe('WorkspaceBackend contract helpers', () => {
  it('capability tri-state carries a reason unless supported', () => {
    expect(supported()).toEqual({ state: 'supported' });
    expect(limited('This server allows one history page per minute.').reason).toMatch(/one history page/);
    expect(unavailable('Not granted.').state).toBe('unavailable');
    const caps = capabilitiesFrom(unavailable('This server does not have this.'), { send: supported(), history: limited('1/min') });
    expect(canUse(caps, 'send')).toBe(true);
    expect(canUse(caps, 'history')).toBe(true);
    expect(canUse(caps, 'artifacts')).toBe(false);
    expect(caps.artifacts.reason).toMatch(/does not have this/);
    expect(Object.keys(allSupported()).sort()).toEqual([...CAPABILITY_NAMES].sort());
  });

  it('dedupes messages that arrive from both a page and an event, keeping order', () => {
    const rows = [{ id: '1.000001' }, { id: '1.000002' }, { id: '1.000001' }, { id: '1.000003' }];
    expect(dedupeMessages(rows).map(r => r.id)).toEqual(['1.000001', '1.000002', '1.000003']);
  });

  it('BackendError carries a retry hint for rate limits', () => {
    const err = new BackendError('rate_limited', 'The server asked us to wait', { retryAfterMs: 60_000, providerCode: 'ratelimited' });
    expect(err.code).toBe('rate_limited');
    expect(err.retryAfterMs).toBe(60_000);
    expect(err.providerCode).toBe('ratelimited');
    expect(err).toBeInstanceOf(Error);
  });
});
