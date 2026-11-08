// FreeFlow Mail's API, /v1/mail/* (docs/specs/mail-api.md): the caller is authenticated here, then the request goes to
// the Mail object of their account in the organization named (src/imap/object.ts, platform.md §3.6), which holds the
// mail accounts connected there. Only the provider presets are answered here.
// Each request logs one timing line here, not in the object: see `Mail.handle`.
import { Hono } from 'hono';
import type { Mail } from '../imap/object';
import { TIMING_HEADER, providerFor, timingLine } from '../imap/rules';
import { ApiError, unauthorized } from '../errors';
import { resolveAccountCaller, resolveCaller, type AuthEnv } from './auth';

export interface MailRouteEnv extends AuthEnv { MAIL: DurableObjectNamespace<Mail>; MAIL_ALLOW_INSECURE?: string }

export const mailRoutes = new Hono<{ Bindings: MailRouteEnv }>();

mailRoutes.get('/v1/mail/providers', async (c) => {
  if (!(await resolveCaller(c)).user) throw unauthorized('missing bearer token');
  c.header('Cache-Control', 'no-store');
  return c.json(providerFor(c.req.query('email') ?? ''));
});

mailRoutes.all('/v1/mail/*', async (c) => {
  const start = Date.now();
  let status = 500, timing: string | null = null;
  try {
    const who = await resolveAccountCaller(c, 'Mail');
    const res = await c.env.MAIL.get(c.env.MAIL.idFromName(who.account.id)).handle(c.req.raw, who);
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
