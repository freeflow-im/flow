// Single-range `Range: bytes=…` parsing for the file download route —
// video seeking needs 206 partial responses (ui_nits: video sharing).
// Blobs are AES-GCM envelope-encrypted so the whole file is decrypted
// anyway (20 MB cap); ranges are sliced from the plaintext buffer.

export interface ByteRange {
  /** Inclusive byte offsets, per RFC 9110. */
  start: number;
  end: number;
}

/**
 * Parse a Range header against a body length.
 * - null → serve the full body with 200 (header absent, malformed, or a
 *   multi-range request — RFC 9110 lets servers ignore those).
 * - 'unsatisfiable' → respond 416 with `Content-Range: bytes *\/<length>`.
 * - ByteRange → respond 206 with the inclusive slice.
 */
export function parseByteRange(
  header: string | undefined,
  length: number,
): ByteRange | 'unsatisfiable' | null {
  if (!header || length <= 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const a = m[1]!;
  const b = m[2]!;
  if (a === '' && b === '') return null;
  if (a === '') {
    // suffix form: last N bytes
    const n = Number(b);
    if (n === 0) return 'unsatisfiable';
    return { start: Math.max(0, length - n), end: length - 1 };
  }
  const start = Number(a);
  if (start >= length) return 'unsatisfiable';
  const end = b === '' ? length - 1 : Math.min(Number(b), length - 1);
  if (end < start) return 'unsatisfiable';
  return { start, end };
}
