// Docs' API: /api/*. A request names its organization (`?workspace=`, from the client's current organization, or the
// `workspace` in its JSON body) or a file the directory can place; one naming neither goes to the caller's first
// organization. Docs' object checks membership itself.
// The caller context carries the account and the channels the caller is in there, which grants name (docs/server/access.ts).
import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Docs } from '../docs/object';
import { directory, type AuthEnv } from './auth';

export interface DocsRouteEnv extends AuthEnv { DOCS: DurableObjectNamespace<Docs> }
export type C = Context<{ Bindings: DocsRouteEnv }>;

export const docsRoutes = new Hono<{ Bindings: DocsRouteEnv }>();

export async function who(c: C) {
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

export const BY_FILE = /^\/api\/(?:sheets|docs|decks|markdown|whiteboards|files|images|revisions)\/([^/]+)/;

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

/**
 * The organization a JSON body names (`{ workspace }`, docs client api.ts placeFields), which the Docs server reads as
 * it reads `?workspace=` (requireUser). Every route counts, not only those that make a file: a move into a folder
 * (POST /api/library/move) names its root only there, and went to the caller's first organization, whose object did
 * not have the file ("File not found"). A folder's change of root names its own in `from` (POST /api/folders/scope).
 */
export function bodyPlace(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const { workspace, from } = body as { workspace?: unknown; from?: { workspace?: unknown } | null };
  const named = (from && typeof from === 'object' ? from.workspace : undefined) ?? workspace;
  return typeof named === 'string' && named ? named : null;
}

/** A JSON body's organization (`bodyPlace`). Only JSON is read: an upload's body is the file, and can be large. */
async function placeOfBody(c: C): Promise<string | null> {
  if (c.req.method === 'GET' || c.req.method === 'HEAD' || !c.req.header('content-type')?.includes('application/json')) return null;
  return bodyPlace(await c.req.raw.clone().json().catch(() => null));
}

/** A public link's data (/api/public/<token>/...), asked for by anyone: the directory knows which organization's object made its token. */
async function placeOfLink(c: C): Promise<string | null> {
  const token = /^\/api\/public\/([A-Za-z0-9_-]{32})(?:\/|$)/.exec(new URL(c.req.url).pathname)?.[1];
  return token ? directory(c, 'organizationOfId', token) : null;
}

/** The headless browser making a PDF: its print ticket names the organization whose object made it (docs/server/pdf.ts). */
function placeOfPrint(c: C): string | null {
  const ticket = getCookie(c, 'print');
  return ticket?.includes('~') ? ticket.slice(0, ticket.indexOf('~')) : null;
}

docsRoutes.all('/api/*', async (c) => {
  const caller = await who(c);
  const link = await placeOfLink(c);
  const named = link ?? (caller.userId ? null : placeOfPrint(c)) ?? (await placeOfOpened(c)) ?? c.req.query('workspace') ?? c.req.query('org') ?? (await placeOfFile(c)) ?? (await placeOfBody(c));
  const first = caller.userId ? (await directory(c, 'organizationsOf', caller.userId))[0] ?? null : null;
  // Someone in no organization yet, and anyone not signed in, share an object that can only say so.
  const id = named ?? first ?? 'none';
  const account = caller.userId && id !== 'none' ? await directory(c, 'accountFor', caller.userId, id) : null;
  // A guest uses Chat only (docs/specs/workspace-admin.md §6.5); a public link is anyone's, a guest's too.
  if (account?.kind === 'guest' && !link) return c.json({ error: "Guests use Chat only. Docs is for the organization's members." }, 403);
  const accountId = account?.id ?? null;
  const channelIds = accountId ? await c.env.ORG.get(c.env.ORG.idFromName(id)).channelIdsOf(caller.userId!) : [];
  const stub = c.env.DOCS.get(c.env.DOCS.idFromName(id));
  return stub.handle(c.req.raw, { ...caller, accountId, channelIds }, id);
});
