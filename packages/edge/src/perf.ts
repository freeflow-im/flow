// Timing logs (scripts/perf/README.md § Stored logs): one structured record per Mail and Calendar request, a standard
// `Server-Timing` header that the browser's DevTools and resource timing show, and the browser's own timings of what a
// person does (POST /v1/perf, routes/perf.ts). Workers Logs (wrangler.toml [observability]) keeps every record, so a slow
// moment can be looked up afterwards. No record carries an account, message, folder or content: routes have their ids
// taken out, and the browser's records name an action, never what it acted on.
import { z } from 'zod';
import { routeOf as mailRoute } from './imap/rules';
import { routeOf as calendarRoute } from './calendar/rules';

/** When this isolate began: a request in its first seconds paid for a cold start. */
const ISOLATE_START = Date.now();
let served = 0;

/** This isolate's age at a request, and how many timed requests it served before it (0: the first, likely a cold start). */
export function isolate(): { isolateAgeMs: number; isolateRequest: number } {
  return { isolateAgeMs: Date.now() - ISOLATE_START, isolateRequest: served++ };
}

/** The parts of a request's time that the Mail or Calendar object reported in its timing header. */
export interface Parts { wait?: number; imap?: number; server?: number; cache?: string }

/** Reads `wait=<ms>;imap=<ms>;cache=hit` (Mail) or `server=<ms>` (Calendar). */
export function parseParts(header: string | null | undefined): Parts {
  const out: Parts = {};
  for (const key of ['wait', 'imap', 'server'] as const) {
    const m = new RegExp(`(?:^|;)${key}=(\\d+)`).exec(header ?? '');
    if (m) out[key] = Number(m[1]);
  }
  const cache = /(?:^|;)cache=(hit|fill|live)/.exec(header ?? '')?.[1];
  if (cache) out.cache = cache;
  return out;
}

/**
 * The `Server-Timing` header of a response: the Worker's total, then the object's parts (`lock` is the wait for a
 * connection and a folder's lock), the cache answer, and the Cloudflare ray id that finds the request's log record.
 */
export function serverTiming(totalMs: number, parts: Parts, ray: string | null): string {
  const items = [`total;dur=${totalMs}`];
  if (parts.wait !== undefined) items.push(`lock;dur=${parts.wait}`);
  if (parts.imap !== undefined) items.push(`imap;dur=${parts.imap}`);
  if (parts.server !== undefined) items.push(`upstream;dur=${parts.server}`);
  if (parts.cache) items.push(`cache;desc=${parts.cache}`);
  if (ray && /^[\w-]+$/.test(ray)) items.push(`ray;desc=${ray}`);
  return items.join(', ');
}

/** The ray id of a request (`cf-ray`, e.g. `8f1c2a3b4c5d6e7f-SJC`): it names the request in Cloudflare's logs. */
export const rayOf = (req: Request) => req.headers.get('cf-ray');

/** The data center that served a request, when Cloudflare says. */
export const coloOf = (req: Request) => (req as Request & { cf?: { colo?: unknown } }).cf?.colo as string | undefined;

/**
 * One request's record, logged as an object so Workers Logs can filter and group by its fields; `message` is the line
 * that `wrangler tail` and the dashboard show (the old `[mail] ...` / `[calendar] ...` line, unchanged).
 */
export function requestRecord(app: 'mail' | 'calendar', message: string, req: Request, status: number, ms: number, parts: Parts) {
  const route = (app === 'mail' ? mailRoute : calendarRoute)(req.method, req.url);
  return { message, perf: 'request', app, route, status, ms, ...parts, ray: rayOf(req), colo: coloOf(req), ...isolate() };
}

// ---- the browser's timings (POST /v1/perf) --------------------------------------------------------------------------

/** One call the browser made during an action, from its resource timing. */
export const ClientCall = z.object({
  path: z.string().max(1000),
  ms: z.number().nonnegative().max(600_000),
  /** Time the browser held the call before sending it (`requestStart - startTime`). */
  queuedMs: z.number().nonnegative().max(600_000).optional(),
  /** Time waiting for the first byte (`responseStart - requestStart`). */
  waitMs: z.number().nonnegative().max(600_000).optional(),
  status: z.number().int().min(0).max(999).optional(),
  /** The response's `Server-Timing`, as the browser read it: name → duration, and the ray and cache answer. */
  server: z.record(z.string().max(20), z.number().nonnegative().max(600_000)).optional(),
  ray: z.string().max(40).regex(/^[\w-]*$/).optional(),
  cache: z.string().max(10).optional(),
});

/** One thing a person did, timed from its start until its result was on screen. */
export const ClientEvent = z.object({
  app: z.enum(['mail', 'calendar']),
  action: z.string().regex(/^[a-z][a-z_.]{0,39}$/),
  ms: z.number().nonnegative().max(600_000),
  ok: z.boolean(),
  /** The result was already in the browser's cache when the action began. */
  cached: z.boolean().optional(),
  /** The page was hidden during it, so the browser slowed it. */
  hidden: z.boolean().optional(),
  calls: z.array(ClientCall).max(30).default([]),
});

export const PerfBody = z.object({ events: z.array(ClientEvent).min(1).max(50) });

/** A path the browser called, as a route with its ids taken out (the query, which names folders, is dropped). */
export function clientRoute(path: string): string {
  const url = new URL(path, 'https://x');
  if (url.pathname.startsWith('/v1/mail/')) return mailRoute('GET', url.href).slice(4);
  if (url.pathname.startsWith('/v1/calendar/')) return calendarRoute('GET', url.href).slice(4);
  // Any other path (Docs' previews): segments that look like ids become `:id`.
  return url.pathname.split('/').map((s) => (/^\d+$/.test(s) || (s.length >= 12 && /\d/.test(s)) || s.includes('@') ? ':id' : s)).join('/');
}

/** The record logged for one of the browser's events. */
export function clientRecord(e: z.output<typeof ClientEvent>) {
  const calls = e.calls.map(({ path, ...rest }) => ({ route: clientRoute(path), ...rest }));
  const slowest = calls.reduce<(typeof calls)[number] | null>((a, b) => (!a || b.ms > a.ms ? b : a), null);
  const message = `[perf] ${e.app}.${e.action} ${Math.round(e.ms)}ms${e.ok ? '' : ' failed'}${e.cached ? ' cached' : ''}${e.hidden ? ' hidden' : ''}`
    + (slowest ? ` (${calls.length} call${calls.length === 1 ? '' : 's'}, slowest ${slowest.route} ${Math.round(slowest.ms)}ms)` : '');
  return { message, perf: 'client', app: e.app, action: e.action, ms: Math.round(e.ms), ok: e.ok, cached: e.cached ?? false, hidden: e.hidden ?? false, calls };
}
