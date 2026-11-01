import { describe, expect, it } from 'vitest';
import { looksLikeText } from './files.ts';

describe('telling plain text by its bytes', () => {
  it('takes UTF-8 and ASCII text, with tabs, line ends and escapes', () => {
    expect(looksLikeText(Buffer.from(''))).toBe(true);
    expect(looksLikeText(Buffer.from('name,qty\r\napple,3\n\tindented\f\x1b[31mred\x1b[0m'))).toBe(true);
    expect(looksLikeText(Buffer.from('héllo — 日本語 ✓'))).toBe(true);
    // A character cut off by the end of a sample that is only the start of the file.
    expect(looksLikeText(Buffer.from('ok ✓').subarray(0, 4), false)).toBe(true);
    expect(looksLikeText(Buffer.from('ok ✓').subarray(0, 4), true)).toBe(false);
  });

  it('refuses bytes that are not text', () => {
    expect(looksLikeText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(false);
    expect(looksLikeText(Buffer.from('text with a \u0000 in it'))).toBe(false);
    expect(looksLikeText(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x6f, 0x6b]))).toBe(false); // Latin-1, not UTF-8
    expect(looksLikeText(Buffer.from('\x01\x02\x03\x04 mostly control'))).toBe(false);
  });
});
