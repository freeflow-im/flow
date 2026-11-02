// Phase 11 §3: the guarded fetch.
//
// Built on node:http(s) rather than global fetch so we can pin the connection
// to the address the SSRF guard vetted (see ssrf.ts) — global fetch gives no
// hook for that without pulling in undici. Redirects are followed manually so
// every hop re-runs the full guard.
import http from 'node:http';
import https from 'node:https';
import { assertPublicHost, pinnedLookup, SsrfError } from './ssrf.js';

export const USER_AGENT = 'Flow-LinkExpanding/1.0 (+https://app.freeflow.im/bot)';

export const LIMITS = {
  connectTimeoutMs: 3_000,
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
  constructor(
    message: string,
    readonly reason: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'FetchError';
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

/**
 * One hop. Resolves + vets the host, connects to the vetted address, and
 * streams at most `maxBytes`. Never follows redirects itself — it reports them
 * so the caller can re-run the guard.
 */
async function fetchOnce(url: URL, opts: FetchOptions): Promise<FetchResult & { location?: string | undefined }> {
  const resolved = await assertPublicHost(url.hostname);
  const isHttps = url.protocol === 'https:';
  const mod = isHttps ? https : http;
  const maxBytes = opts.maxBytes ?? LIMITS.maxBodyBytes;

  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        lookup: pinnedLookup(resolved),
        servername: isHttps ? url.hostname : undefined,
        headers: {
          'user-agent': USER_AGENT,
          accept: opts.accept ?? 'text/html,application/xhtml+xml,image/*,*/*;q=0.8',
          'accept-encoding': 'identity', // we cap by bytes; compressed streams hide the real size
          range: `bytes=0-${maxBytes - 1}`,
          host: url.host,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let settled = false;

        const finish = () => {
          if (settled) return;
          settled = true;
          res.destroy();
          const bytes = Buffer.concat(chunks);
          const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') headers[k] = v;
            else if (Array.isArray(v)) headers[k] = v.join(', ');
          }
          resolve({
            status: res.statusCode ?? 0,
            headers,
            body: bytes.toString('utf8'),
            bytes,
            finalUrl: url.toString(),
            contentType,
            location: typeof res.headers.location === 'string' ? res.headers.location : undefined,
          });
        };

        res.on('data', (chunk: Buffer) => {
          if (settled) return;
          total += chunk.length;
          chunks.push(chunk);
          if (total >= maxBytes) return finish(); // §3 abort past the cap
          if (opts.stopAt) {
            // Only scan the tail plus a small overlap — scanning the whole
            // buffer on every chunk is quadratic on big pages.
            const overlap = Math.min(total, chunk.length + opts.stopAt.length);
            const tail = Buffer.concat(chunks).subarray(total - overlap).toString('utf8');
            if (tail.toLowerCase().includes(opts.stopAt)) return finish();
          }
        });
        res.on('end', finish);
        res.on('error', (err) => {
          if (settled) return;
          settled = true;
          reject(new FetchError(err.message, 'network'));
        });
      },
    );

    req.setTimeout(LIMITS.connectTimeoutMs, () => {
      req.destroy(new FetchError('connect timeout', 'timeout'));
    });
    req.on('error', (err) =>
      reject(err instanceof FetchError ? err : new FetchError(err.message, 'network')),
    );
    req.end();
  });
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
    const res = await fetchOnce(url, opts);
    const isRedirect = res.status >= 300 && res.status < 400 && res.location;
    if (!isRedirect) return res;
    let next: URL;
    try {
      next = new URL(res.location!, url); // relative Location is legal
    } catch {
      throw new FetchError(`bad redirect target: ${res.location}`, 'bad_redirect');
    }
    url = next; // loop re-runs assertPublicHost on the new host
  }
  throw new FetchError('too many redirects', 'too_many_redirects');
}
