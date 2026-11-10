// How an attachment is previewed in the overlay (components/AttachmentPreview.tsx): pictures, video and audio by the
// browser itself; PDFs, Word, Excel, PowerPoint, CSV and Markdown in Docs' read-only views (a preview Docs makes from
// the bytes, /docs/preview/<id>); text and code as text; an HTML file as its source, or in a frame that runs
// nothing; anything else not at all. The name's extension decides first, as mail often sends files as
// application/octet-stream; the stated type is used when the name has none we know.

export type Viewer = 'image' | 'video' | 'audio' | 'docs' | 'text' | 'html' | 'none';

/** Docs' limit for a preview (packages/docs/server/previews.ts). */
export const MAX_PREVIEW_BYTES = 25 * 1024 * 1024;
/** The largest text file shown as text. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

const BY_EXT: Record<Viewer, string[]> = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'],
  video: ['mp4', 'm4v', 'mov', 'webm', 'ogv'],
  audio: ['mp3', 'm4a', 'wav', 'ogg', 'oga', 'opus', 'aac', 'flac'],
  docs: ['pdf', 'docx', 'xlsx', 'xls', 'pptx', 'csv', 'md', 'markdown'],
  html: ['html', 'htm', 'xhtml'],
  text: [
    'txt', 'text', 'log', 'json', 'jsonl', 'ndjson', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties', 'eml', 'ics', 'vcf', 'tsv',
    'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'less', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php',
    'sh', 'bash', 'zsh', 'ps1', 'bat', 'sql', 'diff', 'patch', 'r', 'lua', 'pl', 'scala', 'dart', 'gradle', 'make', 'dockerfile', 'rst', 'tex', 'srt', 'vtt',
  ],
  none: [],
};
const EXT_VIEWER = new Map(Object.entries(BY_EXT).flatMap(([viewer, exts]) => exts.map((e) => [e, viewer as Viewer])));

const DOCS_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'text/csv',
  'text/markdown',
]);
const TEXT_TYPES = new Set(['application/json', 'application/xml', 'application/x-yaml', 'application/yaml', 'application/javascript', 'message/rfc822', 'text/calendar', 'text/vcard']);

export const extensionOf = (filename: string): string => /\.([a-z0-9]{1,10})$/i.exec(filename.trim())?.[1]?.toLowerCase() ?? '';

/** The viewer for an attachment, by its name's extension, else its MIME type. */
export function viewerFor(a: { filename: string; mimeType: string }): Viewer {
  const byExt = EXT_VIEWER.get(extensionOf(a.filename));
  if (byExt) return byExt;
  const type = a.mimeType.split(';')[0]!.trim().toLowerCase();
  if (/^image\/(png|jpeg|gif|webp|svg\+xml|bmp|avif)$/.test(type)) return 'image';
  if (/^video\/(mp4|webm|ogg|quicktime)$/.test(type)) return 'video';
  if (/^audio\//.test(type)) return 'audio';
  if (DOCS_TYPES.has(type)) return 'docs';
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html';
  if (type.startsWith('text/') || TEXT_TYPES.has(type) || /\+(json|xml)$/.test(type)) return 'text';
  return 'none';
}

/** Whether the picture is an SVG: shown as an <img> from a blob of its own type (an <img> runs nothing in it). */
export const isSvg = (a: { filename: string; mimeType: string }): boolean => extensionOf(a.filename) === 'svg' || /^image\/svg\+xml/i.test(a.mimeType);

/** Why an attachment cannot be previewed as its viewer would (too large), or null. */
export function previewLimit(viewer: Viewer, size: number): string | null {
  if ((viewer === 'text' || viewer === 'html') && size > MAX_TEXT_BYTES) return 'This file is too large to show as text (2 MB maximum).';
  if (viewer === 'docs' && size > MAX_PREVIEW_BYTES) return 'This file is too large to preview (25 MB maximum).';
  return null;
}

/** What the top bar says the file is: "PDF", "Word document", or the extension in capitals. */
export function typeLabel(a: { filename: string; mimeType: string }): string {
  const ext = extensionOf(a.filename);
  const named: Record<string, string> = {
    pdf: 'PDF', docx: 'Word document', doc: 'Word document', xlsx: 'Excel spreadsheet', xls: 'Excel spreadsheet', pptx: 'PowerPoint presentation',
    ppt: 'PowerPoint presentation', csv: 'CSV', md: 'Markdown', markdown: 'Markdown', txt: 'Text', html: 'HTML', htm: 'HTML', eml: 'Email message',
  };
  if (named[ext]) return named[ext];
  if (ext) return ext.toUpperCase();
  return a.mimeType.split(';')[0]!.trim() || 'File';
}

/** What kind of file an attachment is, for its icon (components/FileIcon.tsx): by the name's extension, else the MIME type. */
export type FileKind = 'pdf' | 'word' | 'excel' | 'powerpoint' | 'image' | 'video' | 'audio' | 'archive' | 'text' | 'other';

const KIND_EXT: Record<Exclude<FileKind, 'other'>, string[]> = {
  pdf: ['pdf'],
  word: ['doc', 'docx', 'docm', 'dot', 'dotx', 'odt', 'rtf', 'pages'],
  excel: ['xls', 'xlsx', 'xlsm', 'xlsb', 'ods', 'csv', 'tsv', 'numbers'],
  powerpoint: ['ppt', 'pptx', 'pptm', 'pps', 'ppsx', 'odp', 'key'],
  image: [...BY_EXT.image, 'heic', 'heif', 'tif', 'tiff', 'ico'],
  video: [...BY_EXT.video, 'avi', 'mkv', 'wmv'],
  audio: BY_EXT.audio,
  archive: ['zip', 'rar', '7z', 'gz', 'tgz', 'tar', 'bz2', 'xz'],
  text: ['txt', 'md', 'markdown', 'rst', 'log', 'eml', 'ics', 'vcf'],
};
const EXT_KIND = new Map(Object.entries(KIND_EXT).flatMap(([kind, exts]) => exts.map((e) => [e, kind as FileKind])));

export function fileKind(a: { filename: string; mimeType: string }): FileKind {
  const byExt = EXT_KIND.get(extensionOf(a.filename));
  if (byExt) return byExt;
  const type = a.mimeType.split(';')[0]!.trim().toLowerCase();
  if (type === 'application/pdf') return 'pdf';
  if (/wordprocessingml|msword|opendocument\.text|rtf/.test(type)) return 'word';
  if (/spreadsheetml|ms-excel|opendocument\.spreadsheet|^text\/csv/.test(type)) return 'excel';
  if (/presentationml|ms-powerpoint|opendocument\.presentation/.test(type)) return 'powerpoint';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (/zip|compressed|x-tar|x-7z|x-rar|gzip/.test(type)) return 'archive';
  if (type.startsWith('text/')) return 'text';
  return 'other';
}

/**
 * A frame's document for an HTML attachment shown as a page: nothing loads from anywhere (no scripts, styles or
 * pictures from the web), and the frame it goes in has an empty sandbox, so nothing in it runs or reaches this page.
 */
export function inertHtml(html: string): string {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">${html}`;
}
