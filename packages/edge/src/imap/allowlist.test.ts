import { describe, expect, it } from 'vitest';
import { authPasses, cleanAllowlist, senderAllowed } from './allowlist';

const allowed = new Set(['scott@locked-in.freeflow.im', 'scott@gmail.com']);

describe('the assistant’s sender allowlist', () => {
  it('takes an allowlisted sender only when the receiving server vouches for the From domain', () => {
    const dmarc = ['mx.mxrouting.net; dkim=pass header.d=gmail.com header.s=20230601; spf=pass smtp.mailfrom=scott@gmail.com; dmarc=pass (p=NONE) header.from=gmail.com'];
    expect(senderAllowed('Scott@Gmail.com', dmarc, allowed)).toBe(true);
    expect(senderAllowed('bob@gmail.com', dmarc, allowed)).toBe(false);
    // A forged From: the mail came from somewhere else, so nothing passes for gmail.com.
    const forged = ['mx.mxrouting.net; dkim=pass header.d=evil.example; spf=pass smtp.mailfrom=x@evil.example; dmarc=fail header.from=gmail.com'];
    expect(senderAllowed('scott@gmail.com', forged, allowed)).toBe(false);
    expect(senderAllowed('scott@gmail.com', [], allowed)).toBe(false);
    expect(senderAllowed('scott@gmail.com', [], allowed, true)).toBe(true);
    expect(senderAllowed(null, dmarc, allowed)).toBe(false);
  });

  it('counts DKIM or SPF for the From domain or a parent of it', () => {
    expect(authPasses('scott@locked-in.freeflow.im', ['h; dkim=pass header.d=freeflow.im'])).toBe(true);
    expect(authPasses('scott@locked-in.freeflow.im', ['h; spf=pass smtp.mailfrom=bounce@locked-in.freeflow.im'])).toBe(true);
    expect(authPasses('scott@locked-in.freeflow.im', ['h; spf=softfail smtp.mailfrom=locked-in.freeflow.im'])).toBe(false);
    expect(authPasses('scott@locked-in.freeflow.im', ['h; dkim=pass header.d=other.im'])).toBe(false);
  });

  it('cleans what the sponsor typed', () => {
    expect(cleanAllowlist([' Ann@Example.com ', 'ann@example.com', 'nope', 3, 'b@c.io'])).toEqual(['ann@example.com', 'b@c.io']);
    expect(cleanAllowlist('x')).toEqual([]);
  });
});
