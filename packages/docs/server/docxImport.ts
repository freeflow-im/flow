// Convert an uploaded .docx file into a document. Keeps paragraphs with their styles (title, subtitle, headings,
// quotes), bulleted and numbered lists with nesting, run formatting (bold, italic, underline, strikethrough,
// color, highlight, font and size), hyperlinks, line breaks and inline pictures. Tables are flattened to
// paragraphs; a header and footer of plain text and page numbers are read into the page setup, and richer
// ones, footnotes, comments, fields and drawings other than pictures are dropped and reported as warnings.
// What the app's own writer (server/docxExport.ts) adds for itself in its namespace is read back too: that a
// style's look is the app's own (not formatting to keep as marks), and the page mode.
import { XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';
import { Fragment, type Mark, type Node as PMNode } from 'prosemirror-model';
import { cleanFontFamily, DEFAULT_DOC_STYLE, docFromNode, docSchema, isColor, MAX_BLOCKS, MAX_FONT_SIZE, MAX_HEADER_CHARS, MAX_LINE_HEIGHT, MAX_MARGIN, MAX_PARAGRAPH_SPACE, MIN_FONT_SIZE, MIN_LINE_HEIGHT, MIN_MARGIN, PAGE_SIZES, validateDoc, type Alignment, type Doc, type DocStyle, type PageSetup, type PageSizeId, type Spacing } from '../shared/doc.ts';
import { safeLinkUrl } from '../shared/links.ts';
import { MAX_CELL_IMAGE_BYTES } from '../shared/types.ts';
import { ImportError, IMPORT_LIMITS } from './xlsxImport.ts';

/** Stores an image for the importing user; returns its /api/images/... URL. */
export type ImageSink = (type: string, data: Buffer) => Promise<string>;

export interface DocxImportResult {
  doc: Doc;
  warnings: string[];
}

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const EMU_PER_PX = 9525;
const MAX_IMAGE_PX = 760;
/** Highlight names Word uses (w:highlight) as colors. */
const HIGHLIGHTS: Record<string, string> = {
  yellow: '#ffff00',
  green: '#00ff00',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  blue: '#0000ff',
  red: '#ff0000',
  darkblue: '#000080',
  darkcyan: '#008080',
  darkgreen: '#008000',
  darkmagenta: '#800080',
  darkred: '#800000',
  darkyellow: '#808000',
  darkgray: '#808080',
  lightgray: '#c0c0c0',
  black: '#000000',
};

// --- Tiny helpers over fast-xml-parser's ordered output ------------------------------------------------

type XNode = Record<string, unknown>;

const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '', parseTagValue: false, parseAttributeValue: false, trimValues: false });

const tagOf = (n: XNode): string => Object.keys(n).find((k) => k !== ':@') ?? '';
const kids = (n: XNode | undefined): XNode[] => {
  const v = n ? n[tagOf(n)] : undefined;
  return Array.isArray(v) ? (v as XNode[]) : []; // a text node holds a string, not children
};
const attrs = (n: XNode | undefined): Record<string, string> => ((n?.[':@'] as Record<string, string> | undefined) ?? {});
const child = (n: XNode | undefined, name: string): XNode | undefined => kids(n).find((c) => tagOf(c) === name);
const children = (n: XNode | undefined, name: string): XNode[] => kids(n).filter((c) => tagOf(c) === name);
const textOf = (n: XNode | undefined): string =>
  kids(n)
    .map((c) => ('#text' in c ? String(c['#text']) : ''))
    .join('');
const num = (v: string | undefined): number | undefined => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
/** A w:val attribute, or "" for a present element without one (which means "on"). */
const val = (n: XNode | undefined): string | undefined => (n ? (attrs(n)['w:val'] ?? '') : undefined);
/** Toggle properties (w:b, w:i, ...): present means on unless w:val says 0/false. */
const on = (n: XNode | undefined): boolean | undefined => (n ? !['0', 'false', 'off'].includes(attrs(n)['w:val'] ?? '') : undefined);

function parseXml(xml: string): XNode[] {
  return parser.parse(xml) as XNode[];
}

function root(doc: XNode[], name: string): XNode | undefined {
  return doc.find((n) => tagOf(n) === name);
}

function resolvePath(baseDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = baseDir.split('/').filter(Boolean);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg) parts.push(seg);
  }
  return parts.join('/');
}

interface Rel {
  id: string;
  type: string;
  target: string;
}

/** Run formatting, as found on a run and inherited from its paragraph and character styles. */
interface RunProps {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  color?: string;
  highlight?: string;
  font?: string;
  size?: number;
}

interface ParaProps {
  /** Resolved paragraph kind. */
  kind: 'paragraph' | 'title' | 'subtitle' | 'heading' | 'quote' | 'code';
  level?: number;
  align?: Alignment;
  /** Numbering, when the paragraph is a list item. */
  numId?: string;
  ilvl?: number;
  /** Spacing from the paragraph and its styles (points; line as a multiple). */
  spacing: Spacing;
}

/** Word's "single" line spacing (240 twentieths) is about 1.15 times the font size on screen. */
const SINGLE_LINE = 1.15;

interface Style {
  id: string;
  name: string;
  type: string;
  basedOn?: string;
  pPr?: XNode;
  rPr?: XNode;
  /** Written by the app with the look of its own block styles, which the block already has: its formatting is not kept as marks or spacing. */
  app?: boolean;
}

const n = docSchema.nodes;
const m = docSchema.marks;

class Importer {
  private zip: JSZip;
  private sink: ImageSink;
  private warn = new Map<string, number>();
  private styles = new Map<string, Style>();
  /** The document's defaults (docDefaults plus the Normal style), which become the document style. */
  private defaultRun: RunProps = {};
  private defaultSpacing: Spacing = {};
  /** numId → abstractNumId, and abstractNumId → per-level format ("bullet" or a number format) and start. */
  private nums = new Map<string, string>();
  private abstractNums = new Map<string, Map<number, { fmt: string; start: number }>>();
  /** numId → per-level starts that override its abstract numbering's. */
  private numStarts = new Map<string, Map<number, number>>();
  private imageCache = new Map<string, Promise<string | null>>();
  private blockCount = 0;

  private pageSetup(sectPr: XNode | undefined): Partial<PageSetup> | null {
    return pageSetupFromSectPr(sectPr);
  }

  constructor(zip: JSZip, sink: ImageSink) {
    this.zip = zip;
    this.sink = sink;
  }

  private note(msg: string): void {
    this.warn.set(msg, (this.warn.get(msg) ?? 0) + 1);
  }

  warnings(): string[] {
    return [...this.warn.entries()].map(([msg, n]) => (n > 1 ? `${msg} (${n}×)` : msg));
  }

  private async xml(file: string): Promise<XNode[] | null> {
    const f = this.zip.file(file);
    if (!f) return null;
    try {
      return parseXml(await f.async('string'));
    } catch {
      return null;
    }
  }

  private async rels(partFile: string): Promise<Rel[]> {
    const dir = partFile.includes('/') ? partFile.slice(0, partFile.lastIndexOf('/')) : '';
    const name = partFile.slice(dir.length + (dir ? 1 : 0));
    const doc = await this.xml(`${dir ? `${dir}/` : ''}_rels/${name}.rels`);
    if (!doc) return [];
    return children(root(doc, 'Relationships'), 'Relationship').map((r) => {
      const a = attrs(r);
      const external = a.TargetMode === 'External' || /^[a-z][a-z0-9+.-]*:/i.test(a.Target ?? '');
      return { id: a.Id, type: a.Type, target: external ? (a.Target ?? '') : resolvePath(dir, a.Target) };
    });
  }

  // --- Styles and numbering -----------------------------------------------------------------------

  private async loadStyles(): Promise<void> {
    const doc = await this.xml('word/styles.xml');
    const stylesRoot = doc && root(doc, 'w:styles');
    if (!stylesRoot) return;
    for (const s of children(stylesRoot, 'w:style')) {
      const a = attrs(s);
      const id = a['w:styleId'];
      if (!id) continue;
      this.styles.set(id, {
        id,
        name: attrs(child(s, 'w:name'))['w:val'] ?? id,
        type: a['w:type'] ?? 'paragraph',
        basedOn: attrs(child(s, 'w:basedOn'))['w:val'],
        pPr: child(s, 'w:pPr'),
        rPr: child(s, 'w:rPr'),
        app: a['ud:look'] === 'app',
      });
    }
    const defaults = child(stylesRoot, 'w:docDefaults');
    let run = this.runProps(child(child(defaults, 'w:rPrDefault'), 'w:rPr'), {});
    let spacing = this.spacingProps(child(child(defaults, 'w:pPrDefault'), 'w:pPr'), {});
    const normal = [...this.styles.values()].find((s) => s.type === 'paragraph' && (s.id === 'Normal' || /^normal$/i.test(s.name)));
    if (normal) {
      run = this.runProps(normal.rPr, run);
      spacing = this.spacingProps(normal.pPr, spacing);
    }
    this.defaultRun = { font: run.font, size: run.size };
    this.defaultSpacing = spacing;
  }

  /** The document style for the document node: Word's defaults where the file gives them. */
  docStyle(): Partial<DocStyle> | null {
    const out: Partial<DocStyle> = {};
    if (this.defaultRun.font) out.font = this.defaultRun.font;
    if (this.defaultRun.size !== undefined) out.size = this.defaultRun.size;
    out.lineHeight = this.defaultSpacing.line ?? SINGLE_LINE;
    out.spaceAfter = this.defaultSpacing.after ?? 0;
    return out;
  }

  /** Paragraph spacing from w:spacing: before/after in twentieths of a point, line as a multiple or in twentieths. */
  private spacingProps(pPr: XNode | undefined, base: Spacing): Spacing {
    const out: Spacing = { ...base };
    const sp = child(pPr, 'w:spacing');
    if (!sp) return out;
    const a = attrs(sp);
    const pt = (v: string | undefined) => {
      const n = num(v);
      return n === undefined ? undefined : Math.min(MAX_PARAGRAPH_SPACE, Math.max(0, Math.round(n / 2) / 10));
    };
    const before = pt(a['w:before']);
    const after = pt(a['w:after']);
    if (before !== undefined) out.before = before;
    if (after !== undefined) out.after = after;
    const line = num(a['w:line']);
    if (line !== undefined && line > 0) {
      const rule = a['w:lineRule'] ?? 'auto';
      // auto: multiples of single spacing; exact/atLeast: a height in twentieths of a point, relative to 12pt.
      const multiple = rule === 'auto' ? (line / 240) * SINGLE_LINE : line / 20 / 12;
      out.line = Math.min(MAX_LINE_HEIGHT, Math.max(MIN_LINE_HEIGHT, Math.round(multiple * 100) / 100));
    }
    return out;
  }

  private async loadNumbering(): Promise<void> {
    const doc = await this.xml('word/numbering.xml');
    const numbering = doc && root(doc, 'w:numbering');
    if (!numbering) return;
    for (const abs of children(numbering, 'w:abstractNum')) {
      const levels = new Map<number, { fmt: string; start: number }>();
      for (const lvl of children(abs, 'w:lvl')) {
        const i = num(attrs(lvl)['w:ilvl']) ?? 0;
        levels.set(i, { fmt: attrs(child(lvl, 'w:numFmt'))['w:val'] ?? 'decimal', start: num(val(child(lvl, 'w:start'))) ?? 1 });
      }
      this.abstractNums.set(attrs(abs)['w:abstractNumId'], levels);
    }
    for (const nm of children(numbering, 'w:num')) {
      const absId = attrs(child(nm, 'w:abstractNumId'))['w:val'];
      if (absId !== undefined) this.nums.set(attrs(nm)['w:numId'], absId);
      const starts = new Map<number, number>();
      for (const o of children(nm, 'w:lvlOverride')) {
        const start = num(val(child(o, 'w:startOverride')));
        if (start !== undefined) starts.set(num(attrs(o)['w:ilvl']) ?? 0, start);
      }
      if (starts.size) this.numStarts.set(attrs(nm)['w:numId'], starts);
    }
  }

  /** The chain of a style and the styles it is based on, base first. */
  private styleChain(id: string | undefined): Style[] {
    const out: Style[] = [];
    const seen = new Set<string>();
    for (let cur = id; cur && !seen.has(cur); ) {
      seen.add(cur);
      const s = this.styles.get(cur);
      if (!s) break;
      out.unshift(s);
      cur = s.basedOn;
    }
    return out;
  }

  private isBullet(numId: string, ilvl: number): boolean {
    const abs = this.nums.get(numId);
    const fmt = abs !== undefined ? this.abstractNums.get(abs)?.get(ilvl)?.fmt : undefined;
    return fmt === 'bullet' || fmt === undefined;
  }

  /** The number a list's level starts at. */
  private listStart(numId: string, ilvl: number): number {
    const abs = this.nums.get(numId);
    return this.numStarts.get(numId)?.get(ilvl) ?? (abs !== undefined ? this.abstractNums.get(abs)?.get(ilvl)?.start : undefined) ?? 1;
  }

  // --- Properties ----------------------------------------------------------------------------------

  private runProps(rPr: XNode | undefined, base: RunProps): RunProps {
    if (!rPr) return { ...base };
    const out: RunProps = { ...base };
    // A character style on the run applies underneath its direct properties; a code style makes it code.
    const styleId = attrs(child(rPr, 'w:rStyle'))['w:val'];
    for (const s of this.styleChain(styleId)) {
      if (/\bcode\b/.test(`${s.id} ${s.name}`.toLowerCase())) out.code = true;
      if (!s.app) Object.assign(out, this.runProps(s.rPr, out));
    }
    const set = <K extends keyof RunProps>(k: K, v: RunProps[K] | undefined) => {
      if (v !== undefined) out[k] = v;
    };
    set('bold', on(child(rPr, 'w:b')));
    set('italic', on(child(rPr, 'w:i')));
    set('strike', on(child(rPr, 'w:strike')) ?? on(child(rPr, 'w:dstrike')));
    const u = val(child(rPr, 'w:u'));
    if (u !== undefined) out.underline = u !== 'none';
    const color = val(child(rPr, 'w:color'));
    if (color !== undefined) out.color = color === 'auto' || !/^[0-9a-f]{6}$/i.test(color) ? undefined : `#${color.toLowerCase()}`;
    const hl = val(child(rPr, 'w:highlight'));
    if (hl !== undefined) out.highlight = hl === 'none' ? undefined : HIGHLIGHTS[hl.toLowerCase()];
    const shd = attrs(child(rPr, 'w:shd'))['w:fill'];
    if (shd && /^[0-9a-f]{6}$/i.test(shd) && shd.toLowerCase() !== 'ffffff') out.highlight = `#${shd.toLowerCase()}`;
    const fonts = attrs(child(rPr, 'w:rFonts'));
    const family = fonts['w:ascii'] ?? fonts['w:hAnsi'];
    if (family) out.font = cleanFontFamily(family) ?? undefined;
    const sz = num(val(child(rPr, 'w:sz')));
    if (sz !== undefined) out.size = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, sz / 2));
    return out;
  }

  /**
   * A paragraph's kind, alignment, numbering and spacing from its direct properties and its style chain, plus
   * the run properties its styles give the text (used as the base for each run, against the document defaults).
   */
  private paraProps(pPr: XNode | undefined): { para: ParaProps; run: RunProps } {
    const styleId = attrs(child(pPr, 'w:pStyle'))['w:val'];
    const chain = this.styleChain(styleId);
    const para: ParaProps = { kind: 'paragraph', spacing: {} };
    let run: RunProps = {};
    for (const s of chain) if (!s.app) run = this.runProps(s.rPr, run);
    let spacing: Spacing = { ...this.defaultSpacing };
    for (const s of chain) if (!s.app) spacing = this.spacingProps(s.pPr, spacing);
    spacing = this.spacingProps(pPr, spacing);
    for (const k of ['before', 'after', 'line'] as const) {
      const v = spacing[k];
      const base = this.defaultSpacing[k] ?? (k === 'line' ? SINGLE_LINE : 0);
      if (v !== undefined && Math.abs(v - base) > 0.01) para.spacing[k] = v;
    }
    // The kind comes from the most specific style whose id or name says what it is.
    for (const s of [...chain].reverse()) {
      const key = `${s.id} ${s.name}`.toLowerCase();
      let h: RegExpExecArray | null;
      if (/^(title|heading\s*0)\b/.test(key) && !/subtitle/.test(key)) para.kind = 'title';
      else if (/subtitle/.test(key)) para.kind = 'subtitle';
      else if ((h = /heading\s*(\d)/.exec(key))) {
        para.kind = 'heading';
        para.level = Math.min(3, Math.max(1, Number(h[1])));
      } else if (/quote/.test(key)) para.kind = 'quote';
      else if (/\b(code|sourcecode|htmlpreformatted|plain text)\b/.test(key)) para.kind = 'code';
      else continue;
      break;
    }
    const props = [...chain.map((s) => s.pPr), pPr];
    for (const p of props) {
      if (!p) continue;
      const jc = val(child(p, 'w:jc'));
      if (jc === 'center') para.align = 'center';
      else if (jc === 'right' || jc === 'end') para.align = 'right';
      else if (jc === 'both' || jc === 'distribute') para.align = 'justify';
      else if (jc === 'left' || jc === 'start') para.align = undefined;
      const numPr = child(p, 'w:numPr');
      if (numPr) {
        const id = val(child(numPr, 'w:numId'));
        if (id !== undefined && id !== '0') {
          para.numId = id;
          para.ilvl = num(val(child(numPr, 'w:ilvl'))) ?? 0;
        } else {
          delete para.numId;
        }
      }
    }
    // Paragraph-level run properties (w:pPr/w:rPr) describe the paragraph mark, not the text; ignore them.
    return { para, run };
  }

  // --- Content -------------------------------------------------------------------------------------

  private marksFor(p: RunProps, href?: string): Mark[] {
    const out: Mark[] = [];
    if (href) out.push(m.link.create({ href }));
    if (p.code) out.push(m.code.create());
    if (p.bold) out.push(m.bold.create());
    if (p.italic) out.push(m.italic.create());
    if (p.underline && !href) out.push(m.underline.create());
    if (p.strike) out.push(m.strike.create());
    // Links have their own look; Word's explicit blue on link text would fight it.
    if (p.color && isColor(p.color) && !href) out.push(m.color.create({ color: p.color }));
    if (p.highlight && isColor(p.highlight)) out.push(m.highlight.create({ color: p.highlight }));
    const defaultFont = this.defaultRun.font ?? DEFAULT_DOC_STYLE.font;
    const defaultSize = this.defaultRun.size ?? DEFAULT_DOC_STYLE.size;
    if (p.font && p.font !== defaultFont) out.push(m.font.create({ family: p.font }));
    if (p.size !== undefined && p.size !== defaultSize) out.push(m.size.create({ size: p.size }));
    return out;
  }

  /** Inline nodes of a paragraph, plus the image blocks found inside it (emitted after the paragraph). */
  private async inline(p: XNode, base: RunProps, rels: Rel[]): Promise<{ inline: PMNode[]; images: PMNode[] }> {
    const inline: PMNode[] = [];
    const images: PMNode[] = [];
    const walk = async (parent: XNode, href?: string) => {
      for (const c of kids(parent)) {
        const tag = tagOf(c);
        if (tag === 'w:r') {
          const props = this.runProps(child(c, 'w:rPr'), base);
          const marks = this.marksFor(props, href);
          for (const part of kids(c)) {
            const t = tagOf(part);
            if (t === 'w:t') {
              const text = textOf(part);
              if (text) inline.push(docSchema.text(text, marks));
            } else if (t === 'w:tab') inline.push(docSchema.text('\t', marks));
            else if (t === 'w:br' || t === 'w:cr') {
              if (attrs(part)['w:type'] === 'page') images.push(n.page_break.create());
              else inline.push(n.hard_break.create());
            } else if (t === 'w:drawing' || t === 'w:pict') {
              const img = await this.picture(part, rels);
              // A picture in the line (not floating) stays there, unless it turns out to be the paragraph's only content.
              if (img && t === 'w:drawing' && child(part, 'wp:inline')) inline.push(n.inline_image.create({ src: img.attrs.src, alt: img.attrs.alt, width: img.attrs.width }));
              else if (img) images.push(img);
            } else if (t === 'w:sym') {
              const ch = attrs(part)['w:char'];
              const code = ch ? Number.parseInt(ch, 16) : NaN;
              if (Number.isFinite(code)) inline.push(docSchema.text(String.fromCharCode(code & 0xfff), marks));
            } else if (t === 'w:footnoteReference' || t === 'w:endnoteReference') this.note('Footnotes and endnotes were dropped.');
          }
        } else if (tag === 'w:hyperlink') {
          const id = attrs(c)['r:id'];
          const target = id ? rels.find((r) => r.id === id)?.target : undefined;
          const url = target ? safeLinkUrl(target) : null;
          await walk(c, url ?? href);
        } else if (tag === 'w:ins' || tag === 'w:smartTag' || tag === 'w:sdt' || tag === 'w:sdtContent' || tag === 'w:fldSimple' || tag === 'w:customXml') {
          await walk(c, href); // tracked insertions and content controls: keep the text
        } else if (tag === 'w:del') {
          this.note('Tracked deletions were left out.');
        } else if (tag === 'w:commentRangeStart') {
          this.note('Comments were dropped.');
        }
      }
    };
    await walk(p);
    // A paragraph of nothing but pictures is pictures, each a block of its own as before.
    if (!inline.some((x) => x.isText && x.text!.trim()) && inline.some((x) => x.type === n.inline_image)) {
      const blocks = inline.filter((x) => x.type === n.inline_image).map((x) => n.image.create({ src: x.attrs.src, alt: x.attrs.alt, width: x.attrs.width, align: null }));
      return { inline: inline.filter((x) => x.type !== n.inline_image), images: [...blocks, ...images] };
    }
    return { inline, images };
  }

  private async picture(drawing: XNode, rels: Rel[]): Promise<PMNode | null> {
    // Find the first a:blip (picture) anywhere inside the drawing.
    const find = (node: XNode, tag: string): XNode | undefined => {
      for (const c of kids(node)) {
        if (tagOf(c) === tag) return c;
        const deep = find(c, tag);
        if (deep) return deep;
      }
      return undefined;
    };
    const blip = find(drawing, 'a:blip');
    if (!blip) {
      if (find(drawing, 'c:chart')) this.note('Charts were dropped.');
      else if (find(drawing, 'dgm:relIds')) this.note('SmartArt was dropped.');
      else this.note('Drawings other than pictures were dropped.');
      return null;
    }
    const embed = attrs(blip)['r:embed'];
    const target = embed ? rels.find((r) => r.id === embed)?.target : undefined;
    if (!target) {
      this.note('Linked pictures (not stored in the file) were dropped.');
      return null;
    }
    const src = await this.image(target);
    if (!src) return null;
    const extent = find(drawing, 'wp:extent') ?? find(drawing, 'a:ext');
    const cx = num(attrs(extent).cx);
    const width = cx ? Math.min(MAX_IMAGE_PX, Math.max(20, Math.round(cx / EMU_PER_PX))) : null;
    const docPr = find(drawing, 'wp:docPr');
    const alt = attrs(docPr).descr ?? attrs(docPr).title ?? '';
    return n.image.create({ src, alt, width, align: null });
  }

  private image(file: string): Promise<string | null> {
    let p = this.imageCache.get(file);
    if (!p) {
      p = (async () => {
        const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
        const type = IMAGE_TYPES[ext];
        if (!type) {
          this.note(`Pictures in ${ext.toUpperCase()} format were dropped (PNG, JPEG, GIF and WebP are supported).`);
          return null;
        }
        const f = this.zip.file(file);
        if (!f) {
          this.note('Some pictures were missing from the file.');
          return null;
        }
        const data = await f.async('nodebuffer');
        if (data.length > MAX_CELL_IMAGE_BYTES) {
          this.note('Pictures over 100 MB were dropped.');
          return null;
        }
        return this.sink(type, data);
      })();
      this.imageCache.set(file, p);
    }
    return p;
  }

  /** A paragraph's blocks: its textblock (if it has any content) and any pictures it held. */
  private async paragraph(p: XNode, rels: Rel[]): Promise<{ blocks: PMNode[]; list?: { numId: string; ilvl: number; bullet: boolean } }> {
    const pPr = child(p, 'w:pPr');
    const { para, run } = this.paraProps(pPr);
    const { inline, images: found } = await this.inline(p, run, rels);
    // A paragraph holding only pictures places them as it is aligned.
    const images = !inline.length && (para.align === 'center' || para.align === 'right') ? found.map((b) => (b.type === n.image ? n.image.create({ ...b.attrs, align: para.align }) : b)) : found;
    const attrsOf = { align: para.align ?? null, spacing: Object.keys(para.spacing).length ? para.spacing : null };
    let block: PMNode | null = null;
    // An empty paragraph with a border under it is a rule across the page.
    if (para.kind === 'paragraph' && !para.numId && !inline.length && !images.length && child(child(pPr, 'w:pBdr'), 'w:bottom')) return { blocks: [n.horizontal_rule.create()] };
    if (para.kind === 'code') {
      const text = inline.map((x) => (x.isText ? x.text : '\n')).join('');
      block = n.code_block.create(null, text ? docSchema.text(text) : undefined);
    } else if (inline.length || !images.length) {
      const content = Fragment.from(inline);
      if (para.kind === 'title') block = n.title.create(attrsOf, content);
      else if (para.kind === 'subtitle') block = n.subtitle.create(attrsOf, content);
      else if (para.kind === 'heading') block = n.heading.create({ ...attrsOf, level: para.level ?? 1 }, content);
      else block = n.paragraph.create(attrsOf, content);
      if (para.kind === 'quote') block = n.blockquote.create(null, block);
    }
    const blocks = block ? [block, ...images] : images;
    const list = para.numId !== undefined && block && (block.type === n.paragraph || block.type === n.heading) ? { numId: para.numId, ilvl: para.ilvl ?? 0, bullet: this.isBullet(para.numId, para.ilvl ?? 0) } : undefined;
    return { blocks, list };
  }

  /** The blocks of a body-like container (the body, or a table cell), with list paragraphs grouped into lists. */
  private async blocks(container: XNode, rels: Rel[]): Promise<PMNode[]> {
    const out: PMNode[] = [];
    // Open lists by level: the list node's items are built up, then closed when the level ends.
    // A list is one numbering's: one of another (abstract) numbering at the same level is another list.
    type Open = { ilvl: number; bullet: boolean; abs?: string; start: number; items: PMNode[][] };
    let open: Open[] = [];
    const closeTo = (level: number) => {
      while (open.length && open[open.length - 1].ilvl >= level) {
        const done = open.pop()!;
        const items = done.items.map((blocks) => n.list_item.create(null, blocks));
        const list = done.bullet ? n.bullet_list.create(null, items) : n.ordered_list.create({ start: done.start }, items);
        const parent = open[open.length - 1];
        if (parent && parent.items.length) parent.items[parent.items.length - 1].push(list);
        else if (parent) parent.items.push([n.paragraph.create(), list]);
        else out.push(list);
      }
    };
    const push = (block: PMNode) => {
      if (++this.blockCount > MAX_BLOCKS) throw new ImportError('This document has too many paragraphs to import.');
      // Quote paragraphs one after another are one quote.
      const last = out[out.length - 1];
      if (block.type === n.blockquote && last?.type === n.blockquote) out[out.length - 1] = n.blockquote.create(null, last.content.append(block.content));
      else out.push(block);
    };
    for (const el of kids(container)) {
      const tag = tagOf(el);
      if (tag === 'w:p') {
        const { blocks, list } = await this.paragraph(el, rels);
        if (list && blocks.length) {
          // Start or continue a list at this level; a different kind at the same level starts a new list.
          const top = open[open.length - 1];
          const abs = this.nums.get(list.numId);
          if (top && top.ilvl === list.ilvl && (top.bullet !== list.bullet || top.abs !== abs)) closeTo(list.ilvl);
          else closeTo(list.ilvl + 1);
          let cur = open[open.length - 1];
          if (!cur || cur.ilvl < list.ilvl) {
            cur = { ilvl: list.ilvl, bullet: list.bullet, abs, start: this.listStart(list.numId, list.ilvl), items: [] };
            open.push(cur);
          }
          const [first, ...rest] = blocks;
          cur.items.push([first.type === n.heading ? n.paragraph.create({ align: first.attrs.align, spacing: first.attrs.spacing }, first.content) : first, ...rest]);
          this.blockCount++;
        } else {
          closeTo(0);
          for (const b of blocks) push(b);
        }
      } else if (tag === 'w:tbl') {
        closeTo(0);
        this.note('Tables were converted to paragraphs (one per row, cells separated by tabs).');
        for (const row of children(el, 'w:tr')) {
          const cells: string[] = [];
          for (const cell of children(row, 'w:tc')) {
            const inner = await this.blocks(cell, rels);
            cells.push(inner.map((b) => b.textContent).join(' ').trim());
          }
          push(n.paragraph.create(null, cells.join('\t') ? docSchema.text(cells.join('\t')) : undefined));
        }
      } else if (tag === 'w:sdt') {
        const content = child(el, 'w:sdtContent');
        if (content) {
          closeTo(0);
          for (const b of await this.blocks(content, rels)) push(b);
        }
      }
    }
    closeTo(0);
    return out;
  }

  /**
   * A header or footer part that is plain text with page fields: its text line ({page} and {pages} for the
   * fields) and how its page number is aligned, when it has one on a line of its own. Null if it is richer.
   */
  private async marginPart(file: string): Promise<{ text: string; number?: Alignment | 'left' } | null> {
    const doc = await this.xml(file);
    const part = doc && (root(doc, 'w:hdr') ?? root(doc, 'w:ftr'));
    if (!part) return null;
    const texts: string[] = [];
    let number: Alignment | 'left' | undefined;
    for (const p of kids(part)) {
      if (tagOf(p) !== 'w:p') return null;
      let text = '';
      let field: string | null = null;
      let inResult = false;
      let rich = false;
      const token = (instr: string) => {
        const name = instr.trim().split(/\s+/)[0]?.toUpperCase();
        if (name === 'PAGE') text += '{page}';
        else if (name === 'NUMPAGES' || name === 'SECTIONPAGES') text += '{pages}';
        else rich = true;
      };
      const walk = (node: XNode) => {
        for (const c of kids(node)) {
          const tag = tagOf(c);
          if (tag === 'w:r') {
            for (const r of kids(c)) {
              const t = tagOf(r);
              if (t === 'w:fldChar') {
                const type = attrs(r)['w:fldCharType'];
                if (type === 'begin') field = '';
                else if (type === 'separate') inResult = true;
                else if (type === 'end') {
                  if (field !== null) token(field);
                  field = null;
                  inResult = false;
                }
              } else if (t === 'w:instrText') {
                if (field !== null) field += textOf(r);
              } else if (t === 'w:t') {
                if (field === null && !inResult) text += textOf(r);
              } else if (t === 'w:tab') text += ' ';
              else if (t === 'w:drawing' || t === 'w:pict' || t === 'w:object') rich = true;
            }
          } else if (tag === 'w:fldSimple') token(attrs(c)['w:instr'] ?? '');
          else if (tag === 'w:hyperlink' || tag === 'w:smartTag' || tag === 'w:sdt' || tag === 'w:sdtContent' || tag === 'w:ins') walk(c);
        }
      };
      walk(p);
      if (rich) return null;
      const jc = val(child(child(p, 'w:pPr'), 'w:jc'));
      if (text.trim() === '{page}' && number === undefined) number = jc === 'center' ? 'center' : jc === 'right' || jc === 'end' ? 'right' : 'left';
      else if (text.trim()) texts.push(text.trim());
    }
    if (texts.length > 1 || (texts[0]?.length ?? 0) > MAX_HEADER_CHARS) return null;
    return { text: texts[0] ?? '', ...(number ? { number } : {}) };
  }

  /**
   * The page setup's header, footer and page numbers from the section's header and footer parts; null when
   * they are richer than that (more than one section's, a different first page, pictures, other fields).
   */
  private async headersFooters(sectPr: XNode | undefined, rels: Rel[]): Promise<Partial<PageSetup> | null> {
    const parts = rels.filter((r) => /\/(header|footer)$/.test(r.type));
    if (!parts.length) return {};
    const refs = [...children(sectPr, 'w:headerReference'), ...children(sectPr, 'w:footerReference')];
    // Every part must be one of this section's, and only the default ones may hold anything.
    if (parts.some((r) => !refs.some((ref) => attrs(ref)['r:id'] === r.id))) return null;
    const out: Partial<PageSetup> = {};
    for (const ref of refs) {
      const rel = rels.find((r) => r.id === attrs(ref)['r:id']);
      const read = rel && (await this.marginPart(rel.target));
      if (!read) return null;
      const footer = tagOf(ref) === 'w:footerReference';
      if ((attrs(ref)['w:type'] ?? 'default') !== 'default') {
        if (read.text || read.number) return null;
        continue;
      }
      if (read.text) out[footer ? 'footer' : 'header'] = read.text;
      if (read.number) {
        if (out.pageNumbers) return null;
        out.pageNumbers = !footer ? 'top-right' : read.number === 'right' ? 'bottom-right' : 'bottom-center';
      }
    }
    return out;
  }

  async run(): Promise<Doc> {
    const docXml = await this.xml('word/document.xml');
    const body = docXml && child(root(docXml, 'w:document'), 'w:body');
    if (!body) throw new ImportError('This file is not a valid Word document (.docx).');
    await Promise.all([this.loadStyles(), this.loadNumbering()]);
    const rels = await this.rels('word/document.xml');
    const sectPr = child(body, 'w:sectPr');
    const margins = await this.headersFooters(sectPr, rels);
    if (!margins) this.note('Headers and footers were dropped.');
    const blocks = await this.blocks(body, rels);
    const page = { ...this.pageSetup(sectPr), ...margins };
    const node = n.doc.create({ page: Object.keys(page).length ? page : null, style: this.docStyle() }, blocks.length ? blocks : n.paragraph.create());
    const doc = docFromNode(node);
    const problem = validateDoc(doc);
    if (problem) throw new ImportError(`The imported document is not valid: ${problem}`);
    return doc;
  }
}

const TWIPS_PER_INCH = 1440;

/** Page size, orientation and margins from the body's section properties; null when they are the defaults. */
function pageSetupFromSectPr(sectPr: XNode | undefined): Partial<PageSetup> | null {
  if (!sectPr) return null;
  const out: Partial<PageSetup> = {};
  // The app's writer says when a document has no pages (Word has no such thing).
  if (attrs(sectPr)['ud:mode'] === 'pageless') out.mode = 'pageless';
  const sz = attrs(child(sectPr, 'w:pgSz'));
  const w = num(sz['w:w']);
  const h = num(sz['w:h']);
  if (w && h) {
    const landscape = sz['w:orient'] === 'landscape' || w > h;
    const [pw, ph] = landscape ? [h, w] : [w, h];
    let best: PageSizeId = 'letter';
    let bestDiff = Infinity;
    for (const [id, size] of Object.entries(PAGE_SIZES) as [PageSizeId, { w: number; h: number }][]) {
      const diff = Math.abs(size.w - pw / TWIPS_PER_INCH) + Math.abs(size.h - ph / TWIPS_PER_INCH);
      if (diff < bestDiff) (best = id), (bestDiff = diff);
    }
    out.size = best;
    out.orientation = landscape ? 'landscape' : 'portrait';
  }
  const mar = attrs(child(sectPr, 'w:pgMar'));
  const margin = (v: string | undefined) => {
    const n = num(v);
    return n === undefined ? undefined : Math.min(MAX_MARGIN, Math.max(MIN_MARGIN, Math.round((n / TWIPS_PER_INCH) * 20) / 20));
  };
  const margins = { top: margin(mar['w:top']), right: margin(mar['w:right']), bottom: margin(mar['w:bottom']), left: margin(mar['w:left']) };
  if (Object.values(margins).some((v) => v !== undefined)) {
    out.margins = { top: margins.top ?? 1, right: margins.right ?? 1, bottom: margins.bottom ?? 1, left: margins.left ?? 1 };
  }
  return Object.keys(out).length ? out : null;
}

async function openArchive(buf: Buffer): Promise<JSZip> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    throw new ImportError('This file is not a valid Word document (.docx).');
  }
  const entries = Object.values(zip.files);
  if (entries.length > IMPORT_LIMITS.maxZipEntries) throw new ImportError('This document contains too many parts to import.');
  let total = 0;
  for (const f of entries) total += (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
  if (total > IMPORT_LIMITS.maxUncompressedBytes) throw new ImportError('This document is too large to import.');
  if (!zip.file('word/document.xml')) throw new ImportError('This file is not a valid Word document (.docx).');
  return zip;
}

/** True if the bytes look like a .docx (a zip holding word/document.xml). */
export async function isDocx(buf: Buffer): Promise<boolean> {
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) return false;
  try {
    const zip = await JSZip.loadAsync(buf);
    return !!zip.file('word/document.xml');
  } catch {
    return false;
  }
}

export async function importDocx(buf: Buffer, storeImage: ImageSink): Promise<DocxImportResult> {
  const zip = await openArchive(buf);
  const imp = new Importer(zip, storeImage);
  const doc = await imp.run();
  return { doc, warnings: imp.warnings() };
}
