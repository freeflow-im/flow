// The desktop app's MCP server: the ChatGPT plugin's tools (plugin/server) over the open folder, for an agent
// on this machine (Claude Code, say) to read and edit the folder's files while the app shows them. The
// endpoint is /mcp, behind a bearer token: desktop/main.js signs agents in (OAuth, desktop/mcpAuth.js) on a
// fixed port and passes their requests on here with the token it gave this server. What the
// model opens, creates or imports is shown in the window, and the window reports which file it shows, which
// is the one the tools act on when no id is given. Edits are saved through the app's stores, so an open
// editor follows them as it follows any other save (the revision feed).
import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { FileHub, type FileService, type LibraryKind, type LiveEditor } from '../plugin/server/files.ts';
import { createPluginHandler, mcpVersion } from '../plugin/server/http.ts';
import { MCP_VERSIONS, type McpOptions } from '../plugin/server/mcp.ts';
import type { DB } from './db.ts';
import type { FileStore } from './files.ts';
import type { Folders } from './folders.ts';
import type { ImageStore } from './images.ts';
import type { PdfMaker } from './pdf.ts';
import type { SheetStore } from './sheets.ts';

export interface LocalMcpOptions {
  db: DB;
  dataDir: string;
  sheets: SheetStore;
  images: ImageStore;
  files: FileStore;
  folders: Folders;
  /** The local user every request is. */
  userId: string;
  /** What an MCP request must present as `Authorization: Bearer <token>`. */
  token: string;
  /** Where the endpoint is reached (the fixed port), for the addresses the tools hand out; null for this server's own. */
  publicUrl: string | null;
  /** Show a page of the app (a file's address) in the window. */
  show(path: string): void;
  /** A stored file was rewritten (edit_file): a window showing it loads it again. */
  changed?(id: string): void;
  /** The windows, where the edit tools run on a file open in one (windowTools.ts). */
  live?: LiveEditor | null;
  /** Makes PDFs of files (pdf.ts), for export_pdf. */
  pdf?: PdfMaker;
  /** A file on this machine by its path, for open_path (McpOptions.openPath). */
  openPath?: McpOptions['openPath'];
}

/** The app's address of a file. */
export const pathOfFile = (kind: LibraryKind, id: string): string =>
  `/${kind === 'doc' ? 'doc' : kind === 'deck' ? 'd' : kind === 'markdown' ? 'md' : kind === 'file' ? 'f' : 's'}/${encodeURIComponent(id)}`;

const LATEST = Math.max(...MCP_VERSIONS);

function bearerMatches(header: string | undefined, token: string): boolean {
  const given = Buffer.from(/^Bearer\s+(.+)$/i.exec(header ?? '')?.[1]?.trim() ?? '');
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** Serve /mcp (and the plugin's upload and file links) from the app; returns the local user's file service. */
export async function mountLocalMcp(app: FastifyInstance, opts: LocalMcpOptions): Promise<FileService> {
  const hub = new FileHub({ db: opts.db, dataDir: opts.dataDir, publicUrl: opts.publicUrl, sheets: opts.sheets, images: opts.images, files: opts.files, folders: opts.folders, pdf: opts.pdf });
  hub.onShow = (_userId, file) => opts.show(pathOfFile(file.kind, file.id));
  hub.onFileChanged = (_userId, id) => opts.changed?.(id);
  hub.live = opts.live ?? null;
  // The model's tools only: none of the parts for ChatGPT's own app (its UI resource and app-only tools).
  const handler = createPluginHandler({ hub, oauth: null, devUserId: opts.userId, publicUrl: opts.publicUrl, webDir: '', production: true, mcp: { level: 'tools', local: true, openPath: opts.openPath } });
  app.addHook('onRequest', (req, reply, done) => {
    const pathname = (req.raw.url ?? '/').split('?')[0];
    // Uploads and file links carry their own one-time tickets and tokens; OAuth is not served here.
    if (!(mcpVersion(pathname) || pathname.startsWith('/plugin/'))) return done();
    if (mcpVersion(pathname) && !bearerMatches(req.headers.authorization, opts.token)) {
      void reply
        .code(401)
        .header('www-authenticate', 'Bearer')
        .send({ error: 'unauthorized', error_description: 'Connect at the address in the app’s File › Connect an Agent (MCP)…, which signs the agent in.' });
      return;
    }
    // /mcp is the newest version of the tools here: version 1 is kept as it is only for ChatGPT's review.
    if (pathname === '/mcp') req.raw.url = req.raw.url!.replace(/^\/mcp/, `/mcp/v${LATEST}`);
    reply.hijack();
    handler.handle(req.raw, reply.raw).catch((e: unknown) => {
      req.log.error({ err: e }, 'MCP request failed');
      if (!reply.raw.headersSent) reply.raw.writeHead(500).end();
    });
  });
  return hub.forUser(opts.userId);
}
