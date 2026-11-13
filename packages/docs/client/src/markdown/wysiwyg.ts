// Editing a Markdown document in its rendered preview (WysiwygPreview.tsx). Each top-level block of the text
// (markdownBlocks) is shown as its own editable element; when one is changed, its HTML is turned back into
// Markdown and only that block's lines are replaced in the text, so every other block keeps the exact text it
// was written with.
import type { Element as HastElement, ElementContent, Nodes as HastNodes, Root as HastRoot } from 'hast';
import { toMdast, type Handle } from 'hast-util-to-mdast';
import { gfmToMarkdown } from 'mdast-util-gfm';
import { toMarkdown, type Options } from 'mdast-util-to-markdown';
import type { MarkdownBlock } from '../../../shared/agent/markdownBlocks.ts';
import { imgTag, parseImgTags } from './imgTags.ts';

/** The Markdown dialect the editor writes: what the text editor's own shortcuts write (`**bold**`, `_italic_`, `-` items). */
const WRITE_OPTIONS: Options = { bullet: '-', emphasis: '_', strong: '*', fence: '`', fences: true, rule: '-', listItemIndent: 'one', extensions: [gfmToMarkdown()] };

/** Undo what the preview did to the HTML of a block so it reads back as the Markdown it came from. */
function restore(node: HastNodes): void {
  if (node.type !== 'root' && node.type !== 'element') return;
  if (node.type === 'element') {
    const props = node.properties;
    if (node.tagName === 'img' && typeof props.dataMdSrc === 'string') {
      props.src = props.dataMdSrc;
      delete props.dataMdSrc;
    }
  }
  // A line break that ends an element is the one a browser keeps in an emptied line, not one the user wrote.
  while (node.children.length) {
    const last = node.children[node.children.length - 1];
    if (last.type === 'element' && last.tagName === 'br') node.children.pop();
    else if (last.type === 'text' && !last.value.trim() && node.children.length > 1) node.children.pop();
    else break;
  }
  for (const c of node.children) restore(c);
}

const str = (v: unknown): string | undefined => (v === undefined || v === null || v === '' ? undefined : String(v));

/** A picture written as an `<img>` tag stays one (and one with a size must be one); any other as `![alt](src)`. */
const img: Handle = (state, node) => {
  const p = node.properties;
  const src = str(p.src) ?? '';
  if (p.dataMdTag !== undefined || str(p.width) || str(p.height)) {
    const result = { type: 'html' as const, value: imgTag({ src, alt: str(p.alt), width: str(p.width), height: str(p.height), title: str(p.title) }) };
    state.patch(node, result);
    return result;
  }
  const result = { type: 'image' as const, url: src, alt: str(p.alt) ?? '', title: str(p.title) ?? null };
  state.patch(node, result);
  return result;
};

/** Markdown for the content of an edited block (a hast tree of its element's children). */
export function hastToMarkdown(children: ElementContent[]): string {
  const root: HastRoot = { type: 'root', children: structuredClone(children) };
  restore(root);
  const mdast = toMdast(root, { handlers: { img } });
  return toMarkdown(mdast, WRITE_OPTIONS)
    .replace(/\n+$/, '')
    .replace(/^\n+/, '');
}

/** The hast of an element's children, for hastToMarkdown. */
export function childrenOf(el: HastElement | HastRoot): ElementContent[] {
  return el.children.filter((c) => c.type !== 'doctype') as ElementContent[];
}

/**
 * Replace text[from, to) with `insert`, keeping it a block of its own: a blank line is kept before and after
 * it (a paragraph written right under a heading would otherwise join the next lines). An empty insert takes
 * the block away with the blank line after it. Returns the new text and where `insert` now is.
 */
export function spliceBlock(text: string, from: number, to: number, insert: string): { text: string; from: number; to: number } {
  let before = text.slice(0, from);
  let after = text.slice(to);
  if (!insert) {
    // One blank line is left between what was before the block and what was after it.
    before = before.replace(/\n+$/, '');
    after = after.replace(/^\n+/, '');
    if (!before.trim()) return { text: after, from: 0, to: 0 };
    if (!after.trim()) return { text: before + (text.endsWith('\n') ? '\n' : ''), from: before.length, to: before.length };
    return { text: `${before}\n\n${after}`, from: before.length + 2, to: before.length + 2 };
  }
  if (before && !before.endsWith('\n\n')) before = before.replace(/\n*$/, before.trim() ? '\n\n' : '');
  if (after.trim() && !after.startsWith('\n\n')) after = after.replace(/^\n*/, '\n\n');
  if (!after.trim() && text.endsWith('\n') && !after.endsWith('\n')) after += '\n';
  return { text: before + insert + after, from: before.length, to: before.length + insert.length };
}

/** A stable React key for each block: its text, numbered when the same text appears more than once. */
export function blockKeys(blocks: MarkdownBlock[], taken: Iterable<string> = []): string[] {
  const used = new Set(taken);
  return blocks.map((b) => {
    let n = 0;
    let key = `${b.markdown}\u0000${n}`;
    while (used.has(key)) key = `${b.markdown}\u0000${++n}`;
    used.add(key);
    return key;
  });
}

/** Blocks the preview shows but that are only edited as text: front matter, raw HTML and Mermaid diagrams. */
export function editableBlock(b: MarkdownBlock): boolean {
  if (b.type === 'html') return parseImgTags(b.markdown) !== null;
  if (b.type === 'front_matter' || b.type === 'definition' || b.type === 'footnoteDefinition') return false;
  if (b.type === 'code_block' && /^\s*(```|~~~)\s*mermaid\b/.test(b.markdown)) return false;
  return true;
}
