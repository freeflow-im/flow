import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { LEGAL_PATHS, legalPage } from './legal.ts';
import { llmsTxt } from './llms.ts';
import { featureHtml, featureMarkdown, featuresIndexHtml, robotsTxt, sitemapXml } from './marketing.ts';
import { scratchPadName } from '../shared/docNames.ts';
import { sniffImageType } from './importFile.ts';
import { fetchPublicFile, WebFetchError } from './webFetch.ts';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import Anthropic from '@anthropic-ai/sdk';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { HOME_CHAT, isChatScope, type AgentEvent, type AgentTurnRequest, type AssistantSettingsUpdate } from '../shared/agent/protocol.ts';
import { newDeck, validateDeck, type Deck } from '../shared/deck.ts';
import { newDoc, validateDoc, type Doc } from '../shared/doc.ts';
import { MAX_MARKDOWN_CHARS, newMarkdownDoc, validateMarkdownDoc, type MarkdownDoc } from '../shared/markdown.ts';
import { CsvError, MAX_CSV_CHARS } from '../shared/csv.ts';
import { importDocx } from './docxImport.ts';
import { closePdfReaders, isPdf, PdfError, pdfToMarkdownFile } from './pdfMarkdown.ts';
import { FileStore, isImageOfType, isTextFile } from './files.ts';
import { checkImageEditRate, editedImageName, EDITABLE_IMAGE_TYPES, ImageEditError, MAX_EDIT_IMAGE_BYTES, MAX_EDIT_PROMPT_CHARS, openaiImageEditor, type ImageEditor } from './imageEdit.ts';
import { CELL_IMAGE_TYPES, fileTypeOf, HTML_TYPE, isHtmlName, isTextFileType, MAX_CELL_IMAGE_BYTES, MAX_VIDEO_BYTES, PREVIEW_FILE_TYPES, videoTypeOf, VIDEO_TYPES, type ConnectedAgent, type DocKind, type NewFilesSettings, type NewFilesUpdate, type SheetMeta, type Workbook } from '../shared/types.ts';
import { AgentError, AgentService, type AgentOptions } from './agent/agent.ts';
import { JobRunner, JobStore, publicJob, workerLauncher, type Launcher } from './agent/jobs.ts';
import { openaiErrorMessage } from './agent/openai.ts';
import { OpenRouterError } from './agent/openrouter.ts';
import { checkAssistantKey, OwnKeyError } from './agent/providers.ts';
import { AssistantSettingsStore, SettingsError, type KeyCheck, type SearchKeyCheck } from './agent/settings.ts';
import { isSignatureImage, MAX_SIGNATURES, SignatureStore } from './signatures.ts';
import { AgentStore } from './agent/store.ts';
import { checkBraveKey, registerConnectorService } from './agent/tools.ts';
import { ConnectorService, type ConnectorServiceOptions } from './connectors/service.ts';
import { ConnectorError } from './connectors/types.ts';
import { AuthService, RESET_TTL_MS, SESSION_TTL_MS, VERIFY_TTL_MS, validateCredentials, type User } from './auth.ts';
import { Backup } from './backup.ts';
import { r2FromEnv, S3ObjectStore, type ObjectStore } from './blob.ts';
import { openDb } from './db.ts';
import { EXPORT_FORMATS, ExportError, exportAll, exportFile, exportFolder, imageSource, loadFile, type ExportFormat } from './export.ts';
import { appName, ORIGIN_MARK } from '../shared/brand.ts';
import { openGettingStarted } from './gettingStarted.ts';
import { isFileId } from './ids.ts';
import { ImageStore } from './images.ts';
import { deckPreview, docPreview, markdownPreview, sheetPreview, type FilePreview } from '../shared/preview.ts';
import { cleanFolderName, cleanFolderPath, folderName, joinFolder, parentFolder } from '../shared/folders.ts';
import { FolderStore, type Folders } from './folders.ts';
import { LISTED_EXTS, listedKind, LocalFileStore, LocalFolder, LocalFolders, LocalSheetStore, type FindByName } from './localStore.ts';
import { Favorites, FOLDER_REF } from './favorites.ts';
import { openedFiles, recentFiles, RecentOpens, recentsAvailable, whereOf, type Recents } from './recents.ts';
import { googleFromEnv, GoogleLogin, GoogleLoginError, GOOGLE_STATE_TTL_MS, type GoogleOptions } from './googleAuth.ts';
import { mountPlugin } from '../plugin/server/mount.ts';
import { ToolError } from '../plugin/server/files.ts';
import { mailerFromEnv, type Mailer } from './mail.ts';
import { RevisionFeed } from './revisionFeed.ts';
import { DirWatchers } from './folderWatch.ts';
import { SheetStore, validateWorkbook } from './sheets.ts';
import { listSheetCharts, loadLinkedChart, loadLinkedTable } from './linkedTable.ts';
import { importPptx } from './pptxImport.ts';
import { isSharableVideo, PublicLinks, publicDeck, type PublicLink, type SharedKind } from './publicLinks.ts';
import type { StoredFile } from '../shared/types.ts';
import { ImportError, importExcel } from './xlsxImport.ts';
import { WindowTools, type WindowToolAnswer, type WindowToolCall } from './windowTools.ts';
import { ClaudeAgentDriver, type ClaudeAgentOptions } from './agent/claudeAgent.ts';
import { mountLocalMcp } from './localMcp.ts';
import { MAX_OFFICE_ENTRY_BYTES, openZip, ZipError, zipEntries, zipEntryBytes, zipOfficeView } from './zipView.ts';
import { isZipName } from '../shared/zip.ts';
import { downloadFromWeb, uploadToWeb, webFolders, WebCopyError, webPreview, webStatus, type DownloadFormat, type LibraryKind, type Web } from './webCopy.ts';
import { NotPrintableError, paperFor, PdfMaker, PlaywrightRenderer, PRINT_COOKIE, PrintError, type PdfRenderer } from './pdf.ts';

const SESSION_COOKIE = 'sid';
/** Carries the desktop app's per-launch token (see AppOptions.local). */
export const LOCAL_COOKIE = 'local';
// Ties a Google sign-in callback to the browser that started it (login CSRF).
const GOOGLE_STATE_COOKIE = 'gstate';
/** The desktop app's scratch pads: Markdown files in this folder under the home folder. */
export const SCRATCH_DIR = path.join('.config', 'mcp-docs');
export { scratchPadName };
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
/** How long a search of the home folder may walk it when Spotlight cannot answer, and how many files it lists. */
const HOME_FIND_BUDGET_MS = 5_000;
const HOME_SEARCH_LIMIT = 50;
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const MAX_STORED_FILE_BYTES = 50 * 1024 * 1024;

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
    /** The folder a request names (its "folder" query or body field), checked to exist; '' is the top. */
    folder: string;
  }
  interface FastifyInstance {
    connectors: ConnectorService;
  }
}

/** The desktop app's MCP server for agents on this computer: its address, whether it is running (another copy of the app may hold its port), and the agents allowed. */
export interface LocalAgents {
  list(): Promise<{ url: string; running: boolean; agents: { id: string; name: string; approved: string }[] }>;
  /** Disconnect one: false if there is no such agent. */
  disconnect(id: string): Promise<boolean>;
}

export interface AppOptions {
  dataDir: string;
  staticDir?: string;
  secureCookies?: boolean;
  logger?: boolean;
  agent?: AgentOptions;
  /** Starts the worker for an app-change job. Tests pass a stub; the default runs server/agent/worker.ts. */
  launchJob?: Launcher;
  /** Sends email (password reset links). Tests pass a stub; the default comes from the environment. */
  sendMail?: Mailer;
  /** Google sign-in. Defaults to GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET; unset leaves the button off. */
  google?: GoogleOptions;
  /** Public origin for links in email, e.g. https://sheets.example.com. Defaults to the request's own origin. */
  appUrl?: string;
  /**
   * Old host names that should redirect (301) to appUrl, keeping the path. Defaults to LEGACY_HOSTS
   * (comma-separated). Lets the app move to a new domain while old links keep working.
   */
  legacyHosts?: string[];
  /**
   * Makes PDFs (server/pdf.ts): Chromium through Playwright when not given; the desktop app passes its window's
   * (ElectronRenderer); tests pass a fake; null has Download as PDF refused.
   */
  pdf?: PdfRenderer | null;
  /** Checks an assistant API key before it is saved in Settings. Tests pass a stub; the default asks the provider. */
  checkAssistantKey?: KeyCheck;
  /** Checks a Brave Search API key before it is saved in Settings. Tests pass a stub; the default searches once with it. */
  checkSearchKey?: SearchKeyCheck;
  /** Edits a picture for the assistant's edit_image. Tests pass a stub; the default asks OpenAI's image model. */
  imageEditor?: ImageEditor;
  /** Connector overrides (tests pass a fake fetch). */
  connectors?: Partial<Omit<ConnectorServiceOptions, 'keyFile'>>;
  /**
   * Serve the ChatGPT plugin (plugin/) from this server too: MCP at /mcp, OAuth at /oauth and the well-known
   * documents, the built plugin app from webDir. publicUrl is the origin ChatGPT reaches this server on.
   */
  plugin?: { publicUrl: string; webDir: string };
  /**
   * Object store for the off-box copy of every file (server/backup.ts). Defaults to Cloudflare R2 from the
   * environment (R2_BUCKET and friends); null leaves backups off. Tests pass a MemoryObjectStore.
   */
  blob?: ObjectStore | null;
  /**
   * Hosted inside another Fastify server (the FreeFlow suite, packages/server): the routes join `app` as an
   * encapsulated plugin, so their hooks run for them alone; the host says who is signed in (its own session,
   * carried as a bearer or its cookie); the client is served under `basePath`. There are no accounts of this
   * app's own then: /api/auth/* beyond `me` and `logout` is the host's, and `users` only mirrors the host's.
   */
  host?: {
    app: FastifyInstance;
    /** The signed-in user of a request by the host's session; null for a visitor. */
    authenticate(req: FastifyRequest): Promise<User | null>;
    /** End the request's session at the host (and clear its cookie): /api/auth/logout. */
    signOut(req: FastifyRequest, reply: FastifyReply): Promise<void>;
    /** The user id behind a raw Cookie header, for the plugin's OAuth pages, which answer outside Fastify. */
    userForCookie(cookieHeader: string | undefined): Promise<string | null>;
    /** Where the client lives, e.g. "/workspace". */
    basePath: string;
    /** The suite's sign-in page, for the plugin's OAuth pages (absolute, as they may be reached on another host); default "/". */
    signInUrl?: string;
  };
  /**
   * The desktop app (desktop/): the library is the files of this folder (server/localStore.ts) and there
   * are no accounts, every request is the one local user. With a token, only requests carrying it in the
   * "local" cookie are that user, which keeps other programs and web pages on this machine out.
   */
  local?: {
    dir: string;
    token?: string;
    /**
     * The cookie the token is in ("local" when not given). Cookies are per host, not per port, so servers
     * running side by side (one for each folder open in the desktop app) each need their own.
     */
    cookie?: string;
    /**
     * Show a file that is outside the folder: the desktop app (desktop/main.js) opens the file's own folder
     * in place of this one. Without it only files inside the folder can be opened from Recents.
     */
    openFile?: (file: string, fromRecents?: boolean, back?: string) => void;
    /** Show a file outside the folder in a new tab on its own folder (the desktop app does it), for the MCP server's open_path. */
    openFileInTab?: (file: string) => void;
    /** Open another folder in place of this one (the desktop app does it; this server ends), or in a new tab; at `folder` in it. */
    openFolder?: (dir: string, inTab?: boolean, folder?: string) => void;
    /** Ask the person for a folder to open, in the desktop app's Open Folder dialog: in place of this one, or in a new tab. */
    chooseFolder?: (inTab?: boolean) => void;
    /** The person's account on the web, through the Web tab's session (webCopy.ts): Upload to Web and Download to Folder. */
    web?: Web;
    /** Options for the assistant run on the user's own Claude Code (tests pass a stub query and executable). */
    claudeAgent?: Partial<ClaudeAgentOptions>;
    /** The agents connected to the desktop app's MCP server (its main process signs them in: desktop/mcpAuth.js), for Settings. */
    agents?: LocalAgents;
    /** Whether the desktop app opens new files that appear in Downloads, Documents and Desktop (its main process watches them), for Settings. */
    newFiles?: { get(): Promise<NewFilesSettings>; set(update: NewFilesUpdate): Promise<NewFilesSettings> };
    /** Show a file or folder of the folder in the system's file browser (Finder, File Explorer): a folder opened, a file selected in its own. */
    reveal?: (target: string) => void;
    /** Drag a file of the folder out of the window as the file itself, to another app (a drag the system runs, from the window in front). */
    startDrag?: (file: string) => void;
    /**
     * The files last opened on this machine, as Spotlight knows them (server/recents.ts); null where there is no
     * such list. Recents lists them below the files opened in the app. Tests give their own.
     */
    recents?: (() => Promise<Recents>) | null;
    /** An index that finds files by name in the folder faster than walking it (Spotlight on macOS); without it a search walks. */
    findByName?: FindByName | null;
    /**
     * An MCP server for agents on this machine (server/localMcp.ts) at /mcp, for requests with this bearer
     * token. `url` is where agents reach it (desktop/main.js's fixed port); `show` puts a page in the window.
     */
    mcp?: { token: string; url?: string; show(path: string): void; changed?(id: string): void };
    /**
     * Where the assistant settings are kept (the app's own data folder), so every folder's server shares
     * them; defaults to dataDir. The desktop app has no model of its own, so the user brings a key.
     */
    settingsDir?: string;
    /**
     * Keys found in the user's environment (ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY), used for
     * the assistant when the user has no settings yet: the app's first run.
     */
    env?: Record<string, string | undefined>;
  };
}

/** The page the system browser shows after a Google sign-in for the desktop app, which picks the session up itself. */
const HANDOFF_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Signed in</title>
<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:80px auto;padding:0 16px;color:#1f1f1f;text-align:center}p{color:#5f6368}</style>
</head><body><h1>You're signed in</h1><p>Go back to MCP Docs: it is signed in now. You can close this tab.</p></body></html>`;

const LIBRARY_KINDS: readonly LibraryKind[] = ['doc', 'deck', 'sheet', 'markdown', 'file'];
const DOWNLOAD_FORMATS: readonly DownloadFormat[] = ['office', 'native', 'pdf', 'csv', 'as-is'];

function cleanTitle(t: unknown): string | null {
  if (typeof t !== 'string') return null;
  const s = t.trim().slice(0, 200);
  return s || null;
}

function agentErrorMessage(e: unknown): string {
  if (e instanceof AgentError || e instanceof OwnKeyError || e instanceof OpenRouterError) return e.message;
  const openai = openaiErrorMessage(e);
  if (openai) return openai;
  if (e instanceof Anthropic.RateLimitError) return 'The assistant is getting too many requests right now. Try again in a minute.';
  if (e instanceof Anthropic.AuthenticationError) return 'The assistant is not configured correctly on this server (API key).';
  if (e instanceof Anthropic.APIError && e.status && e.status >= 500) return 'The AI service had a problem. Try again in a moment.';
  if (e instanceof Anthropic.AnthropicError && /api ?key|authentication/i.test(e.message)) return 'The assistant is not configured on this server (no API key).';
  return 'Something went wrong while the assistant was working. Try again.';
}

export async function buildApp(opts: AppOptions) {
  const db = openDb(path.join(opts.dataDir, 'app.db'));
  const auth = new AuthService(db);
  // Hosted (the FreeFlow suite, opts.host): the routes join the host's server as an encapsulated plugin (wire()
  // below), so this app's hooks run for them alone and the host's own (cookies, static files, its routes) stay as
  // they are; the host's server is the one whose log and address this app uses. Standalone: a server of its own.
  const host = opts.host ?? null;
  const basePath = host ? host.basePath.replace(/\/$/, '') : '';
  const app: FastifyInstance = host ? host.app : Fastify({ logger: opts.logger ?? false, bodyLimit: 100 * 1024 * 1024, trustProxy: true });
  if (!host) await app.register(cookie);
  // Hosted, the suite signs people in and up and sends the mail: no mailer or Google sign-in of this app's own
  // (the host's environment names its own mail and Google settings).
  const sendMail: Mailer = opts.sendMail ?? (host ? async () => {} : mailerFromEnv((msg) => app.log.info(msg)));
  const googleOpts = host ? null : (opts.google ?? googleFromEnv());
  const google = googleOpts ? new GoogleLogin(googleOpts) : null;
  // Emails sent per kind and address (password resets, verification links), to keep the mailbox and the
  // mailer quiet under abuse: at most 5 an hour.
  const mailRequests = new Map<string, number[]>();
  const tooManyMails = (kind: string, email: string): boolean => {
    const key = `${kind}:${email.trim().toLowerCase()}`;
    const now = Date.now();
    const recent = (mailRequests.get(key) ?? []).filter((t) => now - t < 60 * 60 * 1000);
    if (recent.length >= 5) return true;
    mailRequests.set(key, [...recent, now]);
    return false;
  };
  const folder = opts.local ? new LocalFolder(opts.local.dir, path.join(opts.dataDir, 'trash'), opts.local.findByName) : null;
  // The desktop app's Find a file looks through the whole home folder too: Spotlight's answer, or a short walk where there is none.
  const homeFolder = opts.local ? new LocalFolder(homedir(), path.join(opts.dataDir, 'trash'), opts.local.findByName, HOME_FIND_BUDGET_MS) : null;
  const sheets = folder ? new LocalSheetStore(db, folder, opts.dataDir) : new SheetStore(db, path.join(opts.dataDir, 'sheets'));
  await sheets.init();
  /**
   * A save may name the revision (updatedAt) the editor loaded. When it does and the file has been saved
   * since, by another editor or the ChatGPT plugin, the current metadata is returned so the save is refused
   * instead of silently overwriting that change.
   */
  const staleRev = (ownerId: string, id: string, kind: DocKind, rev: unknown): SheetMeta | null => {
    if (typeof rev !== 'string') return null;
    const cur = sheets.get(ownerId, id, kind);
    return cur && cur.updatedAt !== rev ? cur : null;
  };
  const images = new ImageStore(db, path.join(opts.dataDir, 'images'));
  await images.init();
  const storedFiles = folder ? new LocalFileStore(db, folder) : new FileStore(db, path.join(opts.dataDir, 'files'));
  await storedFiles.init();
  const folders: Folders = folder ? new LocalFolders(folder) : new FolderStore(db);
  // Every save and upload also goes to the object store, and a daily pass snapshots the database and
  // re-uploads anything missing (backup.ts). Restore with `npm run r2 restore <dir>`.
  const blob = opts.local ? null : opts.blob === undefined ? (() => { const cfg = r2FromEnv(); return cfg ? new S3ObjectStore(cfg) : null; })() : opts.blob;
  const backup = blob ? new Backup(blob, { dataDir: opts.dataDir, db, log: { info: (m) => app.log.info(m), error: (m) => app.log.error(m) } }) : null;
  if (backup) {
    sheets.backup = backup;
    images.backup = backup;
  }
  auth.purgeExpiredSessions();
  const connectors = new ConnectorService(db, { keyFile: path.join(opts.dataDir, 'connector.key'), ...opts.connectors });
  // Lets the agent's server tools (list_connections, fetch_connector_data) reach the user's connections.
  registerConnectorService(sheets, connectors);
  // Created after the connector service, which makes the encryption key file they share.
  // The desktop app's settings are the app's, not the folder's: one database for every folder's server.
  let windowTools: WindowTools | null = null; // made in wire(), used by the Claude Code driver's pins
  const settingsDir = opts.local?.settingsDir ?? opts.dataDir;
  const settingsDb = settingsDir === opts.dataDir ? db : openDb(path.join(settingsDir, 'settings.db'));
  if (settingsDb !== db) settingsDb.prepare("INSERT OR IGNORE INTO users (id, email, password_hash, created_at) VALUES ('local', 'local', '', ?)").run(new Date().toISOString());
  // In the desktop app the assistant can also run on the user's own Claude Code (server/agent/claudeAgent.ts),
  // working in the open folder through this server's MCP endpoint, whose edits run in the window.
  const claudeAgent =
    opts.local?.mcp && folder
      ? new ClaudeAgentDriver({
          cwd: () => folder.root,
          mcp: () => {
            const address = app.server.address();
            return { url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/mcp`, token: opts.local!.mcp!.token };
          },
          pinGroup: (group) => windowTools?.pinGroup(group),
          ...opts.local.claudeAgent,
        })
      : undefined;
  const signatures = new SignatureStore(settingsDb);
  const assistantSettings = new AssistantSettingsStore(settingsDb, path.join(settingsDir, 'connector.key'), { builtIn: !opts.local, agents: !!claudeAgent });
  // PDFs of files (server/pdf.ts): Download as PDF, and export_pdf for the assistant and the MCP. The headless
  // browser loads the app's pages from this server when it serves them, else (development) from Vite.
  const pdfRenderer = opts.pdf === undefined ? new PlaywrightRenderer() : opts.pdf;
  const pdfMaker = pdfRenderer
    ? new PdfMaker({
        renderer: pdfRenderer,
        sheets,
        files: storedFiles,
        // The pages are this server's own (the host's, when hosted), under the client's base path.
        origin: () => {
          const address = app.server.address();
          return (opts.staticDir ? `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}` : (process.env.PRINT_ORIGIN ?? 'http://localhost:5173')) + basePath;
        },
      })
    : null;
  const agent = new AgentService(new AgentStore(db), sheets, assistantSettings, { jobs: !opts.local, ...opts.agent, images, files: storedFiles, pdf: pdfMaker ?? undefined, claudeAgent });
  const jobs = new JobStore(db);
  const jobRunner = new JobRunner(jobs, opts.launchJob ?? workerLauncher(opts.dataDir));
  // A previous server process may have died (or been restarted by the job itself) with a job in flight.
  jobRunner.reconcile();

  if (host) {
    let child!: FastifyInstance;
    await host.app.register(async (c) => {
      child = c;
      await wire(c);
    });
    return child;
  }
  await wire(app);
  return app;

  // The routes, hooks and static files, on `app`: the host's encapsulated child, or the standalone server.

  async function wire(app: FastifyInstance): Promise<void> {
  // The plugin answers its paths (/mcp, /oauth/*, ...) in a hook before routing: on the host's server when
  // hosted, as the hook of an encapsulated plugin runs only for that plugin's routes.
  const pluginOAuth = opts.plugin
    ? await mountPlugin(host?.app ?? app, { db, dataDir: opts.dataDir, sheets, images, files: storedFiles, auth: host ? null : auth, google: host ? null : google, sendMail, mailAllowed: (email) => !tooManyMails('verify', email), pdf: pdfMaker ?? undefined, publicUrl: opts.plugin.publicUrl, webDir: opts.plugin.webDir, sessionCookie: SESSION_COOKIE, sessionUser: host ? (cookieHeader) => host.userForCookie(cookieHeader) : undefined, suiteSignIn: host ? (host.signInUrl ?? '/') : undefined, production: !!opts.staticDir })
    : null;
  // Raw file uploads (xlsx import).
  app.addContentTypeParser([XLSX_MIME, PPTX_MIME, DOCX_MIME, 'application/vnd.ms-excel', 'application/octet-stream'], { parseAs: 'buffer', bodyLimit: MAX_IMPORT_BYTES }, (_req, body, done) =>
    done(null, body),
  );
  // Raw cell image uploads. Images are stored as files and cells only reference them, so workbook saves
  // (JSON, under the default body limit) stay small however large the images are.
  app.addContentTypeParser('application/pdf', { parseAs: 'buffer', bodyLimit: MAX_STORED_FILE_BYTES }, (_req, body, done) => done(null, body));
  app.addContentTypeParser([...new Set(Object.values(VIDEO_TYPES))], { parseAs: 'buffer', bodyLimit: MAX_VIDEO_BYTES }, (_req, body, done) => done(null, body));
  app.addContentTypeParser(CELL_IMAGE_TYPES, { parseAs: 'buffer', bodyLimit: MAX_CELL_IMAGE_BYTES }, (_req, body, done) => done(null, body));

  app.decorate('connectors', connectors);
  if (!host) app.decorateRequest('user', null); // hosted: the host's own request decoration
  app.decorateRequest('folder', '');

  // Requests to a retired host name go to the current one (same path and query). Hosted, the host does it.
  const appUrl = (opts.appUrl ?? process.env.APP_URL)?.replace(/\/$/, '');
  const legacyHosts = new Set((opts.legacyHosts ?? process.env.LEGACY_HOSTS?.split(',') ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean));
  if (!host && appUrl && legacyHosts.size) {
    const current = new URL(appUrl).host.toLowerCase();
    app.addHook('onRequest', async (req, reply) => {
      const host = String(req.headers.host ?? '').toLowerCase();
      if (legacyHosts.has(host) && host !== current) return reply.code(301).redirect(`${appUrl}${req.url}`);
    });
  }

  // The desktop app has one user, who owns the mounted folder's files and is never asked to sign in.
  const localUser: User | null = opts.local ? { id: 'local', email: 'local' } : null;
  if (localUser) db.prepare("INSERT OR IGNORE INTO users (id, email, password_hash, created_at) VALUES (?, ?, '', ?)").run(localUser.id, localUser.email, new Date().toISOString());
  // The first run: a key already set in the user's environment runs the assistant without a visit to Settings.
  if (localUser && opts.local?.env) {
    const used = assistantSettings.adoptFromEnvironment(localUser.id, opts.local.env);
    if (used) app.log.info({ provider: used }, 'assistant key found in the environment');
  }
  // The pictures of the folder's PowerPoint and Word files, read each time one is opened, are stored once.
  if (localUser && sheets instanceof LocalSheetStore) sheets.media = { store: (type, data) => images.createOnce(localUser.id, type, data), source: imageSource(images, localUser.id) };
  // The desktop app's MCP server, and the file its window shows (the one the tools act on by default). Its
  // edit tools on a file open in a window run in that window (windowTools.ts).
  windowTools = opts.local?.mcp ? new WindowTools() : null;
  // A file named by its path, for the MCP server's open_path: one in the folder is its document or stored file;
  // for any other the app opens the file's own folder in a new tab.
  const openLocalPath = (given: string): { kind: LibraryKind; id: string } | { elsewhere: string } => {
    const target = path.resolve(folder!.root, given === '~' || given.startsWith('~/') ? path.join(homedir(), given.slice(1)) : given);
    let isFile = false;
    try {
      isFile = statSync(target).isFile();
    } catch {
      // Not there: answered below.
    }
    if (!isFile) throw new ToolError(`There is no file at ${target}.`);
    const rel = path.relative(folder!.root, target);
    const parts = rel.split(path.sep);
    if (path.isAbsolute(rel) || parts.some((p) => p === '..' || p === 'node_modules')) {
      if (!opts.local?.openFileInTab) throw new ToolError(`${target} is outside the open folder (${folder!.root}).`);
      opts.local.openFileInTab(target);
      return { elsewhere: path.dirname(target) };
    }
    const file = parts.join('/');
    const kind = listedKind(file);
    const id = kind === 'file' ? (storedFiles as LocalFileStore).idOf(localUser!.id, file) : (sheets as LocalSheetStore).idOf(localUser!.id, file);
    if (!id) throw new ToolError(`${file} is not a file the app shows.`);
    return { kind, id };
  };
  const localMcp = opts.local?.mcp
    ? await mountLocalMcp(app, { db, dataDir: opts.dataDir, sheets, images, files: storedFiles, folders, userId: localUser!.id, token: opts.local.mcp.token, publicUrl: opts.local.mcp.url ?? null, show: opts.local.mcp.show, changed: opts.local.mcp.changed, live: windowTools, pdf: pdfMaker ?? undefined, openPath: openLocalPath })
    : null;
  // Hosted, the host's users are mirrored into this database as they are seen, so that everything a user owns
  // (sheets, files, folders, ...) keeps its foreign key to a users row of theirs; the row has no password.
  const mirrorUser = db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, '', ?) ON CONFLICT(id) DO UPDATE SET email = excluded.email WHERE email <> excluded.email");
  const mirrored = new Map<string, string>();
  app.addHook('onRequest', async (req, reply) => {
    // The headless browser making a PDF carries a print ticket instead of a session (server/pdf.ts): it is the
    // user who asked, for reading only.
    const printing = pdfMaker?.tickets.userFor(req.cookies[PRINT_COOKIE]);
    if (printing) {
      req.user = localUser ?? (db.prepare('SELECT id, email FROM users WHERE id = ?').get(printing) as User | undefined) ?? null;
      if (req.method !== 'GET' && req.method !== 'HEAD') return reply.code(403).send({ error: 'Read only' });
      return;
    }
    if (localUser) req.user = !opts.local!.token || req.cookies[opts.local!.cookie ?? LOCAL_COOKIE] === opts.local!.token ? localUser : null;
    else if (host) {
      req.user = await host.authenticate(req);
      if (req.user && mirrored.get(req.user.id) !== req.user.email) {
        try {
          mirrorUser.run(req.user.id, req.user.email, new Date().toISOString());
          mirrored.set(req.user.id, req.user.email);
        } catch (e) {
          // Another row holds this email (an account from before the merge that the migration did not map).
          req.log.error({ err: e, userId: req.user.id }, 'could not mirror the host user');
          return reply.code(500).send({ error: 'This account is not set up for Workspace yet.' });
        }
      }
    } else req.user = auth.userForSession(req.cookies[SESSION_COOKIE]);
  });
  app.addHook('onClose', async () => {
    await closePdfReaders();
    await pdfMaker?.renderer.close();
    if (backup) {
      backup.stop();
      // Let queued uploads finish before the database closes (a redeploy gives 15 s).
      if (!(await backup.drain(8_000))) app.log.error(`backup: ${backup.pending} upload(s) still pending at shutdown`);
    }
    db.close();
    if (settingsDb !== db) settingsDb.close();
  });
  // The daily pass runs for a real deployment (store from the environment), not for tests.
  if (backup && opts.blob === undefined) backup.startDaily();

  const setSessionCookie = (reply: FastifyReply, userId: string) => {
    const { token } = auth.createSession(userId);
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: opts.secureCookies ?? false,
      maxAge: SESSION_TTL_MS / 1000,
    });
  };

  /** Public origin of the app, for links and OAuth redirect URIs. */
  const originOf = (req: FastifyRequest) =>
    (opts.appUrl ?? process.env.APP_URL ?? `${req.headers['x-forwarded-proto'] ?? req.protocol}://${req.headers.host}`).replace(/\/$/, '');

  const requireUser = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) return reply.code(401).send({ error: 'Not signed in' });
    // New files go into the folder the request names; uploads name it in the query, the rest in the body.
    const body = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? (req.body as { folder?: unknown }) : {};
    const named = (req.query as { folder?: unknown } | undefined)?.folder ?? body.folder;
    if (named === undefined) return;
    const path = cleanFolderPath(named);
    if (path === null || !folders.exists(req.user.id, path)) return reply.code(404).send({ error: 'Folder not found' });
    req.folder = path;
  };

  // --- Auth ----------------------------------------------------------------
  /** Email the link that verifies a new account's address. */
  const sendVerification = async (req: FastifyRequest, user: User) => {
    const { token } = auth.createEmailVerification(user.id);
    const link = `${originOf(req)}/verify?token=${token}`;
    const hours = Math.round(VERIFY_TTL_MS / 3600000);
    await sendMail({
      to: user.email,
      subject: 'Verify your email for MCP Docs',
      text: `Welcome to MCP Docs! Confirm that ${user.email} is your address by opening this link (it expires in ${hours} hours):\n${link}\n\nIf you didn't create an MCP Docs account, you can ignore this email.`,
    });
  };

  // Hosted, accounts are the host's: none of the sign-up, sign-in and password routes below exist.
  if (!host) {
  // Sign-up creates the account but no session: the user is signed in by the link in the verification email.
  app.post('/api/auth/register', async (req, reply) => {
    const { email, password } = (req.body ?? {}) as { email?: unknown; password?: unknown };
    const problem = validateCredentials(email, password);
    if (problem) return reply.code(400).send({ error: problem });
    if (tooManyMails('verify', email as string)) return reply.code(429).send({ error: 'Too many sign-up attempts for this address. Try again in an hour.' });
    const user = await auth.register(email as string, password as string);
    if (user === 'exists') return reply.code(409).send({ error: 'An account with this email already exists.' });
    try {
      await sendVerification(req, user);
    } catch (e) {
      req.log.error({ err: e }, 'verification email failed');
      return reply.code(500).send({ error: 'The verification email could not be sent. Try again later.' });
    }
    return { pending: true, email: user.email };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const { email, password } = (req.body ?? {}) as { email?: unknown; password?: unknown };
    if (typeof email !== 'string' || typeof password !== 'string') {
      return reply.code(400).send({ error: 'Email and password are required.' });
    }
    const user = await auth.login(email, password);
    if (!user) return reply.code(401).send({ error: 'Invalid email or password.' });
    if (user === 'unverified') {
      return reply.code(403).send({ error: 'Please verify your email address first. Check your inbox for the link we sent you.', code: 'unverified' });
    }
    setSessionCookie(reply, user.id);
    return { user };
  });

  // Send the verification link again. Always answers OK so the response doesn't reveal account state.
  app.post('/api/auth/verify/resend', async (req, reply) => {
    const { email } = (req.body ?? {}) as { email?: unknown };
    if (typeof email !== 'string' || !email.trim()) return reply.code(400).send({ error: 'Please enter your email address.' });
    if (tooManyMails('verify', email)) return reply.code(429).send({ error: 'Too many verification emails for this address. Try again in an hour.' });
    const user = auth.unverifiedUser(email);
    if (user) {
      try {
        await sendVerification(req, user);
      } catch (e) {
        req.log.error({ err: e }, 'verification email failed');
        return reply.code(500).send({ error: 'The verification email could not be sent. Try again later.' });
      }
    }
    return { ok: true };
  });

  // The emailed link opens /verify, which posts the token here; a good token signs the user in.
  app.post('/api/auth/verify', async (req, reply) => {
    const { token } = (req.body ?? {}) as { token?: unknown };
    const user = typeof token === 'string' ? auth.verifyEmail(token) : null;
    if (!user) return reply.code(400).send({ error: 'This verification link is invalid or has expired. Sign in to request a new one.' });
    setSessionCookie(reply, user.id);
    return { user };
  });

  // Password reset: always answers OK so the response doesn't reveal whether an account exists.
  app.post('/api/auth/forgot', async (req, reply) => {
    const { email } = (req.body ?? {}) as { email?: unknown };
    if (typeof email !== 'string' || !email.trim()) return reply.code(400).send({ error: 'Please enter your email address.' });
    if (tooManyMails('reset', email)) return reply.code(429).send({ error: 'Too many reset requests for this address. Try again in an hour.' });

    const reset = auth.createPasswordReset(email);
    if (reset) {
      const link = `${originOf(req)}/reset?token=${reset.token}`;
      const minutes = Math.round(RESET_TTL_MS / 60000);
      try {
        await sendMail({
          to: reset.user.email,
          subject: 'Reset your MCP Docs password',
          text: `Someone asked to reset the password for ${reset.user.email} on MCP Docs.\n\nSet a new password here (the link works once and expires in ${minutes} minutes):\n${link}\n\nIf you didn't ask for this, you can ignore this email; your password stays the same.`,
        });
      } catch (e) {
        req.log.error({ err: e }, 'password reset email failed');
        return reply.code(500).send({ error: 'The reset email could not be sent. Try again later.' });
      }
    }
    return { ok: true };
  });

  app.get('/api/auth/reset', async (req, reply) => {
    const { token } = req.query as { token?: string };
    const user = typeof token === 'string' ? auth.userForResetToken(token) : null;
    if (!user) return reply.code(400).send({ error: 'This reset link is invalid or has expired. Request a new one.' });
    return { email: user.email };
  });

  app.post('/api/auth/reset', async (req, reply) => {
    const { token, password } = (req.body ?? {}) as { token?: unknown; password?: unknown };
    if (typeof token !== 'string') return reply.code(400).send({ error: 'This reset link is invalid or has expired. Request a new one.' });
    const problem = validateCredentials('reset@example.com', password);
    if (problem) return reply.code(400).send({ error: problem });
    const user = await auth.resetPassword(token, password as string);
    if (!user) return reply.code(400).send({ error: 'This reset link is invalid or has expired. Request a new one.' });
    setSessionCookie(reply, user.id);
    return { user };
  });
  }

  app.post('/api/auth/logout', async (req, reply) => {
    if (host) {
      await host.signOut(req, reply);
      return { ok: true };
    }
    const token = req.cookies[SESSION_COOKIE];
    if (token) auth.destroySession(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // Recents: the files each user opened in the app (in the desktop app kept with its settings, for every folder),
  // and in the desktop app then the ones the system knows were opened lately, asked of Spotlight unless the
  // options say otherwise.
  const recentOpens = new RecentOpens(settingsDb);
  const favorites = new Favorites(settingsDb);
  const recents = opts.local ? (opts.local.recents === undefined ? (recentsAvailable() ? () => recentFiles(LISTED_EXTS) : null) : opts.local.recents) : null;
  // `suite`: hosted in the FreeFlow suite, whose sign-in is at /; the client sends a visitor there.
  app.get('/api/auth/me', async (req) => ({ user: req.user, googleLogin: !host && !!google, ...(folder && req.user ? { local: { dir: folder.root } } : {}), ...(host ? { suite: { basePath } } : {}) }));

  if (!host) {
  // Google refuses to sign in inside an embedded browser, so the desktop app's Web tab (MCP Docs) has the
  // system browser do it, with a random key of the app's (?desktop=<key>). The callback gives that browser no
  // session: it keeps the sign-in under the key, which the app asks after (/api/auth/handoff/status) and then
  // trades for its tab's own session (/api/auth/handoff). Kept ten minutes, in memory.
  const handoffs = new Map<string, { userId: string; next: string; expires: number }>();
  const HANDOFF_TTL_MS = 10 * 60 * 1000;
  const handoffKey = (k: unknown): string | null => (typeof k === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(k) ? k : null);

  // Google sign-in: send the browser to Google; it comes back to the callback, which signs the user in.
  app.get('/api/auth/google/start', async (req, reply) => {
    if (!google) return reply.code(404).send({ error: 'Google sign-in is not set up on this server.' });
    const { next, desktop } = req.query as { next?: string; desktop?: string };
    const { url, state } = google.start(`${originOf(req)}/api/auth/google/callback`, next, handoffKey(desktop));
    reply.setCookie(GOOGLE_STATE_COOKIE, state, {
      path: '/api/auth/google',
      httpOnly: true,
      sameSite: 'lax',
      secure: opts.secureCookies ?? false,
      maxAge: GOOGLE_STATE_TTL_MS / 1000,
    });
    return reply.redirect(url);
  });

  app.get('/api/auth/google/callback', async (req, reply) => {
    const fail = (message: string) => reply.redirect(`/login?error=${encodeURIComponent(message)}`);
    if (!google) return fail('Google sign-in is not set up on this server.');
    const q = req.query as { state?: string; code?: string; error?: string };
    const expected = req.cookies[GOOGLE_STATE_COOKIE];
    reply.clearCookie(GOOGLE_STATE_COOKIE, { path: '/api/auth/google' });
    if (q.error === 'access_denied') return fail('The Google sign-in was cancelled.');
    if (q.error || !q.state || !q.code) return fail('Google sign-in failed. Try again.');
    if (!expected || expected !== q.state) return fail('This sign-in link is invalid or has expired. Try again.');
    try {
      const { identity, next, desktop } = await google.finish(q.state, q.code);
      const user = auth.loginWithGoogle(identity);
      if (user === 'unverified') return fail("Your Google account's email address isn't verified, so it can't be used to sign in.");
      if (desktop) {
        const now = Date.now();
        for (const [k, v] of handoffs) if (v.expires < now) handoffs.delete(k);
        handoffs.set(desktop, { userId: user.id, next, expires: now + HANDOFF_TTL_MS });
        return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(HANDOFF_PAGE);
      }
      setSessionCookie(reply, user.id);
      return reply.redirect(next);
    } catch (e) {
      if (e instanceof GoogleLoginError) return fail(e.message);
      req.log.error({ err: e }, 'google sign-in failed');
      return fail('Google sign-in failed. Try again.');
    }
  });

  // Whether the Google sign-in the desktop app started under this key has finished.
  app.get('/api/auth/handoff/status', async (req, reply) => {
    const key = handoffKey((req.query as { key?: unknown }).key);
    const h = key ? handoffs.get(key) : undefined;
    return reply.header('cache-control', 'no-store').send({ ready: !!h && h.expires >= Date.now() });
  });

  // The desktop app's Web tab trades the key for its own session, once.
  app.get('/api/auth/handoff', async (req, reply) => {
    const key = handoffKey((req.query as { key?: unknown }).key);
    const h = key ? handoffs.get(key) : undefined;
    if (key) handoffs.delete(key);
    if (!h || h.expires < Date.now()) return reply.redirect(`/login?error=${encodeURIComponent('This sign-in has expired. Try again.')}`);
    setSessionCookie(reply, h.userId);
    return reply.redirect(h.next);
  });
  }

  // The privacy policy, terms of service and support page: public, and plain HTML for readers without scripts.
  // Hosted, the suite has a privacy page of its own at /privacy.
  for (const p of LEGAL_PATHS) if (!(host && p === '/privacy')) app.get(p, async (_req, reply) => reply.type('text/html; charset=utf-8').header('cache-control', 'public, max-age=300').send(legalPage(p)));

  // For agents, which do not run the app's scripts: what this is and how to connect to its MCP server.
  app.get('/llms.txt', async (req, reply) => reply.type('text/markdown; charset=utf-8').header('cache-control', 'public, max-age=300').send(llmsTxt(originOf(req), !!pluginOAuth)));

  // The feature pages (server/marketing.ts): HTML for people and crawlers, and each as Markdown for agents, at its
  // address with .md or when the request asks for Markdown; the sitemap and robots.txt that list them.
  const publicPage = (reply: FastifyReply, type: string, body: string) => reply.type(type).header('cache-control', 'public, max-age=300').send(body);
  app.get('/features', async (req, reply) => publicPage(reply, 'text/html; charset=utf-8', featuresIndexHtml(originOf(req))));
  app.get<{ Params: { page: string } }>('/features/:page', async (req, reply) => {
    const md = req.params.page.endsWith('.md') || /\btext\/markdown\b/.test(req.headers.accept ?? '');
    const slug = req.params.page.replace(/\.md$/, '');
    const body = md ? featureMarkdown(slug, originOf(req)) : featureHtml(slug, originOf(req));
    if (body === null) return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
    reply.header('vary', 'accept');
    return publicPage(reply, md ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8', body);
  });
  app.get('/sitemap.xml', async (req, reply) => publicPage(reply, 'application/xml; charset=utf-8', sitemapXml(originOf(req))));
  app.get('/robots.txt', async (req, reply) => publicPage(reply, 'text/plain; charset=utf-8', robotsTxt(originOf(req))));

  // Liveness/readiness for the hosting platform: verifies the database is reachable.
  app.get('/api/health', async (_req, reply) => {
    try {
      db.prepare('SELECT 1').get();
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  // --- Sheets ----------------------------------------------------------------
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);

    r.get('/api/sheets', async (req) => ({ sheets: sheets.list(req.user!.id) }));

    // Create: empty, or a CSV file from its text (an uploaded .csv file, read by the browser).
    r.post('/api/sheets', async (req, reply) => {
      const body = (req.body ?? {}) as { title?: unknown; csv?: unknown };
      if (body.csv !== undefined) {
        if (typeof body.csv !== 'string') return reply.code(400).send({ error: 'CSV must be a string' });
        if (body.csv.length > MAX_CSV_CHARS) return reply.code(400).send({ error: 'This file is too large to import (10 MB maximum).' });
        try {
          return { sheet: await sheets.createCsv(req.user!.id, cleanTitle(body.title) ?? 'Imported CSV', body.csv, req.folder) };
        } catch (e) {
          if (e instanceof CsvError) return reply.code(400).send({ error: e.message });
          throw e;
        }
      }
      return { sheet: await sheets.create(req.user!.id, cleanTitle(body.title) ?? 'Untitled spreadsheet', undefined, req.folder) };
    });

    /** Parse an uploaded .xlsx body; sends a 400 and returns null on failure. */
    const convertUpload = async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        reply.code(400).send({ error: 'Upload an Excel file (.xlsx or .xls) as the request body.' });
        return null;
      }
      let result;
      try {
        result = await importExcel(body);
      } catch (e) {
        if (!(e instanceof ImportError)) req.log.warn({ err: e }, 'xlsx import failed');
        const msg = e instanceof ImportError ? e.message : 'This file could not be imported. Make sure it is a valid Excel workbook (.xlsx or .xls).';
        reply.code(400).send({ error: msg });
        return null;
      }
      const problem = validateWorkbook(result.workbook);
      if (problem) {
        reply.code(400).send({ error: `Import produced an invalid workbook: ${problem}` });
        return null;
      }
      return result;
    };

    // Import as a brand-new spreadsheet.
    r.post('/api/sheets/import', async (req, reply) => {
      const result = await convertUpload(req, reply);
      if (!result) return reply;
      const title = cleanTitle((req.query as { title?: unknown }).title) ?? 'Imported spreadsheet';
      const sheet = await sheets.create(req.user!.id, title, result.workbook, req.folder);
      return { sheet, warnings: result.warnings };
    });

    // Convert only (nothing is stored); the client adds the tabs to an open spreadsheet.
    r.post('/api/import/xlsx', async (req, reply) => {
      const result = await convertUpload(req, reply);
      if (!result) return reply;
      return result;
    });

    r.get('/api/sheets/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const res = await sheets.load(req.user!.id, id);
        if (!res) return reply.code(404).send({ error: 'Sheet not found' });
        return { sheet: res.meta, workbook: res.workbook, ...(res.notKept ? { notKept: res.notKept } : {}) };
      } catch (e) {
        // A CSV or Excel file from a mounted folder that cannot be opened (too large, or not what it says).
        if (e instanceof CsvError || e instanceof ImportError) return reply.code(400).send({ error: e.message });
        throw e;
      }
    });

    // A range of the spreadsheet as the cells of a slide table (a table linked to it, shared/sheetTable.ts).
    r.get('/api/sheets/:id/table', async (req, reply) => {
      const { id } = req.params as { id: string };
      const q = req.query as { tabId?: string; tab?: string; range?: string };
      try {
        const t = await loadLinkedTable(sheets, req.user!.id, id, { tabId: q.tabId || undefined, tab: q.tab || undefined, range: q.range || undefined });
        if (!t) return reply.code(404).send({ error: 'Sheet not found' });
        if (typeof t === 'string') return reply.code(400).send({ error: t });
        return t;
      } catch (e) {
        if (e instanceof CsvError || e instanceof ImportError) return reply.code(400).send({ error: e.message });
        throw e;
      }
    });

    // The spreadsheet's charts, for a slide: the list to choose from, and one as a slide shows it (shared/chart.ts).
    r.get('/api/sheets/:id/charts', async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const list = await listSheetCharts(sheets, req.user!.id, id);
        return list ?? reply.code(404).send({ error: 'Sheet not found' });
      } catch (e) {
        if (e instanceof CsvError || e instanceof ImportError) return reply.code(400).send({ error: e.message });
        throw e;
      }
    });
    r.get('/api/sheets/:id/chart', async (req, reply) => {
      const { id } = req.params as { id: string };
      const chartId = (req.query as { chart?: string }).chart ?? '';
      try {
        const c = await loadLinkedChart(sheets, req.user!.id, id, chartId);
        if (!c) return reply.code(404).send({ error: 'Sheet not found' });
        if (typeof c === 'string') return reply.code(404).send({ error: c });
        return c;
      } catch (e) {
        if (e instanceof CsvError || e instanceof ImportError) return reply.code(400).send({ error: e.message });
        throw e;
      }
    });

    // Branch: a copy that stays connected to its original for comparison.
    r.post('/api/sheets/:id/branch', async (req, reply) => {
      const { id } = req.params as { id: string };
      const title = cleanTitle((req.body as { title?: unknown } | undefined)?.title);
      const source = sheets.get(req.user!.id, id, 'sheet');
      if (!source) return reply.code(404).send({ error: 'Sheet not found' });
      const sheet = await sheets.branch(req.user!.id, id, title ?? `${source.title} (branch)`);
      return { sheet };
    });

    r.get('/api/sheets/:id/compare', async (req, reply) => {
      const { id } = req.params as { id: string };
      const data = await sheets.compareData(req.user!.id, id);
      if (data === null) return reply.code(404).send({ error: 'Sheet not found' });
      if (data === 'not-branch') return reply.code(400).send({ error: 'This spreadsheet is not a branch.' });
      return data;
    });

    r.put('/api/sheets/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as { workbook?: Workbook; rev?: unknown } | undefined;
      const workbook = body?.workbook;
      const problem = validateWorkbook(workbook);
      if (problem) return reply.code(400).send({ error: problem });
      const stale = staleRev(req.user!.id, id, 'sheet', body?.rev);
      if (stale) return reply.code(409).send({ error: 'The spreadsheet was changed elsewhere since you loaded it.', meta: stale });
      const meta = await sheets.save(req.user!.id, id, workbook!);
      if (!meta) return reply.code(404).send({ error: 'Sheet not found' });
      return { sheet: meta };
    });

    // Convert a CSV file to a richer spreadsheet (formatting, more tabs and so on), or an Excel file to the
    // app's own format (pictures in cells).
    r.post('/api/sheets/:id/convert', async (req, reply) => {
      const { id } = req.params as { id: string };
      const meta = await sheets.convertToNative(req.user!.id, id);
      if (!meta) return reply.code(404).send({ error: 'Sheet not found' });
      return { sheet: meta };
    });

    r.patch('/api/sheets/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const title = cleanTitle((req.body as { title?: unknown } | undefined)?.title);
      if (!title) return reply.code(400).send({ error: 'Title is required' });
      const meta = sheets.rename(req.user!.id, id, title, 'sheet');
      if (!meta) return reply.code(404).send({ error: 'Sheet not found' });
      return { sheet: meta };
    });

    r.delete('/api/sheets/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!(await sheets.delete(req.user!.id, id, 'sheet'))) return reply.code(404).send({ error: 'Sheet not found' });
      return { ok: true };
    });
  });

  // --- Revisions: an open editor hears when its file is saved elsewhere (revisionFeed.ts) ---
  const revisions = new RevisionFeed();
  sheets.onRevision = (id, rev) => revisions.publish(id, rev);
  const revisionStreams = new Set<ServerResponse>();
  // In the desktop app, the directories open editors and lists look at, for changes other programs make.
  const dirWatchers = folder ? new DirWatchers((dir) => folder.abs(dir)) : null;
  app.addHook('onClose', async () => {
    for (const res of revisionStreams) res.end();
    dirWatchers?.close();
  });
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);

    // Server-sent events, each `{ rev }`: the current revision on connecting (EventSource reconnects by itself,
    // so this also covers saves missed while disconnected), then every new one.
    r.get('/api/revisions/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const meta = sheets.get(req.user!.id, id);
      if (!meta) return reply.code(404).send({ error: 'File not found' });
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const send = (rev: string) => res.write(`data: ${JSON.stringify({ rev })}\n\n`);
      send(meta.updatedAt);
      const stop = revisions.watch(id, send);
      // In the desktop app the file can also be changed by another program: its directory is watched, and a
      // change the store did not make is a new revision (LocalSheetStore.fileChanged), announced as any other.
      const rel = dirWatchers && sheets instanceof LocalSheetStore ? sheets.relOf(req.user!.id, id) : null;
      const unwatch =
        rel !== null && sheets instanceof LocalSheetStore
          ? dirWatchers!.watch(parentFolder(rel), (names) => {
              if (!names || names.has(path.posix.basename(rel))) sheets.fileChanged(rel);
            })
          : null;
      // A comment now and then keeps proxies from closing a quiet connection.
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      revisionStreams.add(res);
      res.on('close', () => {
        stop();
        unwatch?.();
        clearInterval(ping);
        revisionStreams.delete(res);
      });
    });
  });

  // --- Text documents ------------------------------------------------------------
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);

    r.get('/api/docs', async (req) => ({ docs: sheets.list(req.user!.id, 'doc') }));

    r.post('/api/docs', async (req, reply) => {
      const body = (req.body ?? {}) as { title?: unknown; doc?: unknown };
      const title = cleanTitle(body.title) ?? 'Untitled document';
      const doc = body.doc === undefined ? newDoc() : body.doc;
      const problem = validateDoc(doc);
      if (problem) return reply.code(400).send({ error: problem });
      return { doc: await sheets.createDoc(req.user!.id, title, doc as Doc, req.folder) };
    });

    r.get('/api/docs/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const res = await sheets.loadDoc(req.user!.id, id);
        if (!res) return reply.code(404).send({ error: 'Document not found' });
        return { meta: res.meta, doc: res.doc, ...(res.notKept ? { notKept: res.notKept } : {}) };
      } catch (e) {
        // A PowerPoint or Word file from a mounted folder that cannot be opened.
        if (e instanceof ImportError) return reply.code(400).send({ error: e.message });
        throw e;
      }
    });

    // Keep a document stored as an Office file (desktop app) in the app's own format, which holds everything.
    r.post('/api/docs/:id/convert', async (req, reply) => {
      const { id } = req.params as { id: string };
      const meta = await sheets.convertToOwnFormat(req.user!.id, id, 'doc');
      if (!meta) return reply.code(404).send({ error: 'Document not found' });
      return { meta };
    });

    r.put('/api/docs/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as { doc?: unknown; rev?: unknown } | undefined;
      const doc = body?.doc;
      const problem = validateDoc(doc);
      if (problem) return reply.code(400).send({ error: problem });
      const stale = staleRev(req.user!.id, id, 'doc', body?.rev);
      if (stale) return reply.code(409).send({ error: 'The document was changed elsewhere since you loaded it.', meta: stale });
      const meta = await sheets.saveDoc(req.user!.id, id, doc as Doc);
      if (!meta) return reply.code(404).send({ error: 'Document not found' });
      return { meta };
    });

    r.patch('/api/docs/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const title = cleanTitle((req.body as { title?: unknown } | undefined)?.title);
      if (!title) return reply.code(400).send({ error: 'Title is required' });
      const meta = sheets.rename(req.user!.id, id, title, 'doc');
      if (!meta) return reply.code(404).send({ error: 'Document not found' });
      return { meta };
    });

    r.delete('/api/docs/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!(await sheets.delete(req.user!.id, id, 'doc'))) return reply.code(404).send({ error: 'Document not found' });
      return { ok: true };
    });

    /** Convert an uploaded .docx body; sends a 400 and returns null on failure. Pictures are stored for the user. */
    const convertDocx = async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        reply.code(400).send({ error: 'Upload a Word document (.docx) as the request body.' });
        return null;
      }
      try {
        return await importDocx(body, (type, data) => images.create(req.user!.id, type, data));
      } catch (e) {
        if (!(e instanceof ImportError)) req.log.warn({ err: e }, 'docx import failed');
        reply.code(400).send({ error: e instanceof ImportError ? e.message : 'This file could not be imported. Make sure it is a valid Word document (.docx).' });
        return null;
      }
    };

    // Import as a brand-new document.
    r.post('/api/docs/import', async (req, reply) => {
      const title = cleanTitle((req.query as { title?: unknown }).title) ?? 'Imported document';
      const result = await convertDocx(req, reply);
      if (!result) return reply;
      const doc = await sheets.createDoc(req.user!.id, title, result.doc, req.folder);
      return { doc, warnings: result.warnings };
    });

    // Convert only (nothing is stored but the pictures); the client adds the blocks to an open document.
    r.post('/api/import/pdf', async (req, reply) => {
      if (!Buffer.isBuffer(req.body) || !isPdf(req.body)) return reply.code(400).send({ error: 'This file is not a valid PDF.' });
      const raw = String((req.query as { filename?: unknown }).filename ?? '');
      const name = raw.replace(/[\\/\u0000-\u001f]/g, '_').trim().slice(0, 200) || 'document.pdf';
      return { file: await storedFiles.create(req.user!.id, /\.pdf$/i.test(name) ? name : `${name}.pdf`, 'application/pdf', req.body, req.folder) };
    });

    r.post('/api/import/docx', async (req, reply) => {
      const result = await convertDocx(req, reply);
      if (!result) return reply;
      return result;
    });
  });

  // --- Markdown documents --------------------------------------------------------
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);

    r.get('/api/markdown', async (req) => ({ docs: sheets.list(req.user!.id, 'markdown') }));

    // Create: empty, or from text (an uploaded .md file, read by the browser).
    r.post('/api/markdown', async (req, reply) => {
      const body = (req.body ?? {}) as { title?: unknown; text?: unknown };
      const title = cleanTitle(body.title) ?? 'Untitled Markdown';
      const text = body.text === undefined ? '' : body.text;
      if (typeof text !== 'string') return reply.code(400).send({ error: 'Text must be a string' });
      if (text.length > MAX_MARKDOWN_CHARS) return reply.code(400).send({ error: 'This file is too large to import (5 MB maximum).' });
      return { doc: await sheets.createMarkdown(req.user!.id, title, newMarkdownDoc(text), req.folder) };
    });

    r.get('/api/markdown/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const res = await sheets.loadMarkdown(req.user!.id, id);
      if (!res) return reply.code(404).send({ error: 'Document not found' });
      return { meta: res.meta, doc: res.doc };
    });

    r.put('/api/markdown/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as { doc?: unknown; rev?: unknown } | undefined;
      const doc = body?.doc;
      const problem = validateMarkdownDoc(doc);
      if (problem) return reply.code(400).send({ error: problem });
      const stale = staleRev(req.user!.id, id, 'markdown', body?.rev);
      if (stale) return reply.code(409).send({ error: 'The document was changed elsewhere since you loaded it.', meta: stale });
      const meta = await sheets.saveMarkdown(req.user!.id, id, doc as MarkdownDoc);
      if (!meta) return reply.code(404).send({ error: 'Document not found' });
      return { meta };
    });

    r.patch('/api/markdown/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const title = cleanTitle((req.body as { title?: unknown } | undefined)?.title);
      if (!title) return reply.code(400).send({ error: 'Title is required' });
      const meta = sheets.rename(req.user!.id, id, title, 'markdown');
      if (!meta) return reply.code(404).send({ error: 'Document not found' });
      return { meta };
    });

    r.delete('/api/markdown/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!(await sheets.delete(req.user!.id, id, 'markdown'))) return reply.code(404).send({ error: 'Document not found' });
      return { ok: true };
    });
  });

  // --- Slide decks ---------------------------------------------------------------
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);

    r.get('/api/decks', async (req) => ({ decks: sheets.list(req.user!.id, 'deck') }));

    r.post('/api/decks', async (req, reply) => {
      const body = (req.body ?? {}) as { title?: unknown; deck?: unknown };
      const title = cleanTitle(body.title) ?? 'Untitled presentation';
      const deck = body.deck === undefined ? newDeck() : body.deck;
      const problem = validateDeck(deck);
      if (problem) return reply.code(400).send({ error: problem });
      return { deck: await sheets.createDeck(req.user!.id, title, deck as Deck, req.folder) };
    });

    // The user's copy of the Getting started guide, made the first time they ask for it.
    r.post('/api/getting-started', async (req) => ({ deck: await openGettingStarted(sheets, images, req.user!.id) }));

    r.get('/api/decks/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const res = await sheets.loadDeck(req.user!.id, id);
        if (!res) return reply.code(404).send({ error: 'Presentation not found' });
        return { meta: res.meta, deck: res.deck, ...(res.notKept ? { notKept: res.notKept } : {}) };
      } catch (e) {
        // A PowerPoint or Word file from a mounted folder that cannot be opened.
        if (e instanceof ImportError) return reply.code(400).send({ error: e.message });
        throw e;
      }
    });

    // Keep a presentation stored as an Office file (desktop app) in the app's own format, which holds everything.
    r.post('/api/decks/:id/convert', async (req, reply) => {
      const { id } = req.params as { id: string };
      const meta = await sheets.convertToOwnFormat(req.user!.id, id, 'deck');
      if (!meta) return reply.code(404).send({ error: 'Presentation not found' });
      return { meta };
    });

    r.put('/api/decks/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as { deck?: unknown; rev?: unknown } | undefined;
      const deck = body?.deck;
      const problem = validateDeck(deck);
      if (problem) return reply.code(400).send({ error: problem });
      const stale = staleRev(req.user!.id, id, 'deck', body?.rev);
      if (stale) return reply.code(409).send({ error: 'The presentation was changed elsewhere since you loaded it.', meta: stale });
      const meta = await sheets.saveDeck(req.user!.id, id, deck as Deck);
      if (!meta) return reply.code(404).send({ error: 'Presentation not found' });
      return { meta };
    });

    r.patch('/api/decks/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const title = cleanTitle((req.body as { title?: unknown } | undefined)?.title);
      if (!title) return reply.code(400).send({ error: 'Title is required' });
      const meta = sheets.rename(req.user!.id, id, title, 'deck');
      if (!meta) return reply.code(404).send({ error: 'Presentation not found' });
      return { meta };
    });

    r.delete('/api/decks/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!(await sheets.delete(req.user!.id, id, 'deck'))) return reply.code(404).send({ error: 'Presentation not found' });
      return { ok: true };
    });

    /** Convert an uploaded .pptx body; sends a 400 and returns null on failure. Pictures are stored for the user. */
    const convertPptx = async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        reply.code(400).send({ error: 'Upload a PowerPoint file (.pptx) as the request body.' });
        return null;
      }
      try {
        return await importPptx(body, (type, data) => images.create(req.user!.id, type, data));
      } catch (e) {
        if (!(e instanceof ImportError)) req.log.warn({ err: e }, 'pptx import failed');
        reply.code(400).send({ error: e instanceof ImportError ? e.message : 'This file could not be imported. Make sure it is a valid PowerPoint presentation (.pptx).' });
        return null;
      }
    };

    // Import as a brand-new presentation.
    r.post('/api/decks/import', async (req, reply) => {
      const result = await convertPptx(req, reply);
      if (!result) return reply;
      const title = cleanTitle((req.query as { title?: unknown }).title) ?? 'Imported presentation';
      const deck = await sheets.createDeck(req.user!.id, title, result.deck, req.folder);
      return { deck, warnings: result.warnings };
    });

    // Convert only (nothing is stored but the pictures); the client adds the slides to an open presentation.
    r.post('/api/import/pptx', async (req, reply) => {
      const result = await convertPptx(req, reply);
      if (!result) return reply;
      return result;
    });
  });

  // A file, or the part of it a Range header asks for: "a-b", "a-" (to the end) or "-n" (the last n bytes).
  const sendRange = (req: FastifyRequest, reply: FastifyReply, file: string, size: number) => {
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (!range || (!range[1] && !range[2])) return reply.header('Content-Length', size).send(createReadStream(file));
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) return reply.code(416).header('Content-Range', `bytes */${size}`).send();
    return reply
      .code(206)
      .header('Content-Range', `bytes ${start}-${end}/${size}`)
      .header('Content-Length', end - start + 1)
      .send(createReadStream(file, { start, end }));
  };

  // --- Public links: a presentation or video anyone with the address can view (server/publicLinks.ts) -------
  // Files stored on the server only: a file in the desktop app's folder is on the person's own computer.
  if (!opts.local) {
    const links = new PublicLinks(db);
    const sharable = (ownerId: string, kind: SharedKind, id: string) => {
      if (kind === 'deck') return !!sheets.get(ownerId, id, 'deck');
      const f = storedFiles.get(ownerId, id);
      return !!f && isSharableVideo(f.meta.type);
    };
    const linkAddress = (req: FastifyRequest, token: string | null) => ({ url: token ? `${originOf(req)}/p/${token}` : null });

    app.register(async (r) => {
      r.addHook('preHandler', requireUser);
      // The owner's side: whether a file has a link, making one and stopping it.
      r.addHook('preHandler', async (req, reply) => {
        const { kind, id } = req.params as { kind: SharedKind; id: string };
        if ((kind !== 'deck' && kind !== 'file') || !sharable(req.user!.id, kind, id)) return reply.code(404).send({ error: 'This file cannot be shared.' });
      });
      r.get('/api/sharing/:kind/:id', async (req) => {
        const { kind, id } = req.params as { kind: SharedKind; id: string };
        return linkAddress(req, links.tokenOf(req.user!.id, kind, id));
      });
      r.put('/api/sharing/:kind/:id', async (req) => {
        const { kind, id } = req.params as { kind: SharedKind; id: string };
        return linkAddress(req, links.create(req.user!.id, kind, id));
      });
      r.delete('/api/sharing/:kind/:id', async (req) => {
        const { kind, id } = req.params as { kind: SharedKind; id: string };
        links.remove(req.user!.id, kind, id);
        return linkAddress(req, null);
      });
    });

    // What a shared deck shows, kept until the deck changes: each picture and each seek of a video asks.
    const shownByDeck = new Map<string, { rev: string; images: Set<string>; files: Set<string> }>();
    const shownBy = async (link: PublicLink) => {
      const rev = sheets.get(link.ownerId, link.fileId, 'deck')?.updatedAt;
      if (!rev) return null;
      const known = shownByDeck.get(link.fileId);
      if (known?.rev === rev) return known;
      const res = await sheets.loadDeck(link.ownerId, link.fileId);
      if (!res) return null;
      const { images: shownImages, files } = publicDeck(res.deck, link.token);
      if (shownByDeck.size >= 500) shownByDeck.clear();
      const shown = { rev: res.meta.updatedAt, images: shownImages, files };
      shownByDeck.set(link.fileId, shown);
      return shown;
    };
    // A guest's answers: the address is not passed on or indexed, and a file opened by itself runs nothing.
    const forGuest = (reply: FastifyReply) => reply.header('Referrer-Policy', 'no-referrer').header('X-Robots-Tag', 'noindex').header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', 'sandbox');
    // Browsers keep a file a short while, so a link that is stopped soon stops working everywhere.
    const GUEST_CACHE = 'private, max-age=300';
    const sendGuestFile = (req: FastifyRequest, reply: FastifyReply, f: { meta: StoredFile; file: string }) =>
      sendRange(req, reply.header('Content-Type', f.meta.type === 'video/quicktime' ? 'video/mp4' : f.meta.type).header('Content-Disposition', 'inline').header('Cache-Control', GUEST_CACHE).header('Accept-Ranges', 'bytes'), f.file, statSync(f.file).size);
    const noLink = (reply: FastifyReply) => reply.code(404).send({ error: 'This link does not work. It may have been turned off, or the file was deleted.' });

    app.get('/api/public/:token', async (req, reply) => {
      forGuest(reply).header('Cache-Control', 'no-store');
      const link = links.resolve((req.params as { token: string }).token);
      if (!link) return noLink(reply);
      if (link.kind === 'deck') {
        const res = await sheets.loadDeck(link.ownerId, link.fileId);
        if (!res) return noLink(reply);
        return { kind: 'deck', title: res.meta.title, deck: publicDeck(res.deck, link.token).deck };
      }
      const f = storedFiles.get(link.ownerId, link.fileId);
      if (!f || !isSharableVideo(f.meta.type)) return noLink(reply);
      return { kind: 'video', title: f.meta.filename, url: `/api/public/${link.token}/video` };
    });
    app.get('/api/public/:token/video', async (req, reply) => {
      forGuest(reply);
      const link = links.resolve((req.params as { token: string }).token);
      const f = link?.kind === 'file' ? storedFiles.get(link.ownerId, link.fileId) : null;
      if (!f || !isSharableVideo(f.meta.type)) return noLink(reply);
      return sendGuestFile(req, reply, f);
    });
    app.get('/api/public/:token/images/:id', async (req, reply) => {
      forGuest(reply);
      const { token, id } = req.params as { token: string; id: string };
      const link = links.resolve(token);
      const shown = link?.kind === 'deck' ? await shownBy(link) : null;
      const img = link && shown?.images.has(id) ? images.get(link.ownerId, id) : null;
      if (!img) return noLink(reply);
      reply.header('Content-Type', img.type).header('Cache-Control', GUEST_CACHE);
      return reply.send(createReadStream(img.file));
    });
    app.get('/api/public/:token/files/:id', async (req, reply) => {
      forGuest(reply);
      const { token, id } = req.params as { token: string; id: string };
      const link = links.resolve(token);
      const shown = link?.kind === 'deck' ? await shownBy(link) : null;
      const f = link && shown?.files.has(id) ? storedFiles.get(link.ownerId, id) : null;
      if (!f || !PREVIEW_FILE_TYPES.includes(f.meta.type)) return noLink(reply);
      return sendGuestFile(req, reply, f);
    });
  }

  // --- Cell images -------------------------------------------------------------
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);

    // Upload an image (the raw file as the body, with its image/* content type); returns its URL for a cell.
    r.post('/api/images', async (req, reply) => {
      const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      const body = req.body;
      if (!CELL_IMAGE_TYPES.includes(type) || !Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send({ error: 'Upload a PNG, JPEG, GIF or WebP image as the request body.' });
      }
      return { url: await images.create(req.user!.id, type, body) };
    });

    // Keep a copy of a picture that is on the web: the assistant puts pictures it found on slides, and one left
    // at its web address would break when the site moves it (and cannot be drawn into a render or a PDF). It is
    // stored like an upload, with the file it is used in, and is not a file in the user's library.
    r.post('/api/images/fetch', async (req, reply) => {
      const { url } = (req.body ?? {}) as { url?: unknown };
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return reply.code(400).send({ error: 'Give the http(s) address of a picture.' });
      try {
        const { bytes } = await fetchPublicFile(url, { limit: MAX_CELL_IMAGE_BYTES, timeoutMs: 20_000 });
        const type = sniffImageType(bytes);
        if (!type) return reply.code(400).send({ error: 'That address does not hold a PNG, JPEG, GIF or WebP picture.' });
        return { url: await images.create(req.user!.id, type, bytes) };
      } catch (e) {
        if (e instanceof WebFetchError) return reply.code(400).send({ error: e.message });
        throw e;
      }
    });

    r.get('/api/images/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const img = /^[0-9a-f-]{36}$/.test(id) ? images.get(req.user!.id, id) : null;
      if (!img) return reply.code(404).send({ error: 'Image not found' });
      // Images never change once uploaded.
      reply.header('Content-Type', img.type).header('Cache-Control', 'private, max-age=31536000, immutable').header('X-Content-Type-Options', 'nosniff');
      return reply.send(createReadStream(img.file));
    });

    // --- Export: one file in a readable format, or everything as a zip (server/export.ts) ---------
    const attachment = (reply: FastifyReply, name: string, type: string) =>
      reply
        .header('Content-Type', type)
        .header('Content-Disposition', `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'")}"; filename*=UTF-8''${encodeURIComponent(name)}`)
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff');

    // A PDF of a document, presentation, Markdown file or stored web page (server/pdf.ts): the file's page in the
    // app, loaded by a headless browser with a print ticket, or the web page's own HTML.
    const sendPdf = async (req: FastifyRequest, reply: FastifyReply, id: string) => {
      if (!pdfMaker) return reply.code(400).send({ error: 'PDFs cannot be made here.' });
      const { locale } = req.query as { locale?: string };
      const paper = paperFor(locale ?? String(req.headers['accept-language'] ?? '').split(',')[0]);
      try {
        // In development the app's pages are where the request came from (Vite), not on this server.
        const made = await pdfMaker.make(req.user!.id, id, { paper, origin: opts.staticDir ? undefined : `${req.protocol}://${req.headers.host}` });
        if (!made) return reply.code(404).send({ error: 'File not found' });
        if (made.revision) reply.header('X-Revision', made.revision);
        return attachment(reply, made.name, 'application/pdf').send(made.pdf);
      } catch (e) {
        if (e instanceof PrintError) return reply.code(e instanceof NotPrintableError ? 400 : 500).send({ error: e.message });
        throw e;
      }
    };

    r.get('/api/files/:id/export', async (req, reply) => {
      const { id } = req.params as { id: string };
      const { format, tab } = req.query as { format?: string; tab?: string };
      if (format === 'pdf') return sendPdf(req, reply, id);
      const loaded = await loadFile(sheets, req.user!.id, id);
      if (!loaded) return reply.code(404).send({ error: 'File not found' });
      const fmt = (format ?? (loaded.meta.format === 'csv' ? 'csv' : EXPORT_FORMATS[loaded.meta.kind][0])) as ExportFormat;
      try {
        const out = await exportFile(loaded.meta, loaded.data, fmt, imageSource(images, req.user!.id), tab);
        return attachment(reply, out.name, out.type).send(out.body);
      } catch (e) {
        if (e instanceof ExportError) return reply.code(400).send({ error: e.message });
        throw e;
      }
    });

    // --- Stored files (generated PDFs, uploads; server/files.ts) ----------------------------------
    // Upload: the raw bytes as the body with their content type; the name in the x-filename header (URL-encoded).
    r.post('/api/files', async (req, reply) => {
      const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(400).send({ error: 'Send the file as the request body.' });
      let name = '';
      try {
        name = decodeURIComponent(String(req.headers['x-filename'] ?? ''));
      } catch {
        // Malformed name: fall back to the default below.
      }
      name = name.replace(/[\\/\u0000-\u001f]/g, '_').trim().slice(0, 200) || 'file';
      // A video or a web page is stored under the type of its extension, whatever the browser called it.
      // Plain bytes of any other file are stored as what their name says, when the app knows it.
      return { file: await storedFiles.create(req.user!.id, name, videoTypeOf(name) ?? (isHtmlName(name) ? HTML_TYPE : type === 'application/octet-stream' ? (fileTypeOf(name) ?? type) : type), body, req.folder) };
    });

    r.get('/api/files', async (req) => ({ files: storedFiles.list(req.user!.id) }));

    const storedFile = (req: { user?: { id: string } | null; params: unknown }) => {
      const { id } = req.params as { id: string };
      return isFileId(id) ? storedFiles.get(req.user!.id, id) : null;
    };

    // The stored file called `name` in the request's folder, by a redirect to its own address: how a Markdown
    // preview shows a picture named by a path relative to the document (`images/chart.png`).
    r.get('/api/files/at', async (req, reply) => {
      const { name } = req.query as { name?: unknown };
      const f = typeof name === 'string' && name && !/[\\/]/.test(name) ? storedFiles.listIn(req.user!.id, req.folder ?? '').find((m) => m.filename === name) : undefined;
      return f ? reply.header('Cache-Control', 'no-cache').redirect(`/api/files/${f.id}`) : reply.code(404).send({ error: 'File not found' });
    });

    r.get('/api/files/:id/meta', async (req, reply) => {
      const f = storedFile(req);
      return f ? { file: f.meta } : reply.code(404).send({ error: 'File not found' });
    });

    // Inline: only PDFs, images and videos are served with their own type; anything else is a plain download.
    // A Range request gets just that part of the file, which is what lets a video player seek.
    r.get('/api/files/:id', async (req, reply) => {
      const f = storedFile(req);
      if (!f) return reply.code(404).send({ error: 'File not found' });
      // Any other file is a download; a part of one is what the text editor's Tail reads as a log grows.
      if (!PREVIEW_FILE_TYPES.includes(f.meta.type)) return sendRange(req, attachment(reply, f.meta.filename, 'application/octet-stream').header('Accept-Ranges', 'bytes'), f.file, statSync(f.file).size);
      // A stored file never changes, except a picture the image editor saved over (asked for again each time,
      // and sent only if it changed); one in a mounted folder can.
      // Browsers that play QuickTime files (H.264) only do so when they are served as MP4.
      const type = f.meta.type === 'video/quicktime' ? 'video/mp4' : f.meta.type;
      const rewritable = EDITABLE_IMAGE_TYPES.includes(f.meta.type);
      reply.header('Content-Type', type).header('Content-Disposition', 'inline').header('Cache-Control', opts.local ? 'no-cache' : rewritable ? 'private, no-cache' : 'private, max-age=31536000, immutable').header('X-Content-Type-Options', 'nosniff').header('Accept-Ranges', 'bytes');
      const { size, mtimeMs } = statSync(f.file);
      if (rewritable) {
        const etag = `"${Math.round(mtimeMs).toString(36)}-${size.toString(36)}"`;
        reply.header('ETag', etag);
        if (req.headers['if-none-match'] === etag) return reply.code(304).send();
      }
      return sendRange(req, reply, f.file, size);
    });

    r.get('/api/files/:id/download', async (req, reply) => {
      const f = storedFile(req);
      if (!f) return reply.code(404).send({ error: 'File not found' });
      return attachment(reply, f.meta.filename, f.meta.type || 'application/octet-stream').send(createReadStream(f.file));
    });

    // A PDF's text as a new Markdown file beside it (server/pdfMarkdown.ts); the PDF stays as it is.
    r.post('/api/files/:id/markdown', async (req, reply) => {
      try {
        const made = await pdfToMarkdownFile({ sheets, files: storedFiles }, req.user!.id, (req.params as { id: string }).id);
        if (!made) return reply.code(404).send({ error: 'File not found' });
        return { doc: made.sheet, pages: made.pageCount, ocrPages: made.ocrPages, warnings: made.warnings };
      } catch (e) {
        if (e instanceof PdfError) return reply.code(400).send({ error: e.message });
        throw e;
      }
    });

    // --- A zip file's contents (server/zipView.ts): listed, and each file in it opened read-only ------
    const storedZip = async (req: FastifyRequest, reply: FastifyReply) => {
      const f = storedFile(req);
      if (!f || !isZipName(f.meta.filename)) return void reply.code(404).send({ error: 'Zip file not found' });
      return openZip(f.file);
    };
    const zipFailed = (req: FastifyRequest, reply: FastifyReply, e: unknown) => {
      if (e instanceof ZipError || e instanceof ImportError) return reply.code(400).send({ error: e.message });
      req.log.warn({ err: e }, 'zip view failed');
      return reply.code(400).send({ error: 'This file could not be read from the zip.' });
    };
    const entryPath = (req: FastifyRequest) => String((req.query as { path?: unknown }).path ?? '');

    r.get('/api/files/:id/zip', async (req, reply) => {
      try {
        const zip = await storedZip(req, reply);
        return zip && { entries: zipEntries(zip) };
      } catch (e) {
        return zipFailed(req, reply, e);
      }
    });

    // One file in the zip (?path=), served as a stored file is: a PDF, picture or video inline, anything else
    // as plain bytes (a web page is shown from its text in a sandboxed frame). &download=1 saves it.
    r.get('/api/files/:id/zip/entry', async (req, reply) => {
      try {
        const zip = await storedZip(req, reply);
        if (!zip) return;
        const path = entryPath(req);
        const bytes = await zipEntryBytes(zip, path);
        if (!bytes) return reply.code(404).send({ error: 'That file is not in the zip.' });
        const name = path.split('/').pop() || 'file';
        const type = videoTypeOf(name) ?? fileTypeOf(name) ?? 'application/octet-stream';
        if ((req.query as { download?: string }).download === '1') return attachment(reply, name, type).send(bytes);
        if (!PREVIEW_FILE_TYPES.includes(type)) return attachment(reply, name, 'application/octet-stream').send(bytes);
        return reply
          .header('Content-Type', type === 'video/quicktime' ? 'video/mp4' : type)
          .header('Content-Disposition', 'inline')
          .header('Cache-Control', 'private, no-cache')
          .header('X-Content-Type-Options', 'nosniff')
          .send(bytes);
      } catch (e) {
        return zipFailed(req, reply, e);
      }
    });

    // A Word, Excel or PowerPoint file in the zip (?path=), converted to be shown read-only.
    r.get('/api/files/:id/zip/view', async (req, reply) => {
      try {
        const zip = await storedZip(req, reply);
        if (!zip) return;
        const path = entryPath(req);
        const bytes = await zipEntryBytes(zip, path, MAX_OFFICE_ENTRY_BYTES);
        if (!bytes) return reply.code(404).send({ error: 'That file is not in the zip.' });
        return { view: await zipOfficeView(path, bytes) };
      } catch (e) {
        return zipFailed(req, reply, e);
      }
    });

    // Rewrite a text file (the assistant's edit_file), a picture (the image editor) or a PDF (signed in the PDF
    // signer), keeping the version before for one revert. Videos and animated pictures are never rewritten.
    r.put('/api/files/:id', async (req, reply) => {
      const f = storedFile(req);
      if (!f) return reply.code(404).send({ error: 'File not found' });
      if (f.meta.type === 'application/pdf') {
        const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (type !== 'application/pdf' || !Buffer.isBuffer(req.body) || !req.body.subarray(0, 1024).includes('%PDF-')) return reply.code(400).send({ error: 'Send the PDF as the request body, as application/pdf.' });
        return { file: await storedFiles.update(req.user!.id, f.meta.id, req.body) };
      }
      if (EDITABLE_IMAGE_TYPES.includes(f.meta.type)) {
        // A picture stays the type it is: its name and everything that shows it depend on that.
        const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (type !== f.meta.type || !Buffer.isBuffer(req.body) || !isImageOfType(req.body, type)) return reply.code(400).send({ error: `Send the edited picture as the request body, as ${f.meta.type}.` });
        return { file: await storedFiles.update(req.user!.id, f.meta.id, req.body) };
      }
      if (!isTextFileType(f.meta.type) || PREVIEW_FILE_TYPES.includes(f.meta.type)) return reply.code(400).send({ error: 'Only text files can be edited.' });
      if (!Buffer.isBuffer(req.body) || req.body.includes(0)) return reply.code(400).send({ error: 'Send the new text as the request body.' });
      return { file: await storedFiles.update(req.user!.id, f.meta.id, req.body) };
    });

    // Put back the version before the last rewrite (the two swap, so reverting twice redoes it).
    r.post('/api/files/:id/revert', async (req, reply) => {
      const f = storedFile(req);
      const file = f && (await storedFiles.revert(req.user!.id, f.meta.id));
      return file ? { file } : reply.code(404).send({ error: 'There is no earlier version of this file.' });
    });

    // Edit a picture with an image-generation model (the assistant's edit_image). The result is a new file
    // next to the original, which stays as it is.
    r.post('/api/files/:id/edit-image', async (req, reply) => {
      const f = storedFile(req);
      if (!f) return reply.code(404).send({ error: 'File not found' });
      const prompt = String((req.body as { prompt?: unknown } | null)?.prompt ?? '').trim();
      if (!prompt || prompt.length > MAX_EDIT_PROMPT_CHARS) return reply.code(400).send({ error: 'Say what to change in the picture.' });
      if (!EDITABLE_IMAGE_TYPES.includes(f.meta.type)) return reply.code(400).send({ error: 'Only PNG, JPEG and WebP pictures can be edited.' });
      if (f.meta.size > MAX_EDIT_IMAGE_BYTES) return reply.code(400).send({ error: 'This picture is too large to edit (20 MB maximum).' });
      const apiKey = assistantSettings.openaiKey(req.user!.id) ?? process.env.OPENAI_API_KEY;
      if (!apiKey) return reply.code(400).send({ error: 'Image editing needs an OpenAI API key. The user can add theirs on the Settings page; nothing was changed.' });
      try {
        checkImageEditRate(req.user!.id);
        const edited = await (opts.imageEditor ?? openaiImageEditor)({ apiKey, image: await readFile(f.file), filename: f.meta.filename, type: f.meta.type, prompt });
        return { file: await storedFiles.create(req.user!.id, editedImageName(f.meta.filename), 'image/png', edited, f.meta.folder ?? '') };
      } catch (e) {
        if (e instanceof ImageEditError) return reply.code(400).send({ error: e.message });
        throw e;
      }
    });

    // Rename: the extension stays as it is.
    r.patch('/api/files/:id', async (req, reply) => {
      const name = (req.body as { name?: unknown } | null)?.name;
      if (typeof name !== 'string' || !name.trim()) return reply.code(400).send({ error: 'Give the file a name.' });
      const f = storedFile(req);
      const file = f && storedFiles.rename(req.user!.id, f.meta.id, name);
      return file ? { file } : reply.code(404).send({ error: 'File not found' });
    });

    r.delete('/api/files/:id', async (req, reply) => {
      const f = storedFile(req);
      if (!f || !(await storedFiles.delete(req.user!.id, f.meta.id))) return reply.code(404).send({ error: 'File not found' });
      return { ok: true };
    });

    // --- The library, one folder at a time (shared/folders.ts) ------------------------------------
    // What is in a folder: its folders, then documents of every kind and stored files.
    r.get('/api/library', async (req, reply) => {
      const id = req.user!.id;
      const problem = folders.problem?.(id, req.folder);
      if (problem) return reply.code(403).send({ error: problem });
      return {
        folder: req.folder,
        folders: folders.children(id, req.folder).map((path) => ({ name: folderName(path), path })),
        docs: sheets.listIn(id, req.folder),
        files: storedFiles.listIn(id, req.folder),
      };
    });

    // A small picture of a document for the thumbnail view (shared/preview.ts).
    r.get('/api/library/preview/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      let loaded;
      try {
        loaded = isFileId(id) ? await loadFile(sheets, req.user!.id, id) : null;
      } catch {
        // A file that cannot be read (a CSV too large to open, say) has no picture.
        return { preview: { kind: 'empty' } satisfies FilePreview };
      }
      if (!loaded) return reply.code(404).send({ error: 'File not found' });
      const d = loaded.data;
      const preview: FilePreview = d.kind === 'doc' ? docPreview(d.doc) : d.kind === 'markdown' ? markdownPreview(d.markdown) : d.kind === 'deck' ? deckPreview(d.deck) : sheetPreview(d.workbook);
      return { preview };
    });

    // Find by name through the whole library, every folder (the desktop app: the whole mounted folder).
    r.get('/api/library/search', async (req, reply) => {
      const q = String((req.query as { q?: unknown }).q ?? '').trim().slice(0, 200);
      if (!q) return reply.code(400).send({ error: 'Say what to look for.' });
      const id = req.user!.id;
      const [paths, docs, files] = [await folders.search(id, q), await sheets.search(id, q), await storedFiles.search(id, q)];
      return {
        folders: paths.map((path) => ({ name: folderName(path), path })),
        docs,
        files,
        // Set when a very large folder could not be searched to the end.
        truncated: folder ? (await folder.find(q)).truncated : false,
      };
    });

    // The desktop app: files by name (or the end of their path) anywhere in the home folder but the open folder,
    // which /api/library/search covers; named by their absolute paths, as Recents' are, and opened as they are.
    r.get('/api/local/search', async (req, reply) => {
      const q = String((req.query as { q?: unknown }).q ?? '').trim().slice(0, 200);
      if (!folder || !homeFolder) return reply.code(400).send({ error: 'There is no open folder.' });
      if (!q) return reply.code(400).send({ error: 'Say what to look for.' });
      const found = await homeFolder.find(q);
      const files = found.files
        .map((f) => homeFolder.abs(f.rel))
        .filter((file) => {
          const rel = path.relative(folder.root, file);
          return rel.startsWith('..') || path.isAbsolute(rel);
        })
        .slice(0, HOME_SEARCH_LIMIT)
        .map((file) => ({ path: file, name: path.basename(file), where: whereOf(file, homeFolder.root), kind: listedKind(file) }));
      return { files, truncated: found.truncated || found.files.length > HOME_SEARCH_LIMIT };
    });

    // --- Recents: the files the user last opened in the app, then (desktop app) on this machine ------
    // A page reports each file it shows. On the web it is named by its kind and id, in the desktop app by its path.
    r.post('/api/recents', async (req, reply) => {
      const { kind, id } = (req.body ?? {}) as { kind?: unknown; id?: unknown };
      const shown = typeof id === 'string' && (['doc', 'deck', 'sheet', 'markdown', 'file'] as const).find((k) => k === kind);
      if (!shown) return reply.code(400).send({ error: 'Give the kind and id of the file opened.' });
      const user = req.user!.id;
      if (folder) {
        const file = shown === 'file' ? (storedFiles as LocalFileStore).get(user, id as string)?.file : (sheets as LocalSheetStore).fileOf(user, id as string);
        if (!file) return reply.code(404).send({ error: 'File not found' });
        recentOpens.record(user, file);
      } else {
        if (!(shown === 'file' ? storedFiles.get(user, id as string) : sheets.get(user, id as string, shown))) return reply.code(404).send({ error: 'File not found' });
        recentOpens.record(user, `${shown}:${id}`);
      }
      return { ok: true };
    });

    // The files opened in the app. `system` says there is also the slower list of /api/recents/system to ask for,
    // and `cached` is its last answer, to show until the new one comes.
    r.get('/api/recents', async (req) => {
      const user = req.user!.id;
      if (folder) {
        const cached = recents ? recentOpens.systemCached() : null;
        return { files: (await openedFiles(recentOpens.list(user), LISTED_EXTS)).map((f) => ({ ...f, kind: listedKind(f.path) })), system: !!recents, ...(cached ? { cached: { files: cached.files.map((f) => ({ ...f, kind: listedKind(f.path) })), blocked: cached.blocked } } : {}) };
      }
      // On the web a file that was deleted is gone for good: it is forgotten.
      const files = [];
      for (const { ref, openedAt } of recentOpens.list(user)) {
        const [kind, id] = [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)];
        if (kind === 'file') {
          const f = storedFiles.get(user, id);
          if (f) files.push({ id, kind, name: f.meta.filename, folder: f.meta.folder ?? '', ...(f.meta.text ? { text: true } : {}), lastUsed: openedAt, size: f.meta.size, app: true });
          else recentOpens.forget(user, ref);
        } else {
          const d = sheets.get(user, id, kind as DocKind);
          if (d) files.push({ id, kind, name: d.title, folder: d.folder ?? '', ...(d.format ? { format: d.format } : {}), lastUsed: openedAt, app: true });
          else recentOpens.forget(user, ref);
        }
      }
      return { files, system: false };
    });

    // The desktop app's: the files last opened on this machine in any app, from Spotlight, which can take seconds.
    r.get('/api/recents/system', async (_req, reply) => {
      if (!folder || !recents) return reply.code(404).send({ error: 'There is no list of recent files here.' });
      const found = await recents();
      recentOpens.cacheSystem(found);
      return { files: found.files.map((f) => ({ ...f, kind: listedKind(f.path) })), blocked: found.blocked };
    });

    // --- Favorites (favorites.ts): the folders and files the user keeps at hand, a tab beside Recents -------------
    // A request names a file by its kind and id, or a folder by `folder` (its path in the library, or in the open
    // folder); in the desktop app any file or folder by its absolute `path`, as the list names those outside the open
    // folder. Null when there is no such file or folder; more than one name when a path that is gone may have been either.
    const favoriteRefs = (user: string, b: Record<string, unknown>): string[] | null => {
      if (folder) {
        if (typeof b.path === 'string' && path.isAbsolute(b.path)) {
          const p = path.resolve(b.path);
          let dir: boolean | null = null;
          try {
            dir = statSync(p).isDirectory();
          } catch {
            // Gone: it can still be taken off the list.
          }
          return dir === null ? [p, FOLDER_REF + p] : [dir ? FOLDER_REF + p : p];
        }
        if (typeof b.folder === 'string') {
          const rel = cleanFolderPath(b.folder);
          return rel === null || !folder.isDir(rel) ? null : [FOLDER_REF + folder.abs(rel)];
        }
      } else if (typeof b.folder === 'string') {
        const p = cleanFolderPath(b.folder);
        return p && folders.exists(user, p) ? [FOLDER_REF + p] : null;
      }
      const kind = (['doc', 'deck', 'sheet', 'markdown', 'file'] as const).find((k) => k === b.kind);
      if (!kind || typeof b.id !== 'string') return null;
      if (folder) {
        const file = kind === 'file' ? (storedFiles as LocalFileStore).get(user, b.id)?.file : (sheets as LocalSheetStore).fileOf(user, b.id);
        return file ? [file] : null;
      }
      return (kind === 'file' ? storedFiles.get(user, b.id) : sheets.get(user, b.id, kind)) ? [`${kind}:${b.id}`] : null;
    };

    r.post('/api/favorites', async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const refs = favoriteRefs(req.user!.id, body);
      if (!refs) return reply.code(404).send({ error: 'There is no such file or folder.' });
      if (body.on === false) for (const ref of refs) favorites.set(req.user!.id, ref, false);
      else favorites.set(req.user!.id, refs[0], true);
      return { ok: true };
    });

    // Whether one file or folder (named as for POST) is a favorite: an editor's star.
    r.get('/api/favorites/one', async (req, reply) => {
      const refs = favoriteRefs(req.user!.id, req.query as Record<string, unknown>);
      if (!refs) return reply.code(404).send({ error: 'There is no such file or folder.' });
      return { on: refs.some((ref) => favorites.has(req.user!.id, ref)) };
    });

    // The favorites, the newest first: files as Recents lists them, folders with where they are, and `keys`, the
    // ones in the library (the desktop app: the open folder) as its list names them (`doc:<id>`, `folder:<path>`).
    r.get('/api/favorites', async (req) => {
      const user = req.user!.id;
      const files = [];
      const dirs: { name: string; path: string; where: string }[] = [];
      const keys: string[] = [];
      for (const { ref, addedAt } of favorites.list(user)) {
        const isFolder = ref.startsWith(FOLDER_REF);
        const at = isFolder ? ref.slice(FOLDER_REF.length) : ref;
        if (folder) {
          let st;
          try {
            st = statSync(at);
          } catch {
            continue; // Gone: kept, in case it comes back (a drive, say).
          }
          const rel = path.relative(folder.root, at);
          const inside = !rel.startsWith('..') && !path.isAbsolute(rel);
          const relPath = rel.split(path.sep).join('/');
          if (isFolder && st.isDirectory()) {
            dirs.push({ name: path.basename(at), path: at, where: whereOf(at, homedir()) });
            if (inside) keys.push(FOLDER_REF + relPath);
          } else if (!isFolder && st.isFile()) {
            const kind = listedKind(at);
            // A plain text file (a log, source code) opens as text, as a stored one does.
            const text = kind === 'file' && isTextFile(at, { type: 'application/octet-stream', size: st.size, created_at: st.mtime.toISOString() });
            files.push({ path: at, name: path.basename(at), where: whereOf(at, homedir()), kind, ...(text ? { text: true } : {}), lastUsed: addedAt, size: st.size });
            const id = inside ? (kind === 'file' ? (storedFiles as LocalFileStore).idOf(user, relPath) : (sheets as LocalSheetStore).idOf(user, relPath)) : null;
            if (id) keys.push(`${kind}:${id}`);
          }
          continue;
        }
        // On the web what was deleted is gone for good: it is forgotten.
        if (isFolder) {
          if (folders.exists(user, at)) dirs.push({ name: folderName(at), path: at, where: parentFolder(at) });
          else favorites.set(user, ref, false);
          continue;
        }
        const [kind, id] = [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)];
        if (kind === 'file') {
          const f = storedFiles.get(user, id);
          if (f) files.push({ id, kind, name: f.meta.filename, folder: f.meta.folder ?? '', ...(f.meta.text ? { text: true } : {}), lastUsed: addedAt, size: f.meta.size });
          else favorites.set(user, ref, false);
        } else {
          const d = sheets.get(user, id, kind as DocKind);
          if (d) files.push({ id, kind, name: d.title, folder: d.folder ?? '', ...(d.format ? { format: d.format } : {}), lastUsed: addedAt });
          else favorites.set(user, ref, false);
        }
      }
      if (!folder) keys.push(...favorites.list(user).map((f) => f.ref));
      return { files, folders: dirs, keys };
    });

    // Copying between the folder and the person's account on the web (webCopy.ts), with the Web tab's session.
    const web = opts.local?.web;
    if (web && folder && sheets instanceof LocalSheetStore && storedFiles instanceof LocalFileStore) {
      const copyStores = (req: FastifyRequest) => ({ userId: req.user!.id, sheets, files: storedFiles, images, folder });
      const copying = async <T>(reply: FastifyReply, work: () => Promise<T>) => {
        try {
          return await work();
        } catch (e) {
          // Not 401, which would read as this app's own sign-in.
          if (e instanceof WebCopyError) return reply.code(e.signedOut ? 409 : 400).send({ error: e.message, ...(e.signedOut ? { code: 'web-signed-out' } : {}) });
          throw e;
        }
      };
      r.get('/api/web/status', async () => webStatus(web));
      r.get('/api/web/folders', async (req, reply) => copying(reply, async () => ({ folders: await webFolders(web, String((req.query as { path?: string }).path ?? '')) })));
      r.post('/api/web/upload', async (req, reply) => {
        const { id, webFolder } = (req.body ?? {}) as { id?: unknown; webFolder?: unknown };
        if (typeof id !== 'string' || (webFolder !== undefined && typeof webFolder !== 'string')) return reply.code(400).send({ error: 'Give the file id and the web folder.' });
        return copying(reply, () => uploadToWeb(web, copyStores(req), id, webFolder ?? ''));
      });
      r.get('/api/web/preview', async (req, reply) => {
        const { kind, id } = req.query as { kind?: string; id?: string };
        if (!id || !LIBRARY_KINDS.includes(kind as LibraryKind)) return reply.code(400).send({ error: 'Give the kind and id of the web file.' });
        return copying(reply, () => webPreview(web, kind as LibraryKind, id));
      });
      // The folder it goes in is `folder` (checked to exist here, as for any request that names one).
      r.post('/api/web/download', async (req, reply) => {
        const { kind, id, title, format } = (req.body ?? {}) as { kind?: unknown; id?: unknown; title?: unknown; format?: unknown };
        if (typeof id !== 'string' || !LIBRARY_KINDS.includes(kind as LibraryKind) || !DOWNLOAD_FORMATS.includes(format as DownloadFormat)) return reply.code(400).send({ error: 'Give the kind, id and format of the web file.' });
        return copying(reply, () => downloadFromWeb(web, copyStores(req), { kind: kind as LibraryKind, id, title: typeof title === 'string' && title.trim() ? title.trim() : undefined }, req.folder, format as DownloadFormat));
      });
    }

    // Server-sent events, an empty `{}` each time something in the folder `folder` changes (a file added, removed,
    // renamed or written, by this app or another program), so the list showing it can load it again.
    r.get('/api/local/folder-changes', async (req, reply) => {
      if (!dirWatchers) return reply.code(404).send({ error: 'Not a folder.' });
      reply.hijack();
      const res = reply.raw;
      // Watching first, so a change made as soon as the stream is open is not missed.
      const unwatch = dirWatchers.watch(req.folder, () => res.write('data: {}\n\n'));
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      // Nothing is sent until something changes: the headers go now, so the stream counts as open.
      res.flushHeaders();
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      revisionStreams.add(res);
      res.on('close', () => {
        unwatch();
        clearInterval(ping);
        revisionStreams.delete(res);
      });
    });

    // The file the window shows ({kind, id}, or nothing): what the MCP tools act on when no id is given.
    r.post('/api/local/showing', async (req) => {
      const { kind, id, window } = (req.body ?? {}) as { kind?: unknown; id?: unknown; window?: unknown };
      const shown = typeof id === 'string' && (['doc', 'deck', 'sheet', 'markdown', 'file'] as const).find((k) => k === kind);
      try {
        localMcp?.setOpen(shown ? { kind: shown, id } : null);
      } catch {
        // Not a file of this folder (any more): nothing is open.
        localMcp?.setOpen(null);
      }
      if (typeof window === 'string') windowTools?.showing(window, shown ? (id as string) : null);
      return { ok: true };
    });

    // A window takes the agent's edit tools on the file it shows (windowTools.ts): the calls come as
    // server-sent events, and each answer is posted back.
    r.get('/api/local/tool-calls', async (req, reply) => {
      const window = (req.query as { window?: unknown }).window;
      if (!windowTools || typeof window !== 'string' || !window) return reply.code(404).send({ error: 'There are no agent tools here.' });
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(': connected\n\n');
      const disconnect = windowTools.connect(window, (call: WindowToolCall) => res.write(`data: ${JSON.stringify(call)}\n\n`));
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      revisionStreams.add(res);
      res.on('close', () => {
        disconnect();
        clearInterval(ping);
        revisionStreams.delete(res);
      });
    });

    r.post('/api/local/tool-calls/:id', async (req, reply) => {
      const body = (req.body ?? {}) as { content?: unknown; isError?: unknown; images?: unknown; unavailable?: unknown };
      let answer: WindowToolAnswer;
      if (body.unavailable === true) answer = { unavailable: true };
      else if (typeof body.content === 'string') {
        const images = Array.isArray(body.images)
          ? body.images.filter((i): i is { mediaType: string; data: string } => !!i && typeof (i as { mediaType?: unknown }).mediaType === 'string' && typeof (i as { data?: unknown }).data === 'string')
          : [];
        answer = { content: body.content, isError: body.isError === true, ...(images.length ? { images } : {}) };
      } else return reply.code(400).send({ error: 'Give the tool’s content, or unavailable.' });
      if (!windowTools?.answer((req.params as { id: string }).id, answer)) return reply.code(404).send({ error: 'No such tool call (it timed out, or was answered).' });
      return { ok: true };
    });

    // Open one of them. A file in the open folder is named by its path there; for any other, the app is
    // asked to open the file's own folder, and this server ends.
    r.post('/api/local/open', async (req, reply) => {
      const file = (req.body as { path?: unknown } | undefined)?.path;
      if (!folder || typeof file !== 'string' || !path.isAbsolute(file) || !LISTED_EXTS.has(path.extname(file).toLowerCase())) return reply.code(400).send({ error: 'This file cannot be opened here.' });
      let isFile = false;
      try {
        isFile = statSync(file).isFile();
      } catch {
        // Gone: answered below.
      }
      if (!isFile) return reply.code(404).send({ error: 'This file is no longer there.' });
      const rel = path.relative(folder.root, file);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return { file: rel.split(path.sep).join('/') };
      if (!opts.local?.openFile) return reply.code(400).send({ error: 'This file is outside the open folder. Open its folder to see it.' });
      opts.local.openFile(file);
      return { switching: true };
    });

    // Open a file or a folder the person names by its path: absolute, from the home folder (~/...), or
    // relative to the open folder. One in the open folder is shown here (its path there); for any other the
    // app is asked to open it, or the file's own folder, and this server ends.
    // With `tab`, one outside the open folder opens in a new tab instead (one inside, the page opens in a new tab).
    r.post('/api/local/open-path', async (req, reply) => {
      const given = (req.body as { path?: unknown } | undefined)?.path;
      const inTab = (req.body as { tab?: unknown } | undefined)?.tab === true;
      if (!folder || typeof given !== 'string' || !given.trim()) return reply.code(400).send({ error: 'Enter the path of a file or folder.' });
      const typed = given.trim();
      const target = path.resolve(folder.root, typed === '~' || typed.startsWith('~/') ? path.join(homedir(), typed.slice(1)) : typed);
      let st;
      try {
        st = statSync(target);
      } catch {
        return reply.code(404).send({ error: `There is no file or folder at ${target}.` });
      }
      const rel = path.relative(folder.root, target);
      const parts = rel.split(path.sep);
      // Inside the open folder and listed there (no part of it skipped).
      const inside = !path.isAbsolute(rel) && !parts.some((p) => p === '..' || p === 'node_modules' || p === '.DS_Store');
      if (st.isDirectory()) {
        if (inside) return { folder: rel.split(path.sep).join('/') };
        if (!opts.local?.openFolder) return reply.code(400).send({ error: 'Only folders inside the open folder can be opened here.' });
        opts.local.openFolder(target, inTab);
        return inTab ? { opened: true } : { switching: true };
      }
      if (!st.isFile()) return reply.code(400).send({ error: `${path.basename(target)} is not a file or a folder.` });
      if (inTab && !inside) {
        if (!opts.local?.openFileInTab) return reply.code(400).send({ error: 'This file is outside the open folder. Open its folder to see it.' });
        opts.local.openFileInTab(target);
        return { opened: true };
      }
      return showLocalFile(target, reply);
    });

    // A file by its absolute path: one in the open folder by its path there; for any other the app is asked to
    // open the file's own folder, and this server ends.
    // `back`, a folder of this one: where the file's breadcrumbs lead back to, in place of its own folder.
    const showLocalFile = (target: string, reply: FastifyReply, back?: string) => {
      const rel = path.relative(folder!.root, target);
      const parts = rel.split(path.sep);
      if (!path.isAbsolute(rel) && !parts.some((p) => p === '..' || p === 'node_modules' || p === '.DS_Store')) return { file: parts.join('/') };
      if (!opts.local?.openFile) return reply.code(400).send({ error: 'This file is outside the open folder. Open its folder to see it.' });
      opts.local.openFile(target, false, back === undefined ? undefined : `?${new URLSearchParams({ backDir: folder!.root, backFolder: back })}`);
      return { switching: true };
    };

    // Scratch pads: the Markdown files in ~/.config/mcp-docs, last changed first, for the home page's Scratch pad menu.
    r.get('/api/local/scratch-pads', async (_req, reply) => {
      if (!folder) return reply.code(400).send({ error: 'There is no open folder.' });
      const dir = path.join(homedir(), SCRATCH_DIR);
      const names = await readdir(dir).catch(() => [] as string[]);
      const pads = names
        .filter((n) => n.toLowerCase().endsWith('.md') && !n.startsWith('.'))
        .flatMap((name) => {
          try {
            const st = statSync(path.join(dir, name));
            return st.isFile() ? [{ name, modified: st.mtimeMs }] : [];
          } catch {
            return [];
          }
        })
        .sort((a, b) => b.modified - a.modified);
      return { pads: pads.map((p) => ({ name: p.name, modified: new Date(p.modified).toISOString() })) };
    });

    // Open a scratch pad by its name, or, with none, make a new one (and the folder, the first time). Opened from
    // another folder, its breadcrumbs lead back to that folder (`folder`, the one of it being shown), not its own.
    r.post('/api/local/scratch-pad', async (req, reply) => {
      if (!folder) return reply.code(400).send({ error: 'There is no open folder.' });
      const dir = path.join(homedir(), SCRATCH_DIR);
      const name = (req.body as { name?: unknown } | undefined)?.name;
      const at = (req.body as { folder?: unknown } | undefined)?.folder;
      const back = typeof at === 'string' ? at : '';
      if (name !== undefined) {
        if (typeof name !== 'string' || !name.toLowerCase().endsWith('.md') || name !== path.basename(name)) return reply.code(400).send({ error: 'That is not a scratch pad.' });
        if (!existsSync(path.join(dir, name))) return reply.code(404).send({ error: `${name} is no longer there.` });
        return showLocalFile(path.join(dir, name), reply, back);
      }
      await mkdir(dir, { recursive: true });
      for (;;) {
        const file = path.join(dir, scratchPadName((n) => existsSync(path.join(dir, n))));
        // 'wx' never writes over one made meanwhile; the next name is tried instead.
        const made = await writeFile(file, '', { flag: 'wx' }).then(
          () => true,
          (e: NodeJS.ErrnoException) => {
            if (e.code === 'EEXIST') return false;
            throw e;
          },
        );
        if (made) return showLocalFile(file, reply, back);
      }
    });

    // The folders the folder menu offers: the usual places in the home folder (HOME, Documents, Downloads,
    // Desktop) that are there.
    r.get('/api/local/places', async (_req, reply) => {
      if (!folder) return reply.code(400).send({ error: 'There is no open folder.' });
      const home = homedir();
      const isDir = (d: string) => {
        try {
          return statSync(d).isDirectory();
        } catch {
          return false;
        }
      };
      const usual = [home, ...['Documents', 'Downloads', 'Desktop'].map((n) => path.join(home, n))].filter((d) => d !== folder.root && isDir(d));
      return { places: usual.map((d) => ({ name: d === home ? 'HOME' : path.basename(d), path: d })) };
    });

    // The absolute path of a file of the folder (its kind and id), or of a folder of it (the request's `folder`).
    const localTarget = (req: FastifyRequest): string | null => {
      const { kind, id } = (req.body ?? {}) as { kind?: unknown; id?: unknown };
      if (id === undefined) return path.join(folder!.root, ...req.folder.split('/').filter(Boolean));
      if (typeof id !== 'string') return null;
      if (kind === 'file') return (storedFiles as LocalFileStore).get(req.user!.id, id)?.file ?? null;
      if (kind === 'doc' || kind === 'deck' || kind === 'sheet' || kind === 'markdown') return (sheets as LocalSheetStore).fileOf(req.user!.id, id);
      return null;
    };

    // Show a file ({kind, id}) or a folder (`folder`) in Finder or File Explorer.
    r.post('/api/local/reveal', async (req, reply) => {
      if (!folder || !opts.local?.reveal) return reply.code(400).send({ error: 'Files cannot be shown in the file browser here.' });
      const target = localTarget(req);
      if (!target || !existsSync(target)) return reply.code(404).send({ error: 'This file is no longer there.' });
      opts.local.reveal(target);
      return { ok: true };
    });

    // Drag a file ({kind, id}) out of the window, as the file itself: another app (Finder, a video editor) takes it.
    r.post('/api/local/drag', async (req, reply) => {
      if (!folder || !opts.local?.startDrag) return reply.code(400).send({ error: 'Files cannot be dragged out here.' });
      if ((req.body as { id?: unknown } | undefined)?.id === undefined) return reply.code(400).send({ error: 'Give the kind and id of the file.' });
      const target = localTarget(req);
      if (!target || !existsSync(target)) return reply.code(404).send({ error: 'This file is no longer there.' });
      opts.local.startDrag(target);
      return { ok: true };
    });

    // Go back to the folder a scratch pad was opened from (its breadcrumbs, the logo, Home): the window switches to
    // `dir` again, showing the folder `at` in it (not named `folder`, which requests name in this one).
    r.post('/api/local/return', async (req, reply) => {
      const { dir, at } = (req.body ?? {}) as { dir?: unknown; at?: unknown };
      if (typeof dir !== 'string' || !path.isAbsolute(dir) || (at !== undefined && typeof at !== 'string')) return reply.code(400).send({ error: 'Give the folder to go back to.' });
      if (!existsSync(dir)) return reply.code(404).send({ error: `${dir} is no longer there.` });
      if (!opts.local?.openFolder) return reply.code(400).send({ error: 'Folders cannot be opened here.' });
      opts.local.openFolder(dir, false, at || undefined);
      return { switching: true };
    });

    // Show the desktop app's Open Folder dialog; with `tab`, the folder chosen opens in a new tab.
    r.post('/api/local/choose-folder', async (req, reply) => {
      if (!opts.local?.chooseFolder) return reply.code(400).send({ error: 'Folders cannot be opened here.' });
      opts.local.chooseFolder((req.body as { tab?: unknown } | undefined)?.tab === true);
      return { ok: true };
    });

    // The library's file at a path inside the open folder: what to show for it.
    r.get('/api/local/resolve', async (req, reply) => {
      const rel = (req.query as { file?: unknown }).file;
      // A path inside the folder: no part of it may lead out.
      if (!folder || typeof rel !== 'string' || !rel || rel.split('/').some((p) => !p || p === '.' || p === '..' || p.includes('\\'))) return reply.code(404).send({ error: 'File not found' });
      const kind = listedKind(rel);
      const id = kind === 'file' ? (storedFiles as LocalFileStore).idOf(req.user!.id, rel) : (sheets as LocalSheetStore).idOf(req.user!.id, rel);
      if (!id) return reply.code(404).send({ error: 'File not found' });
      return { kind, id };
    });

    // Create a folder called `name` inside the request's folder.
    r.post('/api/folders', async (req, reply) => {
      const name = cleanFolderName((req.body as { name?: unknown } | undefined)?.name);
      if (!name) return reply.code(400).send({ error: 'A folder name cannot be empty, start with a dot, or contain \\ / : * ? " < > |.' });
      const path = cleanFolderPath(joinFolder(req.folder, name));
      if (path === null) return reply.code(400).send({ error: 'Folders cannot be nested this deep.' });
      if (!folders.create(req.user!.id, path)) return reply.code(409).send({ error: `There is already a folder called “${name}” here.` });
      return { folder: { name, path } };
    });

    // Delete the request's folder, which must be empty.
    r.delete('/api/folders', async (req, reply) => {
      const res = folders.remove(req.user!.id, req.folder);
      if (res === 'missing') return reply.code(404).send({ error: 'Folder not found' });
      if (res === 'not-empty') return reply.code(409).send({ error: 'This folder is not empty. Move or delete what is in it first.' });
      return { ok: true };
    });

    // The request's folder as a zip: its files in their readable formats, and the folders inside it.
    r.get('/api/folders/download', async (req, reply) => {
      const id = req.user!.id;
      const { body, files, problems } = await exportFolder({ sheets, files: storedFiles, folders }, id, req.folder, imageSource(images, id));
      req.log.info({ folder: req.folder, files, problems: problems.length }, 'downloaded folder');
      return attachment(reply, `${req.folder ? folderName(req.folder) : 'Files'}.zip`, 'application/zip').send(body);
    });

    // Move a document (any kind) or a stored file into the request's folder.
    r.post('/api/library/move', async (req, reply) => {
      const { id, kind } = (req.body ?? {}) as { id?: unknown; kind?: unknown };
      if (!isFileId(id)) return reply.code(404).send({ error: 'File not found' });
      const moved = kind === 'file' ? storedFiles.move(req.user!.id, id, req.folder) : sheets.move(req.user!.id, id, req.folder);
      if (!moved) return reply.code(404).send({ error: 'File not found' });
      return { ok: true };
    });

    // --- Trash: files deleted in the last 30 days, kept in the off-box copy (server/backup.ts) ---------
    r.get('/api/trash', async (req) => ({ files: backup ? await backup.listDeleted(req.user!.id) : [], available: !!backup }));

    r.post('/api/trash/:id/restore', async (req, reply) => {
      if (!backup) return reply.code(404).send({ error: 'No backup store is configured' });
      const { id } = req.params as { id: string };
      if (!isFileId(id)) return reply.code(404).send({ error: 'File not found' });
      const entry = (await backup.listDeleted(req.user!.id)).find((f) => f.id === id);
      if (!entry) return reply.code(404).send({ error: 'File not found in the trash' });
      if (sheets.get(req.user!.id, id)) return reply.code(409).send({ error: 'This file is not deleted' });
      const json = await backup.latestRevision(req.user!.id, entry.kind, id);
      if (!json) return reply.code(404).send({ error: 'No copy of this file is left' });
      const meta = await sheets.restore(req.user!.id, entry.kind, id, entry.title, json);
      await backup.undelete(req.user!.id, entry.kind, id);
      return { file: meta };
    });

    r.get('/api/export.zip', async (req, reply) => {
      const { body, files, problems } = await exportAll(sheets, req.user!.id, imageSource(images, req.user!.id));
      req.log.info({ files, problems: problems.length }, 'exported account');
      const date = new Date().toISOString().slice(0, 10);
      return attachment(reply, `${appName(!!opts.local)} export ${date}.zip`, 'application/zip').send(body);
    });
  });

  // --- Connectors (external data sources) ---------------------------------------
  const connectorStatus = (e: ConnectorError) => (e.code === 'not_found' ? 404 : e.code === 'rate_limited' ? 429 : e.code === 'unavailable' ? 502 : 400);
  /** Run a connector call, answering ConnectorErrors with their (credential-free) message. */
  const connectorCall = async <T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ConnectorError) return reply.code(connectorStatus(e)).send({ error: e.message, code: e.code });
      throw e;
    }
  };
  const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const oauthRedirectUri = (req: FastifyRequest) => `${originOf(req)}/api/connectors/oauth/callback`;

  app.register(async (r) => {
    r.addHook('preHandler', requireUser);

    r.get('/api/connectors', async () => ({ connectors: connectors.connectorInfo() }));
    r.get('/api/connections', async (req) => ({ connections: connectors.list(req.user!.id) }));

    r.post('/api/connections', async (req, reply) => {
      const body = asRecord(req.body);
      return connectorCall(reply, async () => ({
        connection: await connectors.create(req.user!.id, {
          connector: String(body.connector ?? ''),
          name: typeof body.name === 'string' ? body.name : undefined,
          fields: asRecord(body.fields),
        }),
      }));
    });

    // Test credentials before saving them; with an id, blank secret fields use the saved ones.
    r.post('/api/connections/test', async (req, reply) => {
      const body = asRecord(req.body);
      return connectorCall(reply, async () => {
        const id = typeof body.id === 'string' && body.id ? { userId: req.user!.id, id: body.id } : undefined;
        const connector = id ? (connectors.get(id.userId, id.id)?.connector ?? '') : String(body.connector ?? '');
        await connectors.testCredentials(connector, asRecord(body.fields), id);
        return { ok: true };
      });
    });

    r.patch('/api/connections/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = asRecord(req.body);
      return connectorCall(reply, async () => {
        const connection = await connectors.update(req.user!.id, id, {
          name: typeof body.name === 'string' ? body.name : undefined,
          fields: body.fields ? asRecord(body.fields) : undefined,
        });
        return connection ? { connection } : reply.code(404).send({ error: 'Connection not found' });
      });
    });

    r.delete('/api/connections/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!connectors.delete(req.user!.id, id)) return reply.code(404).send({ error: 'Connection not found' });
      return { ok: true };
    });

    r.post('/api/connections/:id/test', async (req, reply) => {
      const { id } = req.params as { id: string };
      return connectorCall(reply, async () => ({ connection: await connectors.test(req.user!.id, id) }));
    });

    // Run a dataset query (or return an earlier result by handle); used by the ingest_connector_data tool.
    r.post('/api/connections/:id/fetch', async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = asRecord(req.body);
      return connectorCall(reply, async () => {
        const cached = typeof body.handle === 'string' ? connectors.cachedResult(req.user!.id, body.handle) : null;
        return cached ?? (await connectors.fetch(req.user!.id, id, String(body.dataset ?? ''), body.params ?? {}));
      });
    });

    // OAuth 2.0: send the browser to the provider's consent page; it comes back to the callback below.
    r.get('/api/connectors/:connector/oauth/start', async (req, reply) => {
      const { connector } = req.params as { connector: string };
      const { name } = req.query as { name?: string };
      try {
        return reply.redirect(connectors.oauthStart(req.user!.id, connector, name, oauthRedirectUri(req)));
      } catch (e) {
        if (e instanceof ConnectorError) return reply.redirect(`/connectors?error=${encodeURIComponent(e.message)}`);
        throw e;
      }
    });

    r.get('/api/connectors/oauth/callback', async (req, reply) => {
      const q = req.query as { state?: string; code?: string; error?: string; error_description?: string };
      if (q.error || !q.state || !q.code) {
        return reply.redirect(`/connectors?error=${encodeURIComponent(q.error_description || q.error || 'The sign-in was cancelled.')}`);
      }
      try {
        const connection = await connectors.oauthCallback(req.user!.id, q.state, q.code);
        return reply.redirect(`/connectors?connected=${encodeURIComponent(connection.id)}`);
      } catch (e) {
        if (e instanceof ConnectorError) return reply.redirect(`/connectors?error=${encodeURIComponent(e.message)}`);
        throw e;
      }
    });
  });

  // --- Agent ---------------------------------------------------------------
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);

    // A chat: a file's (scope = its id) or the home page's, with the file's name for the panel to show.
    r.get('/api/agent', async (req, reply) => {
      const scope = (req.query as { scope?: unknown }).scope ?? HOME_CHAT;
      if (!isChatScope(scope)) return reply.code(400).send({ error: 'That is not a chat.' });
      const userId = req.user!.id;
      const title = scope === HOME_CHAT ? null : (sheets.get(userId, scope)?.title ?? (isFileId(scope) ? storedFiles.get(userId, scope)?.meta.filename : undefined) ?? null);
      return { items: agent.transcript(userId, scope), title };
    });

    // The user's answer to a permission their own agent asked for in the panel (AgentEvent 'permission').
    r.post('/api/agent/permission', async (req, reply) => {
      const { id, allow } = (req.body ?? {}) as { id?: unknown; allow?: unknown };
      if (typeof id !== 'string' || typeof allow !== 'boolean') return reply.code(400).send({ error: 'Give the question’s id and allow.' });
      if (!agent.answerPermission(id, allow)) return reply.code(404).send({ error: 'That question is no longer open.' });
      return { ok: true };
    });

    r.post('/api/agent/reset', async (req, reply) => {
      const scope = (req.body as { scope?: unknown } | undefined)?.scope ?? HOME_CHAT;
      if (!isChatScope(scope)) return reply.code(400).send({ error: 'That is not a chat.' });
      try {
        agent.reset(req.user!.id, scope);
      } catch (e) {
        if (e instanceof AgentError) return reply.code(e.status).send({ error: e.message });
        throw e;
      }
      return { ok: true };
    });

    // Runs or resumes a turn, streaming AgentEvents as server-sent events.
    r.post('/api/agent/turn', async (req, reply) => {
      const body = (req.body ?? {}) as AgentTurnRequest;
      try {
        agent.checkTurn(req.user!.id, body);
      } catch (e) {
        if (e instanceof AgentError) return reply.code(e.status).send({ error: e.message });
        throw e;
      }
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const abort = new AbortController();
      // The browser stopped the request (Stop button, navigation): abort the model call too.
      res.on('close', () => {
        if (!res.writableEnded) abort.abort();
      });
      const emit = (e: AgentEvent) => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`);
      };
      try {
        await agent.runTurn(req.user!.id, body, emit, abort.signal);
      } catch (e) {
        if (!abort.signal.aborted) {
          req.log.error({ err: e }, 'agent turn failed');
          emit({ type: 'error', message: agentErrorMessage(e) });
        }
      } finally {
        res.end();
        // Jobs queued during the turn start only now: the worker's edits restart the dev server, which would
        // cut off a reply still streaming.
        jobRunner.startQueued();
      }
    });

    // --- Assistant settings: the server's model, or an OpenAI model on the user's own key ---
    r.get('/api/settings/assistant', async (req) => ({ settings: assistantSettings.get(req.user!.id) }));

    r.put('/api/settings/assistant', async (req, reply) => {
      try {
        return { settings: await assistantSettings.update(req.user!.id, (req.body ?? {}) as Partial<AssistantSettingsUpdate>, opts.checkAssistantKey ?? checkAssistantKey, opts.checkSearchKey ?? checkBraveKey) };
      } catch (e) {
        if (e instanceof SettingsError) return reply.code(400).send({ error: e.message });
        throw e;
      }
    });

    // --- The user's saved signatures, for signing PDFs (server/signatures.ts) ---
    r.get('/api/settings/signatures', async (req) => ({ signatures: signatures.list(req.user!.id) }));

    r.post('/api/settings/signatures', async (req, reply) => {
      const image = (req.body as { image?: unknown } | null)?.image;
      if (!isSignatureImage(image)) return reply.code(400).send({ error: 'Send the signature as a PNG picture (a data: address of at most 2 MB).' });
      const signature = signatures.add(req.user!.id, image);
      return signature ? { signature } : reply.code(400).send({ error: `You can keep up to ${MAX_SIGNATURES} signatures. Remove one to save another.` });
    });

    r.delete('/api/settings/signatures/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      return signatures.delete(req.user!.id, id) ? { ok: true } : reply.code(404).send({ error: 'No such signature.' });
    });

    // --- Agents signed in to the plugin's MCP endpoint with a device code (none when the plugin is not mounted) ---
    // In the desktop app, the agents on this computer signed in to its own MCP server, at its fixed address.
    r.get('/api/settings/agents', async (req) => {
      const local = opts.local?.agents;
      if (local) {
        const { url, running, agents } = await local.list();
        return { enabled: true, local: true, running, mcpUrl: url, agents: agents.map((a): ConnectedAgent => ({ id: a.id, name: a.name, origin: 'This computer', endpoint: url, connectedAt: a.approved })) };
      }
      return { enabled: !!pluginOAuth, agents: pluginOAuth?.connectedAgents(req.user!.id) ?? [], ...(pluginOAuth ? { mcpUrl: `${originOf(req)}/mcp/v2` } : {}) };
    });

    r.delete('/api/settings/agents/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const local = opts.local?.agents;
      if (!(local ? await local.disconnect(id) : pluginOAuth?.disconnectAgent(req.user!.id, id))) return reply.code(404).send({ error: 'No such agent.' });
      return { ok: true };
    });

    // --- New files the desktop app opens (desktop/newFiles.js) ---
    r.get('/api/settings/new-files', async (_req, reply) => {
      const newFiles = opts.local?.newFiles;
      return newFiles ? newFiles.get() : reply.code(404).send({ error: 'Only the desktop app opens new files.' });
    });

    r.put('/api/settings/new-files', async (req, reply) => {
      const newFiles = opts.local?.newFiles;
      if (!newFiles) return reply.code(404).send({ error: 'Only the desktop app opens new files.' });
      const { open, kinds } = (req.body ?? {}) as { open?: unknown; kinds?: unknown };
      if (open !== undefined && typeof open !== 'boolean') return reply.code(400).send({ error: 'open must be true or false.' });
      if (kinds !== undefined && !(Array.isArray(kinds) && kinds.every((k) => typeof k === 'string'))) return reply.code(400).send({ error: 'kinds must be a list of kinds of file.' });
      return newFiles.set({ open, kinds });
    });

    // --- App-change jobs (self-improvement) ---
    // A change to the app (kind "change") or a research task (kind "research"), both run by the worker.
    r.post('/api/agent/jobs', async (req, reply) => {
      const body = (req.body ?? {}) as { title?: unknown; spec?: unknown; kind?: unknown; sheetId?: unknown };
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const spec = typeof body.spec === 'string' ? body.spec.trim() : '';
      if (!title || !spec) return reply.code(400).send({ error: 'A title and a spec are required.' });
      // Jobs run a worker against the hosted app's checkout, which the desktop app does not have.
      if (opts.local) return reply.code(400).send({ error: 'Background jobs are not available in the desktop app.' });
      const kind = body.kind === 'research' ? 'research' : 'change';
      let sheetId: string | undefined;
      if (kind === 'research' && typeof body.sheetId === 'string' && body.sheetId) {
        if (!sheets.get(req.user!.id, body.sheetId, 'sheet')) return reply.code(404).send({ error: 'Sheet not found' });
        sheetId = body.sheetId;
      }
      const active = jobs.active();
      if (active) return reply.code(409).send({ error: `A job is already in progress: "${active.title}". Wait for it to finish.` });
      return { job: publicJob(jobs.create(req.user!.id, title.slice(0, 120), spec.slice(0, 8000), { kind, sheetId, requestedBy: req.user!.email })) };
    });

    // The app's change history, for the Changes page.
    r.get('/api/agent/jobs', async () => ({ jobs: jobs.list().map(publicJob) }));

    // Undo a change: a job that applies its patch in reverse (or has the coding agent undo it), then goes
    // through the same verify, restart and publish steps. Starts right away; nothing is streaming to this user.
    r.post('/api/agent/jobs/:id/revert', async (req, reply) => {
      const { id } = req.params as { id: string };
      const target = jobs.get(id);
      if (!target) return reply.code(404).send({ error: 'Change not found' });
      if (opts.local) return reply.code(400).send({ error: 'Changes to the app are not available in the desktop app.' });
      if (target.kind !== 'change') return reply.code(400).send({ error: 'Only changes can be reverted, not reverts.' });
      if (target.status !== 'done') return reply.code(400).send({ error: 'Only a finished change can be reverted.' });
      if (target.revertedByJobId) return reply.code(400).send({ error: 'That change has already been reverted.' });
      const active = jobs.active();
      if (active) return reply.code(409).send({ error: `A change is already in progress: "${active.title}". Wait for it to finish.` });
      const job = jobs.create(req.user!.id, target.title, `Revert the change "${target.title}" (job ${target.id}).`, {
        kind: 'revert',
        requestedBy: req.user!.email,
        revertsJobId: target.id,
      });
      jobRunner.startQueued();
      return { job: publicJob(jobs.get(job.id)!) };
    });

    r.get('/api/agent/jobs/latest', async (req) => {
      const job = jobs.latest(req.user!.id);
      return { job: job ? publicJob(job) : null };
    });

    r.post('/api/agent/jobs/:id/ack', async (req, reply) => {
      const { id } = req.params as { id: string };
      const job = jobs.get(id);
      if (!job || job.userId !== req.user!.id) return reply.code(404).send({ error: 'Job not found' });
      jobs.acknowledge(id, req.user!.id);
      return { ok: true };
    });
  });

  // --- Static client (production) ----------------------------------------------
  if (host && opts.staticDir && existsSync(opts.staticDir)) {
    // Under the base path (the client is built with it: BASE_PATH), its files and its page for every address of
    // its own. The page is read and sent here (whether the host's static files decorate replies is the host's
    // business; read each time, so a rebuilt client is live without a restart). A visitor at the base goes to the
    // suite's sign-in; the suite sends them back here once signed in (/?next=).
    const staticDir = opts.staticDir;
    await app.register(fastifyStatic, { root: staticDir, prefix: `${basePath}/`, wildcard: false, index: false, decorateReply: false });
    const indexFile = path.join(staticDir, 'index.html');
    const page = (req: FastifyRequest, reply: FastifyReply) => {
      // A public link's address is its secret: not passed on to other sites, not indexed.
      if (req.url.startsWith(`${basePath}/p/`)) reply.header('Referrer-Policy', 'no-referrer').header('X-Robots-Tag', 'noindex');
      return reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache').send(readFileSync(indexFile, 'utf8'));
    };
    app.get(basePath, async (req, reply) => (req.user ? page(req, reply) : reply.redirect(`/?next=${encodeURIComponent(req.url)}`)));
    app.get(`${basePath}/*`, async (req, reply) => page(req, reply));
    // Public links from before the move keep working at their old address.
    app.get('/p/*', async (req, reply) => reply.code(301).redirect(`${basePath}${req.url}`));
  } else if (opts.staticDir && existsSync(opts.staticDir)) {
    // `index: false`: / is answered below, as the front page already drawn for a visitor.
    await app.register(fastifyStatic, { root: opts.staticDir, wildcard: false, index: false });
    const landingFile = path.join(opts.staticDir, 'landing.html');
    const landing = existsSync(landingFile) ? readFileSync(landingFile, 'utf8') : null;
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
      // The page with the front page in it (scripts/prerender-landing.ts) for a visitor at /; the app's own page for
      // everyone else, and for every other address.
      if (landing && !req.user && req.method === 'GET' && req.url.split('?')[0] === '/')
        return reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache').send(landing.replaceAll(ORIGIN_MARK, originOf(req)));
      // A public link's address is its secret: not passed on to other sites, not indexed.
      if (req.url.startsWith('/p/')) reply.header('Referrer-Policy', 'no-referrer').header('X-Robots-Tag', 'noindex');
      return reply.sendFile('index.html');
    });
  }
  }
}
