// The Workspace app (packages/docs, the former MCP Docs) inside this server: FreeFlow suite phase 2
// (docs/specs/freeflow-suite.md §2.1–2.3, §3.1). Its routes (/api/*) join this Fastify instance as an
// encapsulated plugin; who is signed in is this server's session, carried as a bearer or the `sid` cookie
// (lib/sessionCookie.ts); its client is served under /workspace. It keeps its own SQLite database and files
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
import { clearSessionCookie, sessionTokenInCookieHeader, sessionTokenOf } from './lib/sessionCookie.js';

export const WORKSPACE_BASE = '/workspace';

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

/** Mount the Workspace app when WORKSPACE_DATA_DIR is set; returns whether it was. */
export async function mountWorkspace(app: FastifyInstance): Promise<boolean> {
  const dataDir = config.workspaceDataDir;
  if (!dataDir) return false;
  fs.mkdirSync(dataDir, { recursive: true });
  const file = workspaceAppFile();
  const mod = (await import(pathToFileURL(file).href)) as WorkspaceModule;
  const staticDir = config.workspaceStaticDir;
  // The app's old host names: a page asked for there is the same page under /workspace here (a 301, so links and
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
      // The suite's sign-in, as an absolute address: the plugin's OAuth pages are reached on the old host names too.
      signInUrl: `${config.webUrlBase.replace(/\/+$/, '')}/`,
      authenticate: (req: FastifyRequest) => userOf(sessionTokenOf(req)),
      signOut: async (req: FastifyRequest, reply: FastifyReply) => {
        const token = sessionTokenOf(req);
        if (token) await auth.logout(token).catch(() => {});
        clearSessionCookie(reply);
      },
      userForCookie: async (header: string | undefined) => (await userOf(sessionTokenInCookieHeader(header)))?.id ?? null,
    },
  });
  app.log.info({ dataDir, staticDir: fs.existsSync(staticDir) ? staticDir : null }, `Workspace app mounted at ${WORKSPACE_BASE}`);
  return true;
}
