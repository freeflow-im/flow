// Canonical origin for a Flow backend (docs/specs/multi-server-workspaces.md,
// "Connection and identity model"). Two connections are the same server iff
// their canonical origins are byte-equal, so every comparison — cache keys,
// "may this request carry our bearer", "is this origin already connected" —
// goes through this one normalization rather than string-matching URLs.
//
// V1 requires an origin-root deployment. A server address with userinfo, a
// query string, a fragment, or a path is rejected rather than trimmed: those
// forms usually mean the user pasted an invite link or a reverse-proxy subpath,
// and silently discarding the part that made it wrong would point credentials
// at a server they did not name.
import { getHost } from './host';

/** Providers a connection can speak. Only Flow servers; the field stays in the
 * registry schema so stored registries keep their shape (spec, "Provider
 * abstraction and identity"). */
export type ConnectionProvider = 'flow';

export class ServerOriginError extends Error {
  constructor(
    public code:
      | 'empty'
      | 'unparseable'
      | 'scheme_not_supported'
      | 'insecure'
      | 'userinfo_not_allowed'
      | 'path_not_allowed'
      | 'query_not_allowed'
      | 'fragment_not_allowed'
      | 'host_missing',
    message: string,
  ) {
    super(message);
  }
}

export interface CanonicalOrigin {
  /** `https://flow.example.com` or `http://127.0.0.1:8787` — no trailing slash. */
  origin: string;
  scheme: 'http' | 'https';
  /** Lowercased hostname, no brackets stripped for IPv6 (URL keeps them). */
  host: string;
  /** The port that is actually dialed, default included (443/80). */
  effectivePort: number;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Loopback is the one place HTTP is allowed, and only from a development
 * build or a page that is itself on plaintext loopback (see
 * `insecureLoopbackAllowed`). A private-network HTTPS deployment is fine;
 * plaintext to anywhere else is not, and we never disable certificate
 * validation to make one work. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host.toLowerCase());
}

export interface CanonicalizeOptions {
  /** Permit `http://` on loopback. Defaults to `insecureLoopbackAllowed()`. */
  allowInsecureLoopback?: boolean;
}

/** May this page connect to an `http://` loopback backend?
 *
 * Yes when it is a Vite dev bundle, and yes when **the page itself** is served
 * over http from loopback. The second clause is the one that matters in
 * practice: `pnpm dev` and `pnpm qa:up` both serve a *built* bundle out of the
 * server, so `import.meta.env.DEV` is false there and the web client refused
 * every local backend — which made the multi-server flow the one thing nobody
 * could try locally.
 *
 * It gives nothing away. A page already loaded over plaintext loopback cannot
 * be downgraded by talking to another plaintext loopback origin, and browsers
 * classify `http://localhost` and `http://127.0.0.1` as potentially
 * trustworthy for exactly that reason — no mixed-content rule applies. A page
 * on `https://app.freeflow.im` still refuses `http://` anywhere, including
 * loopback, which is the rule that protects anybody. */
export function insecureLoopbackAllowed(): boolean {
  if (import.meta.env.DEV) return true;
  // The desktop shell's page origin is `app://flow`, which says nothing about
  // the server; a development build baked with a loopback server says yes.
  if (getHost().allowsInsecureLoopback) return true;
  if (typeof location === 'undefined') return false;
  return isPlaintextLoopbackPage(location.protocol, location.hostname);
}

/** The page-origin half of `insecureLoopbackAllowed`, as a pure function —
 * the Vite dev flag is true under the test runner, so this is the only part
 * that can actually be asserted. */
export function isPlaintextLoopbackPage(protocol: string, hostname: string): boolean {
  return protocol === 'http:' && isLoopbackHost(hostname);
}

/** Normalize a typed/stored server address into its canonical origin.
 * Throws `ServerOriginError` — callers show the message next to the field. */
export function canonicalizeOrigin(
  input: string,
  opts: CanonicalizeOptions = {},
): CanonicalOrigin {
  const allowInsecureLoopback = opts.allowInsecureLoopback ?? insecureLoopbackAllowed();
  const raw = input.trim();
  if (!raw) throw new ServerOriginError('empty', 'Enter a server address.');

  // A bare host ("flow.example.com") is the common typed form; default it to
  // HTTPS rather than rejecting it. Anything with an explicit scheme keeps it,
  // so "http://flow.example.com" still fails the HTTPS check below instead of
  // being quietly upgraded.
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ServerOriginError('unparseable', `"${raw}" is not a valid server address.`);
  }

  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    throw new ServerOriginError(
      'scheme_not_supported',
      'A Flow server address must start with https://.',
    );
  }
  if (url.username || url.password) {
    throw new ServerOriginError(
      'userinfo_not_allowed',
      'Remove the username and password from the server address.',
    );
  }
  if (url.search) {
    throw new ServerOriginError('query_not_allowed', 'A server address cannot include a query string.');
  }
  if (url.hash) {
    throw new ServerOriginError('fragment_not_allowed', 'A server address cannot include a fragment.');
  }
  if (url.pathname !== '' && url.pathname !== '/') {
    throw new ServerOriginError(
      'path_not_allowed',
      'Flow must be served at the root of its own domain — remove the path.',
    );
  }
  const host = url.hostname.toLowerCase();
  if (!host) throw new ServerOriginError('host_missing', 'Enter a server address.');

  if (scheme === 'http' && !(allowInsecureLoopback && isLoopbackHost(host))) {
    throw new ServerOriginError(
      'insecure',
      'A Flow server must be reachable over https://.',
    );
  }

  const defaultPort = scheme === 'https' ? 443 : 80;
  const effectivePort = url.port ? Number(url.port) : defaultPort;
  // `URL` already drops a default port from `.host`; rebuild rather than reuse
  // `url.origin` so an IPv6 literal and an explicit default port normalize the
  // same way on every engine.
  const hostPart = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const origin =
    effectivePort === defaultPort ? `${scheme}://${hostPart}` : `${scheme}://${hostPart}:${effectivePort}`;

  return { origin, scheme, host, effectivePort };
}

/** Non-throwing form for callers that only want a yes/no. */
export function tryCanonicalizeOrigin(
  input: string,
  opts: CanonicalizeOptions = {},
): CanonicalOrigin | null {
  try {
    return canonicalizeOrigin(input, opts);
  } catch {
    return null;
  }
}

/** True when `url` is on exactly `origin` — the test the bearer attaches on.
 * Scheme, host *and* port must match: a redirect from `https://a.example` to
 * `https://a.example:8443` is a different server as far as credentials go. */
export function isSameOrigin(origin: string, url: string): boolean {
  let target: URL;
  try {
    target = new URL(url, origin);
  } catch {
    return false;
  }
  const canonical = tryCanonicalizeOrigin(target.protocol + '//' + target.host, {
    // A stored origin has already passed the policy check; re-applying HTTPS
    // rules here would refuse to match a legitimate loopback dev connection.
    allowInsecureLoopback: true,
  });
  return canonical?.origin === origin;
}

/** `wss://…/v1/ws` for a canonical origin. */
export function socketUrlFor(origin: string): string {
  const proto = origin.startsWith('https:') ? 'wss:' : 'ws:';
  return `${proto}${origin.slice(origin.indexOf('//'))}/v1/ws`;
}

/** Short human label ("flow.example.com", "127.0.0.1:8787"). */
export function originLabel(origin: string): string {
  return origin.replace(/^https?:\/\//, '');
}
