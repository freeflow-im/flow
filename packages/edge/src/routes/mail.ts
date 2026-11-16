// FreeFlow Mail's API, /v1/mail/* (docs/specs/mail-api.md): the caller is authenticated here, then the request goes to
// the Mail object of their account in the organization named (src/imap/object.ts, platform.md §3.6), which holds the
// mail accounts connected there. Only the provider presets are answered here.
// Each request logs one timing line here, not in the object: see `Mail.handle`.
import { Hono, type Context } from 'hono';
import { SetLinkedAddressBody, type AccountDTO } from '@flow/shared';
import type { Mail } from '../imap/object';
import { TIMING_HEADER, providerFor, timingLine } from '../imap/rules';
import { ApiError, badRequest, unauthorized } from '../errors';
import { directory, resolveAccountCaller, resolveCaller, type AuthEnv } from './auth';

export interface MailRouteEnv extends AuthEnv { MAIL: DurableObjectNamespace<Mail>; MAIL_ALLOW_INSECURE?: string }

export const mailRoutes = new Hono<{ Bindings: MailRouteEnv }>();

mailRoutes.get('/v1/mail/providers', async (c) => {
  if (!(await resolveCaller(c)).user) throw unauthorized('missing bearer token');
  c.header('Cache-Control', 'no-store');
  return c.json(providerFor(c.req.query('email') ?? ''));
});

type C = Context<{ Bindings: MailRouteEnv }>;

/**
 * A person without a hosted address goes by a mailbox they linked (platform.md §3.2). After a mailbox is linked or
 * unlinked, the one they go by is kept if it is still linked, else it becomes the oldest linked one (or none), and the
 * organization's member list takes it.
 */
async function followLinked(c: C, account: AccountDTO): Promise<void> {
  if (account.address || account.agentMode || account.kind !== 'native') return;
  const linked = await c.env.MAIL.get(c.env.MAIL.idFromName(account.id)).linkedEmails(account);
  const now = (await directory(c, 'accountById', account.id))?.linkedAddress ?? null;
  const next = now && linked.includes(now) ? now : linked[0] ?? null;
  if (next === now) return;
  await directory(c, 'setLinkedAddress', account.id, next);
  await c.env.ORG.get(c.env.ORG.idFromName(account.organizationId)).syncAddresses();
}

/** The linked mailbox the caller goes by in the organization (§3.2): one of theirs, or null for none. */
mailRoutes.put('/v1/workspaces/:id/me/address', async (c) => {
  const who = await resolveCaller(c, c.req.param('id'));
  if (!who.user) throw unauthorized('missing bearer token');
  if (!who.account) throw new ApiError(403, 'no_account', 'not a member of this organization');
  const body = SetLinkedAddressBody.safeParse(await c.req.json().catch(() => undefined));
  if (!body.success) throw badRequest('validation', body.error.issues[0]?.message ?? 'invalid request');
  const address = body.data.address;
  if (address && !(await c.env.MAIL.get(c.env.MAIL.idFromName(who.account.id)).linkedEmails(who.account)).includes(address)) {
    throw badRequest('not_linked', `link ${address} in Mail first`);
  }
  const account = await directory(c, 'setLinkedAddress', who.account.id, address);
  await c.env.ORG.get(c.env.ORG.idFromName(account.organizationId)).syncAddresses();
  return c.json({ account });
});

mailRoutes.all('/v1/mail/*', async (c) => {
  const start = Date.now();
  let status = 500, timing: string | null = null;
  try {
    const who = await resolveAccountCaller(c, 'Mail');
    const res = await c.env.MAIL.get(c.env.MAIL.idFromName(who.account.id)).handle(c.req.raw, who);
    status = res.status;
    timing = res.headers.get(TIMING_HEADER);
    // A mailbox linked or unlinked may change the address a person goes by (§3.2).
    const linking = /^\/v1\/mail\/accounts(\/[^/]+)?$/.test(new URL(c.req.url).pathname) && ((c.req.method === 'POST' && status === 201) || (c.req.method === 'DELETE' && status === 200));
    if (linking) c.executionCtx.waitUntil(followLinked(c, who.account).catch((err: Error) => console.error(`linked address ${who.account.id}: ${err.message}`)));
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
