// The desktop app (Electron). It opens a folder as the library: the folder given on the command line, or
// the directory the app was started in. The app itself is the web app, served to this window by a local
// server (desktop/server.ts) that reads and writes the folder's files. A window may instead be a Web tab: the
// hosted app (MCP Docs on the web), signed in to the person's account (docs/web-and-pdf.md).
import { app, BrowserWindow, clipboard, dialog, Menu, session, shell } from 'electron';
import { execFile, fork } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { contextMenuTemplate } from './contextMenu.js';
import { LocalOAuth } from './mcpAuth.js';
import { DEFAULT_KINDS, KINDS, watchNewFiles } from './newFiles.js';
import { createUpdater } from './updater.js';

const root = path.resolve(import.meta.dirname, '..');
// Also names the app's data directory, which would otherwise be the generic "Electron" one.
// The name the app's data folder is kept under (last folder, each folder's database): changing it would lose them.
app.setName('MCP Docs');
const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
// The app was called Universal Docs, and before that FreeFlow Docs: the first time it starts under its new name,
// its data folder moves over.
const legacyData = ['Universal Docs', 'FreeFlow Docs'].map((name) => path.join(app.getPath('appData'), name)).find(isDir);
if (!existsSync(app.getPath('userData')) && legacyData) {
  try {
    renameSync(legacyData, app.getPath('userData'));
  } catch (e) {
    console.error(`Could not move ${legacyData}: ${e.message}`);
  }
}

// The installed app is started from a menu or an icon, where the current directory means nothing: it
// reopens the folder it showed last, or the home folder the first time.
const lastFolderFile = () => path.join(app.getPath('userData'), 'last-folder.txt');
function lastFolder() {
  try {
    const dir = readFileSync(lastFolderFile(), 'utf8').trim();
    return dir && isDir(dir) ? dir : null;
  } catch {
    return null;
  }
}
function rememberFolder(dir) {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(lastFolderFile(), dir);
  } catch {
    // Not remembered, that's all.
  }
}

// --- Folders, their servers and the windows showing them ---------------------------------------------------
// Each window (a tab, on macOS) shows one folder, and each folder open in a window has a server of its own, which
// stops when its last window closes. Opening a folder changes the window it was asked in, not the others.
/** The servers running, by folder. */
const servers = new Map();
/** Folders whose server is starting, so two windows opening one folder share it. */
const starting = new Map();
/** Each window's server, by window id. */
const windowServers = new Map();
/** The window last in front: what the menu, Finder and agents act on. */
let front = null;
/** The windows in the order they were last in front, the most recent last. */
let recent = [];

const serverOf = (win) => (win && !win.isDestroyed() ? windowServers.get(win.id) : undefined);
/** The window last in front that `pred` accepts. */
const lastWindow = (pred) => [...recent].reverse().find((w) => !w.isDestroyed() && pred(w)) ?? null;
/** The server of the window in front, else of the Local tab last in front; agents' MCP requests go to it. */
const frontServer = () => serverOf(BrowserWindow.getFocusedWindow()) ?? serverOf(front) ?? serverOf(lastWindow((w) => !!serverOf(w))) ?? servers.values().next().value ?? null;

// --- Web tabs ------------------------------------------------------------------------------------------------
// A Web tab is the hosted app (UNIVERSAL_WEB_URL), with a session of its own kept on disk, so web cookies and
// the folders' tokens never mix and the person stays signed in. The page gets nothing of the app's: it talks
// to the app only through mcpdocs:// links (the Local | Web switch), which the app catches before they load.
const WEB_URL = (process.env.UNIVERSAL_WEB_URL || 'https://mcpdocs.freeflow.im').replace(/\/$/, '');
const WEB_ORIGIN = new URL(WEB_URL).origin;
/** Added to the pages' user agent, so the client knows it is in the app and shows the Local | Web switch (PlaceSwitch). */
const UA_MARK = 'MCPDocs/1';
let webSession = null;
const webWindows = new Set();
const isWeb = (win) => !!win && !win.isDestroyed() && webWindows.has(win);

/** The window to show something of `server` in: the one in front when it is that server's, else one of its own. */
function windowFor(server) {
  const focused = BrowserWindow.getFocusedWindow();
  if (serverOf(focused) === server) return focused;
  if (serverOf(front) === server) return front;
  return [...server.windows][0] ?? null;
}

/** Make `win` one of `server`'s windows (and no longer one of the server it showed before). */
function attach(win, server) {
  const old = serverOf(win);
  if (old === server) return;
  windowServers.set(win.id, server);
  server.windows.add(win);
  if (old) {
    old.windows.delete(win);
    release(old);
  }
}

/** A window closed: its server stops if no window shows its folder any more. */
function detach(id, win) {
  const server = windowServers.get(id);
  windowServers.delete(id);
  recent = recent.filter((w) => w !== win);
  if (front === win) front = null;
  if (!server) return;
  server.windows.delete(win);
  release(server);
}

function release(server) {
  if (server.windows.size) return;
  servers.delete(server.dir);
  server.child.removeAllListeners('exit');
  server.child.kill('SIGTERM');
  void session.defaultSession.cookies.remove(server.origin, server.cookie).catch(() => {});
}

function stopServers() {
  for (const server of servers.values()) {
    server.child.removeAllListeners('exit');
    server.child.kill('SIGTERM');
  }
  servers.clear();
}

// --- The MCP server, for agents on this machine (server/localMcp.ts) ------------------------------------
// The folder's server is on a port the system picks, and a new one starts with each folder. Agents are set up
// once, so they reach it on a fixed port, here, which passes MCP requests on to whichever server is running.
// An agent signs in with OAuth (mcpAuth.js): the person allows it in a dialog of the app, and it gets a token
// of its own. Requests it makes with that token are passed on with a secret the folder's server knows, made
// for each run of the app, which no agent ever sees.
const MCP_PORT = Number(process.env.UNIVERSAL_MCP_PORT) || 39217;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}`;
const MCP_SECRET = randomBytes(32).toString('base64url');
/** False until the port is ours: another copy of the app may hold it. */
let mcpListening = false;
let mcpAuth = null;

/** Ask the person whether an agent may connect, in front of whatever they are doing. */
async function approveAgent(name) {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (win?.isMinimized()) win.restore();
  bringToFront();
  const options = {
    type: 'question',
    title: 'Connect an Agent',
    message: `Allow “${name}” to use MCP Docs?`,
    detail:
      'It will be able to read, change, create and delete the files in the folders you open in the app, and show them in this window, until you disconnect it (File › Connect an Agent).\n\nAllow it only if you just asked an agent on this computer to connect. The name is the one the agent gave itself.',
    buttons: ['Allow', 'Don’t Allow'],
    defaultId: 0,
    cancelId: 1,
  };
  const res = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  return res.response === 0;
}

/** What a request may be addressed to: this port on this computer, not a name a web page made point here. */
const ownHost = (host) => host === `127.0.0.1:${MCP_PORT}` || host === `localhost:${MCP_PORT}`;

function startMcpProxy() {
  mkdirSync(app.getPath('userData'), { recursive: true });
  // The one shared token an earlier version kept: agents sign in now, so it opens nothing and goes.
  rmSync(path.join(app.getPath('userData'), 'mcp-token'), { force: true });
  mcpAuth = new LocalOAuth({ file: path.join(app.getPath('userData'), 'mcp-auth.json'), issuer: MCP_URL, approve: approveAgent });
  const proxy = http.createServer((req, res) => {
    const pathname = (req.url ?? '/').split('?')[0];
    if (!ownHost(req.headers.host)) return void res.writeHead(421).end();
    if (mcpAuth.handles(pathname)) {
      mcpAuth.handle(req, res).catch(() => !res.headersSent && res.writeHead(500).end());
      return;
    }
    // Only the MCP endpoint and the plugin's upload and file links; the app itself is not served here.
    const mcp = pathname === '/mcp' || pathname.startsWith('/mcp/');
    if (!(mcp || pathname.startsWith('/plugin/'))) return void res.writeHead(404).end();
    const headers = { ...req.headers };
    if (mcp) {
      if (!mcpAuth.verify(req.headers.authorization)) {
        // The agent learns where to sign in from this (RFC 9728), and opens the sign-in page.
        return void res
          .writeHead(401, { 'content-type': 'application/json', 'www-authenticate': `Bearer resource_metadata="${mcpAuth.resourceMetadataUrl}"` })
          .end(JSON.stringify({ error: 'unauthorized', error_description: 'Sign in: the app asks you to allow this agent.' }));
      }
      headers.authorization = `Bearer ${MCP_SECRET}`;
    }
    const current = frontServer();
    if (!current) return void res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'The app is opening a folder. Try again in a moment.' }));
    const up = http.request({ host: '127.0.0.1', port: current.port, method: req.method, path: req.url, headers }, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'The app’s server is not answering.' }));
      else res.end();
    });
    req.pipe(up);
  });
  proxy.on('error', (e) => {
    mcpListening = false;
    console.error(`MCP server not started on ${MCP_URL}: ${e.message}`);
  });
  proxy.listen(MCP_PORT, '127.0.0.1', () => {
    mcpListening = true;
  });
}

/**
 * Make the app the one in front. macOS (14 and later) no longer lets an app take the front on its own
 * (app.focus's steal is ignored), but it does when asked to open the app: for one already running, Launch
 * Services brings it forward rather than starting another.
 */
function bringToFront() {
  if (process.platform !== 'darwin') return app.focus();
  // .../MCP Docs.app/Contents/MacOS/MCP Docs (or Electron.app in development).
  const bundle = path.resolve(process.execPath, '..', '..', '..');
  if (!bundle.endsWith('.app')) return app.focus({ steal: true });
  execFile('open', ['-a', bundle], (e) => e && app.focus({ steal: true }));
}

/**
 * Put a page of the app (a file the model opened, created or imported) in a window of `server`'s folder, and
 * bring the app to the front so the person sees it. Edits to the file already showing do not come here.
 */
function showPage(page, server = frontServer()) {
  if (!server) return;
  const win = windowFor(server);
  if (!win) return createWindow(server, `${server.origin}${page}`);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  bringToFront();
  // The client's router goes there (main.tsx), as a link in the app would.
  void win.webContents.executeJavaScript(`dispatchEvent(new CustomEvent('universal-show', { detail: ${JSON.stringify(page)} }))`).catch(() => {});
}

/** An agent rewrote a stored file: a window showing it loads it again (FilePage listens for this, as for the app's own assistant). */
function fileChanged(id, server) {
  for (const win of server.windows) {
    void win.webContents.executeJavaScript(`dispatchEvent(new CustomEvent('stored-file-changed', { detail: ${JSON.stringify(id)} }))`).catch(() => {});
  }
}

/** Settings' list of the agents connected to the MCP server, and its Disconnect (desktop/server.ts asks). */
function agentsAnswer(msg) {
  if (msg.disconnect !== undefined) return typeof msg.disconnect === 'string' && !!mcpAuth?.revoke(msg.disconnect);
  return { url: `${MCP_URL}/mcp`, running: mcpListening, agents: mcpAuth?.clients() ?? [] };
}

/** Connect an Agent: Settings, which has the MCP server's address, how to add it and the agents connected. */
function connectAgent() {
  showPage('/settings#agents');
}

// --- New files (desktop/newFiles.js) --------------------------------------------------------------------------
// A file that appears in Downloads, Documents or Desktop (a download that finished, a file saved from another app)
// opens in the app, which comes to the front, as one Finder asks for does. On unless the person turns it off in
// Settings, which also chooses the kinds of file (kept in new-files.json in the app's data folder). The app's own writes (desktop/server.ts tells them)
// are not new files: a document made in the app is already showing.
const newFilesFile = () => path.join(app.getPath('userData'), 'new-files.json');
/** The folders watched: Downloads, Documents and Desktop, wherever the system keeps them (OneDrive's, on Windows). */
const newFilesFolders = () => [...new Set(['downloads', 'documents', 'desktop'].map((name) => app.getPath(name)))].filter(isDir);
/** The files the folders' servers wrote lately, by path, with when. */
const ownWrites = new Map();
let stopNewFiles = null;

/** What Settings chose: `{ open, kinds }`, on with the default kinds until then. */
function newFilesChosen() {
  let saved = {};
  try {
    saved = JSON.parse(readFileSync(newFilesFile(), 'utf8'));
  } catch {
    // Not chosen yet.
  }
  const kinds = Array.isArray(saved.kinds) ? saved.kinds.filter((k) => KINDS.some((kind) => kind.id === k)) : DEFAULT_KINDS;
  return { open: saved.open !== false, kinds };
}

function wrote(file) {
  const now = Date.now();
  for (const [f, at] of ownWrites) if (now - at > 5 * 60_000) ownWrites.delete(f);
  ownWrites.set(path.resolve(file), now);
}

function watchFolders({ open, kinds }) {
  stopNewFiles?.();
  stopNewFiles = null;
  if (!open || !kinds.length) return;
  stopNewFiles = watchNewFiles({
    dirs: newFilesFolders(),
    kinds,
    ignore: (file) => ownWrites.has(file),
    settle: 750,
    bulk: 750,
    onFile: (file) =>
      void showFile(file, true)
        .then(bringToFront)
        .catch(() => {}),
  });
}

/** Settings' New files (desktop/server.ts asks): `{ open, kinds }` changes them; the answer is how they are now. */
function newFilesAnswer(set) {
  let chosen = newFilesChosen();
  if (typeof set?.open === 'boolean' || Array.isArray(set?.kinds)) {
    chosen = {
      open: typeof set.open === 'boolean' ? set.open : chosen.open,
      kinds: Array.isArray(set.kinds) ? KINDS.filter((k) => set.kinds.includes(k.id)).map((k) => k.id) : chosen.kinds,
    };
    try {
      mkdirSync(app.getPath('userData'), { recursive: true });
      writeFileSync(newFilesFile(), JSON.stringify(chosen));
    } catch {
      // Back to what it was at the next start, that's all.
    }
    watchFolders(chosen);
  }
  return { open: chosen.open, folders: newFilesFolders(), kinds: KINDS.map((k) => ({ id: k.id, label: k.label, on: chosen.kinds.includes(k.id) })) };
}

// --- PDFs (server/pdf.ts) ------------------------------------------------------------------------------------
// A folder's server asks for the PDF of a page of the app (with a print ticket as its cookie, which lets the
// page read the file) or of a stored web page's HTML. It is printed in a hidden window with a session of its
// own, thrown away after.

/** Wait for the page to say it is drawn (client/src/print.ts). */
async function printReady(win, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript('window.__printReady === true')) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the page took too long to draw');
}

async function printPdf(req) {
  const ses = session.fromPartition(`pdf-${randomBytes(8).toString('hex')}`);
  const win = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { session: ses, backgroundThrottling: false } });
  let page = null;
  try {
    if (req.url) {
      await ses.cookies.set({ url: new URL(req.url).origin, name: req.ticket.name, value: req.ticket.value, httpOnly: true });
      await win.loadURL(req.url);
      await printReady(win, req.opts.timeoutMs);
    } else {
      // A stored web page is someone else's HTML: here nothing it asks for is fetched (the hosted app fetches
      // public addresses for it), so it shows only what it holds.
      page = path.join(app.getPath('temp'), `mcp-docs-print-${randomBytes(8).toString('hex')}.html`);
      writeFileSync(page, req.html);
      const address = pathToFileURL(page).href;
      ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !(details.url === address || /^(data|blob):/i.test(details.url)) }));
      await win.loadURL(address);
    }
    const m = req.opts.margin;
    const data = await win.webContents.printToPDF({
      pageSize: req.opts.paper === 'letter' ? 'Letter' : 'A4',
      preferCSSPageSize: true,
      printBackground: true,
      margins: { top: m, bottom: m, left: m, right: m },
      generateDocumentOutline: true,
      generateTaggedPDF: true,
    });
    return { pdfDone: req.pdf, data: data.toString('base64') };
  } catch (e) {
    return { pdfDone: req.pdf, error: `The PDF could not be made: ${e?.message ?? e}` };
  } finally {
    win.destroy();
    if (page) rmSync(page, { force: true });
  }
}

// --- The assistant's API keys ------------------------------------------------------------------------------
// The app has no model of its own: the assistant runs on the user's Anthropic, OpenAI or OpenRouter key. On
// the first run a key already set where the user works is used (the server keeps it once it has settings,
// server/agent/settings.ts). Started from Finder or the Dock, the app does not get the login shell's
// environment, so it is read from the shell, once.
const KEY_NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'];
const keysCheckedFile = () => path.join(app.getPath('userData'), 'assistant-keys-checked');
let shellKeys = {};

/** The keys set in the user's login shell (or already in this process's environment), by name. */
function readShellKeys() {
  const found = Object.fromEntries(KEY_NAMES.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  if (process.platform === 'win32') return Promise.resolve(found);
  return new Promise((resolve) => {
    // An interactive login shell reads the same files a terminal does (.zprofile, .zshrc, ...).
    execFile(process.env.SHELL || '/bin/zsh', ['-ilc', 'env'], { timeout: 5000, maxBuffer: 1 << 20 }, (_e, out) => {
      for (const line of String(out ?? '').split('\n')) {
        const m = /^([A-Z_]+)=(\S+)$/.exec(line);
        if (m && KEY_NAMES.includes(m[1]) && !found[m[1]]) found[m[1]] = m[2];
      }
      resolve(found);
    });
  });
}

/** The server for a folder: the one running, or a new one once it is listening. */
function serverFor(dir) {
  const running = servers.get(dir);
  if (running) return Promise.resolve(running);
  if (!starting.has(dir)) {
    const start = startServer(dir).finally(() => starting.delete(dir));
    starting.set(dir, start);
  }
  return starting.get(dir);
}

/** `target` is the folder `dir` or inside it: a server only ever names its own folder's files. */
const inFolder = (target, dir) => {
  const rel = path.relative(dir, target);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** Show a file or folder in Finder (File Explorer on Windows): a folder opened, a file selected in its own. */
function reveal(target) {
  if (isDir(target)) void shell.openPath(target);
  else shell.showItemInFolder(target);
}

/**
 * Drag a file out of `win` as the file itself, so another app (Finder, a video editor) takes it. The page has
 * cancelled its own drag of the file's row; the pointer is still down, so the system's drag takes over from here.
 */
async function dragOut(file, win) {
  if (!win || win.isDestroyed() || !statSync(file).isFile()) return;
  const icon = await app.getFileIcon(file, { size: 'normal' });
  if (!win.isDestroyed()) win.webContents.startDrag({ file, icon });
}

/** Start a server for the folder; resolves once it is listening. */
async function startServer(dir) {
  const token = randomBytes(32).toString('base64url');
  // Cookies are per host, not per port: each folder's server has a cookie of its own on 127.0.0.1.
  const cookie = `local-${randomBytes(6).toString('hex')}`;
  // What the app keeps for a folder (chat history, settings, pasted images, deleted files) lives with the
  // app's own data, not in the folder.
  const dataDir = path.join(app.getPath('userData'), 'folders', createHash('sha256').update(dir).digest('hex').slice(0, 16));
  // Electron runs as plain Node in a forked child. The working directory is the app's, where .env is.
  const child = fork(path.join(root, 'desktop', 'server.ts'), [], {
    cwd: root,
    env: { ...process.env, ...shellKeys, LOCAL_DIR: dir, DATA_DIR: dataDir, APP_DATA_DIR: app.getPath('userData'), LOCAL_TOKEN: token, LOCAL_COOKIE: cookie, PORT: '0', MCP_TOKEN: MCP_SECRET, MCP_URL },
  });
  const server = await new Promise((resolve, reject) => {
    child.once('message', (msg) => resolve({ child, dir, token, cookie, port: msg.port, origin: `http://127.0.0.1:${msg.port}`, windows: new Set() }));
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`The server stopped while starting (exit code ${code}).`)));
  });
  child.removeAllListeners('error');
  child.removeAllListeners('exit');
  child.on('error', () => {}); // It stopping is what counts, below.
  const failed = (e) => dialog.showErrorBox('MCP Docs', String(e.message ?? e));
  // Later the server asks, for the window it serves that the person is using, for a file outside its folder to
  // be shown (one of Recents), another folder, or a page (a file an agent opened).
  child.on('message', (msg) => {
    if (msg && typeof msg.openFile === 'string') void openFile(msg.openFile, msg.fromRecents !== false, windowFor(server), typeof msg.back === 'string' ? msg.back : '').catch(failed);
    if (msg && typeof msg.openFileInTab === 'string') void openFile(msg.openFileInTab, false).catch(failed);
    if (msg && typeof msg.openFolder === 'string') void openFolder(msg.openFolder, msg.folder ? `/?folder=${encodeURIComponent(msg.folder)}` : '/', msg.inTab ? null : windowFor(server)).catch(failed);
    if (msg?.chooseFolder) void chooseFolder(windowFor(server), msg.inTab === true).catch(failed);
    if (msg && typeof msg.ask === 'string') child.connected && child.send({ askDone: msg.ask, answer: msg.newFiles ? newFilesAnswer(msg.newFiles) : agentsAnswer(msg) });
    if (msg && typeof msg.wrote === 'string') wrote(msg.wrote);
    if (msg && typeof msg.reveal === 'string' && inFolder(msg.reveal, server.dir)) reveal(msg.reveal);
    if (msg && typeof msg.drag === 'string' && inFolder(msg.drag, server.dir)) void dragOut(msg.drag, windowFor(server)).catch(() => {});
    if (msg && typeof msg.show === 'string' && msg.show.startsWith('/')) showPage(msg.show, server);
    if (msg && typeof msg.fileChanged === 'string') fileChanged(msg.fileChanged, server);
    if (msg && typeof msg.pdf === 'string') void printPdf(msg).then((answer) => child.connected && child.send(answer));
    if (msg && typeof msg.web === 'string') void webRequest(msg).then((answer) => child.connected && child.send(answer));
  });
  child.once('exit', () => {
    servers.delete(dir);
    dialog.showErrorBox('MCP Docs', `The local server for “${dir}” stopped unexpectedly. Its windows will close.`);
    for (const win of [...server.windows]) win.destroy();
  });
  // Only this app's windows hold the token, so nothing else on the machine can use the server.
  await session.defaultSession.cookies.set({ url: server.origin, name: cookie, value: token, httpOnly: true, sameSite: 'strict' });
  servers.set(dir, server);
  return server;
}

const TABS = 'freeflow';
const WINDOW_OPTIONS = { width: 1400, height: 900, title: 'MCP Docs', tabbingIdentifier: TABS };

/** A window's title says which kind of tab it is (native tabs show only titles): "Proposal — Local". */
function titled(win, kind) {
  win.on('page-title-updated', (e, title) => {
    e.preventDefault();
    win.setTitle(`${title.replace(/ - (MCP Docs|Universal Docs)$/, '')} — ${kind}`);
  });
}

/** It is the window in front now. */
function inFront(win) {
  front = win;
  recent = [...recent.filter((w) => w !== win), win];
}

/** Keep track of a window of the app: which folder it shows, and when it is the one in front. */
function track(win, server) {
  const id = win.id;
  attach(win, server);
  titled(win, 'Local');
  win.on('focus', () => {
    inFront(win);
    const s = serverOf(win);
    if (s) rememberFolder(s.dir);
  });
  win.once('closed', () => detach(id, win));
}

/** Keep track of a Web tab. */
function trackWeb(win) {
  webWindows.add(win);
  titled(win, 'Web');
  win.on('focus', () => inFront(win));
  win.once('closed', () => {
    webWindows.delete(win);
    recent = recent.filter((w) => w !== win);
    if (front === win) front = null;
  });
}

/** A Web tab on `url` (the hosted app's); with `tabOf`, a tab of that window where the system has them (macOS). */
function createWebWindow(url = `${WEB_URL}/`, tabOf = null) {
  const win = new BrowserWindow({ ...WINDOW_OPTIONS, webPreferences: { session: webSession } });
  trackWeb(win);
  if (tabOf && !tabOf.isDestroyed() && process.platform === 'darwin') tabOf.addTabbedWindow(win);
  void win.loadURL(url);
  return win;
}

/** Tabs of one window share its frame. */
const sameFrame = (a, b) => {
  const x = a.getBounds();
  const y = b.getBounds();
  return x.x === y.x && x.y === y.y && x.width === y.width && x.height === y.height;
};

/**
 * The Local | Web switch (client/src/components/PlaceSwitch.tsx): to a tab of the other kind in this window,
 * else the one last in front anywhere, else a new tab of that kind here (the folder last open, for Local).
 */
async function switchTo(kind, from) {
  const want = kind === 'web' ? isWeb : (w) => !!serverOf(w);
  const here = from && !from.isDestroyed() ? BrowserWindow.getAllWindows().find((w) => w !== from && want(w) && sameFrame(w, from)) : null;
  const target = here ?? lastWindow(want);
  if (target) {
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
    return;
  }
  if (kind === 'web') return void createWebWindow(`${WEB_URL}/`, from).focus();
  const server = await serverFor(lastFolder() ?? app.getPath('home'));
  createWindow(server, `${server.origin}/`, from).focus();
}

/**
 * A folder's server asks the web something as the person signed in to the Web tab (server/webCopy.ts: Upload to
 * Web, Download to Folder). Only the hosted app's API, and the server never sees the session.
 */
async function webRequest(req) {
  try {
    if (typeof req.path !== 'string' || !req.path.startsWith('/api/')) throw new Error('not a request the app passes on');
    const res = await webSession.fetch(`${WEB_URL}${req.path}`, {
      method: req.method,
      credentials: 'include',
      headers: { ...(req.type ? { 'content-type': req.type } : {}), ...(req.headers ?? {}) },
      body: typeof req.data === 'string' ? Buffer.from(req.data, 'base64') : undefined,
    });
    const data = Buffer.from(await res.arrayBuffer());
    return { webDone: req.web, status: res.status, type: (res.headers.get('content-type') ?? '').split(';')[0].trim(), disposition: res.headers.get('content-disposition') ?? '', data: data.toString('base64') };
  } catch (e) {
    return { webDone: req.web, error: `The web could not be reached: ${e?.message ?? e}` };
  }
}

/** Sign out of the hosted app: its session ends there and here, and Web tabs go to the sign-in page. */
async function signOutOfWeb() {
  try {
    await webSession.fetch(`${WEB_URL}/api/auth/logout`, { method: 'POST', credentials: 'include' });
  } catch {
    // Offline: the session is forgotten here all the same.
  }
  await webSession.clearStorageData();
  for (const win of webWindows) void win.loadURL(`${WEB_URL}/login`);
}

/**
 * Google sign-in for a Web tab, in the system browser (Google refuses an app's own browser): the browser gets a
 * random key of the app's along, and the app asks the hosted app every two seconds whether the sign-in under it
 * has finished, then trades it for the tab's session (/api/auth/handoff). No link back to the app is needed.
 */
function googleSignIn(start, win) {
  const key = randomBytes(32).toString('base64url');
  start.searchParams.set('desktop', key);
  void shell.openExternal(start.href);
  const deadline = Date.now() + 10 * 60 * 1000;
  const check = async () => {
    if (Date.now() > deadline) return;
    let ready = false;
    try {
      const res = await webSession.fetch(`${WEB_URL}/api/auth/handoff/status?key=${key}`, { credentials: 'include', cache: 'no-store' });
      ready = res.ok && (await res.json()).ready === true;
    } catch {
      // Offline for a moment: ask again.
    }
    if (!ready) return void setTimeout(check, 2000);
    const target = win && !win.isDestroyed() ? win : (lastWindow(isWeb) ?? createWebWindow('about:blank', front));
    void target.loadURL(`${WEB_URL}/api/auth/handoff?key=${key}`);
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
    bringToFront();
  };
  setTimeout(check, 2000);
}

/** An mcpdocs:// link: the Local | Web switch (from a page of the app), or one from the system (a browser). */
function handleAppLink(link, from = null) {
  let u;
  try {
    u = new URL(link);
  } catch {
    return;
  }
  const failed = (e) => dialog.showErrorBox('MCP Docs', String(e.message ?? e));
  if (u.hostname === 'switch') return void switchTo(u.searchParams.get('to') === 'web' ? 'web' : 'local', from).catch(failed);
  // Download to Folder… (a Web tab) or Download to MCP Docs (the hosted app in any browser): the download dialog
  // in a Local tab (client/src/components/WebCopyDialogs.tsx).
  if (u.hostname === 'download') {
    const id = u.searchParams.get('id') ?? '';
    const kind = u.searchParams.get('kind') ?? '';
    if (!/^[0-9a-z-]{1,64}$/i.test(id) || !['doc', 'deck', 'sheet', 'markdown', 'file'].includes(kind)) return;
    const page = `/?${new URLSearchParams({ webDownload: id, kind, title: (u.searchParams.get('title') ?? '').slice(0, 200) })}`;
    const server = frontServer();
    if (server) return showPage(page, server);
    return void serverFor(lastFolder() ?? app.getPath('home'))
      .then((s) => createWindow(s, `${s.origin}${page}`, front).focus())
      .catch(failed);
  }
  // A web file the person just uploaded, in a Web tab.
  if (u.hostname === 'open-web') {
    const page = u.searchParams.get('path') ?? '/';
    if (!page.startsWith('/') || page.startsWith('//')) return;
    const win = lastWindow(isWeb);
    if (!win) return void createWebWindow(`${WEB_URL}${page}`, from).focus();
    void win.loadURL(`${WEB_URL}${page}`);
    win.focus();
    return;
  }
}

/** A window on `url` of `server`'s folder; with `tabOf`, a tab of that window where the system has them (macOS). */
function createWindow(server, url, tabOf = null) {
  const win = new BrowserWindow(WINDOW_OPTIONS);
  track(win, server);
  if (tabOf && !tabOf.isDestroyed() && process.platform === 'darwin') tabOf.addTabbedWindow(win);
  void win.loadURL(url);
  return win;
}

// "Open in a new tab" (window.open) opens another window of the app, as a tab of the window it came from
// where the system has window tabs (macOS), on the same folder; links to anywhere else go to the browser.
const serverAt = (url) => [...servers.values()].find((s) => url.startsWith(`${s.origin}/`));
const webAt = (url) => {
  try {
    return new URL(url).origin === WEB_ORIGIN;
  } catch {
    return false;
  }
};
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url: target }) => {
    const opener = BrowserWindow.fromWebContents(contents);
    // A Web tab's links to the hosted app open more Web tabs (with its session, which a window opened from it keeps).
    if (isWeb(opener) ? webAt(target) : serverAt(target)) return { action: 'allow', overrideBrowserWindowOptions: WINDOW_OPTIONS };
    void shell.openExternal(target);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    if (url.startsWith('mcpdocs:')) {
      e.preventDefault();
      return handleAppLink(url, BrowserWindow.fromWebContents(contents));
    }
    if (!isWeb(BrowserWindow.fromWebContents(contents))) return;
    const u = new URL(url);
    // Google refuses to sign in inside an app's browser, so the system browser does it (googleSignIn).
    if (u.origin === WEB_ORIGIN && u.pathname === '/api/auth/google/start') {
      e.preventDefault();
      googleSignIn(u, BrowserWindow.fromWebContents(contents));
    } else if (u.origin !== WEB_ORIGIN) {
      e.preventDefault();
      void shell.openExternal(url);
    }
  });
  // The right-click menu a browser would show (desktop/contextMenu.js).
  contents.on('context-menu', (_e, params) => {
    const template = contextMenuTemplate(params, {
      copyImage: () => contents.copyImageAt(params.x, params.y),
      copyText: (text) => clipboard.writeText(text),
      saveImage: (url) => contents.downloadURL(url),
      openLink: (url) => void shell.openExternal(url),
      replaceMisspelling: (word) => contents.replaceMisspelling(word),
      learnSpelling: (word) => contents.session.addWordToSpellCheckerDictionary(word),
      inspect: app.isPackaged ? undefined : () => contents.inspectElement(params.x, params.y),
    });
    if (template.length) Menu.buildFromTemplate(template).popup({ window: BrowserWindow.fromWebContents(contents) ?? undefined });
  });
  contents.on('did-create-window', (child, { url }) => {
    const opener = BrowserWindow.fromWebContents(contents);
    const server = serverOf(opener) ?? (isWeb(opener) ? null : serverAt(url));
    if (server) track(child, server);
    else if (isWeb(opener)) trackWeb(child);
    if (process.platform === 'darwin' && opener) opener.addTabbedWindow(child);
  });
});

/**
 * Show `dir` in `win` (the window it was opened from), or in a new window (a tab of the one in front) when
 * there is none. Other windows keep their folders. `landing` is the page the window starts on.
 */
async function openFolder(dir, landing = '/', win = null) {
  const server = await serverFor(path.resolve(dir));
  rememberFolder(server.dir);
  if (win && !win.isDestroyed()) {
    attach(win, server);
    void win.loadURL(`${server.origin}${landing}`);
  } else createWindow(server, `${server.origin}${landing}`, front);
}

/**
 * Show a file that is not in the window's folder: its own folder becomes the window's (or a new tab's, with
 * no window), and the window starts on the file. One of Recents (`fromRecents`) keeps Recents as the list its
 * breadcrumbs lead back to; `back` (a query: `?backDir=…&backFolder=…`) names the folder they lead back to instead.
 */
async function openFile(file, fromRecents = true, win = null, back = '') {
  if (!isDir(path.dirname(file))) throw new Error(`"${file}" is no longer there.`);
  const extra = back.startsWith('?') ? `&${back.slice(1)}` : '';
  await openFolder(path.dirname(file), `/open?file=${encodeURIComponent(path.basename(file))}${fromRecents ? '&from=recents' : ''}${extra}`, win);
}

/**
 * Show a file the system asked the app to open (Finder): in the folder in front when it is there, else in a new tab on its own folder.
 * With `inNewTab` (a new file the watcher saw), a file in the folder in front gets a new tab on that folder too, so no tab is taken over.
 */
async function showFile(file, inNewTab = false) {
  const current = frontServer();
  const rel = current ? path.relative(current.dir, file) : '';
  const parts = rel.split(path.sep);
  if (rel && !path.isAbsolute(rel) && !parts.some((p) => p === '..')) {
    const page = `/open?file=${encodeURIComponent(parts.join('/'))}`;
    if (inNewTab) createWindow(current, `${current.origin}${page}`, front).focus();
    else showPage(page, current);
  } else await openFile(file, false);
}

/**
 * A new tab beside the window in front, on its folder, showing the list it shows: its folder within the
 * folder, or Recents. A file's page names the list it came from (client/src/listing.ts).
 */
async function newTab() {
  const win = BrowserWindow.getFocusedWindow() ?? front;
  if (isWeb(win)) return void createWebWindow(`${WEB_URL}/`, win).focus();
  const server = serverOf(win) ?? frontServer();
  if (!server) return openFolder(lastFolder() ?? app.getPath('home'));
  let listing = '/';
  try {
    listing = await win.webContents.executeJavaScript(`(() => {
      const q = new URLSearchParams(location.pathname === '/' ? location.search : sessionStorage.getItem('ui.lastListing') ?? '');
      if (q.get('recents') === '1') return '/?recents=1';
      const folder = q.get('folder');
      return folder ? '/?folder=' + encodeURIComponent(folder) : '/';
    })()`);
  } catch {
    // The top of the folder, then.
  }
  createWindow(server, `${server.origin}${listing}`, win).focus();
}

// Finder asks for a file (a double-click when the app is the file's default, Open With, a file dropped on the
// Dock icon) with open-file, which comes before the app is ready when that is what started it.
let launchFile = null;
let launchLink = null;
let started = false;
app.on('open-file', (e, file) => {
  e.preventDefault();
  if (!started) launchFile = file;
  else void showFile(file).catch((err) => dialog.showErrorBox('MCP Docs', String(err.message ?? err)));
});
// mcpdocs:// links from the system (macOS): Download to MCP Docs in a browser.
app.on('open-url', (e, url) => {
  e.preventDefault();
  if (!started) launchLink = url;
  else handleAppLink(url);
});

// --- Default app (macOS) ----------------------------------------------------------------------------------
// The app owns its own formats, but for the standard ones the system prefers Apple's apps whatever the app
// declares, so becoming their default is the person's choice, set as Get Info › Change All… would set it.
const DEFAULT_TYPES = [
  'org.openxmlformats.wordprocessingml.document',
  'org.openxmlformats.spreadsheetml.sheet',
  'com.microsoft.excel.xls',
  'org.openxmlformats.presentationml.presentation',
  'com.adobe.pdf',
  'public.comma-separated-values-text',
  'net.daringfireball.markdown',
];
const canBeDefault = () => process.platform === 'darwin' && app.isPackaged;
const defaultAskedFile = () => path.join(app.getPath('userData'), 'default-app-asked');

/**
 * Make the app (its bundle id is `build.appId` in package.json) the default for DEFAULT_TYPES, with
 * LSSetDefaultRoleHandlerForContentType through JavaScript for Automation. Each call answers 0 when it worked.
 */
function setDefaultApp() {
  const script = `ObjC.import('CoreServices');
ObjC.bindFunction('LSSetDefaultRoleHandlerForContentType', ['int', ['id', 'unsigned int', 'id']]);
${JSON.stringify(DEFAULT_TYPES)}.map((t) => $.LSSetDefaultRoleHandlerForContentType($(t), 0xFFFFFFFF, $('im.freeflow.docs'))).join(',')`;
  return new Promise((resolve, reject) =>
    execFile('osascript', ['-l', 'JavaScript', '-e', script], (e, out) => {
      if (e) return reject(e);
      const failed = out.trim().split(',').filter((code) => code !== '0').length;
      if (failed) reject(new Error(`${failed} of the ${DEFAULT_TYPES.length} file types could not be changed.`));
      else resolve();
    }),
  );
}

/** Ask, then make the app the default. `first` is the one offer at the first start, which can be declined for good. */
async function offerDefaultApp(first = false) {
  const res = await dialog.showMessageBox({
    type: 'question',
    title: 'Default App',
    message: 'Open Word, Excel, PowerPoint, PDF, CSV and Markdown files in MCP Docs?',
    detail: 'Double-clicking one of these files in Finder will open it here. You can change it back for a type with Get Info › Open with › Change All… in Finder.',
    buttons: [first ? 'Use MCP Docs' : 'Make Default', first ? 'Not Now' : 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (first) {
    try {
      writeFileSync(defaultAskedFile(), '');
    } catch {
      // Asked again next time, that's all.
    }
  }
  if (res.response !== 0) return;
  try {
    await setDefaultApp();
  } catch (e) {
    dialog.showErrorBox('MCP Docs', `The app could not be made the default: ${e.message ?? e}`);
  }
}

/** Ask for a folder and show it in `win` (the window it was asked from), or in a new tab (`inTab`, or with no window). */
async function chooseFolder(win = null, inTab = false) {
  const options = { title: 'Open folder', properties: ['openDirectory', 'createDirectory'], defaultPath: serverOf(win)?.dir ?? app.getPath('documents') };
  const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (res.canceled || !res.filePaths[0]) return false;
  await openFolder(res.filePaths[0], '/', inTab ? null : win);
  return true;
}

// Check for Updates… (desktop/updater.js). While an update downloads, the menu item shows how far it is, as do the
// windows' progress bars (the Dock icon, the taskbar button).
let updateProgress = null;
const updater = createUpdater({
  app,
  dialog,
  shell,
  onProgress: (fraction) => {
    updateProgress = fraction;
    for (const win of BrowserWindow.getAllWindows()) win.setProgressBar(fraction ?? -1);
    buildMenu();
  },
});
const checkForUpdatesItem = () =>
  updateProgress === null
    ? { label: 'Check for Updates…', click: () => void updater.check() }
    : { label: `Downloading Update… ${Math.round(updateProgress * 100)}%`, enabled: false };

function buildMenu() {
  const mac = process.platform === 'darwin';
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(mac
        ? [
            {
              role: 'appMenu',
              submenu: [
                { role: 'about' },
                checkForUpdatesItem(),
                ...(canBeDefault() ? [{ type: 'separator' }, { label: 'Make Default App…', click: () => void offerDefaultApp() }] : []),
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' },
              ],
            },
          ]
        : []),
      {
        label: 'File',
        submenu: [
          { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => void newTab().catch((e) => dialog.showErrorBox('MCP Docs', String(e.message ?? e))) },
          {
            label: 'New Window',
            accelerator: 'CmdOrCtrl+Shift+N',
            click: () => {
              if (isWeb(BrowserWindow.getFocusedWindow() ?? front)) return void createWebWindow();
              const server = frontServer();
              if (server) createWindow(server, `${server.origin}/`);
            },
          },
          { label: 'Open Web Tab', click: () => void switchTo('web', BrowserWindow.getFocusedWindow()).catch((e) => dialog.showErrorBox('MCP Docs', String(e.message ?? e))) },
          { type: 'separator' },
          // From a Web tab the folder opens in a new tab beside it: a Web tab stays one.
          { label: 'Open Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: () => void chooseFolder(isWeb(BrowserWindow.getFocusedWindow()) ? null : BrowserWindow.getFocusedWindow()).catch((e) => dialog.showErrorBox('MCP Docs', String(e.message ?? e))) },
          { label: mac ? 'Show Folder in Finder' : 'Show Folder', click: () => frontServer() && void shell.openPath(frontServer().dir) },
          { type: 'separator' },
          { label: 'Connect an Agent (MCP)…', click: () => connectAgent() },
          { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => showPage('/settings') },
          { label: 'Sign Out of Web', click: () => void signOutOfWeb() },
          { type: 'separator' },
          mac ? { role: 'close' } : { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
      ...(mac ? [] : [{ role: 'help', submenu: [checkForUpdatesItem(), { type: 'separator' }, { role: 'about' }] }]),
    ]),
  );
}

app.whenReady().then(async () => {
  webSession = session.fromPartition('persist:web');
  for (const ses of [session.defaultSession, webSession]) ses.setUserAgent(`${ses.getUserAgent()} ${UA_MARK}`);
  // The installed app handles mcpdocs:// (declared in package.json too); a copy run from a clone only when asked,
  // so it does not take the links from the installed one.
  if (app.isPackaged || process.env.MCPDOCS_SCHEME === '1') app.setAsDefaultProtocolClient('mcpdocs');
  buildMenu();
  startMcpProxy();
  if (!existsSync(path.join(root, 'dist', 'client', 'index.html'))) {
    dialog.showErrorBox('MCP Docs', 'The app has not been built yet. Run "npm run build" in the project, then start it again.');
    return app.quit();
  }
  if (!existsSync(keysCheckedFile())) {
    shellKeys = await readShellKeys();
    try {
      writeFileSync(keysCheckedFile(), '');
    } catch {
      // Looked for again next time, that's all.
    }
  }
  // electron [flags] desktop/main.js [folder]: the folder is the argument that is neither a flag nor this script.
  const arg = process.argv.slice(1).find((a) => !a.startsWith('-') && path.resolve(a) !== import.meta.filename);
  try {
    if (launchFile) {
      await openFile(launchFile, false);
      return;
    }
    if (!arg && app.isPackaged) {
      await openFolder(lastFolder() ?? app.getPath('home'));
      return;
    }
    const dir = path.resolve(arg ?? process.cwd());
    if (isDir(dir)) await openFolder(dir);
    else {
      dialog.showErrorBox('MCP Docs', `"${dir}" is not a folder. Choose a folder to open.`);
      if (!(await chooseFolder())) app.quit();
    }
  } catch (e) {
    dialog.showErrorBox('MCP Docs', `The app could not start: ${e.message ?? e}`);
    app.quit();
  } finally {
    started = true;
    if (launchLink) handleAppLink(launchLink);
    watchFolders(newFilesChosen());
    // The installed app offers once to open the standard formats too.
    if (servers.size && canBeDefault() && !existsSync(defaultAskedFile())) void offerDefaultApp(true);
  }
});

// With no window left (on macOS the app keeps running), the Dock icon opens the folder last in front.
app.on('activate', () => {
  if (started && BrowserWindow.getAllWindows().length === 0) void openFolder(lastFolder() ?? app.getPath('home')).catch((e) => dialog.showErrorBox('MCP Docs', String(e.message ?? e)));
});
// The + in the tab bar (macOS).
app.on('new-window-for-tab', () => void newTab().catch((e) => dialog.showErrorBox('MCP Docs', String(e.message ?? e))));
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('quit', () => {
  stopNewFiles?.();
  stopServers();
});
