// The Workspace app (packages/docs, the former MCP Docs) inside this server: FreeFlow suite phase 2
// (docs/specs/freeflow-suite.md §2.1–2.3, §3.1). Its routes (/api/*) join this Fastify instance as an
// encapsulated plugin; who is signed in is this server's session, carried as a bearer or the `sid` cookie
// (lib/sessionCookie.ts); its client is served under /docs. It keeps its own SQLite database and files
// under WORKSPACE_DATA_DIR, with this server's users mirrored into it as they are seen.
//
// The package runs as TypeScript (Node strips the types), so it is imported by path at run time rather than
// compiled into this package: its tsconfig differs from ours.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import * as auth from './services/auth.js';
import { isWorkspaceMember, workspaceNamesOf } from './services/workspaces.js';
import { clearSessionCookie, sessionCookieHeader, sessionTokenInCookieHeader, sessionTokenOf } from './lib/sessionCookie.js';
import { mirrorUser } from './services/mirrorUser.js';

export const WORKSPACE_BASE = '/docs';
/** Where the client lived until 2026-11-10; its addresses are sent to WORKSPACE_BASE. */
const OLD_BASE = '/workspace';

/** The paths the ChatGPT plugin answers on any host (packages/docs/plugin/server/http.ts, PLUGIN_PATH). */
const PLUGIN_PATH = /^(\/mcp(\/|$)|\/oauth\/|\/plugin\/|\/\.well-known\/)/;

interface WorkspaceUser {
  id: string;
  email: string;
}

interface WorkspaceModule {
  buildApp(opts: Record<string, unknown>): Promise<unknown>;
}

/** Where packages/docs/server/app.ts is, from either src/ (tsx) or dist/ (node). */
function workspaceAppFile(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'server', 'app.ts');
}

async function userOf(token: string | null): Promise<WorkspaceUser | null> {
  if (!token) return null;
  try {
    const { user } = await auth.authenticateWithKind(token);
    return { id: user.id, email: user.email };
  } catch {
    return null;
  }
}

/** How long an answer about who is in which organization is kept (packages/docs/server/scope.ts' access check). */
const MEMBERSHIP_TTL_MS = 60_000;

/**
 * A small cache of answers, each kept a minute: the Workspace app asks on every request, and a minute is how long a
 * member who leaves (or is removed) may still open the organization's files.
 */
function cached<T>(load: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const answers = new Map<string, { value: T; until: number }>();
  return async (key) => {
    const now = Date.now();
    const hit = answers.get(key);
    if (hit && hit.until > now) return hit.value;
    const value = await load(key);
    if (answers.size > 10_000) answers.clear();
    answers.set(key, { value, until: now + MEMBERSHIP_TTL_MS });
    return value;
  };
}

/** Mount the Workspace app when WORKSPACE_DATA_DIR is set; returns whether it was. */
export async function mountWorkspace(app: FastifyInstance): Promise<boolean> {
  const dataDir = config.workspaceDataDir;
  if (!dataDir) return false;
  fs.mkdirSync(dataDir, { recursive: true });
  const file = workspaceAppFile();
  const mod = (await import(pathToFileURL(file).href)) as WorkspaceModule;
  const staticDir = config.workspaceStaticDir;
  // The app's old host names: a page asked for there is the same page under /docs here (a 301, so links and
  // bookmarks learn), the plugin's paths are served as they are, and anything else (the old app's API, with the
  // old app's cookies) is left to 404 or 401 as it does on this host.
  const legacy = new Set(config.workspaceLegacyHosts);
  if (legacy.size) {
    const base = config.webUrlBase.replace(/\/+$/, '');
    app.addHook('onRequest', async (req, reply) => {
      const host = (req.hostname ?? '').toLowerCase().split(':')[0] ?? '';
      if (!legacy.has(host) || PLUGIN_PATH.test(req.url) || req.url.startsWith('/api/')) return;
      if (req.method !== 'GET' && req.method !== 'HEAD') return;
      return reply.code(301).redirect(`${base}${WORKSPACE_BASE}${req.url === '/' ? '' : req.url}`);
    });
  }
  // The app's old base path on this host (/workspace, until 2026-11-10): the same page under /docs, a 301 for the same reason.
  const moved = async (req: FastifyRequest, reply: FastifyReply) => reply.code(301).redirect(`${WORKSPACE_BASE}${req.url.slice(OLD_BASE.length)}`);
  app.get(OLD_BASE, moved);
  app.get(`${OLD_BASE}/*`, moved);
  // Organizations are this server's workspaces (docs/specs/freeflow-suite.md §2.4): membership per pair, and a user's list.
  const member = cached((key) => {
    const [userId, workspaceId] = key.split('\u0000') as [string, string];
    return isWorkspaceMember(workspaceId, userId);
  });
  const organizationsOf = cached((userId) => workspaceNamesOf(userId));
  const webBase = config.webUrlBase.replace(/\/+$/, '');
  await mod.buildApp({
    dataDir,
    staticDir: fs.existsSync(path.join(staticDir, 'index.html')) ? staticDir : undefined,
    logger: false,
    appUrl: config.webUrlBase,
    plugin: config.workspacePluginUrl ? { publicUrl: config.workspacePluginUrl, webDir: config.workspacePluginWebDir } : undefined,
    // The assistant's app-change jobs are retired in the suite (docs/specs/freeflow-suite.md §0).
    agent: { jobs: false },
    host: {
      app,
      basePath: WORKSPACE_BASE,
      // The plugin's OAuth pages are reached on the old host names, and a session cookie is per host, so the suite's
      // sign-in (on its own host, the Worker's) is handed across: the plugin's /oauth/sign-in sends the browser to
      // the Worker's /api/auth/cross-host, which comes back to /oauth/handoff with a one-time key; this server trades
      // it for the user (mirrored into `users` when new here) and signs them in on this host (routes/crossHost.ts).
      signInUrl: '/oauth/sign-in',
      handoff: {
        signIn: (host: string, next: string) => `${webBase}/api/auth/cross-host?host=${encodeURIComponent(host)}&next=${encodeURIComponent(next)}`,
        redeem: async (key: string) => {
          const secret = config.edgeOriginSecret;
          if (!secret) return null;
          const res = await fetch(`${webBase}/api/auth/cross-host/exchange`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-edge-secret': secret }, body: JSON.stringify({ key }) }).catch(() => null);
          if (!res?.ok) return null;
          const { user } = (await res.json()) as { user: { id: string; email: string; displayName: string; avatarUrl: string | null } };
          return mirrorUser(user);
        },
        sessionCookie: async (userId: string) => sessionCookieHeader(await auth.issueSession(userId, 'ChatGPT plugin sign-in')),
      },
      authenticate: (req: FastifyRequest) => userOf(sessionTokenOf(req)),
      signOut: async (req: FastifyRequest, reply: FastifyReply) => {
        const token = sessionTokenOf(req);
        if (token) await auth.logout(token).catch(() => {});
        clearSessionCookie(reply);
      },
      userForCookie: async (header: string | undefined) => (await userOf(sessionTokenInCookieHeader(header)))?.id ?? null,
      isMember: (userId: string, workspaceId: string) => member(`${userId}\u0000${workspaceId}`),
      organizationsOf,
    },
  });
  app.log.info({ dataDir, staticDir: fs.existsSync(staticDir) ? staticDir : null }, `Workspace app mounted at ${WORKSPACE_BASE}`);
  return true;
}
