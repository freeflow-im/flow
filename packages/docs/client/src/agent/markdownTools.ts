// The document tools that also work on an open Markdown document: reading it as numbered blocks and
// changing its content. They act on the text itself (through the editor, so the user can undo). The
// formatting and page tools stay with text documents: in Markdown, formatting is the text.
import type { ClientToolCall } from '../../../shared/agent/protocol.ts';
import { checkBlockNumber, findOccurrences, insertEdit, markdownBlocks, markdownOutline, replaceEdit, type MarkdownBlock } from '../../../shared/agent/markdownBlocks.ts';

export { markdownOutline };
import type { MarkdownController } from '../markdown/controller.ts';
import { ToolError } from './toolError.ts';

export const MARKDOWN_TOOLS: ReadonlySet<string> = new Set(['read_doc', 'insert_content', 'replace_blocks', 'delete_blocks', 'replace_text']);

/** replace_blocks over this many blocks asks the user first. */
const CONFIRM_REPLACE_BLOCKS = 10;

type Input = Record<string, unknown>;

function blockIndex(blocks: MarkdownBlock[], v: unknown): number {
  const r = checkBlockNumber(blocks, v);
  if (typeof r === 'string') throw new ToolError(r);
  return r;
}

/** The 0-based inclusive range of blocks named by from/to (to defaults to from). */
function blockSpan(blocks: MarkdownBlock[], i: Input): [number, number] {
  const a = blockIndex(blocks, i.from);
  const b = i.to === undefined ? a : blockIndex(blocks, i.to);
  if (b < a) throw new ToolError('"to" must not be before "from".');
  return [a, b];
}

const markdownOf = (v: unknown) => (typeof v === 'string' ? v : '');

/** A question to ask before a destructive call on the Markdown document, or null. */
export function markdownConfirmationFor(call: ClientToolCall, ctl: MarkdownController | null): string | null {
  if (!ctl || (call.name !== 'delete_blocks' && call.name !== 'replace_blocks')) return null;
  try {
    const blocks = markdownBlocks(ctl.text);
    const [a, b] = blockSpan(blocks, call.input);
    const count = b - a + 1;
    const span = count === 1 ? `block ${a + 1}` : `blocks ${a + 1}–${b + 1}`;
    if (call.name === 'delete_blocks') return `Delete ${span} of the document?`;
    return count >= CONFIRM_REPLACE_BLOCKS ? `Replace ${span} (${count} blocks) of the document?` : null;
  } catch {
    return null; // The call will fail with a useful error when it runs.
  }
}

/** Why a document tool cannot run on a Markdown document, or null if it can. */
export function markdownToolProblem(name: string): string | null {
  if (MARKDOWN_TOOLS.has(name)) return null;
  return `${name} is for text documents. The open file is a Markdown document, whose formatting is its text: use replace_text, replace_blocks or insert_content and write the Markdown syntax (for example **bold**, # headings, ![alt](url) for images) directly.`;
}

export function runMarkdownTool(call: ClientToolCall, ctl: MarkdownController): string {
  const i = call.input;
  const text = ctl.text;
  const blocks = markdownBlocks(text);
  const count = () => markdownBlocks(ctl.text).length;

  switch (call.name) {
    case 'read_doc':
      return JSON.stringify({ format: 'markdown', ...markdownOutline(text, { from: typeof i.from === 'number' ? i.from : undefined, to: typeof i.to === 'number' ? i.to : undefined, cursor: ctl.cursor }) });

    case 'insert_content': {
      const md = markdownOf(i.markdown);
      if (!md.trim()) throw new ToolError('The markdown is empty; nothing to insert.');
      // after: undefined is the end, 0 the top, otherwise a block number (checked).
      const after = i.after === undefined ? undefined : i.after === 0 ? 0 : blockIndex(blocks, i.after) + 1;
      ctl.applyEdit(insertEdit(text, blocks, after, md));
      const added = markdownBlocks(md).length;
      const first = (after ?? blocks.length) + 1;
      return JSON.stringify({ inserted_blocks: added === 1 ? [first] : [first, first + added - 1], block_count: count() });
    }

    case 'replace_blocks': {
      const [a, b] = blockSpan(blocks, i);
      const md = markdownOf(i.markdown);
      ctl.applyEdit(replaceEdit(text, blocks, a, b, md));
      const added = markdownBlocks(md).length;
      return JSON.stringify({
        replaced_blocks: a === b ? [a + 1] : [a + 1, b + 1],
        ...(added ? { new_blocks: added === 1 ? [a + 1] : [a + 1, a + added] } : { deleted: true }),
        block_count: count(),
      });
    }

    case 'delete_blocks': {
      const [a, b] = blockSpan(blocks, i);
      ctl.applyEdit(replaceEdit(text, blocks, a, b, ''));
      return JSON.stringify({ deleted_blocks: b - a + 1, block_count: count() });
    }

    case 'replace_text': {
      const find = String(i.find ?? '');
      const replace = String(i.replace ?? '');
      const block = i.block === undefined ? undefined : blockIndex(blocks, i.block) + 1;
      const found = findOccurrences(text, blocks, find, block);
      if (!found.length) return JSON.stringify({ replaced: 0, note: `"${find}" was not found${block ? ` in block ${block}` : ''}.` });
      // One edit covering the span of all occurrences, so it is one undo step.
      const from = found[0].from;
      const to = found[found.length - 1].to;
      let out = '';
      let pos = from;
      for (const o of found) {
        out += text.slice(pos, o.from) + replace;
        pos = o.to;
      }
      ctl.applyEdit({ from, to, insert: out });
      return JSON.stringify({ replaced: found.length, blocks: [...new Set(found.map((o) => o.block))], block_count: count() });
    }

    default:
      throw new ToolError(markdownToolProblem(call.name) ?? `Unknown tool ${call.name}`);
  }
}
