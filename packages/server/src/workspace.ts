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
  await mod.buildApp({
    dataDir,
    staticDir: fs.existsSync(path.join(staticDir, 'index.html')) ? staticDir : undefined,
    logger: false,
    appUrl: config.webUrlBase,
    plugin: config.workspacePluginUrl ? { publicUrl: config.workspacePluginUrl, webDir: config.workspacePluginWebDir } : undefined,
    host: {
      app,
      basePath: WORKSPACE_BASE,
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
