// Text document file format (stored as one JSON file per document on the server, next to spreadsheets and
// slide decks).
//
// A document is a ProseMirror document: a sequence of blocks (paragraphs, headings, lists, quotes, code
// blocks, images and rules) whose text carries marks (bold, italic, underline, strikethrough, code, links,
// colors). The schema below is the single definition of what a document may contain; the editor, the
// server's validation and the assistant's Markdown view all use it. `Doc.content` is the ProseMirror JSON of
// the top-level node, so a stored document can be rebuilt with `docSchema.nodeFromJSON`.
import { Node as PMNode, Schema, type DOMOutputSpec, type MarkSpec, type NodeSpec } from 'prosemirror-model';
import { safeLinkUrl } from './links.ts';
import { checkCellImage } from './types.ts';
import { checkVideo, youtubeId, youtubePoster } from './video.ts';

export interface Doc {
  version: 1;
  /** ProseMirror JSON of the document node (`{ type: 'doc', attrs: { page }, content: [...] }`). */
  content: DocJSON;
}

// --- Document style and paragraph spacing ---------------------------------------------------------

/** The document's defaults: what text and paragraphs look like when nothing says otherwise. */
export interface DocStyle {
  /** Default font family. */
  font: string;
  /** Body text size in points. */
  size: number;
  /** Line height as a multiple of the font size. */
  lineHeight: number;
  /** Space after each paragraph in points. */
  spaceAfter: number;
}

export const DEFAULT_DOC_STYLE: DocStyle = { font: 'Google Sans', size: 12, lineHeight: 1.65, spaceAfter: 7.5 };
export const MIN_LINE_HEIGHT = 0.8;
export const MAX_LINE_HEIGHT = 4;
export const MAX_PARAGRAPH_SPACE = 200;

/** Per-paragraph spacing overrides, in points (line is a multiple of the font size). */
export interface Spacing {
  before?: number;
  after?: number;
  line?: number;
}

export function docStyleOf(node: PMNode): DocStyle {
  return { ...DEFAULT_DOC_STYLE, ...((node.attrs.style ?? {}) as Partial<DocStyle>) };
}

export function checkDocStyle(s: unknown): string | null {
  if (s === null || s === undefined) return null;
  if (typeof s !== 'object') return 'Invalid document style';
  const d = s as Partial<DocStyle>;
  if (d.font !== undefined && (typeof d.font !== 'string' || !cleanFontFamily(d.font))) return 'Invalid default font';
  if (d.size !== undefined && (typeof d.size !== 'number' || d.size < MIN_FONT_SIZE || d.size > MAX_FONT_SIZE)) return 'Invalid default font size';
  if (d.lineHeight !== undefined && (typeof d.lineHeight !== 'number' || d.lineHeight < MIN_LINE_HEIGHT || d.lineHeight > MAX_LINE_HEIGHT)) return 'Invalid line spacing';
  if (d.spaceAfter !== undefined && (typeof d.spaceAfter !== 'number' || d.spaceAfter < 0 || d.spaceAfter > MAX_PARAGRAPH_SPACE)) return 'Invalid paragraph spacing';
  return null;
}

export function checkSpacing(s: unknown): string | null {
  if (s === null || s === undefined) return null;
  if (typeof s !== 'object') return 'Invalid spacing';
  const sp = s as Spacing;
  for (const k of ['before', 'after'] as const) {
    if (sp[k] !== undefined && (typeof sp[k] !== 'number' || sp[k] < 0 || sp[k] > MAX_PARAGRAPH_SPACE)) return `Invalid space ${k}`;
  }
  if (sp.line !== undefined && (typeof sp.line !== 'number' || sp.line < MIN_LINE_HEIGHT || sp.line > MAX_LINE_HEIGHT)) return 'Invalid line spacing';
  return null;
}

/** Inline style for the editor root that sets the document's defaults (read by the stylesheet). */
export function docStyleCss(s: DocStyle): string {
  return `--doc-font: ${fontFamilyCss(s.font)}; --doc-size: ${s.size}pt; --doc-line: ${s.lineHeight}; --doc-space: ${s.spaceAfter}pt`;
}

/** Inline style for a block's spacing overrides, or undefined. */
export function spacingCss(spacing: Spacing | null | undefined): string | undefined {
  if (!spacing) return undefined;
  const parts: string[] = [];
  if (spacing.before !== undefined) parts.push(`margin-top: ${spacing.before}pt`);
  if (spacing.after !== undefined) parts.push(`margin-bottom: ${spacing.after}pt`);
  if (spacing.line !== undefined) parts.push(`line-height: ${spacing.line}`);
  return parts.length ? parts.join('; ') : undefined;
}

// --- Pages -------------------------------------------------------------------------------------

export const PAGE_SIZE_IDS = ['letter', 'legal', 'a4'] as const;
export type PageSizeId = (typeof PAGE_SIZE_IDS)[number];
/** Paper sizes in inches (portrait). */
export const PAGE_SIZES: Record<PageSizeId, { name: string; w: number; h: number }> = {
  letter: { name: 'Letter (8.5 × 11 in)', w: 8.5, h: 11 },
  legal: { name: 'Legal (8.5 × 14 in)', w: 8.5, h: 14 },
  a4: { name: 'A4 (210 × 297 mm)', w: 8.27, h: 11.69 },
};
export const PAGE_NUMBER_POSITIONS = ['none', 'bottom-center', 'bottom-right', 'top-right'] as const;
export type PageNumberPosition = (typeof PAGE_NUMBER_POSITIONS)[number];

/** How a document is paginated and printed; stored as the `page` attribute of the document node. */
export interface PageSetup {
  /** Pages: a fixed page size with margins and visible page boundaries. Pageless: one continuous column. */
  mode: 'pages' | 'pageless';
  size: PageSizeId;
  orientation: 'portrait' | 'landscape';
  /** Inches. */
  margins: { top: number; right: number; bottom: number; left: number };
  pageNumbers: PageNumberPosition;
  /** Plain text drawn in the top and bottom margins of every page; {page} and {pages} are replaced. */
  header: string;
  footer: string;
}

export const DEFAULT_PAGE_SETUP: PageSetup = {
  mode: 'pages',
  size: 'letter',
  orientation: 'portrait',
  margins: { top: 1, right: 1, bottom: 1, left: 1 },
  pageNumbers: 'none',
  header: '',
  footer: '',
};

export const PX_PER_INCH = 96;
/** Grey gap drawn between pages on screen, in pixels. */
export const PAGE_GAP = 24;
export const MIN_MARGIN = 0.25;
export const MAX_MARGIN = 3;
export const MAX_HEADER_CHARS = 200;

/** Pixel geometry of a page setup: the page, its margins and the content box inside them. */
export function pageMetrics(p: PageSetup) {
  const size = PAGE_SIZES[p.size];
  const [wIn, hIn] = p.orientation === 'landscape' ? [size.h, size.w] : [size.w, size.h];
  const pageW = Math.round(wIn * PX_PER_INCH);
  const pageH = Math.round(hIn * PX_PER_INCH);
  const mt = Math.round(p.margins.top * PX_PER_INCH);
  const mr = Math.round(p.margins.right * PX_PER_INCH);
  const mb = Math.round(p.margins.bottom * PX_PER_INCH);
  const ml = Math.round(p.margins.left * PX_PER_INCH);
  return { pageW, pageH, mt, mr, mb, ml, contentW: pageW - ml - mr, contentH: pageH - mt - mb, stride: pageH + PAGE_GAP, widthIn: wIn, heightIn: hIn };
}

/** The page setup of a document node (defaults for anything it does not say). */
export function pageSetupOf(node: PMNode): PageSetup {
  const p = (node.attrs.page ?? {}) as Partial<PageSetup>;
  return { ...DEFAULT_PAGE_SETUP, ...p, margins: { ...DEFAULT_PAGE_SETUP.margins, ...(p.margins ?? {}) } };
}

/** Why a page setup is invalid, or null. */
export function checkPageSetup(p: unknown): string | null {
  if (p === null || p === undefined) return null;
  if (typeof p !== 'object') return 'Invalid page setup';
  const s = p as Partial<PageSetup>;
  if (s.mode !== undefined && s.mode !== 'pages' && s.mode !== 'pageless') return 'Invalid page mode';
  if (s.size !== undefined && !PAGE_SIZE_IDS.includes(s.size)) return 'Invalid page size';
  if (s.orientation !== undefined && s.orientation !== 'portrait' && s.orientation !== 'landscape') return 'Invalid page orientation';
  if (s.margins !== undefined) {
    if (!s.margins || typeof s.margins !== 'object') return 'Invalid margins';
    for (const k of ['top', 'right', 'bottom', 'left'] as const) {
      const v = s.margins[k];
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < MIN_MARGIN || v > MAX_MARGIN)) return `Invalid ${k} margin (${MIN_MARGIN} to ${MAX_MARGIN} inches)`;
    }
  }
  if (s.pageNumbers !== undefined && !PAGE_NUMBER_POSITIONS.includes(s.pageNumbers)) return 'Invalid page number position';
  for (const k of ['header', 'footer'] as const) {
    if (s[k] !== undefined && (typeof s[k] !== 'string' || s[k].length > MAX_HEADER_CHARS)) return `Invalid ${k}`;
  }
  return null;
}

/** Header or footer text with {page} and {pages} filled in. */
export function pageText(template: string, page: number, pages: number): string {
  return template.replace(/\{page\}/gi, String(page)).replace(/\{pages\}/gi, String(pages));
}

export interface DocJSON {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocJSON[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
}

export const HEADING_LEVELS = [1, 2, 3] as const;
export type HeadingLevel = (typeof HEADING_LEVELS)[number];

export const ALIGNMENTS = ['left', 'center', 'right', 'justify'] as const;
export type Alignment = (typeof ALIGNMENTS)[number];

/** Block kinds the assistant and the toolbar can turn a block into. */
export const BLOCK_TYPES = ['paragraph', 'title', 'subtitle', 'heading1', 'heading2', 'heading3', 'bullet_list', 'ordered_list', 'blockquote', 'code_block'] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

export const MAX_BLOCKS = 5000;
export const MAX_DOC_CHARS = 2_000_000;
/** Widest an image can be, in CSS pixels, matching the page width in the editor. */
export const DOC_PAGE_WIDTH = 760;
/**
 * The width to show a picture at after it was edited in the image editor. A picture with no width of its own
 * keeps none (it is shown at its size, as wide as the page at most). One that kept its shape keeps its width.
 * One that was cropped or turned is shown at the same scale as before: its width changes as its pixels did.
 */
export function editedImageWidth(width: number | null, before: { width: number; height: number } | null, after: { width: number; height: number } | null): number | null {
  if (width === null || !before || !after || !(before.width > 0 && before.height > 0 && after.width > 0 && after.height > 0)) return width;
  const [was, now] = [before.width / before.height, after.width / after.height];
  if (Math.abs(was - now) / was < 0.01) return width;
  return Math.max(40, Math.min(DOC_PAGE_WIDTH, Math.round((width * after.width) / before.width)));
}

/**
 * How a document looks when nothing says otherwise (the editor's stylesheet uses the same values). Text without
 * a font or size mark is drawn in the default family at the size of its block style; sizes are in points.
 */
export const DOC_DEFAULTS = {
  fontFamily: 'Google Sans',
  fontFallbacks: ['Roboto', 'Segoe UI', 'Arial', 'sans-serif'],
  /** Body text size in points (16px). */
  fontSize: 12,
  lineHeight: 1.65,
  textColor: '#1f1f1f',
  /** Size of each block style in points, at the default body size of 12 (they scale with the document's size). */
  blockSizes: { paragraph: 12, title: 30, subtitle: 15, heading1: 22.5, heading2: 17.25, heading3: 13.5, blockquote: 12, code_block: 10.5, bullet_list: 12, ordered_list: 12 } as Record<BlockType, number>,
  /** Headings are semibold; the title is regular weight. */
  boldHeadings: true,
} as const;
/** Font sizes offered by the toolbar, in points (the body text is 12pt). */
export const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 30, 36, 48, 60, 72] as const;
export const MIN_FONT_SIZE = 6;
export const MAX_FONT_SIZE = 200;
/** Font families offered by the toolbar: system fonts first, then ones loaded from Google Fonts. */
export const FONT_FAMILIES = [
  'Arial',
  'Helvetica',
  'Verdana',
  'Trebuchet MS',
  'Georgia',
  'Times New Roman',
  'Garamond',
  'Courier New',
  'Inter',
  'Roboto',
  'Open Sans',
  'Lato',
  'Montserrat',
  'Nunito',
  'Poppins',
  'Merriweather',
  'Playfair Display',
  'Lora',
  'Libre Baskerville',
  'Source Sans 3',
] as const;

/** style attribute for a block's alignment and spacing. */
const alignAttr = (node: PMNode): Record<string, string> => {
  const parts: string[] = [];
  if (node.attrs.align && node.attrs.align !== 'left') parts.push(`text-align: ${node.attrs.align}`);
  const sp = spacingCss(node.attrs.spacing as Spacing | null);
  if (sp) parts.push(sp);
  return parts.length ? { style: parts.join('; ') } : {};
};
const TEXT_ATTRS = { align: { default: null }, spacing: { default: null } };
const alignFromDOM = (dom: HTMLElement | string): Record<string, unknown> | false => {
  if (typeof dom === 'string') return false;
  const a = dom.style?.textAlign;
  return { align: a && (ALIGNMENTS as readonly string[]).includes(a) && a !== 'left' ? a : null };
};

const nodes: Record<string, NodeSpec> = {
  doc: { content: 'block+', attrs: { page: { default: null }, style: { default: null } } },
  paragraph: {
    content: 'inline*',
    group: 'block',
    attrs: TEXT_ATTRS,
    parseDOM: [{ tag: 'p', getAttrs: alignFromDOM }],
    toDOM: (node) => ['p', alignAttr(node), 0] as DOMOutputSpec,
  },
  heading: {
    content: 'inline*',
    group: 'block',
    defining: true,
    attrs: { level: { default: 1 }, ...TEXT_ATTRS },
    parseDOM: [1, 2, 3, 4, 5, 6].map((n) => ({ tag: `h${n}`, getAttrs: (dom: HTMLElement | string) => ({ level: Math.min(n, 3), ...(alignFromDOM(dom) || {}) }) })),
    toDOM: (node) => [`h${node.attrs.level}`, alignAttr(node), 0] as DOMOutputSpec,
  },
  // The first block node is what Enter creates at the end of a block, so paragraph stays first above; the
  // title and subtitle parse rules get a higher priority than heading's so their h1/h2 rules are tried first.
  title: {
    content: 'inline*',
    group: 'block',
    defining: true,
    attrs: TEXT_ATTRS,
    parseDOM: [{ tag: 'h1.doc-title', getAttrs: alignFromDOM, priority: 60 }, { tag: 'p.doc-title', getAttrs: alignFromDOM, priority: 60 }],
    toDOM: (node) => ['h1', { class: 'doc-title', ...alignAttr(node) }, 0] as DOMOutputSpec,
  },
  subtitle: {
    content: 'inline*',
    group: 'block',
    defining: true,
    attrs: TEXT_ATTRS,
    parseDOM: [{ tag: 'p.doc-subtitle', getAttrs: alignFromDOM, priority: 60 }, { tag: 'h2.doc-subtitle', getAttrs: alignFromDOM, priority: 60 }],
    toDOM: (node) => ['p', { class: 'doc-subtitle', ...alignAttr(node) }, 0] as DOMOutputSpec,
  },
  blockquote: { content: 'block+', group: 'block', defining: true, parseDOM: [{ tag: 'blockquote' }], toDOM: () => ['blockquote', 0] },
  code_block: {
    content: 'text*',
    marks: '',
    group: 'block',
    code: true,
    defining: true,
    parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
    toDOM: () => ['pre', ['code', 0]],
  },
  horizontal_rule: { group: 'block', parseDOM: [{ tag: 'hr' }], toDOM: () => ['hr'] },
  /** An explicit page break: what follows starts on a new page (in Pages mode and in print). */
  page_break: {
    group: 'block',
    atom: true,
    selectable: true,
    parseDOM: [{ tag: 'div.doc-page-break' }, { tag: 'div', getAttrs: (dom) => (typeof dom !== 'string' && /page/.test(dom.style.breakBefore + dom.style.pageBreakBefore + dom.style.breakAfter + dom.style.pageBreakAfter) ? null : false) }],
    toDOM: () => ['div', { class: 'doc-page-break', 'data-label': 'Page break' }],
  },
  image: {
    group: 'block',
    draggable: true,
    selectable: true,
    attrs: { src: {}, alt: { default: '' }, width: { default: null }, align: { default: null } },
    parseDOM: [
      {
        tag: 'img[src]',
        getAttrs: (dom) => {
          if (typeof dom === 'string') return false;
          const src = dom.getAttribute('src') ?? '';
          if (checkCellImage(src)) return false;
          const w = Number.parseInt(dom.getAttribute('width') ?? dom.style?.width ?? '', 10);
          return { src, alt: dom.getAttribute('alt') ?? '', width: Number.isFinite(w) && w > 0 ? w : null, align: null };
        },
      },
    ],
    toDOM: (node) => [
      'figure',
      { class: 'doc-image', ...(node.attrs.align ? { 'data-align': node.attrs.align } : {}) },
      ['img', { src: node.attrs.src, alt: node.attrs.alt || null, ...(node.attrs.width ? { style: `width: ${node.attrs.width}px` } : {}) }],
    ],
  },
  // A picture in a line of text: a signature on a form's line, an icon. Its width is in CSS pixels; with none it
  // is as tall as a few lines at most.
  inline_image: {
    inline: true,
    group: 'inline',
    draggable: true,
    selectable: true,
    attrs: { src: {}, alt: { default: '' }, width: { default: null } },
    parseDOM: [
      {
        tag: 'img.doc-inline-image[src]',
        priority: 60,
        getAttrs: (dom) => {
          if (typeof dom === 'string') return false;
          const w = Number.parseInt(dom.getAttribute('width') ?? dom.style?.width ?? '', 10);
          return { src: dom.getAttribute('src') ?? '', alt: dom.getAttribute('alt') ?? '', width: Number.isFinite(w) && w > 0 ? w : null };
        },
      },
    ],
    toDOM: (node) => ['img', { class: 'doc-inline-image', src: node.attrs.src, alt: node.attrs.alt || null, ...(node.attrs.width ? { style: `width: ${node.attrs.width}px` } : {}) }],
  },
  // A video that plays in the page (shared/video.ts). Outside the editor, which has its own view of it
  // (client/src/doc/DocEditor.tsx), it is its still: YouTube's picture, or the stored file's player.
  video: {
    group: 'block',
    draggable: true,
    selectable: true,
    attrs: { src: {}, title: { default: '' }, width: { default: null }, align: { default: null } },
    parseDOM: [
      {
        tag: 'figure[data-video]',
        getAttrs: (dom) => {
          if (typeof dom === 'string') return false;
          const src = dom.getAttribute('data-video') ?? '';
          if (checkVideo(src)) return false;
          const w = Number.parseInt(dom.getAttribute('data-width') ?? '', 10);
          return { src, title: dom.getAttribute('data-title') ?? '', width: Number.isFinite(w) && w > 0 ? w : null, align: null };
        },
      },
    ],
    toDOM: (node) => {
      const { src, title, width, align } = node.attrs as { src: string; title: string; width: number | null; align: string | null };
      const yt = youtubeId(src);
      return [
        'figure',
        { class: 'doc-video', 'data-video': src, ...(title ? { 'data-title': title } : {}), ...(width ? { 'data-width': String(width) } : {}), ...(align ? { 'data-align': align } : {}) },
        ['div', { class: 'doc-video-frame', ...(width ? { style: `width: ${width}px` } : {}) }, yt ? ['img', { src: youtubePoster(yt), alt: title || 'YouTube video' }] : ['video', { src, preload: 'metadata', controls: '' }]],
      ];
    },
  },
  bullet_list: { content: 'list_item+', group: 'block', parseDOM: [{ tag: 'ul' }], toDOM: () => ['ul', 0] },
  ordered_list: {
    content: 'list_item+',
    group: 'block',
    attrs: { start: { default: 1 } },
    parseDOM: [{ tag: 'ol', getAttrs: (dom) => (typeof dom === 'string' ? false : { start: dom.hasAttribute('start') ? Number(dom.getAttribute('start')) || 1 : 1 }) }],
    toDOM: (node) => ['ol', node.attrs.start === 1 ? {} : { start: node.attrs.start }, 0] as DOMOutputSpec,
  },
  list_item: { content: 'paragraph block*', defining: true, parseDOM: [{ tag: 'li' }], toDOM: () => ['li', 0] },
  text: { group: 'inline' },
  hard_break: { inline: true, group: 'inline', selectable: false, parseDOM: [{ tag: 'br' }], toDOM: () => ['br'] },
};

const marks: Record<string, MarkSpec> = {
  // First in this list is outermost in the DOM.
  link: {
    attrs: { href: {} },
    inclusive: false,
    parseDOM: [{ tag: 'a[href]', getAttrs: (dom) => (typeof dom === 'string' ? false : safeLinkUrl(dom.getAttribute('href') ?? '') ? { href: dom.getAttribute('href') } : false) }],
    toDOM: (mark) => ['a', { href: mark.attrs.href, title: mark.attrs.href, rel: 'noopener noreferrer' }, 0],
  },
  code: { parseDOM: [{ tag: 'code' }], toDOM: () => ['code', 0] },
  bold: {
    parseDOM: [
      { tag: 'strong' },
      { tag: 'b', getAttrs: (dom) => (typeof dom === 'string' ? false : dom.style.fontWeight !== 'normal' && null) },
      { style: 'font-weight', getAttrs: (v) => (typeof v === 'string' && /^(bold(er)?|[5-9]\d{2})$/.test(v) ? null : false) },
    ],
    toDOM: () => ['strong', 0],
  },
  italic: { parseDOM: [{ tag: 'em' }, { tag: 'i' }, { style: 'font-style=italic' }], toDOM: () => ['em', 0] },
  underline: { parseDOM: [{ tag: 'u' }, { style: 'text-decoration', getAttrs: (v) => (typeof v === 'string' && v.includes('underline') ? null : false) }], toDOM: () => ['u', 0] },
  strike: {
    parseDOM: [{ tag: 's' }, { tag: 'del' }, { tag: 'strike' }, { style: 'text-decoration', getAttrs: (v) => (typeof v === 'string' && v.includes('line-through') ? null : false) }],
    toDOM: () => ['s', 0],
  },
  color: {
    attrs: { color: {} },
    parseDOM: [{ style: 'color', getAttrs: (v) => (typeof v === 'string' && isColor(v) ? { color: v } : false) }],
    toDOM: (mark) => ['span', { style: `color: ${mark.attrs.color}` }, 0],
  },
  font: {
    attrs: { family: {} },
    parseDOM: [{ style: 'font-family', getAttrs: (v) => (typeof v === 'string' && cleanFontFamily(v) ? { family: cleanFontFamily(v) } : false) }],
    toDOM: (mark) => ['span', { style: `font-family: ${fontFamilyCss(String(mark.attrs.family))}` }, 0],
  },
  size: {
    attrs: { size: {} },
    parseDOM: [{ style: 'font-size', getAttrs: (v) => (typeof v === 'string' && parseFontSize(v) ? { size: parseFontSize(v) } : false) }],
    toDOM: (mark) => ['span', { style: `font-size: ${Number(mark.attrs.size)}pt` }, 0],
  },
  highlight: {
    attrs: { color: {} },
    parseDOM: [{ tag: 'mark', getAttrs: () => ({ color: '#fff2a8' }) }, { style: 'background-color', getAttrs: (v) => (typeof v === 'string' && isColor(v) && !/transparent|rgba\(0, 0, 0, 0\)/.test(v) ? { color: v } : false) }],
    toDOM: (mark) => ['span', { style: `background-color: ${mark.attrs.color}` }, 0],
  },
};

export const docSchema = new Schema({ nodes, marks });

export const MARK_NAMES = ['bold', 'italic', 'underline', 'strike', 'code', 'link', 'color', 'highlight', 'font', 'size'] as const;

/** The first family of a CSS font-family list, without quotes, or null if it is not a plain font name. */
export function cleanFontFamily(v: string): string | null {
  const first = v.split(',')[0].trim().replace(/^['"]|['"]$/g, '').trim();
  return first && first.length <= 60 && /^[\w .+-]+$/.test(first) ? first : null;
}

/** CSS for a font family: quoted when it has spaces, with a generic fallback. */
export function fontFamilyCss(family: string): string {
  const generic = /courier|mono|consolas|menlo/i.test(family) ? 'monospace' : /georgia|times|garamond|serif|baskerville|playfair|merriweather|lora/i.test(family) ? 'serif' : 'sans-serif';
  return `${/[^\w-]/.test(family) ? `'${family}'` : family}, ${generic}`;
}

/** A font size in points from a CSS value ("14pt", "18px", "1.5em" relative to 12pt), or null. */
export function parseFontSize(v: string): number | null {
  const m = /^\s*([\d.]+)\s*(pt|px|em|rem)?\s*$/i.exec(v);
  if (!m) return null;
  const num = Number(m[1]);
  const unit = (m[2] ?? 'pt').toLowerCase();
  const pt = unit === 'px' ? num * 0.75 : unit === 'em' || unit === 'rem' ? num * 12 : num;
  const rounded = Math.round(pt * 2) / 2;
  return Number.isFinite(rounded) && rounded >= MIN_FONT_SIZE && rounded <= MAX_FONT_SIZE ? rounded : null;
}
export type MarkName = (typeof MARK_NAMES)[number];

/** A CSS color the document may store: hex, rgb()/rgba(), hsl() or a plain color name. */
export function isColor(s: unknown): s is string {
  return typeof s === 'string' && s.length <= 40 && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%]+\)|[a-z]+)$/i.test(s.trim());
}

export function newDoc(): Doc {
  return { version: 1, content: { type: 'doc', content: [{ type: 'paragraph' }] } };
}

/** The ProseMirror node of a stored document. Throws for malformed content (use validateDoc first). */
export function docNode(doc: Doc): PMNode {
  return docSchema.nodeFromJSON(doc.content);
}

export function docFromNode(node: PMNode): Doc {
  return { version: 1, content: node.toJSON() as DocJSON };
}

/** Structural validation of an uploaded document: the schema, the size limits, and image and link addresses. */
export function validateDoc(d: unknown): string | null {
  if (!d || typeof d !== 'object') return 'Document must be an object';
  const doc = d as Doc;
  if (doc.version !== 1) return 'Unsupported document version';
  if (!doc.content || typeof doc.content !== 'object' || doc.content.type !== 'doc') return 'Invalid document content';
  let node: PMNode;
  try {
    node = docSchema.nodeFromJSON(doc.content);
    node.check();
  } catch (e) {
    return `Invalid document: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (node.childCount > MAX_BLOCKS) return 'Too many blocks';
  const pageProblem = checkPageSetup(node.attrs.page);
  if (pageProblem) return pageProblem;
  const styleProblem = checkDocStyle(node.attrs.style);
  if (styleProblem) return styleProblem;
  if (node.content.size > MAX_DOC_CHARS) return 'Document is too large';
  let problem: string | null = null;
  node.descendants((n) => {
    if (problem) return false;
    if (n.type.name === 'image' || n.type.name === 'inline_image') {
      const p = checkCellImage(n.attrs.src);
      if (p) problem = `Invalid image: ${p}`;
      if (n.attrs.width !== null && (typeof n.attrs.width !== 'number' || n.attrs.width < 1 || n.attrs.width > 10000)) problem = 'Invalid image width';
    }
    if (n.type.name === 'video') {
      const p = checkVideo(n.attrs.src);
      if (p) problem = `Invalid video: ${p}`;
      if (typeof n.attrs.title !== 'string' || n.attrs.title.length > 300) problem = 'Invalid video title';
      if (n.attrs.width !== null && (typeof n.attrs.width !== 'number' || n.attrs.width < 1 || n.attrs.width > 10000)) problem = 'Invalid video width';
    }
    if ((n.attrs.align ?? null) !== null && !ALIGNMENTS.includes(n.attrs.align)) problem = 'Invalid alignment';
    const spacingProblem = n.attrs.spacing !== undefined ? checkSpacing(n.attrs.spacing) : null;
    if (spacingProblem) problem = spacingProblem;
    if (n.type.name === 'heading' && !HEADING_LEVELS.includes(n.attrs.level)) problem = 'Invalid heading level';
    for (const m of n.marks) {
      if (m.type.name === 'link' && !safeLinkUrl(String(m.attrs.href))) problem = 'Invalid link';
      if ((m.type.name === 'color' || m.type.name === 'highlight') && !isColor(m.attrs.color)) problem = 'Invalid color';
      if (m.type.name === 'font' && (typeof m.attrs.family !== 'string' || !cleanFontFamily(m.attrs.family))) problem = 'Invalid font';
      if (m.type.name === 'size' && (typeof m.attrs.size !== 'number' || m.attrs.size < MIN_FONT_SIZE || m.attrs.size > MAX_FONT_SIZE)) problem = 'Invalid font size';
    }
    return true;
  });
  return problem;
}

/** The plain text of a document, one line per block, for searching and previews. */
export function docText(node: PMNode): string {
  return node.textBetween(0, node.content.size, '\n', (leaf) => (leaf.type.name === 'image' || leaf.type.name === 'inline_image' ? `[image${leaf.attrs.alt ? `: ${leaf.attrs.alt}` : ''}]` : leaf.type.name === 'video' ? `[video${leaf.attrs.title ? `: ${leaf.attrs.title}` : ''}]` : leaf.type.name === 'hard_break' ? '\n' : ''));
}

/** The kind of a top-level block as the assistant sees it. */
export function blockType(node: PMNode): BlockType | 'image' | 'video' | 'horizontal_rule' | 'page_break' {
  switch (node.type.name) {
    case 'heading':
      return `heading${node.attrs.level as HeadingLevel}`;
    case 'title':
    case 'subtitle':
    case 'image':
    case 'video':
    case 'horizontal_rule':
    case 'page_break':
    case 'bullet_list':
    case 'ordered_list':
    case 'blockquote':
    case 'code_block':
      return node.type.name;
    default:
      return 'paragraph';
  }
}

/** Size in points of text in a block style, given the document's body size. */
export function blockSizePt(type: BlockType, style: DocStyle): number {
  return Math.round(((DOC_DEFAULTS.blockSizes[type] ?? DOC_DEFAULTS.fontSize) / DOC_DEFAULTS.fontSize) * style.size * 100) / 100;
}
