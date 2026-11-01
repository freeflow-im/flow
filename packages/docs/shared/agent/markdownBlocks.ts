// What the assistant sees of a Markdown document, and how its edits land in the text. The document is its
// text; the top-level Markdown constructs (parsed with remark, GitHub flavor, front matter aware) are the
// numbered blocks the document tools name, each mapped to the lines it spans. Edits are character ranges
// to replace, so the editor can apply them through the textarea and keep the browser's undo history.
import type { Root, RootContent } from 'mdast';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { MAX_OUTLINE_BLOCKS } from './docRead.ts';

export interface MarkdownBlock {
  /** 1-based block number. */
  n: number;
  type: string;
  /** Character offsets of the block's lines in the text (end is exclusive, before the line's newline). */
  start: number;
  end: number;
  markdown: string;
}

/** A replacement of text[from, to) with `insert`. */
export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

const MAX_REPLACEMENTS = 1000;

const parser = unified().use(remarkParse).use(remarkFrontmatter).use(remarkGfm);

function typeOf(node: RootContent): string {
  switch (node.type) {
    case 'heading':
      return `heading${node.depth}`;
    case 'list':
      return node.ordered ? 'ordered_list' : 'bullet_list';
    case 'code':
      return 'code_block';
    case 'thematicBreak':
      return 'horizontal_rule';
    case 'yaml':
      return 'front_matter';
    default:
      return node.type;
  }
}

/** Character offset of the start of each line. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let k = 0; k < text.length; k++) if (text[k] === '\n') starts.push(k + 1);
  return starts;
}

/** The top-level blocks of the text, in order. */
export function markdownBlocks(text: string): MarkdownBlock[] {
  const tree = parser.parse(text) as Root;
  const starts = lineStarts(text);
  const blocks: MarkdownBlock[] = [];
  for (const node of tree.children) {
    const pos = node.position;
    if (!pos) continue;
    // Whole lines: a block owns the lines it starts and ends on.
    const start = starts[pos.start.line - 1] ?? 0;
    const endLine = Math.min(pos.end.line, starts.length);
    const end = endLine < starts.length ? starts[endLine] - 1 : text.length;
    blocks.push({ n: blocks.length + 1, type: typeOf(node), start, end, markdown: text.slice(start, end) });
  }
  return blocks;
}

export interface MarkdownOutlineOptions {
  from?: number;
  to?: number;
  /** Character offset of the user's cursor. */
  cursor?: number;
}

/** 1-based number of the block holding (or the last block before) a character offset, or 0 for none. */
export function blockAt(blocks: MarkdownBlock[], offset: number): number {
  let n = 0;
  for (const b of blocks) {
    if (b.start <= offset) n = b.n;
    else break;
  }
  return n;
}

/** The same shape read_doc gives for a text document: numbered blocks as Markdown. */
export function markdownOutline(text: string, opts: MarkdownOutlineOptions = {}) {
  const blocks = markdownBlocks(text);
  const total = blocks.length;
  const from = Math.min(Math.max(1, opts.from ?? 1), Math.max(1, total));
  const to = Math.min(total, opts.to ?? from + MAX_OUTLINE_BLOCKS - 1);
  const cursor = opts.cursor === undefined ? 0 : blockAt(blocks, opts.cursor);
  return {
    block_count: total,
    ...(cursor ? { cursor_block: cursor } : {}),
    ...(from > 1 || to < total ? { showing_blocks: `${from}-${to}`, note: 'Call read_doc with from and to for other blocks.' } : {}),
    blocks: blocks.slice(from - 1, to).map((b) => ({ n: b.n, type: b.type, markdown: b.markdown })),
  };
}

/** 0-based index of a 1-based block number, or an error message. */
export function checkBlockNumber(blocks: MarkdownBlock[], v: unknown): number | string {
  const i = Number(v) - 1;
  if (!Number.isInteger(i) || i < 0 || i >= blocks.length) return `There is no block ${v}. The document has ${blocks.length} block${blocks.length === 1 ? '' : 's'}.`;
  return i;
}

const trimBlank = (md: string) => md.replace(/^\s*\n/, '').replace(/\s+$/, '');

/** Insert Markdown after block `after` (0 for the top, undefined for the end). Returns the edit and the first new block's number. */
export function insertEdit(text: string, blocks: MarkdownBlock[], after: number | undefined, markdown: string): TextEdit {
  const md = trimBlank(markdown);
  if (after === 0 || (after === undefined && !blocks.length)) {
    return { from: 0, to: 0, insert: text.trim() ? `${md}\n\n` : `${md}\n` };
  }
  const index = after === undefined ? blocks.length - 1 : after - 1;
  const b = blocks[index];
  const next = blocks[index + 1];
  if (!next) {
    // After the last block: drop trailing whitespace, then the new content on its own, ending in a newline.
    return { from: b.end, to: text.length, insert: `\n\n${md}\n` };
  }
  return { from: b.end, to: next.start, insert: `\n\n${md}\n\n` };
}

/** Replace blocks a..b (0-based, inclusive) with Markdown; empty Markdown deletes them. */
export function replaceEdit(text: string, blocks: MarkdownBlock[], a: number, b: number, markdown: string): TextEdit {
  const md = trimBlank(markdown);
  const first = blocks[a];
  const last = blocks[b];
  if (md) return { from: first.start, to: last.end, insert: md };
  // Deleting: take the blank lines up to the next block too, or, for the last block, those before it.
  const next = blocks[b + 1];
  if (next) return { from: first.start, to: next.start, insert: '' };
  const prev = blocks[a - 1];
  return { from: prev ? prev.end : 0, to: text.length, insert: prev ? '\n' : '' };
}

/** Every occurrence of `find` in the text, or in one block; at most MAX_REPLACEMENTS. */
export function findOccurrences(text: string, blocks: MarkdownBlock[], find: string, block?: number): { from: number; to: number; block: number }[] {
  const out: { from: number; to: number; block: number }[] = [];
  const lo = block === undefined ? 0 : blocks[block - 1].start;
  const hi = block === undefined ? text.length : blocks[block - 1].end;
  let k = text.indexOf(find, lo);
  while (k >= 0 && k + find.length <= hi && out.length < MAX_REPLACEMENTS) {
    out.push({ from: k, to: k + find.length, block: blockAt(blocks, k) });
    k = text.indexOf(find, k + find.length);
  }
  return out;
}

/** Apply one edit. */
export function applyEdit(text: string, e: TextEdit): string {
  return text.slice(0, e.from) + e.insert + text.slice(e.to);
}
