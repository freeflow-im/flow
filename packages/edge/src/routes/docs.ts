// Docs' API: /api/*. A request names its organization (`?workspace=`, from the client's current organization) or a file the
// directory can place; one naming neither goes to the caller's first organization. Docs' object checks membership itself.
import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Docs } from '../docs/object';
import { directory, type AuthEnv } from './auth';

export interface DocsRouteEnv extends AuthEnv { DOCS: DurableObjectNamespace<Docs> }
type C = Context<{ Bindings: DocsRouteEnv }>;

export const docsRoutes = new Hono<{ Bindings: DocsRouteEnv }>();

async function who(c: C) {
  const header = c.req.header('authorization');
  const token = (header?.startsWith('Bearer ') ? header.slice(7).trim() : getCookie(c, 'sid')) || null;
  const ip = c.req.header('cf-connecting-ip') ?? '';
  if (!token) return { userId: null, email: null, token: null, ip };
  try {
    const { user } = await directory(c, 'authenticate', token);
    return { userId: user.id, email: user.email, token, ip };
  } catch {
    return { userId: null, email: null, token: null, ip };
  }
}

const BY_FILE = /^\/api\/(?:sheets|docs|decks|markdown|files|images|revisions)\/([^/]+)/;

/** A request that names only a file: the directory knows which organization's object made it. */
async function placeOfFile(c: C): Promise<string | null> {
  const id = BY_FILE.exec(new URL(c.req.url).pathname)?.[1];
  return id && !['import', 'at', 'fetch'].includes(id) ? directory(c, 'organizationOfId', decodeURIComponent(id)) : null;
}

/** A page reporting the file it shows (POST /api/recents, `{ kind, id }`): it is recorded where the file is. */
async function placeOfOpened(c: C): Promise<string | null> {
  if (c.req.method !== 'POST' || new URL(c.req.url).pathname !== '/api/recents') return null;
  const id = ((await c.req.raw.clone().json().catch(() => null)) as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? directory(c, 'organizationOfId', id) : null;
}

/** The headless browser making a PDF: its print ticket names the organization whose object made it (docs/server/pdf.ts). */
function placeOfPrint(c: C): string | null {
  const ticket = getCookie(c, 'print');
  return ticket?.includes('~') ? ticket.slice(0, ticket.indexOf('~')) : null;
}

docsRoutes.all('/api/*', async (c) => {
  const caller = await who(c);
  const named = (caller.userId ? null : placeOfPrint(c)) ?? (await placeOfOpened(c)) ?? c.req.query('workspace') ?? c.req.query('org') ?? (await placeOfFile(c));
  const first = caller.userId ? (await directory(c, 'organizationsOf', caller.userId))[0] ?? null : null;
  // Someone in no organization yet, and anyone not signed in, share an object that can only say so.
  const id = named ?? first ?? 'none';
  const stub = c.env.DOCS.get(c.env.DOCS.idFromName(id));
  return stub.handle(c.req.raw, caller, id);
});
