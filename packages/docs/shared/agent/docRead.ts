// What the assistant sees of a document: its top-level blocks, numbered from 1, each as Markdown. Also what a
// message typed in the prompt at the cursor carries of the open document or presentation.
import type { Node as PMNode } from 'prosemirror-model';
import { blockType } from '../doc.ts';
import { blockToMarkdown } from '../docMarkdown.ts';
import { deckOutline, type Deck } from '../deck.ts';
import { MAX_INLINE_CONTEXT_CHARS, MAX_INLINE_SELECTED_TEXT, type DeckInlineContext, type DocInlineContext } from './protocol.ts';

/** Blocks listed by one read_doc call without a range. */
export const MAX_OUTLINE_BLOCKS = 300;
const MAX_SELECTED_TEXT = 500;

export interface DocOutlineOptions {
  /** 1-based range of blocks to list (defaults to the first MAX_OUTLINE_BLOCKS). */
  from?: number;
  to?: number;
  /** 1-based number of the block holding the user's cursor. */
  cursorBlock?: number;
  selectedText?: string;
  /** 1-based page each block starts on (Pages mode in the browser only). */
  pages?: (number | null)[];
}

export function docOutline(doc: PMNode, opts: DocOutlineOptions = {}) {
  const total = doc.childCount;
  const from = Math.min(Math.max(1, opts.from ?? 1), Math.max(1, total));
  const to = Math.min(total, opts.to ?? from + MAX_OUTLINE_BLOCKS - 1);
  const blocks = [];
  for (let k = from - 1; k < to; k++) {
    const node = doc.child(k);
    const page = opts.pages?.[k];
    blocks.push({
      n: k + 1,
      type: blockType(node),
      ...(node.attrs.align ? { align: node.attrs.align as string } : {}),
      ...(node.attrs.spacing ? { spacing: node.attrs.spacing as Record<string, number> } : {}),
      ...(page ? { page } : {}),
      markdown: blockToMarkdown(node),
    });
  }
  const selected = opts.selectedText?.trim();
  return {
    block_count: total,
    ...(opts.cursorBlock ? { cursor_block: opts.cursorBlock } : {}),
    ...(selected ? { selected_text: selected.length > MAX_SELECTED_TEXT ? `${selected.slice(0, MAX_SELECTED_TEXT)}…` : selected } : {}),
    ...(from > 1 || to < total ? { showing_blocks: `${from}-${to}`, note: 'Call read_doc with from and to for other blocks.' } : {}),
    blocks,
  };
}

const CURSOR_TEXT_CHARS = 200;

/** The run of `parts` around index `at` that fits in `maxChars`, grown outwards from it: [first, last]. */
export function windowAround(parts: string[], at: number, maxChars: number): [number, number] {
  const last = Math.max(0, parts.length - 1);
  let a = Math.min(Math.max(0, at), last);
  let b = a;
  let size = parts[a]?.length ?? 0;
  for (;;) {
    const up = a > 0 && size + parts[a - 1].length <= maxChars;
    if (up) size += parts[--a].length;
    const down = b < last && size + parts[b + 1].length <= maxChars;
    if (down) size += parts[++b].length;
    if (!up && !down) break;
  }
  return [a, b];
}

/** The presentation and the text selected on the slide, for a message typed in the prompt on a slide. */
export function deckInlineContext(deck: Deck, current: number, selectedText?: string, maxChars = MAX_INLINE_CONTEXT_CHARS): DeckInlineContext {
  const slides = deckOutline(deck).slides.map((s) => JSON.stringify(s));
  const [a, b] = windowAround(slides, current, maxChars);
  const text = selectedText?.trim();
  return {
    deck: `Theme: ${deck.theme}\n${slides.slice(a, b + 1).join('\n')}`.slice(0, maxChars + 100),
    ...(a > 0 || b < slides.length - 1 ? { showing: [a + 1, b + 1] as [number, number] } : {}),
    ...(text ? { selectedText: text.length > MAX_INLINE_SELECTED_TEXT ? `${text.slice(0, MAX_INLINE_SELECTED_TEXT)}…` : text } : {}),
  };
}

/** The document and the user's place in it, for a message typed in the prompt at the cursor. */
export function docInlineContext(doc: PMNode, selection: { from: number; to: number }, maxChars = MAX_INLINE_CONTEXT_CHARS): DocInlineContext {
  const blocks: string[] = [];
  doc.forEach((node, _offset, k) => blocks.push(`[${k + 1}] ${blockToMarkdown(node)}`));
  const $from = doc.resolve(selection.from);
  const $to = doc.resolve(selection.to);
  const last = Math.max(0, blocks.length - 1);
  const first = Math.min($from.index(0), last);
  const [a, b] = windowAround(blocks, first, maxChars);
  const out: DocInlineContext = { document: blocks.slice(a, b + 1).join('\n\n').slice(0, maxChars) };
  if (a > 0 || b < last) out.showing = [a + 1, b + 1];
  if (selection.from !== selection.to) {
    out.selectionBlocks = [first + 1, Math.min($to.index(0), last) + 1];
  } else if ($from.parent.isTextblock) {
    const text = $from.parent.textBetween(0, $from.parent.content.size, undefined, ' ');
    const at = $from.parent.textBetween(0, $from.parentOffset, undefined, ' ').length;
    if (at > 0) out.before = text.slice(Math.max(0, at - CURSOR_TEXT_CHARS), at);
    if (at < text.length) out.after = text.slice(at, at + CURSOR_TEXT_CHARS);
  }
  return out;
}
