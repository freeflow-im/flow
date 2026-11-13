// The words of a document, for the search index (server/sheets.ts; docs/specs/search.md §5): what a person would read in
// it, as plain text, one block per line. Formulas, styles, pictures and ids are left out.
import type { Deck } from './deck.ts';
import type { Doc } from './doc.ts';
import type { DocKind, Workbook } from './types.ts';

/** Most text indexed for one document; the rest of a very long one is not searchable. */
export const MAX_SEARCH_TEXT = 500_000;

/** A ProseMirror node's text, a line for each block. */
function proseText(node: unknown, out: string[]): void {
  if (!node || typeof node !== 'object') return;
  const n = node as { type?: unknown; text?: unknown; content?: unknown };
  if (typeof n.text === 'string') {
    out.push(n.text);
    return;
  }
  if (!Array.isArray(n.content)) return;
  for (const child of n.content) proseText(child, out);
  // A block ends its line (the inline nodes of a paragraph run together).
  if (typeof n.type === 'string' && n.type !== 'text') out.push('\n');
}

function deckText(deck: Deck): string[] {
  const lines: string[] = [];
  for (const slide of deck.slides ?? []) {
    for (const el of slide.elements ?? []) {
      if (el.type === 'text') for (const p of el.paragraphs ?? []) lines.push(p.text);
      else if (el.type === 'table') for (const row of el.rows ?? []) lines.push(row.map((c) => c.text).join(' '));
    }
    if (slide.notes) lines.push(slide.notes);
  }
  return lines;
}

function workbookText(wb: Workbook): string[] {
  const lines: string[] = [];
  for (const tab of wb.tabs ?? []) {
    lines.push(tab.name);
    for (const cell of Object.values(tab.cells ?? {})) {
      const v = cell?.v;
      // A formula's result is not stored; its source is not what anyone reads.
      if (typeof v === 'string' && v && !v.startsWith('=')) lines.push(v);
    }
  }
  return lines;
}

/** Markdown as it reads: without heading, quote and list marks, emphasis, or the addresses of links and pictures. */
function markdownWords(md: string): string {
  return md
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>+|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_~`]+/g, '');
}

/** The document's searchable text. A CSV file is stored as `{ csv }`; its commas split it into words already. */
export function searchTextOf(kind: DocKind, stored: unknown): string {
  if (!stored || typeof stored !== 'object') return '';
  const s = stored as Record<string, unknown>;
  let text = '';
  if (typeof s.csv === 'string') text = s.csv;
  else if (kind === 'markdown') text = typeof s.text === 'string' ? markdownWords(s.text) : '';
  else if (kind === 'doc') {
    const out: string[] = [];
    proseText((stored as Doc).content, out);
    text = out.join('');
  } else if (kind === 'deck') text = deckText(stored as Deck).join('\n');
  else if (kind === 'sheet') text = workbookText(stored as Workbook).join('\n');
  return text.replace(/\n{2,}/g, '\n').trim().slice(0, MAX_SEARCH_TEXT);
}
