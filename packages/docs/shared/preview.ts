// A small picture of a file for the thumbnail view of the file list: enough of its content to recognise
// it, built by the server (GET /api/library/preview/:id) and drawn by the client.
import type { Deck, Slide, ThemeId } from './deck.ts';
import type { Doc } from './doc.ts';
import type { MarkdownDoc } from './markdown.ts';
import type { Workbook } from './types.ts';

export type FilePreview =
  /** The start of a document's text. */
  | { kind: 'text'; text: string }
  /** The top-left cells of a spreadsheet's first tab, as typed. */
  | { kind: 'grid'; rows: string[][] }
  /** A presentation's first slide. */
  | { kind: 'slide'; slide: Slide; theme: ThemeId }
  | { kind: 'empty' };

const TEXT_CHARS = 900;
const GRID_ROWS = 12;
const GRID_COLS = 6;

export function markdownPreview(doc: MarkdownDoc): FilePreview {
  const text = doc.text.trim().slice(0, TEXT_CHARS);
  return text ? { kind: 'text', text } : { kind: 'empty' };
}

/** The document's text, one block per line. */
export function docPreview(doc: Doc): FilePreview {
  const lines: string[] = [];
  let length = 0;
  const walk = (node: unknown): string => {
    if (!node || typeof node !== 'object') return '';
    const n = node as { text?: unknown; content?: unknown };
    if (typeof n.text === 'string') return n.text;
    return Array.isArray(n.content) ? n.content.map(walk).join('') : '';
  };
  const blocks = (node: unknown) => {
    const content = (node as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) return;
    for (const child of content) {
      if (length > TEXT_CHARS) return;
      const type = (child as { type?: unknown }).type;
      // Lists and tables hold blocks of their own.
      if (typeof type === 'string' && /list|table|row|cell|item|quote/i.test(type)) blocks(child);
      else {
        const text = walk(child).trim();
        if (text) {
          lines.push(text);
          length += text.length;
        }
      }
    }
  };
  blocks(doc.content);
  const text = lines.join('\n').slice(0, TEXT_CHARS);
  return text ? { kind: 'text', text } : { kind: 'empty' };
}

export function sheetPreview(workbook: Workbook): FilePreview {
  const tab = workbook.tabs[0];
  if (!tab) return { kind: 'empty' };
  const rows: string[][] = [];
  let any = false;
  for (let r = 1; r <= GRID_ROWS; r++) {
    const row: string[] = [];
    for (let c = 0; c < GRID_COLS; c++) {
      const v = tab.cells[`${String.fromCharCode(65 + c)}${r}`]?.v ?? '';
      if (v) any = true;
      row.push(v.slice(0, 40));
    }
    rows.push(row);
  }
  return any ? { kind: 'grid', rows } : { kind: 'empty' };
}

export function deckPreview(deck: Deck): FilePreview {
  const slide = deck.slides[0];
  return slide ? { kind: 'slide', slide, theme: deck.theme } : { kind: 'empty' };
}
