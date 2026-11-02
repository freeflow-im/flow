// The session as a cookie, beside the bearer (FreeFlow suite, docs/specs/freeflow-suite.md §2.2). The Chat
// client, the native apps and the agent bridge keep sending `Authorization: Bearer`; the cookie exists for the
// Workspace app, whose formats name files by URL and whose pages fetch them with plain <img>, <video>, iframes
// and downloads that cannot carry a header. Both carry the same session token (services/auth.ts).
//
// CSRF: a cookie-authenticated request that changes state is only accepted from an allowed browser origin —
// lib/browserPolicy.ts already refuses every request whose Origin is not ours, and browsers send Origin on
// cross-site POSTs — so a cookie is accepted wherever a bearer is.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';

export const SESSION_COOKIE = 'sid';

/** The request's session token: the bearer header when there is one, else the cookie; null for neither. */
export function sessionTokenOf(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim() || null;
  const cookie = (req as FastifyRequest & { cookies?: Record<string, string | undefined> }).cookies?.[SESSION_COOKIE];
  return cookie || null;
}

/** The session token in a raw Cookie header (for handlers that answer outside Fastify). */
export function sessionTokenInCookieHeader(header: string | undefined): string | null {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE) return decodeURIComponent(part.slice(i + 1).trim()) || null;
  }
  return null;
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secureCookies,
    maxAge: config.sessionTtlDays * 86400,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}
