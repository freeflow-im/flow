// The connection-bound web-to-app sign-in handoff (PKCE), ported from packages/server/src/services/handoff.ts: the same
// bodies, the same checks and the same errors. A native app (or the web client in a popup, or the desktop shell) starts
// an operation, the person approves it signed in on the web, and the client trades the code and its PKCE verifier for
// a session. The rows live in the directory (core.ts: startHandoff, approveHandoff, exchangeHandoff).
import { z } from 'zod';
import { DESKTOP_ORIGIN } from '@flow/shared';
import { badRequest } from '../errors';

const opaque = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);

/** Accept serialized HTTP origins only; never suffix-match or trust forwarded headers. */
export function validOrigin(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === value;
  } catch {
    return false;
  }
}

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
export type HandoffContext = z.infer<typeof HandoffContext>;

export interface HandoffPolicy {
  /** The public address of this deployment (WEB_URL_BASE): a handoff is exchanged where it started. */
  webUrlBase: string;
  /** FLOW_HANDOFF_RETURN_URLS: the exact return destinations allowed. None turns the handoff off. */
  returnUrls: string[];
  /** FLOW_ALLOWED_WEB_ORIGINS: other browser origins the API admits. */
  allowedWebOrigins: string[];
}

/** Parses a body as the server's routes do, with the same error. */
export function parseBody<S extends z.ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw badRequest('validation', issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid request');
  }
  return r.data;
}

/** The server's lib/browserPolicy.ts `originAllowed`, for a stated origin. */
function originAllowed(origin: string, policy: HandoffPolicy): boolean {
  if (origin === DESKTOP_ORIGIN) return true;
  if (!validOrigin(origin)) return false;
  return origin === new URL(policy.webUrlBase).origin || policy.allowedWebOrigins.some((value) => validOrigin(value) && value === origin);
}

export function validateContext(body: HandoffContext, requestOrigin: string | undefined, checkClient: boolean, policy: HandoffPolicy): void {
  // The desktop app signs in the way the native apps do (a null client origin and a `flow://` return URL), but it sends
  // an Origin header. Treat it as no origin here.
  const origin = requestOrigin === DESKTOP_ORIGIN ? undefined : requestOrigin;
  if (body.serverOrigin !== new URL(policy.webUrlBase).origin) {
    throw badRequest('handoff_origin', 'Handoff must be exchanged at its initiating Flow server');
  }
  const target = new URL(body.returnUrl);
  if (!policy.returnUrls.includes(body.returnUrl) || target.search || target.hash ||
      target.username || target.password || !['https:', 'flow:', 'http:'].includes(target.protocol) ||
      (target.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))) {
    throw badRequest('handoff_return', 'Return destination is not allowlisted');
  }
  if (body.clientOrigin !== null && (!originAllowed(body.clientOrigin, policy) || target.origin !== body.clientOrigin)) {
    throw badRequest('handoff_origin', 'Browser return destination must belong to the initiating origin');
  }
  if (checkClient && (origin ?? null) !== body.clientOrigin) {
    throw badRequest('handoff_origin', 'Exchange Origin does not match the initiating client');
  }
}

/** The PKCE S256 challenge of a verifier: base64url(SHA-256(verifier)). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return Buffer.from(digest).toString('base64url');
}

/** A comma-separated variable as a list, as the server's config reads it. */
export const listVar = (value: string | undefined): string[] => (value ?? '').split(',').map((v) => v.trim()).filter(Boolean);
