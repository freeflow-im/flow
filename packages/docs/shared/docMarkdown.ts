// Markdown for documents: how the assistant reads a document (read_doc) and writes content into it.
//
// The dialect is the usual one (# headings, - and 1. lists with indentation for nesting, > quotes, ``` code
// fences, --- rules, **bold**, *italic*, ~~strike~~, `code`, [text](url), ![alt](src) on a line of its own) plus
// a little HTML for what Markdown cannot say: <u>underline</u>, <mark>highlight</mark> and
// <span style="color: #c00">colored text</span>. A line break inside a paragraph is kept as a line break.
// docToMarkdown(markdownToNodes(md)) gives md back for anything this module writes.
import { Fragment, Mark, Node as PMNode, type Schema } from 'prosemirror-model';
import { cleanFontFamily, docFromNode, docSchema, fontFamilyCss, isColor, parseFontSize, type Doc } from './doc.ts';
import { safeLinkUrl } from './links.ts';
import { checkCellImage } from './types.ts';
import { videoAddress } from './video.ts';

// ---------------------------------------------------------------------------
// Parsing

const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
/** A title or subtitle: a heading with a Pandoc-style class, e.g. `# Annual report {.title}`. */
const TITLE_CLASS_RE = /^(.*?)\s*\{\.(title|subtitle)\}$/;
const RULE_RE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const FENCE_RE = /^( {0,3})(`{3,}|~{3,})\s*(\S*)\s*$/;
const QUOTE_RE = /^ {0,3}>\s?(.*)$/;
const ITEM_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const EMPTY_ITEM_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s*$/;
const IMAGE_RE = /^ {0,3}!\[([^\]]*)\]\(\s*(\S+?)(?:\s+"[^"]*")?\s*\)\s*$/;
/** A page break, as Pandoc writes it. */
const PAGE_BREAK_RE = /^ {0,3}\\newpage\s*$/;

function blank(s: string): boolean {
  return !s.trim();
}

function indentOf(s: string): number {
  let n = 0;
  for (const ch of s) {
    if (ch === ' ') n++;
    else if (ch === '\t') n += 4;
    else break;
  }
  return n;
}

/** Does this line start a block other than a paragraph? (A paragraph ends before such a line.) */
function startsBlock(s: string): boolean {
  return HEADING_RE.test(s) || RULE_RE.test(s) || FENCE_RE.test(s) || QUOTE_RE.test(s) || ITEM_RE.test(s) || IMAGE_RE.test(s) || PAGE_BREAK_RE.test(s);
}

class BlockParser {
  private schema: Schema;
  constructor(schema: Schema) {
    this.schema = schema;
  }

  parse(lines: string[]): PMNode[] {
    const out: PMNode[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (blank(line)) {
        i++;
        continue;
      }
      let m: RegExpMatchArray | null;
      if ((m = FENCE_RE.exec(line))) {
        const fence = m[2];
        const indent = m[1].length;
        const body: string[] = [];
        i++;
        const closes = (l: string) => {
          const t = l.trim();
          return t.startsWith(fence[0].repeat(fence.length)) && /^[`~]+$/.test(t);
        };
        while (i < lines.length && !closes(lines[i])) {
          body.push(lines[i].startsWith(' '.repeat(indent)) ? lines[i].slice(indent) : lines[i].trimStart());
          i++;
        }
        i++; // closing fence (or end of input)
        out.push(this.schema.nodes.code_block.create(null, body.length ? this.schema.text(body.join('\n')) : undefined));
        continue;
      }
      if ((m = HEADING_RE.exec(line))) {
        const t = TITLE_CLASS_RE.exec(m[2]);
        if (t) out.push(this.schema.nodes[t[2]].create(null, this.inline(t[1])));
        else out.push(this.schema.nodes.heading.create({ level: Math.min(m[1].length, 3) }, this.inline(m[2])));
        i++;
        continue;
      }
      if (RULE_RE.test(line) && !ITEM_RE.test(line)) {
        out.push(this.schema.nodes.horizontal_rule.create());
        i++;
        continue;
      }
      if (PAGE_BREAK_RE.test(line)) {
        out.push(this.schema.nodes.page_break.create());
        i++;
        continue;
      }
      // A video is written as an image whose address is a video's: a YouTube link or a stored file.
      if ((m = IMAGE_RE.exec(line)) && videoAddress(m[2])) {
        out.push(this.schema.nodes.video.create({ src: videoAddress(m[2]), title: m[1] }));
        i++;
        continue;
      }
      if ((m = IMAGE_RE.exec(line)) && !checkCellImage(m[2])) {
        out.push(this.schema.nodes.image.create({ src: m[2], alt: m[1] }));
        i++;
        continue;
      }
      if (QUOTE_RE.test(line)) {
        const inner: string[] = [];
        while (i < lines.length && (m = QUOTE_RE.exec(lines[i]))) {
          inner.push(m[1]);
          i++;
        }
        const children = this.parse(inner);
        out.push(this.schema.nodes.blockquote.create(null, children.length ? children : this.schema.nodes.paragraph.create()));
        continue;
      }
      if (ITEM_RE.test(line) || EMPTY_ITEM_RE.test(line)) {
        const [node, next] = this.list(lines, i);
        out.push(node);
        i = next;
        continue;
      }
      // Paragraph: until a blank line or the start of another block. Line breaks are kept.
      const para: string[] = [line.trim()];
      i++;
      while (i < lines.length && !blank(lines[i]) && !startsBlock(lines[i])) {
        para.push(lines[i].trim());
        i++;
      }
      out.push(this.schema.nodes.paragraph.create(null, this.inline(para.join('\n'))));
    }
    return out;
  }

  /** Parse the list starting at lines[start]; returns the node and the index after it. */
  private list(lines: string[], start: number): [PMNode, number] {
    const first = ITEM_RE.exec(lines[start]) ?? EMPTY_ITEM_RE.exec(lines[start])!;
    const indent = indentOf(first[1]);
    const ordered = /\d/.test(first[2]);
    const startNum = ordered ? Number.parseInt(first[2], 10) : 1;
    const items: PMNode[] = [];
    let i = start;
    while (i < lines.length) {
      const m = ITEM_RE.exec(lines[i]) ?? EMPTY_ITEM_RE.exec(lines[i]);
      if (!m || indentOf(m[1]) !== indent || /\d/.test(m[2]) !== ordered) break;
      const contentIndent = indent + m[2].length + 1;
      // Collect the item's own lines (first line plus any continuation indented past the marker).
      const own: string[] = [m[3] ?? ''];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (blank(l)) {
          // A blank line continues the item only when the next non-blank line is indented into it.
          let j = i;
          while (j < lines.length && blank(lines[j])) j++;
          if (j < lines.length && indentOf(lines[j]) >= contentIndent) {
            own.push('');
            i = j;
            continue;
          }
          break;
        }
        const ind = indentOf(l);
        if (ind >= contentIndent) {
          own.push(l.slice(contentIndent));
          i++;
        } else if (ind > indent && (ITEM_RE.test(l) || EMPTY_ITEM_RE.test(l))) {
          // A nested item indented less than the content column still belongs to this item.
          own.push(l.slice(ind));
          i++;
        } else break;
      }
      const children = this.parse(own);
      const blocks = children.length && children[0].type.name === 'paragraph' ? children : [this.schema.nodes.paragraph.create(), ...children];
      items.push(this.schema.nodes.list_item.create(null, blocks));
    }
    const type = ordered ? this.schema.nodes.ordered_list : this.schema.nodes.bullet_list;
    return [type.create(ordered && startNum !== 1 ? { start: startNum } : null, items), i];
  }

  inline(text: string): PMNode[] {
    return new InlineParser(this.schema, text).run();
  }
}

/** Does the delimiter at i open emphasis? (left-flanking: followed by non-space.) */
function canOpen(s: string, i: number, len: number, underscore: boolean): boolean {
  const next = s[i + len];
  if (next === undefined || /\s/.test(next)) return false;
  if (underscore) {
    const prev = s[i - 1];
    return prev === undefined || /[\s\p{P}]/u.test(prev);
  }
  return true;
}

function canClose(s: string, i: number, len: number, underscore: boolean): boolean {
  const prev = s[i - 1];
  if (prev === undefined || /\s/.test(prev)) return false;
  if (underscore) {
    const next = s[i + len];
    return next === undefined || /[\s\p{P}]/u.test(next);
  }
  return true;
}

const TAG_RE = /^<(\/?)(u|s|b|strong|i|em|mark|del|span|br)\b([^>]*)>/i;
/** A picture in the line, as `inlineToMarkdown` writes it: `<img src="…" alt="…" width="…">`. */
const IMG_TAG_RE = /^<img\b([^>]*?)\/?>/i;

class InlineParser {
  private schema: Schema;
  private s: string;
  private out: PMNode[] = [];
  private buf = '';
  private marks: readonly Mark[] = [];
  /** The marks each open <span> added, so its </span> removes exactly those. */
  private spans: string[][] = [];

  constructor(schema: Schema, text: string) {
    this.schema = schema;
    this.s = text;
  }

  private flush(): void {
    if (this.buf) this.out.push(this.schema.text(this.buf, this.marks));
    this.buf = '';
  }

  private has(name: string): Mark | undefined {
    return this.marks.find((m) => m.type.name === name);
  }

  private toggle(name: string, attrs?: Record<string, unknown>): void {
    this.flush();
    const cur = this.has(name);
    if (cur) this.marks = cur.removeFromSet(this.marks);
    else this.marks = this.schema.marks[name].create(attrs).addToSet(this.marks);
  }

  private add(name: string, attrs?: Record<string, unknown>): void {
    this.flush();
    this.marks = this.schema.marks[name].create(attrs).addToSet(this.marks);
  }

  private remove(name: string): void {
    this.flush();
    const cur = this.has(name);
    if (cur) this.marks = cur.removeFromSet(this.marks);
  }

  /** Is there a matching closing delimiter after position i? */
  private closes(delim: string, from: number, underscore: boolean): boolean {
    let k = this.s.indexOf(delim, from);
    while (k >= 0) {
      if (canClose(this.s, k, delim.length, underscore)) return true;
      k = this.s.indexOf(delim, k + 1);
    }
    return false;
  }

  run(): PMNode[] {
    const s = this.s;
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '\\' && i + 1 < s.length && /[\p{P}\p{S}]/u.test(s[i + 1])) {
        this.buf += s[i + 1];
        i += 2;
        continue;
      }
      if (ch === '\n') {
        this.flush();
        this.out.push(this.schema.nodes.hard_break.create());
        i++;
        continue;
      }
      if (ch === '`') {
        let n = 1;
        while (s[i + n] === '`') n++;
        const fence = '`'.repeat(n);
        const end = s.indexOf(fence, i + n);
        if (end > 0) {
          this.flush();
          let code = s.slice(i + n, end);
          if (code.length > 1 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
          this.out.push(this.schema.text(code, this.schema.marks.code.create().addToSet(this.marks)));
          i = end + n;
          continue;
        }
      }
      if (ch === '*' || ch === '_') {
        const underscore = ch === '_';
        const len = s[i + 1] === ch ? 2 : 1;
        const delim = ch.repeat(len);
        const name = len === 2 ? 'bold' : 'italic';
        if (this.has(name) && canClose(s, i, len, underscore)) {
          this.toggle(name);
          i += len;
          continue;
        }
        if (!this.has(name) && canOpen(s, i, len, underscore) && this.closes(delim, i + len, underscore)) {
          this.toggle(name);
          i += len;
          continue;
        }
      }
      if (ch === '~' && s[i + 1] === '~') {
        if (this.has('strike') ? canClose(s, i, 2, false) : canOpen(s, i, 2, false) && this.closes('~~', i + 2, false)) {
          this.toggle('strike');
          i += 2;
          continue;
        }
      }
      if (ch === '!' && s[i + 1] === '[' && this.schema.nodes.inline_image) {
        const pic = /^!\[([^\]]*)\]\(\s*(\S+?)(?:\s+"[^"]*")?\s*\)/.exec(s.slice(i));
        if (pic && !checkCellImage(pic[2]) && !videoAddress(pic[2])) {
          this.flush();
          this.out.push(this.schema.nodes.inline_image.create({ src: pic[2], alt: pic[1] }));
          i += pic[0].length;
          continue;
        }
      }
      if (ch === '[') {
        const close = s.indexOf('](', i + 1);
        if (close > 0) {
          const end = s.indexOf(')', close + 2);
          const url = end > 0 ? s.slice(close + 2, end).trim().replace(/\s+"[^"]*"$/, '') : '';
          if (end > 0 && !s.slice(i + 1, close).includes('[') && safeLinkUrl(url)) {
            this.flush();
            const inner = new InlineParser(this.schema, s.slice(i + 1, close));
            inner.marks = this.schema.marks.link.create({ href: url }).addToSet(this.marks);
            this.out.push(...inner.run());
            i = end + 1;
            continue;
          }
        }
      }
      if (ch === '<') {
        const auto = /^<(https?:\/\/[^\s<>]+|mailto:[^\s<>]+)>/i.exec(s.slice(i));
        if (auto && safeLinkUrl(auto[1])) {
          this.flush();
          this.out.push(this.schema.text(auto[1], this.schema.marks.link.create({ href: auto[1] }).addToSet(this.marks)));
          i += auto[0].length;
          continue;
        }
        const img = IMG_TAG_RE.exec(s.slice(i));
        if (img && this.schema.nodes.inline_image) {
          const attr = (name: string) => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(img[1])?.[1];
          const src = attr('src') ?? '';
          const width = Number.parseInt(attr('width') ?? '', 10);
          if (!checkCellImage(src)) {
            this.flush();
            this.out.push(this.schema.nodes.inline_image.create({ src, alt: attr('alt') ?? '', width: width > 0 && width <= 10000 ? width : null }));
            i += img[0].length;
            continue;
          }
        }
        const tag = TAG_RE.exec(s.slice(i));
        if (tag) {
          const closing = tag[1] === '/';
          const name = tag[2].toLowerCase();
          i += tag[0].length;
          if (name === 'br') {
            this.flush();
            this.out.push(this.schema.nodes.hard_break.create());
          } else if (name === 'u') closing ? this.remove('underline') : this.add('underline');
          else if (name === 's' || name === 'del') closing ? this.remove('strike') : this.add('strike');
          else if (name === 'b' || name === 'strong') closing ? this.remove('bold') : this.add('bold');
          else if (name === 'i' || name === 'em') closing ? this.remove('italic') : this.add('italic');
          else if (name === 'mark') closing ? this.remove('highlight') : this.add('highlight', { color: '#fff2a8' });
          else if (name === 'span') {
            if (closing) {
              for (const mark of this.spans.pop() ?? ['color', 'highlight', 'font', 'size']) this.remove(mark);
            } else {
              const added: string[] = [];
              const style = (prop: string) => new RegExp(`(?:^|[\\s;"'])${prop}\\s*:\\s*([^;"']+)`, 'i').exec(tag[3])?.[1]?.trim();
              const color = style('color');
              const bg = style('background(?:-color)?');
              const family = style('font-family');
              const size = style('font-size');
              if (color && isColor(color)) (this.add('color', { color }), added.push('color'));
              if (bg && isColor(bg)) (this.add('highlight', { color: bg }), added.push('highlight'));
              if (family && cleanFontFamily(family)) (this.add('font', { family: cleanFontFamily(family) }), added.push('font'));
              if (size && parseFontSize(size)) (this.add('size', { size: parseFontSize(size) }), added.push('size'));
              this.spans.push(added);
            }
          }
          continue;
        }
      }
      this.buf += ch;
      i++;
    }
    this.flush();
    return this.out;
  }
}

/** Parse Markdown into top-level block nodes (empty input gives no nodes). */
export function markdownToNodes(md: string, schema: Schema = docSchema): PMNode[] {
  return new BlockParser(schema).parse(md.replace(/\r\n?/g, '\n').split('\n'));
}

/** Parse Markdown into a document (an empty document has one empty paragraph). */
export function markdownToDoc(md: string): Doc {
  const blocks = markdownToNodes(md);
  return docFromNode(docSchema.nodes.doc.create(null, blocks.length ? blocks : docSchema.nodes.paragraph.create()));
}

/** Inline nodes for a Markdown line (no block structure), for text the assistant inserts into a paragraph. */
export function markdownToInline(md: string, schema: Schema = docSchema): Fragment {
  return Fragment.from(new InlineParser(schema, md).run());
}

// ---------------------------------------------------------------------------
// Serializing

const MARK_ORDER = Object.keys(docSchema.marks);
const ESCAPE_RE = /[\\*`~[\]<]/g;
const LINE_START_RE = /^(#{1,6}\s|>|[-+*]\s|\d{1,9}[.)]\s|---|\*\*\*|___)/;

function escapeText(text: string, lineStart: boolean): string {
  // An underscore between word characters (snake_case) is never emphasis, so it stays as is.
  let out = text.replace(ESCAPE_RE, '\\$&').replace(/_/g, (m, at: number, s: string) => (/\w/.test(s[at - 1] ?? '') && /\w/.test(s[at + 1] ?? '') ? m : `\\${m}`));
  if (lineStart) out = out.replace(LINE_START_RE, (m) => `\\${m}`);
  return out;
}

function markDelims(mark: Mark): [string, string] {
  switch (mark.type.name) {
    case 'bold':
      return ['**', '**'];
    case 'italic':
      return ['*', '*'];
    case 'strike':
      return ['~~', '~~'];
    case 'underline':
      return ['<u>', '</u>'];
    case 'code':
      return ['`', '`'];
    case 'link':
      return ['[', `](${String(mark.attrs.href)})`];
    case 'color':
      return [`<span style="color: ${String(mark.attrs.color)}">`, '</span>'];
    case 'highlight':
      return [`<span style="background-color: ${String(mark.attrs.color)}">`, '</span>'];
    case 'font':
      return [`<span style="font-family: ${fontFamilyCss(String(mark.attrs.family))}">`, '</span>'];
    case 'size':
      return [`<span style="font-size: ${Number(mark.attrs.size)}pt">`, '</span>'];
    default:
      return ['', ''];
  }
}

/** Markdown for the inline content of a paragraph or heading. */
export function inlineToMarkdown(node: PMNode): string {
  const children: PMNode[] = [];
  node.forEach((n) => children.push(n));
  const marksOf = (n: PMNode): Mark[] => (n.isText && n.text?.trim() ? [...n.marks] : []);
  let active: Mark[] = [];
  let out = '';
  let lineStart = true;
  for (let k = 0; k < children.length; k++) {
    const n = children[k];
    if (n.type.name === 'inline_image') {
      for (const m of [...active].reverse()) out += markDelims(m)[1];
      active = [];
      const alt = String(n.attrs.alt ?? '').replace(/["<>]/g, '');
      out += `<img src="${String(n.attrs.src).replace(/"/g, '%22')}" alt="${alt}"${n.attrs.width ? ` width="${Number(n.attrs.width)}"` : ''}>`;
      lineStart = false;
      continue;
    }
    if (!n.isText) {
      // Line break: close everything, reopen after.
      for (const m of [...active].reverse()) out += markDelims(m)[1];
      active = [];
      out += '\n';
      lineStart = true;
      continue;
    }
    const text = n.text ?? '';
    const marks = marksOf(n);
    const next = children[k + 1];
    const nextMarks = next ? marksOf(next) : [];
    // Close marks this node doesn't carry (and everything opened after them).
    let keep = 0;
    while (keep < active.length && marks.some((m) => m.eq(active[keep]))) keep++;
    for (const m of active.slice(keep).reverse()) out += markDelims(m)[1];
    active = active.slice(0, keep);
    // Open the rest, those that continue furthest first, so closings nest.
    const toOpen = marks.filter((m) => !active.some((a) => a.eq(m)));
    const reach = (m: Mark) => {
      let r = 0;
      for (let j = k + 1; j < children.length && marksOf(children[j]).some((x) => x.eq(m)); j++) r++;
      return r;
    };
    toOpen.sort((a, b) => reach(b) - reach(a) || MARK_ORDER.indexOf(a.type.name) - MARK_ORDER.indexOf(b.type.name));
    const lead = /^\s*/.exec(text)![0];
    const trail = /\s*$/.exec(text)![0];
    const body = text.slice(lead.length, Math.max(lead.length, text.length - trail.length));
    if (toOpen.length) out += lead;
    for (const m of toOpen) {
      out += markDelims(m)[0];
      active.push(m);
    }
    const code = marks.some((m) => m.type.name === 'code');
    const content = toOpen.length ? body : text;
    out += code ? content : escapeText(content, lineStart);
    lineStart = false;
    // Close here when the next node drops any of this node's marks, so trailing space stays outside.
    const closing = active.filter((m) => !nextMarks.some((x) => x.eq(m)));
    if (toOpen.length && (closing.length || !next)) {
      let keep2 = 0;
      while (keep2 < active.length && nextMarks.some((m) => m.eq(active[keep2]))) keep2++;
      for (const m of active.slice(keep2).reverse()) out += markDelims(m)[1];
      active = active.slice(0, keep2);
      out += trail;
    } else if (toOpen.length) out += trail;
  }
  for (const m of [...active].reverse()) out += markDelims(m)[1];
  return out;
}

function indentLines(s: string, prefix: string, firstPrefix = prefix): string {
  return s
    .split('\n')
    .map((l, i) => (i === 0 ? firstPrefix : prefix) + l)
    .join('\n')
    .replace(/[ \t]+$/gm, '');
}

/** Markdown for one block (a top-level node or a child of a quote or list item). */
export function blockToMarkdown(node: PMNode): string {
  switch (node.type.name) {
    case 'heading':
      return `${'#'.repeat(node.attrs.level as number)} ${inlineToMarkdown(node)}`;
    case 'title':
      return `# ${inlineToMarkdown(node)} {.title}`;
    case 'subtitle':
      return `## ${inlineToMarkdown(node)} {.subtitle}`;
    case 'paragraph':
      return inlineToMarkdown(node);
    case 'blockquote':
      return blocksToMarkdown(node)
        .split('\n')
        .map((l) => (l ? `> ${l}` : '>'))
        .join('\n');
    case 'code_block': {
      const text = node.textContent;
      let fence = '```';
      while (text.includes(fence)) fence += '`';
      return `${fence}\n${text}\n${fence}`;
    }
    case 'horizontal_rule':
      return '---';
    case 'page_break':
      return '\\newpage';
    case 'image':
      return `![${String(node.attrs.alt ?? '').replace(/[[\]]/g, '')}](${String(node.attrs.src)})`;
    case 'video':
      return `![${String(node.attrs.title ?? '').replace(/[[\]]/g, '')}](${String(node.attrs.src)})`;
    case 'bullet_list':
    case 'ordered_list': {
      const ordered = node.type.name === 'ordered_list';
      const start = ordered ? (node.attrs.start as number) : 1;
      const lines: string[] = [];
      node.forEach((item, _off, k) => {
        const marker = ordered ? `${start + k}. ` : '- ';
        const inner: string[] = [];
        item.forEach((child) => inner.push(blockToMarkdown(child)));
        // Blocks inside an item are separated by a blank line, except a list right after the first paragraph.
        let body = '';
        inner.forEach((b, j) => {
          const prevIsPara = j > 0 && item.child(j - 1).type.name === 'paragraph';
          const isList = item.child(j).type.name.endsWith('_list');
          body += (j === 0 ? '' : prevIsPara && isList ? '\n' : '\n\n') + b;
        });
        lines.push(indentLines(body, ' '.repeat(marker.length), marker));
      });
      return lines.join('\n');
    }
    default:
      return node.textContent;
  }
}

/** Markdown for the children of a container (the document, a quote, a list item). */
export function blocksToMarkdown(node: PMNode): string {
  const parts: string[] = [];
  node.forEach((child) => parts.push(blockToMarkdown(child)));
  return parts.join('\n\n');
}

export function docToMarkdown(node: PMNode): string {
  return blocksToMarkdown(node);
}
