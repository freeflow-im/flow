// FreeFlow Calendar's API, /v1/calendar/* (docs/specs/calendar.md §3, §4): the caller is authenticated here, then the
// request goes to their own Calendar object (src/calendar/object.ts). Only the provider presets are answered here. Each
// request logs one timing line here, not in the object (as Mail's: a line logged in an object reaches `wrangler tail` late).
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Calendar } from '../calendar/object';
import { TIMING_HEADER, providerFor, timingLine } from '../calendar/rules';
import { ApiError, unauthorized } from '../errors';
import { directory, type AuthEnv } from './auth';

export interface CalendarRouteEnv extends AuthEnv { CALENDAR: DurableObjectNamespace<Calendar>; CALENDAR_ALLOW_INSECURE?: string }

export const calendarRoutes = new Hono<{ Bindings: CalendarRouteEnv }>();

async function userId(c: { env: CalendarRouteEnv; req: { header(n: string): string | undefined } }, cookie: string | undefined): Promise<string> {
  const header = c.req.header('authorization');
  const token = (header?.startsWith('Bearer ') ? header.slice(7).trim() : cookie) || null;
  if (!token) throw unauthorized('missing bearer token');
  const { user } = await directory(c, 'authenticate', token);
  return user.id;
}

calendarRoutes.get('/v1/calendar/providers', async (c) => {
  await userId(c, getCookie(c, 'sid'));
  c.header('Cache-Control', 'no-store');
  return c.json(providerFor(c.req.query('email') ?? ''));
});

calendarRoutes.all('/v1/calendar/*', async (c) => {
  const start = Date.now();
  let status = 500, timing: string | null = null;
  try {
    const id = await userId(c, getCookie(c, 'sid'));
    const res = await c.env.CALENDAR.get(c.env.CALENDAR.idFromName(id)).handle(c.req.raw);
    status = res.status;
    timing = res.headers.get(TIMING_HEADER);
    const out = new Response(res.body, res);
    if (c.env.CALENDAR_ALLOW_INSECURE !== '1') out.headers.delete(TIMING_HEADER);
    return out;
  } catch (err) {
    if (err instanceof ApiError) status = err.statusCode;
    throw err;
  } finally {
    console.log(timingLine(c.req.method, c.req.url, status, Date.now() - start, timing));
  }
});
