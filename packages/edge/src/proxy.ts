// Everything not yet ported goes to the AWS origin (docs/specs/cloudflare-migration.md, step 1).
//
// A Worker cannot send the visitor's Host to another hostname, so it names the visitor's host, address and a shared
// secret in headers. Caddy's origin.freeflow.im block checks the secret and puts them back in Host and
// X-Forwarded-*, so the server behind it sees what it would see without the Worker (template.yaml, caddyfile.sh).

export interface ProxyEnv {
  ORIGIN_URL: string;
  EDGE_ORIGIN_SECRET: string;
}

/** The waits between tries of a request that can be repeated, in ms: long enough for a deploy to swap the container. */
export const RETRY_WAITS = [250, 500, 1000, 2000, 3000];
const RETRY_STATUS = new Set([502, 503, 504]);

export interface ProxyDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}

const realDeps: ProxyDeps = {
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** The request for the origin. Whatever the visitor sent under the edge's own header names is overwritten. */
export function originRequest(req: Request, env: ProxyEnv): Request {
  const from = new URL(req.url);
  const target = new URL(from.pathname + from.search, env.ORIGIN_URL);
  const headers = new Headers(req.headers);
  headers.set('X-Edge-Secret', env.EDGE_ORIGIN_SECRET);
  headers.set('X-Edge-Host', from.host);
  headers.set('X-Edge-Client-IP', req.headers.get('CF-Connecting-IP') ?? '');
  // `no-store`: a Worker's fetch otherwise goes through Cloudflare's cache, which stores anything whose path looks like a
  // static file, under a key that ignores who is asking. The origin answers per user, so nothing of it may be stored.
  // `duplex` is what Node's Request asks of a streamed body (the tests); Workers ignore it.
  const init = { method: req.method, headers, body: req.body, redirect: 'manual', cache: 'no-store', duplex: 'half' } as RequestInit;
  return new Request(target, init);
}

function unavailable(): Response {
  return Response.json(
    { error: { code: 'origin_unavailable', message: 'The server is restarting. Try again in a moment.' } },
    { status: 502, headers: { 'Retry-After': '5' } },
  );
}

/**
 * Sends a request to the origin. GET and HEAD, WebSocket upgrades included, are tried again while the origin answers
 * 502–504 or cannot be reached, which is what a deploy looks like from here. Anything with a body goes once: it may
 * have been acted on, and its stream can only be read once.
 */
export async function proxy(req: Request, env: ProxyEnv, deps: ProxyDeps = realDeps): Promise<Response> {
  const outgoing = originRequest(req, env);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      return await deps.fetch(outgoing);
    } catch {
      return unavailable();
    }
  }
  let last: Response | null = null;
  for (let attempt = 0; ; attempt++) {
    try {
      last = await deps.fetch(outgoing.clone());
      if (!RETRY_STATUS.has(last.status)) return last;
    } catch {
      last = null;
    }
    const wait = RETRY_WAITS[attempt];
    if (wait === undefined) return last ?? unavailable();
    await deps.sleep(wait);
  }
}
