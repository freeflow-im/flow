// The desktop app's server: the same app as the hosted one, serving the built client, with a folder on
// this machine as its library (AppOptions.local). Started by desktop/main.js as a child process, which
// tells it the folder (LOCAL_DIR), where to keep its own data (DATA_DIR) and the token its window sends
// (LOCAL_TOKEN), and is told the port once the server is listening.
import '../server/env.ts';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildApp, type LocalAgents } from '../server/app.ts';
import { spotlightFind } from '../server/localStore.ts';
import { onOwnWrite } from '../server/sheets.ts';
import { ElectronRenderer, type PdfAnswer } from '../server/pdf.ts';
import { WebBridge, type WebAnswer } from '../server/webCopy.ts';
import type { NewFilesSettings, NewFilesUpdate } from '../shared/types.ts';

const root = path.resolve(import.meta.dirname, '..');
const dir = process.env.LOCAL_DIR;
const dataDir = process.env.DATA_DIR;
if (!dir || !dataDir) throw new Error('LOCAL_DIR and DATA_DIR are required');
// Settings of a hosted deployment that may be in a developer's .env and make no sense here.
delete process.env.APP_URL;
delete process.env.LEGACY_HOSTS;

mkdirSync(dataDir, { recursive: true });
// PDFs are printed by the app's main process in a hidden window (Electron is a browser already); run on its
// own, the server uses Playwright's Chromium as the hosted app does.
const send = process.send?.bind(process);
const pdf = send ? new ElectronRenderer((msg) => send(msg)) : undefined;
if (pdf) process.on('message', (msg: Partial<PdfAnswer> | null) => typeof msg?.pdfDone === 'string' && pdf.answer(msg as PdfAnswer));
// The person's account on the web, which the main process reaches with the Web tab's session (Upload to Web,
// Download to Folder).
const web = send ? new WebBridge((msg) => send(msg)) : undefined;
if (web) process.on('message', (msg: Partial<WebAnswer> | null) => typeof msg?.webDone === 'string' && web.answer(msg as WebAnswer));
// Settings asks main.js for what is its: the agents connected to the app's MCP server (it signs them in), to
// disconnect one, and whether new files in Downloads, Documents and Desktop open (it watches them); and waits
// for its answer.
const asked = new Map<string, (answer: unknown) => void>();
if (send) process.on('message', (msg: { askDone?: string; answer?: unknown } | null) => typeof msg?.askDone === 'string' && asked.get(msg.askDone)?.(msg.answer));
const askMain = <T,>(msg: object): Promise<T> =>
  new Promise((resolve, reject) => {
    const id = randomBytes(8).toString('hex');
    const timer = setTimeout(() => (asked.delete(id), reject(new Error('The app did not answer.'))), 10_000);
    asked.set(id, (answer) => (asked.delete(id), clearTimeout(timer), resolve(answer as T)));
    send!({ ...msg, ask: id });
  });
const agents: LocalAgents | undefined = send && process.env.MCP_TOKEN ? { list: () => askMain({ list: true }), disconnect: (id) => askMain({ disconnect: id }) } : undefined;
const newFiles = send ? { get: () => askMain<NewFilesSettings>({ newFiles: true }), set: (update: NewFilesUpdate) => askMain<NewFilesSettings>({ newFiles: update }) } : undefined;
// The files the app writes are not new files for main.js to open.
if (send) onOwnWrite((file) => send({ wrote: file }));
const app = await buildApp({
  dataDir,
  staticDir: path.join(root, 'dist', 'client'),
  // A file outside the folder (one of Recents) is opened by the app, which serves its folder instead.
  local: {
    dir,
    token: process.env.LOCAL_TOKEN || undefined,
    cookie: process.env.LOCAL_COOKIE || undefined,
    openFile: (file, fromRecents = true, back) => process.send?.({ openFile: file, fromRecents, back }),
    openFileInTab: (file) => process.send?.({ openFileInTab: file }),
    openFolder: (dir, inTab = false, folder) => process.send?.({ openFolder: dir, inTab, folder }),
    chooseFolder: (inTab = false) => process.send?.({ chooseFolder: true, inTab }),
    agents,
    newFiles,
    reveal: (target) => process.send?.({ reveal: target }),
    startDrag: (file) => process.send?.({ drag: file }),
    // A search asks Spotlight before it walks the folder.
    findByName: process.platform === 'darwin' ? spotlightFind : null,
    web,
    // The MCP server for agents on this machine (MCP_TOKEN; MCP_URL is main.js's fixed port in front of it).
    // What the model opens is shown in the window, which main.js does.
    ...(process.env.MCP_TOKEN ? { mcp: { token: process.env.MCP_TOKEN, url: process.env.MCP_URL || undefined, show: (page: string) => process.send?.({ show: page }), changed: (id: string) => process.send?.({ fileChanged: id }) } } : {}),
    // The assistant's settings are the app's (APP_DATA_DIR), shared by every folder; on the first run a key
    // already in the user's environment (main.js passes on the login shell's) is used.
    settingsDir: process.env.APP_DATA_DIR || undefined,
    env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY },
  },
  blob: null,
  pdf,
});
// Loopback only, on a port the system picks unless one is given.
await app.listen({ port: Number(process.env.PORT ?? 0), host: '127.0.0.1' });
const address = app.server.address();
const port = typeof address === 'object' && address ? address.port : 0;
if (process.send) process.send({ port });
else console.log(`Serving ${dir} at http://127.0.0.1:${port}`);

const close = () => {
  app.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.once('SIGTERM', close);
process.once('SIGINT', close);
// The window is gone: finish in-flight saves and stop.
process.once('disconnect', close);
