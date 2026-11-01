// Workbook file format (stored as one JSON file per sheet on the server).

export type HAlign = 'left' | 'center' | 'right';

import type { Chart } from './chart.ts';

export type NumberFormat =
  | 'general'
  | 'number'
  | 'currency'
  | 'percent'
  | 'date'
  | 'time'
  | 'datetime'
  | 'text';

export interface CellStyle {
  b?: boolean; // bold
  i?: boolean; // italic
  u?: boolean; // underline
  s?: boolean; // strikethrough
  wrap?: boolean; // wrap text within the cell width
  color?: string; // text color
  bg?: string; // fill color
  align?: HAlign;
  fmt?: NumberFormat;
  dp?: number; // decimal places for number/currency/percent
}

export interface CellData {
  /** Raw user input: a literal ("12", "hello", "3/4/2025") or a formula ("=SUM(A1:A3)"). */
  v: string;
  st?: CellStyle;
  /**
   * Image shown in the cell, scaled to fit: an image stored on the server ("/api/images/<id>", used for
   * uploads and pastes so large images stay out of the workbook JSON), a data:image/... URL or an http(s) URL.
   */
  img?: string;
}

/** Largest image accepted in a cell, in bytes of image data. */
export const MAX_CELL_IMAGE_BYTES = 100 * 1024 * 1024;
/** Length of the data URL of the largest image accepted (base64 grows data by 4/3, plus the prefix). */
export const MAX_CELL_IMAGE_CHARS = Math.ceil(MAX_CELL_IMAGE_BYTES / 3) * 4 + 32;
export const CELL_IMAGE_TOO_LARGE = 'Image is too large (100 MB maximum)';
export const CELL_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
/** Address of an image stored on the server (see server/images.ts). */
export const STORED_IMAGE_RE = /^\/api\/images\/[0-9a-f-]{36}$/;
const DATA_IMAGE_RE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;

/** True if `src` is an inline data:image/...;base64 URL. */
export const isDataImage = (src: string) => src.startsWith('data:') && DATA_IMAGE_RE.test(src);

/** Returns an error message if `src` cannot be used as a cell image, or null if it is fine. */
export function checkCellImage(src: unknown): string | null {
  if (typeof src !== 'string' || !src) return 'Image must be a non-empty string';
  if (src.length > MAX_CELL_IMAGE_CHARS) return CELL_IMAGE_TOO_LARGE;
  if (STORED_IMAGE_RE.test(src)) return null;
  if (isDataImage(src)) return null;
  if (/^https?:\/\/\S+$/i.test(src)) return null;
  return 'Image must be a PNG, JPEG, GIF or WebP image, or an http(s) URL';
}

/** True if the cell holds a value or an image (formatting alone does not count). */
export function hasContent(cell: CellData | undefined): boolean {
  return !!cell && (cell.v !== '' || !!cell.img);
}

export type FilterConditionType =
  | 'none'
  | 'empty'
  | 'notEmpty'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte';

export interface FilterCondition {
  type: FilterConditionType;
  value?: string;
}

export interface ColumnFilter {
  /** Display values that are hidden (unchecked in the "filter by values" list). */
  hidden?: string[];
  cond?: FilterCondition;
}

export interface FilterState {
  /** Range covered by the filter; row r1 is the header row. */
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  /** Criteria keyed by absolute column index. */
  cols: Record<string, ColumnFilter>;
}

export interface Tab {
  id: string;
  name: string;
  rows: number;
  cols: number;
  /** Sparse cells keyed by A1-style address ("B7"). */
  cells: Record<string, CellData>;
  colWidths: Record<string, number>;
  rowHeights: Record<string, number>;
  frozenRows?: number;
  frozenCols?: number;
  filter?: FilterState;
  /** Charts floating over the grid (shared/chart.ts). */
  charts?: Chart[];
}

export interface Workbook {
  version: 1;
  tabs: Tab[];
}

/**
 * What a stored document is: a spreadsheet (workbook JSON), a slide deck (shared/deck.ts), a text document
 * (shared/doc.ts) or a Markdown document (shared/markdown.ts).
 */
export type DocKind = 'sheet' | 'deck' | 'doc' | 'markdown';

export interface SheetMeta {
  id: string;
  kind: DocKind;
  /**
   * Set on a spreadsheet stored as a CSV file (shared/csv.ts), which holds one tab of plain values, and, in
   * the desktop app, on a document stored as an Office file: a spreadsheet as Excel (shared/xlsxFormat.ts), a
   * presentation as PowerPoint (shared/pptxFormat.ts), a document as Word (shared/docxFormat.ts).
   */
  format?: 'csv' | 'xlsx' | 'pptx' | 'docx';
  title: string;
  /** The folder the file is in (shared/folders.ts); absent at the top of the library. */
  folder?: string;
  createdAt: string;
  updatedAt: string;
  /** Set when this sheet is a branch of another sheet. */
  branch?: {
    parentId: string;
    /** Current title of the original, or its title when branched if it has been deleted. */
    parentTitle: string;
    branchedAt: string;
    /** The original has been deleted; only the base snapshot remains for comparison. */
    detached: boolean;
  };
}

/** A deleted file still held in the off-box copy (server/backup.ts), restorable from the Trash. */
export interface DeletedFile {
  id: string;
  kind: DocKind;
  title: string;
  deletedAt: string;
}

export const DEFAULT_ROWS = 1000;
export const DEFAULT_COLS = 26;

export function newTab(id: string, name: string): Tab {
  return {
    id,
    name,
    rows: DEFAULT_ROWS,
    cols: DEFAULT_COLS,
    cells: {},
    colWidths: {},
    rowHeights: {},
  };
}

export function newWorkbook(firstTabId: string): Workbook {
  return { version: 1, tabs: [newTab(firstTabId, 'Sheet1')] };
}

/** A stored file (generated PDF, upload): metadata only; the bytes are served from `url` / `downloadUrl`. */
/** The desktop app's opening of new files that appear in Downloads, Documents and Desktop (desktop/newFiles.js), on the Settings page. */
export interface NewFilesSettings {
  open: boolean;
  /** The folders watched, absolute. */
  folders: string[];
  /** The kinds of file that open (desktop/newFiles.js's KINDS), each with whether it does. */
  kinds: { id: string; label: string; on: boolean }[];
}
/** A change to NewFilesSettings: turned on or off, and the ids of the kinds that open. */
export interface NewFilesUpdate {
  open?: boolean;
  kinds?: string[];
}

/** An agent signed in to the account's files with a device code (the plugin's /mcp/v2), listed on the Settings page. */
export interface ConnectedAgent {
  id: string;
  /** The name the agent gave itself when it registered. */
  name: string;
  /** Where the sign-in was started from: address and user agent. */
  origin: string;
  /** The MCP endpoint its tokens are for. */
  endpoint: string;
  connectedAt: string;
  /** When it last got fresh tokens (it refreshes about hourly while in use); not known in the desktop app. */
  lastActiveAt?: string;
}

export interface StoredFile {
  id: string;
  filename: string;
  /** The folder the file is in; absent at the top of the library. */
  folder?: string;
  /** MIME type. */
  type: string;
  size: number;
  createdAt: string;
  /** Inline address (for previews). */
  url: string;
  /** Address that downloads the raw file (Content-Disposition: attachment). */
  downloadUrl: string;
  /** Plain text (UTF-8, ASCII included) small enough to edit in the app's text editor, whatever its name says. */
  text?: true;
}

/** The largest plain text file that opens in the text editor. */
export const MAX_TEXT_EDIT_BYTES = 5 * 1024 * 1024;

/** Pictures the image editor and the image model can change (an animated GIF would lose its frames). */
export const EDITABLE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

/** Types the app can preview in a tab; everything else gets an info page with a Download button. */
export const PREVIEW_FILE_TYPES = ['application/pdf', ...['image/png', 'image/jpeg', 'image/gif', 'image/webp'], ...['video/mp4', 'video/webm', 'video/quicktime', 'video/ogg']];

/** Video files the app plays, by extension, with the type each is stored as. */
export const VIDEO_TYPES: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg' };
/** The type of a video file by its name, or null if the name is not a video's. */
export function videoTypeOf(filename: string): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1].toLowerCase();
  return (ext && VIDEO_TYPES[ext]) || null;
}
/** The type a stored file is kept as, by its name: the kinds the app knows; null for any other (kept as application/octet-stream). */
export function fileTypeOf(filename: string): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1].toLowerCase() ?? '';
  return videoTypeOf(filename) ?? KNOWN_FILE_TYPES[ext] ?? null;
}
const KNOWN_FILE_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  html: 'text/html',
  htm: 'text/html',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  zip: 'application/zip',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** Whether a stored file has a page in the app (a viewer, or a copy to edit); any other is only listed, to download, move or delete. */
export const opensInApp = (filename: string): boolean => /\.(pdf|html?|png|jpe?g|gif|webp|mp4|m4v|mov|webm|ogv|xlsx|xls|docx|pptx|zip)$/i.test(filename);

/** The type a web page (.html, .htm) is stored as. It is only ever shown inside a sandboxed frame, never served as a page. */
export const HTML_TYPE = 'text/html';
export const isHtmlName = (filename: string): boolean => /\.html?$/i.test(filename);

/** True for a stored file that holds text (a web page, JSON, SVG, ...), which can be read and rewritten; PDFs, pictures and videos cannot. */
export const isTextFileType = (type: string): boolean => !/^(application\/pdf|image\/(?!svg)|video\/|audio\/)/.test(type);

/** Largest video that can be uploaded. */
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
