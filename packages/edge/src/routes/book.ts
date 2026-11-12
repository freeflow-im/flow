// The guest scheduler's public API, /v1/book/* (docs/specs/guest-scheduler.md §3.3): no session. A token names the owner
// through the directory's index of booking links (its SHA-256 only), and the request goes to the owner's Calendar object
// (`handleBooking`), which checks the token again and answers. A page link is `/v1/book/<page token>`; a booking's own link,
// sent to its guest, is `/v1/book/m/<manage token>`. An unknown token, a page turned off and a malformed token are the same
// 404, so a guess learns nothing. The timing line names the route, never the token.
import { Hono, type Context } from 'hono';
import type { Calendar } from '../calendar/object';
import { isManageToken, normalizePageToken, sha256 } from '../calendar/scheduler';
import { directory, type AuthEnv } from './auth';

export interface BookRouteEnv extends AuthEnv { CALENDAR: DurableObjectNamespace<Calendar> }
type C = Context<{ Bindings: BookRouteEnv }>;

export const bookRoutes = new Hono<{ Bindings: BookRouteEnv }>();

const NOT_FOUND = { error: { code: 'not_found', message: 'This booking link does not exist or is turned off' } };

async function forward(c: C, kind: 'page' | 'manage', raw: string): Promise<Response> {
  const started = Date.now();
  const route = `${c.req.method} /v1/book/${kind === 'manage' ? 'm/:manage' : ':token'}${new URL(c.req.url).pathname.split('/').slice(kind === 'manage' ? 5 : 4).map((p) => `/${p}`).join('')}`;
  let status = 404;
  try {
    if (c.req.method !== 'GET' && c.req.method !== 'POST') return c.json(NOT_FOUND, 404, { 'cache-control': 'no-store' });
    const token = kind === 'page' ? normalizePageToken(raw) : isManageToken(raw) ? raw : null;
    const owner = token ? await directory(c, 'bookingOwner', await sha256(token), kind) : null;
    if (!token || !owner) return c.json(NOT_FOUND, 404, { 'cache-control': 'no-store' });
    const res = await c.env.CALENDAR.get(c.env.CALENDAR.idFromName(owner)).handleBooking(c.req.raw, { kind, token, ip: c.req.header('cf-connecting-ip') ?? '' });
    status = res.status;
    return res;
  } finally {
    console.log(`[calendar] ${route} ${status} ${Date.now() - started}ms`);
  }
}

bookRoutes.all('/v1/book/m/:manage', (c) => forward(c, 'manage', c.req.param('manage')));
bookRoutes.all('/v1/book/m/:manage/*', (c) => forward(c, 'manage', c.req.param('manage')));
bookRoutes.all('/v1/book/:token', (c) => forward(c, 'page', c.req.param('token')));
bookRoutes.all('/v1/book/:token/*', (c) => forward(c, 'page', c.req.param('token')));
