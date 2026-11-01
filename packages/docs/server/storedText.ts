// The text of a stored file, for an assistant to read: a PDF's extracted text, a web page's visible text
// (as light Markdown) and any other text file as it is. Pictures, videos and other binary files have none.
import { HTML_TYPE, isTextFileType, type StoredFile } from '../shared/types.ts';
import { PdfError, pdfToMarkdown } from './pdfMarkdown.ts';

/** A stored file that has no text to read, with what to tell the model. */
export class NoTextError extends Error {}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™', bull: '•', middot: '·' };

const decode = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/** What a reader of the page sees, as light Markdown: headings, list items and paragraphs; no markup, scripts or styles. */
export function htmlToText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<h([1-6])\b[^>]*>/gi, (_, n: string) => `\n\n${'#'.repeat(Number(n))} `)
    .replace(/<\/h[1-6]\s*>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<\/(td|th)\s*>/gi, ' | ')
    .replace(/<\/?(p|div|section|article|header|footer|main|nav|aside|ul|ol|table|tr|blockquote|pre|figure|figcaption|dl|dt|dd|hr|form|fieldset)\b[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  s = decode(s)
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const t = title && decode(title).replace(/\s+/g, ' ').trim();
  return t && !s.startsWith(`# ${t}`) ? `# ${t}\n\n${s}` : s;
}

/** The text of a stored file. Throws NoTextError for a file that has none (a picture, a video, a blank PDF). */
export async function storedFileText(meta: StoredFile, data: Buffer): Promise<string> {
  if (meta.type === 'application/pdf') {
    let text: string;
    try {
      text = (await pdfToMarkdown(data)).markdown;
    } catch (e) {
      if (e instanceof PdfError) throw new NoTextError(e.message);
      throw e;
    }
    if (!text.trim()) throw new NoTextError(`No text could be read from ${meta.filename}, even with OCR.`);
    return text;
  }
  if (meta.type.startsWith('image/') && meta.type !== 'image/svg+xml') throw new NoTextError(`${meta.filename} is a picture, so it has no text to read. view_image shows it to you.`);
  if (!isTextFileType(meta.type) || data.subarray(0, 8000).includes(0)) throw new NoTextError(`${meta.filename} (${meta.type}) is not a text file, so it has no text to read.`);
  const text = new TextDecoder('utf-8').decode(data).replace(/^﻿/, '');
  return meta.type === HTML_TYPE ? htmlToText(text) : text;
}

/** The longest block of a text outline; a longer paragraph is split at line breaks (or anywhere, if it has none). */
const MAX_BLOCK_CHARS = 4000;
/** How much text one read returns by default. */
const MAX_READ_CHARS = 40_000;

/** The text's paragraphs, none longer than MAX_BLOCK_CHARS. */
export function textBlocks(text: string): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n[ \t]*\n/)) {
    if (!para.trim()) continue;
    let rest = para.replace(/^\n+|\s+$/g, '');
    while (rest.length > MAX_BLOCK_CHARS) {
      const cut = rest.lastIndexOf('\n', MAX_BLOCK_CHARS);
      const at = cut > MAX_BLOCK_CHARS / 2 ? cut : MAX_BLOCK_CHARS;
      out.push(rest.slice(0, at));
      rest = rest.slice(at).replace(/^\n/, '');
    }
    if (rest.trim()) out.push(rest);
  }
  return out;
}

/** Numbered blocks of the text from `from` (1-based) to `to`, or as many as fit in one read; the shape read_doc returns. */
export function textOutline(text: string, from?: number, to?: number) {
  const blocks = textBlocks(text);
  const total = blocks.length;
  const first = Math.min(Math.max(1, from ?? 1), Math.max(1, total));
  let last = Math.min(total, to ?? total);
  if (to === undefined) {
    let chars = 0;
    for (let k = first - 1; k < last; k++) {
      chars += blocks[k].length;
      if (chars > MAX_READ_CHARS && k > first - 1) {
        last = k;
        break;
      }
    }
  }
  return {
    format: 'text',
    block_count: total,
    ...(first > 1 || last < total ? { showing_blocks: `${first}-${last}`, note: 'Call read_doc with from and to for other blocks.' } : {}),
    blocks: blocks.slice(first - 1, last).map((markdown, k) => ({ n: first + k, markdown })),
  };
}
