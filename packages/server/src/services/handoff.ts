// Version-1 connection-bound successor to the legacy app-link contract.
import { z } from 'zod';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { config } from '../config.js';
import { hashToken, newToken } from '../lib/tokens.js';
import { badRequest, unauthorized } from '../lib/errors.js';
import { isDesktopOrigin, originAllowed, validOrigin } from '../lib/browserPolicy.js';
import { toUserDTO } from './auth.js';

const opaque = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);
export const HandoffContext = z.object({
  connectionId: z.string().min(1).max(128),
  operationId: opaque,
  state: opaque,
  serverOrigin: z.string().refine(validOrigin),
  clientOrigin: z.string().refine(validOrigin).nullable(),
  returnUrl: z.string().url().max(2048),
}).strict();
export const HandoffStart = HandoffContext.extend({
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  codeChallengeMethod: z.literal('S256'),
});
export const HandoffApprove = HandoffContext.extend({ requestId: opaque });
export const HandoffExchange = HandoffApprove.extend({
  code: opaque,
  codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
});
type Context = z.infer<typeof HandoffContext>;
const { authHandoffs, users, sessions } = schema;

function validateContext(body: Context, requestOrigin: string | undefined, checkClient: boolean): void {
  // The desktop and Android shells sign in the way the native apps do — a
  // null client origin and a `flow://` return URL the OS routes back to them
  // — but unlike them they send an Origin header. Treat it as no origin
  // here; the browser policy already admitted it.
  const origin = isDesktopOrigin(requestOrigin) ? undefined : requestOrigin;
  if (body.serverOrigin !== new URL(config.webUrlBase).origin) {
    throw badRequest('handoff_origin', 'Handoff must be exchanged at its initiating Flow server');
  }
  const target = new URL(body.returnUrl);
  if (!config.handoffReturnUrls.includes(body.returnUrl) || target.search || target.hash ||
      target.username || target.password || !['https:', 'flow:', 'http:'].includes(target.protocol) ||
      (target.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))) {
    throw badRequest('handoff_return', 'Return destination is not allowlisted');
  }
  if (body.clientOrigin !== null && (!originAllowed(body.clientOrigin) || target.origin !== body.clientOrigin)) {
    throw badRequest('handoff_origin', 'Browser return destination must belong to the initiating origin');
  }
  if (checkClient && (origin ?? null) !== body.clientOrigin) {
    throw badRequest('handoff_origin', 'Exchange Origin does not match the initiating client');
  }
}
function binding(body: z.infer<typeof HandoffApprove>) {
  return and(
    eq(authHandoffs.requestHash, hashToken(body.requestId)),
    eq(authHandoffs.connectionId, body.connectionId),
    eq(authHandoffs.operationId, body.operationId),
    eq(authHandoffs.state, body.state),
    eq(authHandoffs.serverOrigin, body.serverOrigin),
    body.clientOrigin === null ? isNull(authHandoffs.clientOrigin) : eq(authHandoffs.clientOrigin, body.clientOrigin),
    eq(authHandoffs.returnUrl, body.returnUrl),
    gt(authHandoffs.expiresAt, sql`now()`),
  );
}
export async function startHandoff(body: z.infer<typeof HandoffStart>, origin?: string) {
  validateContext(body, origin, true);
  await db.delete(authHandoffs).where(lt(authHandoffs.expiresAt, sql`now()`));
  const requestId = newToken();
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  await db.insert(authHandoffs).values({
    requestHash: hashToken(requestId), connectionId: body.connectionId,
    operationId: body.operationId, state: body.state, serverOrigin: body.serverOrigin,
    clientOrigin: body.clientOrigin, returnUrl: body.returnUrl,
    codeChallenge: body.codeChallenge, expiresAt,
  });
  return { requestId, expiresAt: expiresAt.toISOString() };
}
export async function approveHandoff(userId: string, body: z.infer<typeof HandoffApprove>) {
  validateContext(body, undefined, false);
  const code = newToken();
  const expiresAt = new Date(Date.now() + 60_000);
  const [row] = await db.update(authHandoffs).set({ userId, codeHash: hashToken(code), expiresAt })
    .where(and(binding(body), isNull(authHandoffs.codeHash))).returning();
  if (!row) throw unauthorized('Unknown, expired, or already approved handoff operation');
  const callback = new URL(row.returnUrl);
  // No backend URL or session credential in the callback. Client resolves its pending operation.
  callback.searchParams.set('code', code);
  callback.searchParams.set('state', row.state);
  callback.searchParams.set('operationId', row.operationId);
  return { callbackUrl: callback.href, expiresAt: expiresAt.toISOString() };
}
export async function exchangeHandoff(body: z.infer<typeof HandoffExchange>, origin?: string, clientInfo?: string) {
  validateContext(body, origin, true);
  return db.transaction(async tx => {
    const [row] = await tx.delete(authHandoffs).where(and(binding(body),
      eq(authHandoffs.codeHash, hashToken(body.code)),
      eq(authHandoffs.codeChallenge, hashToken(body.codeVerifier).toString('base64url')),
    )).returning();
    if (!row?.userId) throw unauthorized('Invalid, expired, or mismatched handoff');
    const [user] = await tx.select().from(users).where(and(eq(users.id, row.userId), isNull(users.deletedAt)));
    if (!user || user.isBot || user.isAgent) throw unauthorized();
    const token = newToken();
    await tx.insert(sessions).values({ tokenHash: hashToken(token), userId: user.id,
      expiresAt: new Date(Date.now() + config.sessionTtlDays * 86400_000), clientInfo: clientInfo ?? null });
    return { token, user: toUserDTO(user, user.id) };
  });
}
