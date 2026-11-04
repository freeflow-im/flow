// FreeFlow Mail's API, /v1/mail/* (docs/specs/mail-api.md): the caller is authenticated here, then the request goes to
// their own Mail object (src/imap/object.ts), which holds their mail accounts. Only the provider presets are answered here.
// Each request logs one timing line here, not in the object: see `Mail.handle`.
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Mail } from '../imap/object';
import { TIMING_HEADER, providerFor, timingLine } from '../imap/rules';
import { ApiError, unauthorized } from '../errors';
import { directory, type AuthEnv } from './auth';

export interface MailRouteEnv extends AuthEnv { MAIL: DurableObjectNamespace<Mail>; MAIL_ALLOW_INSECURE?: string }

export const mailRoutes = new Hono<{ Bindings: MailRouteEnv }>();

async function userId(c: { env: MailRouteEnv; req: { header(n: string): string | undefined } }, cookie: string | undefined): Promise<string> {
  const header = c.req.header('authorization');
  const token = (header?.startsWith('Bearer ') ? header.slice(7).trim() : cookie) || null;
  if (!token) throw unauthorized('missing bearer token');
  const { user } = await directory(c, 'authenticate', token);
  return user.id;
}

mailRoutes.get('/v1/mail/providers', async (c) => {
  await userId(c, getCookie(c, 'sid'));
  c.header('Cache-Control', 'no-store');
  return c.json(providerFor(c.req.query('email') ?? ''));
});

mailRoutes.all('/v1/mail/*', async (c) => {
  const start = Date.now();
  let status = 500, timing: string | null = null;
  try {
    const id = await userId(c, getCookie(c, 'sid'));
    const res = await c.env.MAIL.get(c.env.MAIL.idFromName(id)).handle(c.req.raw);
    status = res.status;
    timing = res.headers.get(TIMING_HEADER);
    const out = new Response(res.body, res);
    // The timing is for the log line; the e2e (local dev only) reads it from the header.
    if (c.env.MAIL_ALLOW_INSECURE !== '1') out.headers.delete(TIMING_HEADER);
    return out;
  } catch (err) {
    if (err instanceof ApiError) status = err.statusCode;
    throw err;
  } finally {
    console.log(timingLine(c.req.method, c.req.url, status, Date.now() - start, timing));
  }
});
