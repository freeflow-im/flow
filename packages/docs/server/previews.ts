// Previews: a file shown read-only for a while, without becoming one of the user's files. FreeFlow Mail opens an
// attachment through one (packages/edge/src/routes/docs.ts fetches the bytes from the person's Mail object and posts
// them here): a Word, Excel or PowerPoint file, CSV or Markdown is converted by the importers into what Docs' read-only
// views show, and a PDF is kept as it is for Docs' PDF view. A preview is its owner's only, is not in the library, Recents
// or search, and is gone an hour after it was last asked for (swept on each use, and by the Docs object's alarm on the
// Worker). Save to Docs imports its bytes as a real file in the user's My files, at the top.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from '#runtime/fsp';
import { rawBody } from './rawBody.ts';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from '#runtime/http';
import { CsvError, csvToWorkbook, MAX_CSV_CHARS } from '../shared/csv.ts';
import type { Deck } from '../shared/deck.ts';
import type { Doc } from '../shared/doc.ts';
import { MAX_MARKDOWN_CHARS } from '../shared/markdown.ts';
import type { Workbook } from '../shared/types.ts';
import type { DB } from './db.ts';
import { importBytes, ImportFileError, type ImportStores } from './importFile.ts';
import { isPdf } from './pdfMarkdown.ts';
import { scopeOf } from './scope.ts';
import { ImportError } from './xlsxImport.ts';
import { MAX_OFFICE_ENTRY_BYTES, ZipError, zipOfficeView } from './zipView.ts';

/** How long a preview lasts after it was made or last reused. */
export const PREVIEW_TTL_MS = 60 * 60 * 1000;
/** The largest file previewed at all (an Office file's own limit, MAX_OFFICE_ENTRY_BYTES, is lower). */
export const MAX_PREVIEW_BYTES = 25 * 1024 * 1024;

/** What a preview shows: one of Docs' read-only views, a PDF, or nothing (`file`: kept only to be saved to Docs). */
export type PreviewKind = 'doc' | 'deck' | 'sheet' | 'markdown' | 'pdf' | 'file';

export type PreviewView =
  | { kind: 'doc'; doc: Doc; warnings: string[] }
  | { kind: 'deck'; deck: Deck; warnings: string[] }
  | { kind: 'sheet'; workbook: Workbook; warnings: string[] }
  | { kind: 'markdown'; text: string }
  | { kind: 'pdf'; url: string }
  | { kind: 'file' };

/** A preview saved to Docs: the file it became. `path` is its page in the Docs app ("/doc/<id>"). */
export interface SavedPreview {
  kind: 'doc' | 'deck' | 'sheet' | 'markdown' | 'file';
  id: string;
  title: string;
  path: string;
}

export interface PreviewInfo {
  id: string;
  kind: PreviewKind;
  filename: string;
  type: string;
  size: number;
  /** Epoch milliseconds. */
  expiresAt: number;
  saved?: SavedPreview;
}

/** A preview that cannot be made or used, with the status and a message for the user. */
export class PreviewError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const OFFICE_TYPES: Record<string, PreviewKind> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'doc',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'deck',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'sheet',
  'application/vnd.ms-excel': 'sheet',
  'text/csv': 'sheet',
  'text/markdown': 'markdown',
};

/** The kind of preview for a file, by its bytes (a PDF), its name's extension, then its stated type. */
export function previewKindOf(filename: string, type: string, bytes: Buffer): PreviewKind {
  if (isPdf(bytes)) return 'pdf';
  const name = filename.toLowerCase();
  if (name.endsWith('.docx')) return 'doc';
  if (name.endsWith('.pptx')) return 'deck';
  if (/\.(xlsx|xls|csv)$/.test(name)) return 'sheet';
  if (/\.(md|markdown)$/.test(name)) return 'markdown';
  if (/\.[a-z0-9]{1,8}$/.test(name)) return 'file';
  return OFFICE_TYPES[type.split(';')[0].trim().toLowerCase()] ?? 'file';
}

/** The name the importers are given: the file's own, with the extension its kind needs when it has another. */
function importName(filename: string, kind: PreviewKind, type: string): string {
  const csv = /\.csv$/i.test(filename) || type.startsWith('text/csv');
  const ext = { doc: '.docx', deck: '.pptx', sheet: csv ? '.csv' : /\.xls$/i.test(filename) ? '.xls' : '.xlsx', markdown: '.md', pdf: '.pdf', file: '' }[kind];
  return !ext || filename.toLowerCase().endsWith(ext) ? filename : `${filename.replace(/\.[^.]*$/, '') || 'attachment'}${ext}`;
}

const tooLarge = (what: string, max: number) => new PreviewError(413, `This ${what} is too large to preview (${Math.round(max / 1024 / 1024)} MB maximum). Download it instead.`);

/** The text of a text file (UTF-8, no byte order mark); refuses bytes that are not text. */
function textOf(bytes: Buffer): string {
  if (bytes.includes(0)) throw new PreviewError(400, 'This file is not a text file.');
  return bytes.toString('utf8').replace(/^﻿/, '');
}

/** Convert a file for its preview, within the importers' limits. Nothing is stored and nothing in the file runs. */
export async function convertForPreview(filename: string, type: string, kind: PreviewKind, bytes: Buffer): Promise<Exclude<PreviewView, { kind: 'pdf' } | { kind: 'file' }> | null> {
  if (bytes.length > MAX_PREVIEW_BYTES) throw tooLarge('file', MAX_PREVIEW_BYTES);
  try {
    if (kind === 'doc' || kind === 'deck' || (kind === 'sheet' && !/\.csv$/i.test(importName(filename, kind, type)))) {
      if (bytes.length > MAX_OFFICE_ENTRY_BYTES) throw tooLarge(kind === 'doc' ? 'document' : kind === 'deck' ? 'presentation' : 'spreadsheet', MAX_OFFICE_ENTRY_BYTES);
      return await zipOfficeView(importName(filename, kind, type), bytes);
    }
    if (kind === 'sheet') {
      const csv = textOf(bytes);
      if (csv.length > MAX_CSV_CHARS) throw tooLarge('CSV file', MAX_CSV_CHARS);
      return { kind: 'sheet', workbook: csvToWorkbook(csv), warnings: [] };
    }
    if (kind === 'markdown') {
      const text = textOf(bytes);
      if (text.length > MAX_MARKDOWN_CHARS) throw tooLarge('Markdown file', MAX_MARKDOWN_CHARS);
      return { kind: 'markdown', text };
    }
  } catch (e) {
    if (e instanceof PreviewError) throw e;
    if (e instanceof ImportError || e instanceof CsvError || e instanceof ZipError) throw new PreviewError(400, e.message);
    throw new PreviewError(400, `“${filename}” could not be read. It may be damaged, or not the kind of file its name says.`);
  }
  return null;
}

interface PreviewRow {
  id: string;
  owner_id: string;
  workspace_id: string | null;
  source_key: string | null;
  filename: string;
  type: string;
  kind: PreviewKind;
  size: number;
  created_at: number;
  expires_at: number;
  saved: string | null;
}

const toInfo = (r: PreviewRow): PreviewInfo => ({
  id: r.id,
  kind: r.kind,
  filename: r.filename,
  type: r.type,
  size: r.size,
  expiresAt: r.expires_at,
  ...(r.saved ? { saved: JSON.parse(r.saved) as SavedPreview } : {}),
});

export const PREVIEW_ID_RE = /^[A-Za-z0-9_-]{24}$/;

export class Previews {
  private readonly db: DB;
  /** Where the bytes and converted views are kept: `<id>` and `<id>.json`. */
  private readonly dir: string;
  private readonly now: () => number;

  constructor(db: DB, dir: string, now: () => number = Date.now) {
    this.db = db;
    this.dir = dir;
    this.now = now;
    db.exec(`
      CREATE TABLE IF NOT EXISTS previews (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        workspace_id TEXT,
        source_key TEXT,
        filename TEXT NOT NULL,
        type TEXT NOT NULL,
        kind TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        saved TEXT
      );
      CREATE INDEX IF NOT EXISTS previews_source ON previews(owner_id, source_key);
      CREATE INDEX IF NOT EXISTS previews_expiry ON previews(expires_at);
    `);
  }

  private row(id: string): PreviewRow | undefined {
    return this.db.prepare('SELECT * FROM previews WHERE id = ?').get(id) as PreviewRow | undefined;
  }

  /** A preview of its owner's that has not expired; anyone else's, or an expired one, is as if it did not exist. */
  get(ownerId: string, id: string): PreviewInfo | null {
    if (!PREVIEW_ID_RE.test(id)) return null;
    const r = this.row(id);
    return r && r.owner_id === ownerId && r.expires_at > this.now() ? toInfo(r) : null;
  }

  /** The owner's live preview of a source (`mail:<account>:<folder>:<uid>:<index>`), given another hour. */
  reuse(ownerId: string, workspaceId: string | null, sourceKey: string): PreviewInfo | null {
    const r = this.db.prepare('SELECT * FROM previews WHERE owner_id = ? AND source_key = ? AND workspace_id IS ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1').get(ownerId, sourceKey, workspaceId, this.now()) as PreviewRow | undefined;
    if (!r) return null;
    const expires = this.now() + PREVIEW_TTL_MS;
    this.db.prepare('UPDATE previews SET expires_at = ? WHERE id = ?').run(expires, r.id);
    return toInfo({ ...r, expires_at: expires });
  }

  /** Make a preview of a file: converted now, so a file the importers refuse is refused here, with their reason. */
  async create(ownerId: string, workspaceId: string | null, input: { filename: string; type: string; bytes: Buffer; sourceKey?: string | null }): Promise<PreviewInfo> {
    await this.sweep();
    const filename = input.filename.replace(/[\\/\u0000-\u001f]/g, '_').trim().slice(0, 200) || 'attachment';
    const type = input.type.split(';')[0].trim().toLowerCase().slice(0, 200) || 'application/octet-stream';
    if (input.bytes.length > MAX_PREVIEW_BYTES) throw tooLarge('file', MAX_PREVIEW_BYTES);
    const kind = previewKindOf(filename, type, input.bytes);
    const view = await convertForPreview(filename, type, kind, input.bytes);
    const id = randomBytes(18).toString('base64url');
    await mkdir(this.dir, { recursive: true });
    await writeFile(path.join(this.dir, id), input.bytes);
    if (view) await writeFile(path.join(this.dir, `${id}.json`), JSON.stringify(view));
    const now = this.now();
    this.db
      .prepare('INSERT INTO previews (id, owner_id, workspace_id, source_key, filename, type, kind, size, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, ownerId, workspaceId, input.sourceKey ?? null, filename, type, kind, input.bytes.length, now, now + PREVIEW_TTL_MS);
    return toInfo(this.row(id)!);
  }

  /** What the preview page shows. */
  async view(ownerId: string, id: string, fileUrl: string): Promise<PreviewView | null> {
    const p = this.get(ownerId, id);
    if (!p) return null;
    if (p.kind === 'pdf') return { kind: 'pdf', url: fileUrl };
    if (p.kind === 'file') return { kind: 'file' };
    return JSON.parse(await readFile(path.join(this.dir, `${id}.json`), 'utf8')) as PreviewView;
  }

  /** The file's own bytes. */
  async bytes(ownerId: string, id: string): Promise<Buffer | null> {
    return this.get(ownerId, id) ? readFile(path.join(this.dir, id)) : null;
  }

  markSaved(id: string, saved: SavedPreview): void {
    this.db.prepare('UPDATE previews SET saved = ? WHERE id = ?').run(JSON.stringify(saved), id);
  }

  /** Remove expired previews and their files; the time the next one expires, if any is left (for the alarm). */
  async sweep(): Promise<number | null> {
    const gone = this.db.prepare('SELECT id FROM previews WHERE expires_at <= ?').all(this.now()) as { id: string }[];
    for (const { id } of gone) {
      await rm(path.join(this.dir, id), { force: true }).catch(() => {});
      await rm(path.join(this.dir, `${id}.json`), { force: true }).catch(() => {});
      this.db.prepare('DELETE FROM previews WHERE id = ?').run(id);
    }
    const next = this.db.prepare('SELECT MIN(expires_at) AS at FROM previews').get() as { at: number | null } | undefined;
    return next?.at ?? null;
  }
}

/** Each kind's page in the Docs app. */
const PAGE_OF = { doc: 'doc', deck: 'd', sheet: 's', markdown: 'md', file: 'f' } as const;

/**
 * The routes, for a signed-in user (`requireUser` has set `req.scope`, whose organization the preview is made in).
 *   GET  /api/previews?key=        the user's live preview of that source, or null
 *   POST /api/previews?filename=&type=&key=   the file's bytes as the body: make one
 *   GET  /api/previews/:id         its info and view
 *   GET  /api/previews/:id/file    its bytes (a PDF for pdf.js)
 *   POST /api/previews/:id/save    import it into My files (at the top), once
 */
export function previewRoutes(r: FastifyInstance, opts: { previews: Previews; stores: ImportStores; basePath: string; exists(req: FastifyRequest, saved: SavedPreview): boolean }): void {
  const { previews } = opts;
  const owner = (req: FastifyRequest) => req.user!.id;
  const workspaceOf = (req: FastifyRequest) => scopeOf(req.scope).workspaceId;
  const failed = (reply: FastifyReply, e: unknown) => {
    if (e instanceof PreviewError) return reply.code(e.status).send({ error: e.message });
    if (e instanceof ImportFileError) return reply.code(400).send({ error: e.message });
    throw e;
  };
  const gone = (reply: FastifyReply) => reply.code(404).send({ error: 'This preview has expired or does not exist. Open the attachment again.' });
  const q = (req: FastifyRequest) => (req.query ?? {}) as Record<string, unknown>;
  const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');
  const withPage = (s: SavedPreview) => ({ ...s, url: `${opts.basePath}${s.path}` });
  const shown = (p: PreviewInfo) => ({ ...p, ...(p.saved ? { saved: withPage(p.saved) } : {}) });
  // Set before the handler: the Worker's runtime has no onSend hook (packages/edge/src/docs/runtime/fastify.ts).
  r.addHook('preHandler', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Robots-Tag', 'noindex');
  });

  r.get('/api/previews', async (req) => {
    await previews.sweep();
    const key = str(q(req).key);
    const p = key ? previews.reuse(owner(req), workspaceOf(req), key) : null;
    return { preview: p ? shown(p) : null };
  });

  r.post('/api/previews', async (req, reply) => {
    const body = rawBody(req);
    if (!body || !body.length) return reply.code(400).send({ error: 'Send the file’s bytes as the body.' });
    try {
      const p = await previews.create(owner(req), workspaceOf(req), { filename: str(q(req).filename, 300), type: str(q(req).type, 200), bytes: body, sourceKey: str(q(req).key) || null });
      return { preview: shown(p) };
    } catch (e) {
      return failed(reply, e);
    }
  });

  r.get('/api/previews/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = previews.get(owner(req), id);
    const view = p ? await previews.view(owner(req), id, `/api/previews/${id}/file`) : null;
    if (!p || !view) return gone(reply);
    return { preview: shown(p), view };
  });

  r.get('/api/previews/:id/file', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = previews.get(owner(req), id);
    const bytes = p ? await previews.bytes(owner(req), id) : null;
    if (!p || !bytes) return gone(reply);
    // Only a PDF, for pdf.js to read; opened by itself, nothing in it may run.
    return reply
      .header('Content-Type', p.kind === 'pdf' ? 'application/pdf' : 'application/octet-stream')
      .header('Content-Disposition', 'attachment')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "sandbox; default-src 'none'")
      .send(bytes);
  });

  r.post('/api/previews/:id/save', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = previews.get(owner(req), id);
    if (!p) return gone(reply);
    if (p.saved && opts.exists(req, p.saved)) return { preview: shown(p), saved: withPage(p.saved) };
    const bytes = await previews.bytes(owner(req), id);
    if (!bytes) return gone(reply);
    try {
      const made = await importBytes(opts.stores, req.scope, bytes, importName(p.filename, p.kind, p.type), undefined);
      const saved: SavedPreview = made.sheet
        ? { kind: made.sheet.kind, id: made.sheet.id, title: made.sheet.title, path: `/${PAGE_OF[made.sheet.kind]}/${made.sheet.id}` }
        : { kind: 'file', id: made.file!.id, title: made.file!.filename, path: `/f/${made.file!.id}` };
      previews.markSaved(id, saved);
      return { preview: shown({ ...p, saved }), saved: withPage(saved) };
    } catch (e) {
      return failed(reply, e);
    }
  });
}
