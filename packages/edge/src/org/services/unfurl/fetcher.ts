// Phase 11 §3: the guarded fetch, on the Workers `fetch`.
//
// The Node server used node:http so it could connect to the exact address its SSRF guard had vetted. A Worker has no
// such hook, and needs none: its subrequests leave through Cloudflare's network, which does not reach private or
// loopback addresses (ssrf.ts). What stays the same: redirects are followed by hand so every hop is checked again,
// one wall-clock budget covers all hops, and the body is read only up to a byte cap (or `</head>`), then dropped.
import { assertPublicUrl, SsrfError } from './ssrf.js';

export const USER_AGENT = 'Flow-LinkExpanding/1.0 (+https://app.freeflow.im/bot)';

export const LIMITS = {
  /** No response headers within this: give up on the hop. */
  connectTimeoutMs: 5_000,
  totalTimeoutMs: 8_000,
  maxRedirects: 5,
  maxBodyBytes: 512 * 1024,
  /**
   * Known video providers get a bigger head budget. YouTube buries og:image,
   * the oEmbed link and `itemprop="duration"` about 690 KB into a ~700 KB
   * <head> of inline script, so under the normal cap we read a third of a
   * megabyte and come away with nothing at all. Only pages we already
   * recognized as playable (unfurl/video.ts) pay this, and the `</head>` stop
   * means we still quit before the body.
   */
  maxVideoPageBytes: 1024 * 1024,
  /** §5: oEmbed responses are capped much tighter. */
  maxJsonBytes: 32 * 1024,
} as const;

export interface FetchResult {
  status: number;
  headers: Record<string, string>;
  /** Decoded text, truncated at the byte cap. Empty for non-text responses. */
  body: string;
  /** Raw bytes actually read (capped). */
  bytes: Buffer;
  /** URL of the final response, after redirects — the base for relative URLs. */
  finalUrl: string;
  contentType: string;
}

export class FetchError extends Error {
  readonly reason: string;
  readonly status?: number | undefined;
  constructor(message: string, reason: string, status?: number) {
    super(message);
    this.name = 'FetchError';
    this.reason = reason;
    this.status = status;
  }
}

interface FetchOptions {
  maxBytes?: number | undefined;
  accept?: string | undefined;
  /** Stop reading as soon as this appears in the decoded body (§3: `</head>`). */
  stopAt?: string | undefined;
  /** Wall-clock budget shared across all redirect hops. */
  deadline?: number | undefined;
}

/** Reads at most `maxBytes` of a body, stopping early at `stopAt`, and cancels the rest. */
async function readCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number, stopAt: string | undefined): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      chunks.push(chunk);
      total += chunk.length;
      if (total >= maxBytes) break; // §3 abort past the cap
      if (stopAt) {
        // Only the new chunk and a small overlap: scanning the whole buffer on every chunk is quadratic on big pages.
        const overlap = Math.min(total, chunk.length + stopAt.length);
        if (Buffer.concat(chunks).subarray(total - overlap).toString('utf8').toLowerCase().includes(stopAt)) break;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const bytes = Buffer.concat(chunks);
  return bytes.length > maxBytes ? bytes.subarray(0, maxBytes) : bytes;
}

/** One hop. Never follows redirects itself — it reports them so the caller can check the next address. */
async function fetchOnce(url: URL, opts: FetchOptions, deadline: number): Promise<FetchResult & { location?: string | undefined }> {
  assertPublicUrl(url);
  const maxBytes = opts.maxBytes ?? LIMITS.maxBodyBytes;
  const controller = new AbortController();
  const remaining = Math.max(0, deadline - Date.now());
  let timedOut = false;
  const abort = () => { timedOut = true; controller.abort(); };
  let timer = setTimeout(abort, Math.min(remaining, LIMITS.connectTimeoutMs));
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'user-agent': USER_AGENT,
        accept: opts.accept ?? 'text/html,application/xhtml+xml,image/*,*/*;q=0.8',
        range: `bytes=0-${maxBytes - 1}`,
      },
    });
    clearTimeout(timer);
    timer = setTimeout(abort, Math.max(0, deadline - Date.now()));
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') ?? undefined : undefined;
    // A redirect's body is never wanted.
    const bytes = location ? (res.body?.cancel().catch(() => {}), Buffer.alloc(0)) : await readCapped(res.body, maxBytes, opts.stopAt);
    return {
      status: res.status,
      headers,
      body: bytes.toString('utf8'),
      bytes,
      finalUrl: url.toString(),
      contentType: (res.headers.get('content-type') ?? '').toLowerCase(),
      location,
    };
  } catch (err) {
    if (err instanceof FetchError || err instanceof SsrfError) throw err;
    if (timedOut) throw new FetchError('timeout', 'timeout');
    throw new FetchError((err as Error).message, 'network');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * §3 + §4: fetch with manual redirect following, re-running the SSRF guard on
 * every hop and enforcing one shared wall-clock budget.
 */
export async function guardedFetch(rawUrl: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const deadline = opts.deadline ?? Date.now() + LIMITS.totalTimeoutMs;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new FetchError(`bad url: ${rawUrl}`, 'bad_url');
  }

  for (let hop = 0; hop <= LIMITS.maxRedirects; hop++) {
    if (Date.now() > deadline) throw new FetchError('total timeout', 'timeout');
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new SsrfError(`refusing non-http(s) scheme ${url.protocol}`);
    }
    const res = await fetchOnce(url, opts, deadline);
    if (!res.location) return res;
    let next: URL;
    try {
      next = new URL(res.location, url); // relative Location is legal
    } catch {
      throw new FetchError(`bad redirect target: ${res.location}`, 'bad_redirect');
    }
    url = next; // the loop checks the new address again
  }
  throw new FetchError('too many redirects', 'too_many_redirects');
}
