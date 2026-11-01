// Document tools the agent calls, run in the browser against the open document's live store, so edits
// render, autosave and undo (as one step per agent request) like the user's own.
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { NodeSelection, TextSelection, type Transaction } from 'prosemirror-state';
import type { ClientToolCall } from '../../../shared/agent/protocol.ts';
import { docOutline } from '../../../shared/agent/docRead.ts';
import { ALIGNMENTS, BLOCK_TYPES, blockSizePt, blockType, checkDocStyle, checkPageSetup, checkSpacing, cleanFontFamily, DOC_DEFAULTS, DOC_PAGE_WIDTH, docSchema, FONT_FAMILIES, isColor, MAX_FONT_SIZE, MIN_FONT_SIZE, pageMetrics, type Alignment, type BlockType, type DocStyle, type MarkName, type PageSetup, type Spacing } from '../../../shared/doc.ts';
import { markdownToNodes } from '../../../shared/docMarkdown.ts';
import { safeLinkUrl } from '../../../shared/links.ts';
import { checkCellImage } from '../../../shared/types.ts';
import type { DocController } from '../doc/controller.ts';
import { refusedChange, ToolError } from './toolError.ts';
import { TransactionRefused } from '../state/store.ts';
import { appName } from '../brand.ts';

export const DOC_TOOLS: ReadonlySet<string> = new Set(['read_doc', 'get_doc_info', 'insert_content', 'replace_blocks', 'delete_blocks', 'replace_text', 'format_text', 'format_blocks', 'insert_image', 'set_page_setup', 'set_doc_style']);

export interface DocToolEnv {
  doc: DocController | null;
  group: string;
}

type Input = Record<string, unknown>;

const n = docSchema.nodes;
/** replace_blocks over this many blocks asks the user first. */
const CONFIRM_REPLACE_BLOCKS = 10;
const MAX_REPLACEMENTS = 1000;

function requireDoc(env: DocToolEnv): DocController {
  if (!env.doc) throw new ToolError('No document is open. Use list_docs to find one and open_doc to open it, or create_doc.');
  // (A Markdown document is routed to markdownTools.ts before this is reached.)
  return env.doc;
}

/** 0-based index of a 1-based block number, checked against the document. */
function blockIndex(ctl: DocController, v: unknown): number {
  const i = Number(v) - 1;
  const count = ctl.doc.childCount;
  if (!Number.isInteger(i) || i < 0 || i >= count) throw new ToolError(`There is no block ${v}. The document has ${count} block${count === 1 ? '' : 's'}.`);
  return i;
}

/** The 0-based inclusive range of blocks named by from/to (to defaults to from). */
function blockSpan(ctl: DocController, i: Input): [number, number] {
  const a = blockIndex(ctl, i.from);
  const b = i.to === undefined ? a : blockIndex(ctl, i.to);
  if (b < a) throw new ToolError('"to" must not be before "from".');
  return [a, b];
}

/** Document positions covering blocks a..b (0-based, inclusive). */
function positions(doc: PMNode, a: number, b: number): { from: number; to: number } {
  let pos = 0;
  let from = 0;
  for (let k = 0; k <= b; k++) {
    if (k === a) from = pos;
    pos += doc.child(k).nodeSize;
  }
  return { from, to: pos };
}

function checkImage(src: unknown): string {
  const problem = checkCellImage(src);
  if (problem) throw new ToolError(`${problem}.`);
  return src as string;
}

/** Block nodes from Markdown, with every image checked. */
function parseMarkdown(md: unknown): PMNode[] {
  const nodes = markdownToNodes(typeof md === 'string' ? md : '');
  const check = (d: PMNode) => void (d.type === n.image && checkImage(d.attrs.src));
  // A picture whose address cannot be used is left by the parser as the text it was written as, which would
  // put "![alt](address)" in the document for the user to read. Say what is wrong instead.
  for (const node of nodes) {
    const written = node.type === n.paragraph ? /^!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)$/.exec(node.textContent.trim()) : null;
    if (written) throw new ToolError(`The picture address ${written[1]} cannot be used: ${checkCellImage(written[1]) ?? 'it is not a picture address'}. Use a stored picture's /api/images/... address (transform_image returns one for image), an https address of the picture file itself, or a stored picture file's /api/files/... address.`);
  }
  for (const node of nodes) {
    check(node);
    node.descendants(check);
  }
  return nodes;
}

/** Where to insert for an `after` block number: 0 is the start, undefined the end. */
function insertPos(ctl: DocController, after: unknown): { pos: number; index: number } {
  const doc = ctl.doc;
  if (after === undefined) return { pos: doc.content.size, index: doc.childCount };
  if (after === 0) return { pos: 0, index: 0 };
  const i = blockIndex(ctl, after);
  return { pos: positions(doc, i, i).to, index: i + 1 };
}

/** Replace blocks a..b with nodes, keeping the document non-empty, and put the cursor after the change. */
function replaceSpan(tr: Transaction, a: number, b: number, nodes: PMNode[]): void {
  const { from, to } = positions(tr.doc, a, b);
  const replacement = nodes.length || tr.doc.childCount > b - a + 1 ? nodes : [n.paragraph.create()];
  tr.replaceWith(from, to, replacement);
  const end = from + replacement.reduce((s, x) => s + x.nodeSize, 0);
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(end, tr.doc.content.size)), -1));
}

/** Every occurrence of `find` in the textblocks of blocks a..b, as document positions. */
function occurrences(doc: PMNode, find: string, a: number, b: number): { from: number; to: number; block: number }[] {
  const out: { from: number; to: number; block: number }[] = [];
  const span = positions(doc, a, b);
  doc.nodesBetween(span.from, span.to, (node, pos) => {
    if (!node.isTextblock) return true;
    // One character per leaf node (hard breaks), so text offsets equal document offsets.
    const text = node.textBetween(0, node.content.size, undefined, '\n');
    let k = text.indexOf(find);
    while (k >= 0 && out.length < MAX_REPLACEMENTS) {
      out.push({ from: pos + 1 + k, to: pos + 1 + k + find.length, block: doc.resolve(pos).index(0) + 1 });
      k = text.indexOf(find, k + find.length);
    }
    return false;
  });
  return out;
}

// --- format_blocks: turning blocks into another kind ---------------------------------

/** Flatten a block into the textblocks, images and rules inside it. */
function leaves(node: PMNode): PMNode[] {
  if (node.type === n.blockquote || node.type === n.list_item) {
    const out: PMNode[] = [];
    node.forEach((c) => out.push(...leaves(c)));
    return out;
  }
  if (node.type === n.bullet_list || node.type === n.ordered_list) {
    const out: PMNode[] = [];
    node.forEach((item) => out.push(...leaves(item)));
    return out;
  }
  return [node];
}

const isLeafBlock = (node: PMNode) => node.type === n.image || node.type === n.video || node.type === n.horizontal_rule;

/** A paragraph-like node's inline content (a code block's lines joined with line breaks). */
function inlineOf(tb: PMNode): Fragment {
  if (tb.type !== n.code_block) return tb.content;
  const parts: PMNode[] = [];
  tb.textContent.split('\n').forEach((line, k) => {
    if (k) parts.push(n.hard_break.create());
    if (line) parts.push(docSchema.text(line));
  });
  return Fragment.from(parts);
}

function convertBlocks(blocks: PMNode[], type: BlockType | undefined, align: Alignment | undefined): PMNode[] {
  let out = blocks;
  if (type === 'bullet_list' || type === 'ordered_list') {
    const listType = n[type];
    out = [];
    let items: PMNode[] = [];
    const flush = () => {
      if (items.length) out.push(listType.create(null, items));
      items = [];
    };
    for (const leaf of blocks.flatMap(leaves)) {
      if (isLeafBlock(leaf)) {
        flush();
        out.push(leaf);
      } else items.push(n.list_item.create(null, n.paragraph.create({ align: leaf.attrs.align ?? null }, inlineOf(leaf))));
    }
    flush();
  } else if (type === 'blockquote') {
    const inner = blocks.flatMap((b) => (b.type === n.blockquote ? [...Array(b.childCount).keys()].map((k) => b.child(k)) : [b]));
    out = [n.blockquote.create(null, inner)];
  } else if (type === 'code_block') {
    const lines: string[] = [];
    const rest: PMNode[] = [];
    for (const leaf of blocks.flatMap(leaves)) {
      if (isLeafBlock(leaf)) rest.push(leaf);
      else lines.push(leaf.textBetween(0, leaf.content.size, undefined, '\n'));
    }
    out = [n.code_block.create(null, lines.length ? docSchema.text(lines.join('\n')) : undefined), ...rest];
  } else if (type) {
    const make = (leaf: PMNode) => {
      const attrs = { align: leaf.attrs.align ?? null };
      return type === 'paragraph' || type === 'title' || type === 'subtitle' ? n[type].create(attrs, inlineOf(leaf)) : n.heading.create({ ...attrs, level: Number(type.slice(-1)) }, inlineOf(leaf));
    };
    out = blocks.flatMap(leaves).map((leaf) => (isLeafBlock(leaf) ? leaf : make(leaf)));
  }
  if (align) {
    const value = align === 'left' ? null : align;
    const withAlign = (node: PMNode): PMNode => {
      if (node.type === n.paragraph || node.type === n.heading || node.type === n.title || node.type === n.subtitle || node.type === n.image || node.type === n.video) return node.type.create({ ...node.attrs, align: value }, node.content, node.marks);
      if (node.isLeaf || node.isTextblock) return node;
      const children: PMNode[] = [];
      node.forEach((c) => children.push(withAlign(c)));
      return node.copy(Fragment.from(children));
    };
    out = out.map(withAlign);
  }
  return out;
}

/** A question to ask before a destructive document call, or null. */
export function docConfirmationFor(call: ClientToolCall, doc: DocController | null): string | null {
  if (!doc || (call.name !== 'delete_blocks' && call.name !== 'replace_blocks')) return null;
  try {
    const [a, b] = blockSpan(doc, call.input);
    const count = b - a + 1;
    const span = count === 1 ? `block ${a + 1}` : `blocks ${a + 1}–${b + 1}`;
    if (call.name === 'delete_blocks') {
      let hasContent = false;
      for (let k = a; k <= b; k++) if (doc.doc.child(k).textContent.trim() || doc.doc.child(k).type === n.image || doc.doc.child(k).type === n.video) hasContent = true;
      return hasContent ? `Delete ${span} of the document?` : null;
    }
    return count >= CONFIRM_REPLACE_BLOCKS ? `Replace ${span} (${count} blocks) of the document?` : null;
  } catch {
    return null; // The call will fail with a useful error when it runs.
  }
}

export function runDocTool(call: ClientToolCall, env: DocToolEnv): string {
  const i = call.input;
  const ctl = requireDoc(env);
  const run = (fn: (tr: Transaction) => void) => {
    try {
      return ctl.runAgent(env.group, fn);
    } catch (e) {
      if (e instanceof TransactionRefused) throw refusedChange(e.message, 'Word', `${appName()} document`);
      throw e;
    }
  };

  switch (call.name) {
    case 'read_doc':
      return JSON.stringify(
        docOutline(ctl.doc, {
          from: typeof i.from === 'number' ? i.from : undefined,
          to: typeof i.to === 'number' ? i.to : undefined,
          cursorBlock: ctl.cursorBlock(),
          selectedText: ctl.selectedText(),
          ...(ctl.pageSetup().mode === 'pages' && ctl.pagination().blockPages.length ? { pages: ctl.pagination().blockPages.map((p) => p + 1) } : {}),
        }),
      );

    case 'get_doc_info': {
      const doc = ctl.doc;
      const blocks: Record<string, number> = {};
      doc.forEach((b) => {
        const t = blockType(b);
        blocks[t] = (blocks[t] ?? 0) + 1;
      });
      const fonts = new Map<string, number>();
      const sizes = new Map<number, number>();
      const colors = new Set<string>();
      let images = 0;
      let links = 0;
      let unstyled = 0;
      doc.descendants((node) => {
        if (node.type === n.image) images++;
        if (!node.isText) return true;
        const len = node.text?.length ?? 0;
        const font = node.marks.find((mk) => mk.type.name === 'font');
        const size = node.marks.find((mk) => mk.type.name === 'size');
        if (font) fonts.set(String(font.attrs.family), (fonts.get(String(font.attrs.family)) ?? 0) + len);
        if (size) sizes.set(Number(size.attrs.size), (sizes.get(Number(size.attrs.size)) ?? 0) + len);
        if (!font && !size) unstyled += len;
        if (node.marks.some((mk) => mk.type.name === 'link')) links++;
        for (const mk of node.marks) if (mk.type.name === 'color' || mk.type.name === 'highlight') colors.add(String(mk.attrs.color));
        return true;
      });
      const text = doc.textBetween(0, doc.content.size, '\n', (leaf) => (leaf.type === n.hard_break ? '\n' : ''));
      const chars = text.replace(/\s/g, '').length;
      const words = text.split(/\s+/).filter(Boolean).length;
      const byChars = <K,>(m: Map<K, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => ({ value: k, characters: c }));
      const setup = ctl.pageSetup();
      const metrics = pageMetrics(setup);
      const docStyle = ctl.docStyle();
      return JSON.stringify({
        block_count: doc.childCount,
        blocks_by_type: blocks,
        page_setup: {
          mode: setup.mode,
          ...(setup.mode === 'pages'
            ? {
                size: setup.size,
                orientation: setup.orientation,
                margins_in: setup.margins,
                page_numbers: setup.pageNumbers,
                header: setup.header,
                footer: setup.footer,
                page_count: ctl.pagination().pageCount,
                content_width_px: metrics.contentW,
                content_height_px: metrics.contentH,
              }
            : { note: 'One continuous column; no pages. set_page_setup with mode "pages" turns pages on.' }),
        },
        words,
        characters: chars,
        images,
        linked_runs: links,
        cursor_block: ctl.cursorBlock(),
        ...(ctl.selectedText() ? { selected_text: ctl.selectedText().slice(0, 200) } : {}),
        defaults: {
          note: 'The document style: text without a font or size mark uses these (set_doc_style changes them; format_text sets a font or size on specific text).',
          font_family: docStyle.font,
          font_fallbacks: DOC_DEFAULTS.fontFallbacks,
          body_size_pt: docStyle.size,
          block_sizes_pt: Object.fromEntries(BLOCK_TYPES.map((t) => [t, blockSizePt(t, docStyle)])),
          line_height: docStyle.lineHeight,
          space_after_paragraphs_pt: docStyle.spaceAfter,
          text_color: DOC_DEFAULTS.textColor,
          page_width_px: setup.mode === 'pages' ? metrics.contentW : DOC_PAGE_WIDTH,
        },
        fonts_in_use: byChars(fonts).map((f) => ({ family: f.value, characters: f.characters })),
        sizes_in_use: byChars(sizes).map((s) => ({ size_pt: s.value, characters: s.characters })),
        characters_in_default_font_and_size: unstyled,
        colors_in_use: [...colors],
        available_fonts: [...FONT_FAMILIES].sort(),
      });
    }

    case 'insert_content': {
      const nodes = parseMarkdown(i.markdown);
      if (!nodes.length) throw new ToolError('The markdown is empty; nothing to insert.');
      const { pos, index } = insertPos(ctl, i.after);
      run((tr) => {
        tr.insert(pos, nodes);
        const end = pos + nodes.reduce((s, x) => s + x.nodeSize, 0);
        tr.setSelection(TextSelection.near(tr.doc.resolve(end), -1));
      });
      return JSON.stringify({ inserted_blocks: nodes.length === 1 ? [index + 1] : [index + 1, index + nodes.length], block_count: ctl.doc.childCount });
    }

    case 'replace_blocks': {
      const [a, b] = blockSpan(ctl, i);
      const nodes = parseMarkdown(i.markdown);
      run((tr) => replaceSpan(tr, a, b, nodes));
      return JSON.stringify({
        replaced_blocks: a === b ? [a + 1] : [a + 1, b + 1],
        ...(nodes.length ? { new_blocks: nodes.length === 1 ? [a + 1] : [a + 1, a + nodes.length] } : { deleted: true }),
        block_count: ctl.doc.childCount,
      });
    }

    case 'delete_blocks': {
      const [a, b] = blockSpan(ctl, i);
      run((tr) => replaceSpan(tr, a, b, []));
      return JSON.stringify({ deleted_blocks: b - a + 1, block_count: ctl.doc.childCount });
    }

    case 'replace_text': {
      const find = String(i.find ?? '');
      const replace = String(i.replace ?? '');
      if (!find) throw new ToolError('"find" must not be empty.');
      const [a, b] = i.block === undefined ? [0, ctl.doc.childCount - 1] : [blockIndex(ctl, i.block), blockIndex(ctl, i.block)];
      const found = occurrences(ctl.doc, find, a, b);
      if (!found.length) throw new ToolError(`"${find}" was not found${i.block !== undefined ? ` in block ${i.block}` : ''}. Text must match exactly (case and punctuation); use read_doc to see the text.`);
      run((tr) => {
        for (const o of [...found].reverse()) tr.insertText(replace, o.from, o.to);
        const last = found[found.length - 1];
        tr.setSelection(TextSelection.create(tr.doc, last.from, last.from + replace.length));
      });
      return JSON.stringify({ replaced: found.length, blocks: [...new Set(found.map((o) => o.block))] });
    }

    case 'format_text': {
      const find = typeof i.find === 'string' && i.find ? i.find : null;
      if (!find && i.from === undefined) throw new ToolError('Pass find (the text to format) and/or from/to (the blocks).');
      const [a, b] = i.from === undefined ? [0, ctl.doc.childCount - 1] : blockSpan(ctl, i);
      const flags: MarkName[] = ['bold', 'italic', 'underline', 'strike', 'code'];
      const changes: { type: MarkName; attrs: Record<string, unknown> | null }[] = [];
      for (const f of flags) if (typeof i[f] === 'boolean') changes.push({ type: f, attrs: i[f] ? {} : null });
      for (const c of ['color', 'highlight'] as const) {
        if (typeof i[c] !== 'string') continue;
        const v = (i[c] as string).trim();
        if (v && !isColor(v)) throw new ToolError(`"${v}" is not a CSS color. Use a hex color such as #c00000.`);
        changes.push({ type: c, attrs: v ? { color: v } : null });
      }
      if (typeof i.font === 'string') {
        const v = i.font.trim();
        if (v && !cleanFontFamily(v)) throw new ToolError(`"${v}" is not a font name. Use a family such as Georgia or Open Sans (or "" to remove the font).`);
        changes.push({ type: 'font', attrs: v ? { family: cleanFontFamily(v) } : null });
      }
      if (typeof i.size === 'number') {
        if (i.size !== 0 && (i.size < MIN_FONT_SIZE || i.size > MAX_FONT_SIZE)) throw new ToolError(`size must be between ${MIN_FONT_SIZE} and ${MAX_FONT_SIZE} points (or 0 to remove it).`);
        changes.push({ type: 'size', attrs: i.size ? { size: i.size } : null });
      }
      if (typeof i.link === 'string') {
        const v = i.link.trim();
        if (v && !safeLinkUrl(v)) throw new ToolError('link must be an http(s) or mailto URL (or "" to remove the link).');
        changes.push({ type: 'link', attrs: v ? { href: v } : null });
      }
      if (!changes.length) throw new ToolError('Pass at least one formatting property (bold, italic, underline, strike, code, color, highlight, font, size or link).');
      const ranges = find ? occurrences(ctl.doc, find, a, b) : [{ ...positions(ctl.doc, a, b), block: a + 1 }];
      if (!ranges.length) throw new ToolError(`"${find}" was not found in blocks ${a + 1}–${b + 1}. Text must match exactly; use read_doc to see it.`);
      run((tr) => {
        for (const r of ranges) {
          for (const c of changes) {
            const type = docSchema.marks[c.type];
            tr.removeMark(r.from, r.to, type);
            if (c.attrs) tr.addMark(r.from, r.to, type.create(c.attrs));
          }
        }
        const first = ranges[0];
        tr.setSelection(TextSelection.create(tr.doc, first.from, Math.min(first.to, tr.doc.content.size)));
      });
      return JSON.stringify({ formatted: find ? `${ranges.length} occurrence${ranges.length === 1 ? '' : 's'} of "${find}"` : `blocks ${a + 1}–${b + 1}`, changed: changes.map((c) => c.type) });
    }

    case 'format_blocks': {
      const [a, b] = blockSpan(ctl, i);
      const type = i.type as BlockType | undefined;
      const align = i.align as Alignment | undefined;
      if (type && !BLOCK_TYPES.includes(type)) throw new ToolError(`Unknown block type "${type}". Use one of ${BLOCK_TYPES.join(', ')}.`);
      if (align && !ALIGNMENTS.includes(align)) throw new ToolError(`Unknown alignment "${align}".`);
      const spacing: { [K in keyof Spacing]?: number | null } = {};
      for (const [from, to] of [
        ['space_before', 'before'],
        ['space_after', 'after'],
        ['line_spacing', 'line'],
      ] as const) {
        if (typeof i[from] === 'number') spacing[to] = i[from] === 0 && to === 'line' ? null : (i[from] as number);
      }
      const spacingProblem = checkSpacing(Object.fromEntries(Object.entries(spacing).filter(([, v]) => v !== null)));
      if (spacingProblem) throw new ToolError(`${spacingProblem}.`);
      const hasSpacing = Object.keys(spacing).length > 0;
      if (!type && !align && !hasSpacing) throw new ToolError('Pass type, align and/or spacing (space_before, space_after, line_spacing).');
      const blocks: PMNode[] = [];
      for (let k = a; k <= b; k++) blocks.push(ctl.doc.child(k));
      let nodes = convertBlocks(blocks, type, align);
      if (hasSpacing) {
        const withSpacing = (node: PMNode): PMNode => {
          if (node.isTextblock && node.type !== n.code_block) {
            const cur = { ...((node.attrs.spacing as Spacing | null) ?? {}) };
            for (const k of ['before', 'after', 'line'] as const) {
              const v = spacing[k];
              if (v === undefined) continue;
              if (v === null) delete cur[k];
              else cur[k] = v;
            }
            return node.type.create({ ...node.attrs, spacing: Object.keys(cur).length ? cur : null }, node.content, node.marks);
          }
          if (node.isLeaf || node.isTextblock) return node;
          const children: PMNode[] = [];
          node.forEach((c) => children.push(withSpacing(c)));
          return node.copy(Fragment.from(children));
        };
        nodes = nodes.map(withSpacing);
      }
      run((tr) => replaceSpan(tr, a, b, nodes));
      return JSON.stringify({ blocks: nodes.length === 1 ? [a + 1] : [a + 1, a + nodes.length], ...(type ? { type } : {}), ...(align ? { align } : {}), ...(hasSpacing ? { spacing } : {}), block_count: ctl.doc.childCount });
    }

    case 'insert_image': {
      const src = checkImage(i.src);
      const align = i.align as Alignment | undefined;
      if (align && !ALIGNMENTS.includes(align)) throw new ToolError(`Unknown alignment "${align}".`);
      const width = typeof i.width === 'number' ? Math.max(20, Math.min(10000, Math.round(i.width))) : null;
      const node = n.image.create({ src, alt: typeof i.alt === 'string' ? i.alt : '', width, align: align && align !== 'left' ? align : null });
      const { pos, index } = insertPos(ctl, i.after);
      run((tr) => {
        tr.insert(pos, node);
        tr.setSelection(NodeSelection.create(tr.doc, pos));
      });
      return JSON.stringify({ inserted_block: index + 1, block_count: ctl.doc.childCount });
    }

    case 'set_doc_style': {
      const patch: Partial<DocStyle> = {};
      if (typeof i.font === 'string') {
        const family = cleanFontFamily(i.font);
        if (!family) throw new ToolError(`"${i.font}" is not a font name.`);
        patch.font = family;
      }
      if (typeof i.size === 'number') patch.size = i.size;
      if (typeof i.line_spacing === 'number') patch.lineHeight = i.line_spacing;
      if (typeof i.space_after === 'number') patch.spaceAfter = i.space_after;
      if (!Object.keys(patch).length) throw new ToolError('Pass at least one of font, size, line_spacing or space_after.');
      const problem = checkDocStyle(patch);
      if (problem) throw new ToolError(`${problem}.`);
      const changed = ctl.setDocStyle(patch);
      const s = ctl.docStyle();
      return JSON.stringify({ changed, document_style: { font: s.font, size_pt: s.size, line_spacing: s.lineHeight, space_after_pt: s.spaceAfter } });
    }

    case 'set_page_setup': {
      const patch: Record<string, unknown> = {};
      for (const [from, to] of [
        ['mode', 'mode'],
        ['size', 'size'],
        ['orientation', 'orientation'],
        ['margins', 'margins'],
        ['page_numbers', 'pageNumbers'],
        ['header', 'header'],
        ['footer', 'footer'],
      ] as const) {
        if (i[from] !== undefined) patch[to] = i[from];
      }
      if (!Object.keys(patch).length) throw new ToolError('Pass at least one page setting to change.');
      const problem = checkPageSetup(patch);
      if (problem) throw new ToolError(`${problem}.`);
      const changed = ctl.setPageSetup(patch as Partial<PageSetup>);
      const setup = ctl.pageSetup();
      return JSON.stringify({ changed, page_setup: { mode: setup.mode, size: setup.size, orientation: setup.orientation, margins_in: setup.margins, page_numbers: setup.pageNumbers, header: setup.header, footer: setup.footer } });
    }

    default:
      throw new ToolError(`Unknown tool ${call.name}.`);
  }
}
