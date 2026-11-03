// FreeFlow Mail's API, /v1/mail/* (docs/specs/mail-api.md): the caller is authenticated here, then the request goes to
// their own Mail object (src/imap/object.ts), which holds their mail accounts. Only the provider presets are answered here.
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Mail } from '../imap/object';
import { providerFor } from '../imap/rules';
import { unauthorized } from '../errors';
import { directory, type AuthEnv } from './auth';

export interface MailRouteEnv extends AuthEnv { MAIL: DurableObjectNamespace<Mail> }

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
  const id = await userId(c, getCookie(c, 'sid'));
  return c.env.MAIL.get(c.env.MAIL.idFromName(id)).handle(c.req.raw);
});
