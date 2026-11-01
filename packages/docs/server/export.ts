// Exports: one file in a readable format (GET /api/files/:id/export?format=...) and the whole account as a
// zip (GET /api/export.zip), or one folder of it (GET /api/folders/download). Documents export as Markdown, presentations as PowerPoint, spreadsheets as CSV
// (one tab) or Excel, and every kind as its native JSON. Images stored on the server go into the zip's
// images/ folder, and Markdown exports point at them with relative paths.
import { addChartsToXlsx } from './xlsxCharts.ts';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { workbookToCsv } from '../shared/csv.ts';
import type { Node as PMNode } from 'prosemirror-model';
import type { Deck } from '../shared/deck.ts';
import { docSchema, type Doc } from '../shared/doc.ts';
import { docToMarkdown } from '../shared/docMarkdown.ts';
import type { MarkdownDoc } from '../shared/markdown.ts';
import { cellKey } from '../shared/cellref.ts';
import { Engine } from '../shared/formula/engine.ts';
import { writePptx } from '../shared/pptxExport.ts';
import { STORED_IMAGE_RE, type CellStyle, type DocKind, type SheetMeta, type Tab, type Workbook } from '../shared/types.ts';
import { formatValue, isError, type Scalar } from '../shared/values.ts';
import type { FileStore } from './files.ts';
import { folderName } from '../shared/folders.ts';
import type { Folders } from './folders.ts';
import type { ImageStore } from './images.ts';
import type { SheetStore } from './sheets.ts';
import { titleBase } from '../shared/docNames.ts';

export type ExportFormat = 'json' | 'md' | 'pptx' | 'csv' | 'xlsx';

/** Formats each kind can export to; the first is the readable default. */
export const EXPORT_FORMATS: Record<DocKind, ExportFormat[]> = {
  doc: ['md', 'json'],
  markdown: ['md', 'json'],
  deck: ['pptx', 'json'],
  sheet: ['xlsx', 'csv', 'json'],
};

const MIME: Record<ExportFormat, string> = {
  json: 'application/json',
  md: 'text/markdown; charset=utf-8',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

export interface ExportedFile {
  name: string;
  type: string;
  body: Buffer;
}

export class ExportError extends Error {}

/** A file name that is safe on every platform. */
export function safeName(title: string, ext: string): string {
  // A title that is a file name already (the desktop app's) does not keep that extension (shared/docNames.ts).
  const base = titleBase(title).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().replace(/\.+$/, '').slice(0, 120) || 'Untitled';
  return `${base}.${ext}`;
}

/** Resolves image addresses for an export: stored images to their bytes, anything else to null. */
export interface ImageSource {
  /** Bytes and type of a stored image ("/api/images/<id>") the owner may read, or null. */
  stored(src: string): Promise<{ type: string; bytes: Buffer } | null>;
}

export function imageSource(images: ImageStore, ownerId: string): ImageSource {
  return {
    async stored(src) {
      if (!STORED_IMAGE_RE.test(src)) return null;
      const img = images.get(ownerId, src.slice('/api/images/'.length));
      if (!img) return null;
      try {
        return { type: img.type, bytes: await readFile(img.file) };
      } catch {
        return null;
      }
    },
  };
}

/** Image loader for PowerPoint export: stored images and data URLs; web images are fetched. */
function pptxImageLoader(source: ImageSource): (src: string) => Promise<string | null> {
  return async (src) => {
    if (src.startsWith('data:')) return src;
    const stored = await source.stored(src);
    if (stored) return `data:${stored.type};base64,${stored.bytes.toString('base64')}`;
    if (!/^https?:/i.test(src)) return null;
    try {
      const res = await fetch(src, { signal: AbortSignal.timeout(10_000) });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !type.startsWith('image/')) return null;
      return `data:${type.split(';')[0]};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
    } catch {
      return null;
    }
  };
}

// --- Documents --------------------------------------------------------------------------

export function docNode(doc: Doc): PMNode {
  return docSchema.nodeFromJSON(doc.content);
}

/** Stored image addresses in a document, in order of appearance. */
export function docImages(doc: Doc): string[] {
  const out: string[] = [];
  docNode(doc).descendants((n) => {
    if (n.type.name === 'image' && typeof n.attrs.src === 'string' && STORED_IMAGE_RE.test(n.attrs.src)) out.push(n.attrs.src);
  });
  return out;
}

/** Stored image addresses in a presentation. */
export function deckImages(deck: Deck): string[] {
  const out: string[] = [];
  for (const s of deck.slides) for (const e of s.elements) if (e.type === 'image' && STORED_IMAGE_RE.test(e.src)) out.push(e.src);
  return out;
}

/** Stored image addresses in a workbook. */
export function sheetImages(wb: Workbook): string[] {
  const out: string[] = [];
  for (const t of wb.tabs) for (const c of Object.values(t.cells)) if (c.img && STORED_IMAGE_RE.test(c.img)) out.push(c.img);
  return out;
}

/** The document as Markdown; `rewrite` maps stored image addresses to the paths an export uses. */
export function docMarkdown(doc: Doc, rewrite?: (src: string) => string): string {
  let md = docToMarkdown(docNode(doc));
  if (rewrite) md = md.replace(/\(\/api\/images\/[0-9a-f-]{36}\)/g, (m) => `(${rewrite(m.slice(1, -1))})`);
  return md;
}

// --- Spreadsheets -----------------------------------------------------------------------

function display(engine: Engine, tab: Tab, r: number, c: number): string {
  const cell = tab.cells[cellKey(r, c)];
  if (!cell) return '';
  const v = engine.getValue(tab.id, r, c);
  const implied = typeof v === 'number' ? engine.getImpliedFormat(tab.id, r, c) : undefined;
  return formatValue(v, cell.st, implied);
}

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** One tab as CSV, with values as displayed. */
export function tabCsv(wb: Workbook, tab: Tab, engine = new Engine(wb)): string {
  const ext = engine.extent(tab.id);
  const rows: string[] = [];
  for (let r = 0; r < ext.rows; r++) {
    const row: string[] = [];
    for (let c = 0; c < ext.cols; c++) row.push(csvCell(display(engine, tab, r, c)));
    rows.push(row.join(','));
  }
  return rows.join('\n');
}

const argb = (hex: string): string | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  return m ? `FF${m[1].toUpperCase()}` : null;
};

function numFmt(st: CellStyle | undefined, implied: { fmt?: string; dp?: number } | undefined): string | undefined {
  const fmt = st?.fmt ?? implied?.fmt;
  const dp = st?.dp ?? implied?.dp ?? 2;
  const dec = dp > 0 ? '.' + '0'.repeat(dp) : '';
  switch (fmt) {
    case 'number':
      return `#,##0${dec}`;
    case 'currency':
      return `"$"#,##0${dec}`;
    case 'percent':
      return `0${dec}%`;
    case 'date':
      return 'yyyy-mm-dd';
    case 'time':
      return 'h:mm:ss';
    case 'datetime':
      return 'yyyy-mm-dd h:mm';
    case 'text':
      return '@';
    default:
      return undefined;
  }
}

/** A cell's value for Excel: the formula, or the literal the engine parsed from the input. */
function xlsxValue(engine: Engine, tab: Tab, r: number, c: number, raw: string): ExcelJS.CellValue {
  if (raw.startsWith('=')) {
    const result = engine.getValue(tab.id, r, c);
    return { formula: raw.slice(1), result: isError(result) ? undefined : (result as number | string | boolean) ?? undefined };
  }
  if (raw.startsWith("'")) return raw.slice(1);
  const v: Scalar = engine.getValue(tab.id, r, c);
  if (isError(v) || v === null) return raw;
  return v;
}

/** The workbook as an Excel file: values, formulas, styles, widths, heights, frozen panes and the filtered range. */
export async function workbookXlsx(wb: Workbook, title: string): Promise<Buffer> {
  const engine = new Engine(wb);
  const book = new ExcelJS.Workbook();
  book.title = title;
  const used = new Set<string>();
  const names = new Map<string, string>();
  for (const tab of wb.tabs) {
    let name = tab.name.replace(/[[\]*?/\\:]/g, ' ').trim().slice(0, 31) || 'Sheet';
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${name.slice(0, 28)} ${n}`;
    used.add(name.toLowerCase());
    names.set(tab.id, name);
    const ws = book.addWorksheet(name);
    for (const [key, cell] of Object.entries(tab.cells)) {
      const m = /^([A-Z]+)(\d+)$/.exec(key);
      if (!m) continue;
      const xc = ws.getCell(key);
      const r = Number(m[2]) - 1;
      const c = m[1].split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
      if (cell.v !== '') xc.value = xlsxValue(engine, tab, r, c, cell.v);
      const st = cell.st;
      const implied = typeof engine.getValue(tab.id, r, c) === 'number' ? engine.getImpliedFormat(tab.id, r, c) : undefined;
      const fmt = numFmt(st, implied);
      if (fmt) xc.numFmt = fmt;
      if (!st) continue;
      const font: Partial<ExcelJS.Font> = {};
      if (st.b) font.bold = true;
      if (st.i) font.italic = true;
      if (st.u) font.underline = true;
      if (st.s) font.strike = true;
      const color = st.color ? argb(st.color) : null;
      if (color) font.color = { argb: color };
      if (Object.keys(font).length) xc.font = font;
      const bg = st.bg ? argb(st.bg) : null;
      if (bg) xc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      if (st.align || st.wrap) xc.alignment = { ...(st.align ? { horizontal: st.align } : {}), ...(st.wrap ? { wrapText: true } : {}) };
    }
    // Pixels back to Excel's character units and points (the inverse of the import).
    for (const [c, px] of Object.entries(tab.colWidths)) ws.getColumn(Number(c) + 1).width = Math.max(1, (px - 5) / 7);
    for (const [r, px] of Object.entries(tab.rowHeights)) ws.getRow(Number(r) + 1).height = (px * 72) / 96;
    if (tab.frozenRows || tab.frozenCols) ws.views = [{ state: 'frozen', xSplit: tab.frozenCols ?? 0, ySplit: tab.frozenRows ?? 0 }];
    // The filtered range, without its criteria (as the import reads it).
    const f = tab.filter;
    if (f) ws.autoFilter = { from: { row: f.r1 + 1, column: f.c1 + 1 }, to: { row: f.r2 + 1, column: f.c2 + 1 } };
  }
  // ExcelJS cannot write charts: they go in after it (server/xlsxCharts.ts).
  return addChartsToXlsx(Buffer.from(await book.xlsx.writeBuffer()), wb, engine, names);
}

// --- Presentations ----------------------------------------------------------------------

export async function deckPptx(deck: Deck, title: string, source: ImageSource): Promise<Buffer> {
  const { data } = await writePptx(deck, title, pptxImageLoader(source));
  return Buffer.from(data);
}

// --- One file ---------------------------------------------------------------------------

export type FileData = { kind: 'doc'; doc: Doc } | { kind: 'markdown'; markdown: MarkdownDoc } | { kind: 'deck'; deck: Deck } | { kind: 'sheet'; workbook: Workbook };

export async function loadFile(sheets: SheetStore, ownerId: string, id: string): Promise<{ meta: SheetMeta; data: FileData } | null> {
  const meta = sheets.get(ownerId, id);
  if (!meta) return null;
  if (meta.kind === 'doc') {
    const d = await sheets.loadDoc(ownerId, id);
    return d && { meta, data: { kind: 'doc', doc: d.doc } };
  }
  if (meta.kind === 'markdown') {
    const d = await sheets.loadMarkdown(ownerId, id);
    return d && { meta, data: { kind: 'markdown', markdown: d.doc } };
  }
  if (meta.kind === 'deck') {
    const d = await sheets.loadDeck(ownerId, id);
    return d && { meta, data: { kind: 'deck', deck: d.deck } };
  }
  const s = await sheets.load(ownerId, id);
  return s && { meta, data: { kind: 'sheet', workbook: s.workbook } };
}

/** One file in one format. `tab` picks the spreadsheet tab for CSV (by name or index; the first by default). */
export async function exportFile(meta: SheetMeta, data: FileData, format: ExportFormat, source: ImageSource, tab?: string): Promise<ExportedFile> {
  if (!EXPORT_FORMATS[meta.kind].includes(format)) throw new ExportError(`A ${NOUN[meta.kind]} cannot be exported as ${format}`);
  const raw = data.kind === 'doc' ? data.doc : data.kind === 'markdown' ? data.markdown : data.kind === 'deck' ? data.deck : data.workbook;
  const type = MIME[format];
  switch (format) {
    case 'json':
      return { name: safeName(meta.title, 'json'), type, body: Buffer.from(JSON.stringify(raw, null, 2)) };
    case 'md':
      return { name: safeName(meta.title, 'md'), type, body: Buffer.from(data.kind === 'markdown' ? data.markdown.text : docMarkdown((data as { doc: Doc }).doc)) };
    case 'pptx':
      return { name: safeName(meta.title, 'pptx'), type, body: await deckPptx((data as { deck: Deck }).deck, titleBase(meta.title), source) };
    case 'xlsx':
      return { name: safeName(meta.title, 'xlsx'), type, body: await workbookXlsx((data as { workbook: Workbook }).workbook, titleBase(meta.title)) };
    case 'csv': {
      const wb = (data as { workbook: Workbook }).workbook;
      // A CSV file downloads as the file it is: raw values, not the displayed ones.
      if (meta.format === 'csv') return { name: safeName(meta.title, 'csv'), type, body: Buffer.from(workbookToCsv(wb)) };
      const t = tab === undefined ? wb.tabs[0] : (wb.tabs.find((x) => x.name === tab || x.id === tab) ?? wb.tabs[Number(tab)]);
      if (!t) throw new ExportError(`No tab named ${tab}`);
      const name = wb.tabs.length > 1 ? safeName(`${meta.title} - ${t.name}`, 'csv') : safeName(meta.title, 'csv');
      return { name, type, body: Buffer.from(tabCsv(wb, t)) };
    }
  }
}

// --- Everything -------------------------------------------------------------------------

const FOLDER: Record<DocKind, string> = { doc: 'Documents', markdown: 'Markdown', deck: 'Presentations', sheet: 'Spreadsheets' };
const NOUN: Record<DocKind, string> = { doc: 'document', markdown: 'Markdown document', deck: 'presentation', sheet: 'spreadsheet' };

/**
 * Every file of the account as a zip: per kind a folder with each file in its readable format and as JSON,
 * plus images/ with the stored images they use. Problems converting one file are listed in problems.txt
 * rather than failing the whole export.
 */
export async function exportAll(sheets: SheetStore, ownerId: string, source: ImageSource): Promise<{ body: Buffer; files: number; problems: string[] }> {
  const zip = new JSZip();
  const problems: string[] = [];
  const imageNames = new Map<string, string>();
  const usedNames = new Set<string>();
  let files = 0;

  const unique = (folder: string, name: string): string => {
    const dot = name.lastIndexOf('.');
    const base = name.slice(0, dot);
    const ext = name.slice(dot);
    let candidate = `${folder}/${name}`;
    for (let n = 2; usedNames.has(candidate.toLowerCase()); n++) candidate = `${folder}/${base} (${n})${ext}`;
    usedNames.add(candidate.toLowerCase());
    return candidate;
  };

  const addImage = async (src: string): Promise<string | null> => {
    const known = imageNames.get(src);
    if (known) return known;
    const img = await source.stored(src);
    if (!img) return null;
    const name = `images/${src.slice('/api/images/'.length)}.${IMAGE_EXT[img.type] ?? 'bin'}`;
    zip.file(name, img.bytes);
    imageNames.set(src, name);
    return name;
  };

  const metas = (['doc', 'markdown', 'deck', 'sheet'] as DocKind[]).flatMap((k) => sheets.list(ownerId, k));
  for (const meta of metas) {
    try {
      const loaded = await loadFile(sheets, ownerId, meta.id);
      if (!loaded) continue;
      const { data } = loaded;
      const folder = FOLDER[meta.kind];
      const srcs = data.kind === 'doc' ? docImages(data.doc) : data.kind === 'deck' ? deckImages(data.deck) : data.kind === 'sheet' ? sheetImages(data.workbook) : [];
      for (const src of srcs) await addImage(src);
      const json = await exportFile(meta, data, 'json', source);
      zip.file(unique(folder, json.name), json.body);
      if (data.kind === 'doc') {
        const md = docMarkdown(data.doc, (src) => (imageNames.has(src) ? `../${imageNames.get(src)}` : src));
        zip.file(unique(folder, safeName(meta.title, 'md')), md);
      } else {
        const readable = await exportFile(meta, data, EXPORT_FORMATS[meta.kind][0], source);
        zip.file(unique(folder, readable.name), readable.body);
      }
      files++;
    } catch (e) {
      problems.push(`${meta.title} (${meta.id}): ${(e as Error).message}`);
    }
  }
  if (problems.length) zip.file('problems.txt', problems.join('\n') + '\n');
  const body = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { body, files, problems };
}

/**
 * One folder as a zip, laid out as the folder is: each document, presentation and spreadsheet in its
 * readable format (a CSV file as CSV), stored files as they are, and the folders inside it as folders.
 * Stored images that documents show go in images/, as in the export of everything.
 */
export async function exportFolder(
  stores: { sheets: SheetStore; files: FileStore; folders: Folders },
  ownerId: string,
  folder: string,
  source: ImageSource,
): Promise<{ body: Buffer; files: number; problems: string[] }> {
  const zip = new JSZip();
  const problems: string[] = [];
  const imageNames = new Map<string, string>();
  const usedNames = new Set<string>(['images']);
  let files = 0;

  /** A name nothing else in its zip folder has; `dir` is '' or ends with a slash. */
  const unique = (dir: string, name: string): string => {
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let candidate = dir + name;
    for (let n = 2; usedNames.has(candidate.toLowerCase()); n++) candidate = `${dir}${base} (${n})${ext}`;
    usedNames.add(candidate.toLowerCase());
    return candidate;
  };

  const addImage = async (src: string): Promise<void> => {
    if (imageNames.has(src)) return;
    const img = await source.stored(src);
    if (!img) return;
    const name = `images/${src.slice('/api/images/'.length)}.${IMAGE_EXT[img.type] ?? 'bin'}`;
    zip.file(name, img.bytes);
    imageNames.set(src, name);
  };

  const add = async (path: string, dir: string, depth: number): Promise<void> => {
    for (const meta of stores.sheets.listIn(ownerId, path)) {
      try {
        const loaded = await loadFile(stores.sheets, ownerId, meta.id);
        if (!loaded) continue;
        const { data } = loaded;
        if (data.kind === 'doc') {
          for (const src of docImages(data.doc)) await addImage(src);
          const md = docMarkdown(data.doc, (src) => (imageNames.has(src) ? '../'.repeat(depth) + imageNames.get(src) : src));
          zip.file(unique(dir, safeName(meta.title, 'md')), md);
        } else {
          const out = await exportFile(meta, data, meta.format === 'csv' ? 'csv' : EXPORT_FORMATS[meta.kind][0], source);
          zip.file(unique(dir, out.name), out.body);
        }
        files++;
      } catch (e) {
        problems.push(`${dir}${meta.title}: ${(e as Error).message}`);
      }
    }
    for (const f of stores.files.listIn(ownerId, path)) {
      try {
        const stored = stores.files.get(ownerId, f.id);
        if (!stored) continue;
        zip.file(unique(dir, f.filename.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-') || 'file'), await readFile(stored.file));
        files++;
      } catch (e) {
        problems.push(`${dir}${f.filename}: ${(e as Error).message}`);
      }
    }
    for (const child of stores.folders.children(ownerId, path)) {
      const sub = unique(dir, folderName(child)) + '/';
      // An empty folder is still a folder.
      zip.folder(sub.slice(0, -1));
      await add(child, sub, depth + 1);
    }
  };

  await add(folder, '', 0);
  if (problems.length) zip.file(unique('', 'problems.txt'), problems.join('\n') + '\n');
  const body = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { body, files, problems };
}
