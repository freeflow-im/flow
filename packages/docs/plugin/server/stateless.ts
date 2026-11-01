// MCP 2026-07-28 ("stateless") compatibility on top of an SDK that speaks 2025-11-25.
//
// The newer protocol drops the initialize handshake: a client calls `server/discover` once, then sends every
// request with its protocol version and capabilities in `params._meta`, and expects every result to carry
// `resultType` (lists also `ttlMs` and `cacheScope`). ChatGPT uses it. The SDK rejects the version header
// outright, so the HTTP layer answers discovery itself, presents requests to the SDK as the older version,
// and decorates results on the way out.
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { IncomingMessage } from 'node:http';

export const STATELESS_VERSION = '2026-07-28';
export const SDK_VERSION = '2025-11-25';

export interface Implementation {
  name: string;
  version: string;
}

interface Rpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { _meta?: Record<string, unknown> };
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Make a 2026-07-28 request look like 2025-11-25 to the SDK (which reads the raw header list). */
export function presentAsSdkVersion(req: IncomingMessage): void {
  if (req.headers['mcp-protocol-version'] !== STATELESS_VERSION) return;
  req.headers['mcp-protocol-version'] = SDK_VERSION;
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === 'mcp-protocol-version') req.rawHeaders[i + 1] = SDK_VERSION;
}

/** Whether the request is in the newer protocol: by its version header, or by the version in its `_meta`. */
export function isStateless(req: IncomingMessage, body: unknown): boolean {
  if (req.headers['mcp-protocol-version'] === STATELESS_VERSION) return true;
  const meta = body && typeof body === 'object' && !Array.isArray(body) ? (body as Rpc).params?._meta : undefined;
  return !!meta && Object.values(meta).includes(STATELESS_VERSION);
}

export function isDiscover(body: unknown): body is Rpc & { method: 'server/discover' } {
  return !!body && typeof body === 'object' && !Array.isArray(body) && (body as Rpc).method === 'server/discover';
}

/** The server/discover result: what initialize used to say, cacheable, without a session. */
export function discoverResult(req: Rpc, info: Implementation, capabilities: Record<string, unknown>, instructions: string) {
  return {
    jsonrpc: '2.0',
    id: req.id ?? null,
    result: {
      resultType: 'complete',
      supportedVersions: [STATELESS_VERSION, SDK_VERSION],
      capabilities,
      serverInfo: info,
      instructions,
      ttlMs: 60_000,
      cacheScope: 'private',
      _meta: { 'io.modelcontextprotocol/serverInfo': info },
    },
  };
}

/**
 * Add the fields 2026-07-28 clients expect on the cacheable results the SDK sends: lists and resource reads
 * (ChatGPT validates a resource read as PerRequestReadResourceResult, which requires ttlMs and cacheScope).
 * With `everyResult` (a request in the newer protocol) every result also gets `resultType`, which that
 * protocol requires; otherwise other results are left exactly as the SDK made them.
 */
export function adaptTransport<T extends StreamableHTTPServerTransport>(transport: T, info: Implementation, everyResult = false): T {
  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    const m = message as { result?: Record<string, unknown> };
    if (m.result && typeof m.result === 'object') {
      if (everyResult) m.result = { resultType: 'complete', ...m.result };
      const cacheable = Array.isArray(m.result.tools) || Array.isArray(m.result.resources) || Array.isArray(m.result.prompts) || Array.isArray(m.result.resourceTemplates) || Array.isArray(m.result.contents);
      if (cacheable) {
        m.result = {
          resultType: 'complete',
          ttlMs: 60_000,
          cacheScope: 'private',
          ...m.result,
          _meta: { 'io.modelcontextprotocol/serverInfo': info, ...((m.result._meta as Record<string, unknown> | undefined) ?? {}) },
        };
      }
    }
    return send(message, options);
  };
  return transport;
}
