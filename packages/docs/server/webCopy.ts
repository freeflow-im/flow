// Copying files between the desktop app's folder and the person's account on the hosted app (docs/web-and-pdf.md,
// phase 4). The two stay separate libraries: a copy is a new file, wherever it is put. The desktop app's server
// reaches the hosted app through `Web`, which desktop/main.js answers with the Web tab's session (WebBridge).
//
// Documents, presentations and spreadsheets travel as the app's own JSON, with their pictures carried across
// (each /api/images address is copied and the address changed), so nothing goes through an Office file on the
// way. Locally they are then written in the format asked for: an Office file, the app's own, or a PDF the hosted
// app makes. Markdown, CSV and stored files (PDFs, pictures, web pages, videos) are copied as they are.
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { Deck } from '../shared/deck.ts';
import type { Doc } from '../shared/doc.ts';
import { docxProblem } from '../shared/docxFormat.ts';
import { pptxGaps } from '../shared/pptxFormat.ts';
import type { DocKind, Workbook } from '../shared/types.ts';
import { xlsxProblem } from '../shared/xlsxFormat.ts';
import { titleBase } from '../shared/docNames.ts';
import { docDocx } from './docxExport.ts';
import { deckPptx, imageSource, loadFile, workbookXlsx } from './export.ts';
import type { ImageStore } from './images.ts';
import type { LocalFileStore, LocalFolder, LocalSheetStore } from './localStore.ts';
import { wroteFile } from './sheets.ts';

/** An answer of the hosted app. */
export interface WebResponse {
  status: number;
  /** Content-Type, without parameters. */
  type: string;
  /** Content-Disposition, for a download's file name. */
  disposition: string;
  body: Buffer;
}

/** Requests to the hosted app as the person signed in to the Web tab. */
export interface Web {
  fetch(method: string, path: string, body?: { type: string; data: Buffer; headers?: Record<string, string> }): Promise<WebResponse>;
}

export class WebCopyError extends Error {
  readonly signedOut: boolean;
  constructor(message: string, signedOut = false) {
    super(message);
    this.signedOut = signedOut;
  }
}

export type LibraryKind = DocKind | 'file';
/** What a web file can be downloaded as. */
export type DownloadFormat = 'office' | 'native' | 'pdf' | 'csv' | 'as-is';

export interface CopyStores {
  userId: string;
  sheets: LocalSheetStore;
  files: LocalFileStore;
  images: ImageStore;
  folder: LocalFolder;
}

const IMAGE_ADDR = /\/api\/images\/[0-9a-f-]{36}/g;
const VIDEO_ADDR = /"\/api\/files\/[0-9a-z-]+"/g;
const OFFICE_EXT: Partial<Record<DocKind, string>> = { doc: '.docx', deck: '.pptx', sheet: '.xlsx' };
const NATIVE_EXT: Record<DocKind, string> = { doc: '.ffdoc', deck: '.ffslides', sheet: '.ffsheet', markdown: '.md' };
const OFFICE_NAME: Partial<Record<DocKind, string>> = { doc: 'Word', deck: 'PowerPoint', sheet: 'Excel' };

const SIGNED_OUT = 'Sign in to MCP Docs on the web first: open a Web tab (File › Open Web Tab) and sign in.';

/** The hosted app's JSON answer, or the error it gave. */
async function call<T>(web: Web, method: string, path: string, payload?: unknown): Promise<T> {
  const res = await web.fetch(method, path, payload === undefined ? undefined : { type: 'application/json', data: Buffer.from(JSON.stringify(payload)) });
  return parse<T>(res);
}

function parse<T>(res: WebResponse): T {
  if (res.status === 401) throw new WebCopyError(SIGNED_OUT, true);
  let data: unknown = {};
  try {
    data = JSON.parse(res.body.toString('utf8'));
  } catch {
    // Not JSON: the status says it.
  }
  if (res.status >= 400) throw new WebCopyError((data as { error?: string }).error ?? `The web answered ${res.status}.`);
  return data as T;
}

/** The bytes of a download, or the error the hosted app gave. */
async function bytes(web: Web, path: string): Promise<WebResponse> {
  const res = await web.fetch('GET', path);
  if (res.status >= 400) parse(res);
  return res;
}

/** Each picture address in `json` changed to what `carry` makes of it; those it could not carry stay and are counted. */
async function carryImages(json: string, carry: (addr: string) => Promise<string | null>): Promise<{ json: string; missing: number }> {
  let missing = 0;
  for (const addr of new Set(json.match(IMAGE_ADDR) ?? [])) {
    const to = await carry(addr).catch(() => null);
    if (to) json = json.split(addr).join(to);
    else missing++;
  }
  return { json, missing };
}

function notes(json: string, missing: number): string[] {
  const videos = new Set(json.match(VIDEO_ADDR) ?? []).size;
  return [
    ...(missing ? [`${missing} picture${missing === 1 ? '' : 's'} could not be copied.`] : []),
    ...(videos ? [`${videos === 1 ? 'A video' : `${videos} videos`} in it ${videos === 1 ? 'was' : 'were'} not copied; ${videos === 1 ? 'it shows' : 'they show'} only where the file came from.`] : []),
  ];
}

/** Whether the person is signed in to the web, and as whom. */
export async function webStatus(web: Web): Promise<{ signedIn: boolean; email?: string }> {
  const res = await web.fetch('GET', '/api/auth/me');
  if (res.status >= 400) return { signedIn: false };
  const { user } = parse<{ user: { email: string } | null }>(res);
  return user ? { signedIn: true, email: user.email } : { signedIn: false };
}

/** The folders in a web folder ('' for the top). */
export async function webFolders(web: Web, folder: string): Promise<{ name: string; path: string }[]> {
  return (await call<{ folders: { name: string; path: string }[] }>(web, 'GET', `/api/library?folder=${encodeURIComponent(folder)}`)).folders;
}

// --- Upload: a file of the folder to the web --------------------------------------------------------------

/** Copy a file of the folder to a web folder. Returns the new web file and what did not come along. */
export async function uploadToWeb(web: Web, s: CopyStores, id: string, webFolder: string): Promise<{ kind: LibraryKind; id: string; title: string; warnings: string[] }> {
  const stored = s.files.get(s.userId, id);
  if (stored) {
    // Stored as it is, under its name (which says what it is: the hosted app types it from there).
    const res = await web.fetch('POST', `/api/files?folder=${encodeURIComponent(webFolder)}`, {
      type: 'application/octet-stream',
      data: await readFile(stored.file),
      headers: { 'x-filename': encodeURIComponent(stored.meta.filename) },
    });
    const { file } = parse<{ file: { id: string; filename: string } }>(res);
    return { kind: 'file', id: file.id, title: file.filename, warnings: [] };
  }
  const loaded = await loadFile(s.sheets, s.userId, id);
  if (!loaded) throw new WebCopyError('That file is no longer in the folder.');
  const { meta, data } = loaded;
  const folder = { folder: webFolder };
  if (data.kind === 'markdown') {
    const { doc } = await call<{ doc: { id: string; title: string } }>(web, 'POST', '/api/markdown', { title: titleBase(meta.title), text: data.markdown.text, ...folder });
    return { kind: 'markdown', id: doc.id, title: doc.title, warnings: [] };
  }
  const raw = data.kind === 'doc' ? data.doc : data.kind === 'deck' ? data.deck : data.workbook;
  const source = imageSource(s.images, s.userId);
  const { json, missing } = await carryImages(JSON.stringify(raw), async (addr) => {
    const img = await source.stored(addr);
    if (!img) return null;
    return (parse<{ url: string }>(await web.fetch('POST', '/api/images', { type: img.type, data: img.bytes }))).url;
  });
  const warnings = notes(json, missing);
  const content = JSON.parse(json) as unknown;
  if (data.kind === 'doc') {
    const { doc } = await call<{ doc: { id: string; title: string } }>(web, 'POST', '/api/docs', { title: titleBase(meta.title), doc: content, ...folder });
    return { kind: 'doc', id: doc.id, title: doc.title, warnings };
  }
  if (data.kind === 'deck') {
    const { deck } = await call<{ deck: { id: string; title: string } }>(web, 'POST', '/api/decks', { title: titleBase(meta.title), deck: content, ...folder });
    return { kind: 'deck', id: deck.id, title: deck.title, warnings };
  }
  const { sheet } = await call<{ sheet: { id: string; title: string; updatedAt: string } }>(web, 'POST', '/api/sheets', { title: titleBase(meta.title), ...folder });
  await call(web, 'PUT', `/api/sheets/${encodeURIComponent(sheet.id)}`, { workbook: content, rev: sheet.updatedAt });
  return { kind: 'sheet', id: sheet.id, title: sheet.title, warnings };
}

// --- Download: a web file into the folder -----------------------------------------------------------------

/** What the download dialog offers for a web file: its formats, and what an Office file of it would not hold. */
export async function webPreview(web: Web, kind: LibraryKind, id: string): Promise<{ formats: DownloadFormat[]; officeLosses: string[] }> {
  if (kind === 'file' || kind === 'markdown') return { formats: ['as-is'], officeLosses: [] };
  const raw = parse<unknown>(await bytes(web, `/api/files/${encodeURIComponent(id)}/export?format=json`));
  const officeLosses = kind === 'doc' ? [docxProblem(raw as Doc)].filter((p): p is string => !!p) : kind === 'deck' ? pptxGaps(raw as Deck) : [xlsxProblem(raw as Workbook)].filter((p): p is string => !!p);
  return { formats: kind === 'sheet' ? ['office', 'csv', 'native'] : ['office', 'native', 'pdf'], officeLosses };
}

/** The file name a download gave, without its extension. */
function nameOf(res: WebResponse, fallback: string): { base: string; ext: string } {
  const star = /filename\*=UTF-8''([^;]+)/i.exec(res.disposition)?.[1];
  const plain = /filename="([^"]+)"/i.exec(res.disposition)?.[1];
  let name = fallback;
  try {
    name = star ? decodeURIComponent(star) : (plain ?? fallback);
  } catch {
    // The fallback, then.
  }
  const m = /^(.*?)(\.[A-Za-z0-9]{1,8})?$/.exec(name)!;
  return { base: m[1] || 'Untitled', ext: m[2] ?? '' };
}

/** Copy a web file into a folder of the open folder, in `format`. Returns the new local file. */
export async function downloadFromWeb(
  web: Web,
  s: CopyStores,
  file: { kind: LibraryKind; id: string; title?: string },
  folder: string,
  format: DownloadFormat,
): Promise<{ kind: LibraryKind; id: string; title: string; warnings: string[] }> {
  const id = encodeURIComponent(file.id);
  let rel: string;
  let warnings: string[] = [];
  if (file.kind === 'file') {
    const res = await bytes(web, `/api/files/${id}/download`);
    const { base, ext } = nameOf(res, file.title ?? 'file');
    rel = s.folder.freePath(folder, base, ext);
    await writeFile(s.folder.abs(rel), res.body);
  } else if (file.kind === 'markdown') {
    const res = await bytes(web, `/api/files/${id}/export?format=md`);
    rel = s.folder.freePath(folder, file.title ?? nameOf(res, 'Untitled').base, '.md');
    await writeFile(s.folder.abs(rel), res.body);
  } else if (format === 'pdf' || format === 'csv') {
    const res = await bytes(web, `/api/files/${id}/export?format=${format}`);
    rel = s.folder.freePath(folder, file.title ?? nameOf(res, 'Untitled').base, `.${format}`);
    await writeFile(s.folder.abs(rel), res.body);
  } else {
    const res = await bytes(web, `/api/files/${id}/export?format=json`);
    const title = file.title ?? nameOf(res, 'Untitled').base;
    const carried = await carryImages(res.body.toString('utf8'), async (addr) => {
      const img = await web.fetch('GET', addr);
      if (img.status !== 200 || !img.type.startsWith('image/')) return null;
      return s.images.createOnce(s.userId, img.type, img.body);
    });
    warnings = notes(carried.json, carried.missing);
    const raw = JSON.parse(carried.json) as unknown;
    if (format === 'native') {
      rel = s.folder.freePath(folder, title, NATIVE_EXT[file.kind]);
      await writeFile(s.folder.abs(rel), JSON.stringify(raw));
    } else {
      const source = imageSource(s.images, s.userId);
      const out =
        file.kind === 'doc'
          ? await docDocx(raw as Doc, title, async (src) => {
              const img = await source.stored(src);
              return img && { type: img.type, data: img.bytes };
            })
          : file.kind === 'deck'
            ? await deckPptx(raw as Deck, title, source)
            : await workbookXlsx(raw as Workbook, title);
      rel = s.folder.freePath(folder, title, OFFICE_EXT[file.kind]!);
      await writeFile(s.folder.abs(rel), out);
      const lost = file.kind === 'doc' ? [docxProblem(raw as Doc)] : file.kind === 'deck' ? pptxGaps(raw as Deck) : [xlsxProblem(raw as Workbook)];
      const gone = lost.filter((p): p is string => !!p);
      if (gone.length) warnings.push(`Not kept in the ${OFFICE_NAME[file.kind]} file: ${gone.join(', ')}.`);
    }
  }
  wroteFile(s.folder.abs(rel));
  // The folder's lists pick the new file up; its id is the one they give it.
  s.sheets.listIn(s.userId, folder);
  s.files.listIn(s.userId, folder);
  const sheetId = s.sheets.idOf(s.userId, rel);
  if (sheetId) return { kind: s.sheets.get(s.userId, sheetId)!.kind, id: sheetId, title: s.sheets.get(s.userId, sheetId)!.title, warnings };
  const fileId = s.files.idOf(s.userId, rel);
  if (fileId) return { kind: 'file', id: fileId, title: s.files.get(s.userId, fileId)!.meta.filename, warnings };
  throw new WebCopyError(`The file was saved as ${rel}, but the folder did not list it.`);
}

// --- The desktop app ----------------------------------------------------------------------------------------

/** A request to the desktop app's main process (desktop/main.js), made with the Web tab's session. */
export type WebRequest = { web: string; method: string; path: string; type?: string; headers?: Record<string, string>; data?: string };
export type WebAnswer = { webDone: string; status?: number; type?: string; disposition?: string; data?: string; error?: string };

/**
 * `Web` for the desktop app's server: the main process makes the request with the Web tab's session (so the
 * person's web sign-in never reaches this server) and answers through `answer`, which desktop/server.ts calls
 * with each message from it.
 */
export class WebBridge implements Web {
  private pending = new Map<string, { resolve: (r: WebResponse) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private send: (msg: WebRequest) => void;

  constructor(send: (msg: WebRequest) => void) {
    this.send = send;
  }

  fetch(method: string, path: string, body?: { type: string; data: Buffer; headers?: Record<string, string> }): Promise<WebResponse> {
    const id = randomBytes(8).toString('hex');
    return new Promise<WebResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new WebCopyError('The web did not answer in time. Check the connection and try again.'));
      }, 120_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ web: id, method, path, ...(body ? { type: body.type, headers: body.headers, data: body.data.toString('base64') } : {}) });
    });
  }

  answer(msg: WebAnswer): void {
    const p = this.pending.get(msg.webDone);
    if (!p) return;
    this.pending.delete(msg.webDone);
    clearTimeout(p.timer);
    if (msg.error !== undefined) p.reject(new WebCopyError(msg.error));
    else p.resolve({ status: msg.status ?? 502, type: msg.type ?? '', disposition: msg.disposition ?? '', body: Buffer.from(msg.data ?? '', 'base64') });
  }
}
