// Write a document as a Word file (.docx): hand-written WordprocessingML in a zip, made to be read back by
// importDocx (server/docxImport.ts) as the same document. Block styles are Word's own (Title, Subtitle,
// Heading 1–3, Quote, Code), each list gets its numbering, marks become run properties (a highlight as cell
// shading, so any color survives), pictures are embedded, and the page setup, header, footer and page numbers
// go into the section. What only the app knows (the page mode, and that a style's look is the app's own rather
// than formatting to keep) is written in an ignorable namespace of its own, which Word skips.
// Known approximations: a video is a link to it (shared/docxFormat.ts keeps such documents out of Word
// files); spacing is kept to a tenth of a point and sizes to half a point; colors other than hex and rgb() are
// left out; in a quote only paragraphs keep the quote style, and in a list item only the first paragraph and
// nested lists keep their place in the list.
import JSZip from 'jszip';
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { DOC_DEFAULTS, DOC_PAGE_WIDTH, docNode, docStyleOf, pageSetupOf, PAGE_SIZES, type Doc, type DocStyle, type PageSetup, type Spacing } from '../shared/doc.ts';

/** Loads a picture's bytes by its address; null leaves the picture out. */
export type DocxImageLoader = (src: string) => Promise<{ type: string; data: Buffer } | null>;

/** The namespace of what only the app reads back (declared ignorable, so Word skips it). */
export const APP_NS = 'urn:universal-docs:docx';

const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
};
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const ROOT_NS = `xmlns:w="${NS.w}" xmlns:r="${NS.r}" xmlns:wp="${NS.wp}" xmlns:a="${NS.a}" xmlns:pic="${NS.pic}" xmlns:mc="${NS.mc}" xmlns:ud="${APP_NS}" mc:Ignorable="ud"`;

/** Word's single line spacing is about 1.15 times the font size (as the importer reads it). */
const SINGLE_LINE = 1.15;
const TWIPS_PER_INCH = 1440;
const EMU_PER_PX = 9525;
const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif', 'image/webp': 'webp' };

const esc = (s: string) =>
  s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** A color as Word's six hex digits (from #rgb, #rrggbb or rgb()), or null for anything else. */
function hex6(c: string): string | null {
  const s = c.trim();
  const h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (h) return (h[1].length === 3 ? [...h[1]].map((x) => x + x).join('') : h[1]).toUpperCase();
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s);
  return rgb
    ? rgb
        .slice(1, 4)
        .map((v) => Math.min(255, Number(v)).toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase()
    : null;
}

const twips = (pt: number) => Math.round(pt * 20);
const lineTwips = (multiple: number) => Math.round((multiple / SINGLE_LINE) * 240);

/** A picture's size in pixels from its header (PNG, JPEG, GIF, WebP), or null. */
export function imageSize(b: Buffer): { width: number; height: number } | null {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length >= 10 && b.toString('latin1', 0, 3) === 'GIF') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const kind = b.toString('latin1', 12, 16);
    if (kind === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      // Start-of-frame markers (not DHT, JPG or DAC) hold the size.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

/** A paragraph's properties, in the order Word's schema wants them. */
function pPr(o: { style?: string; numId?: number; ilvl?: number; rule?: boolean; spacing?: Spacing | null; align?: string | null }): string {
  const parts: string[] = [];
  if (o.style) parts.push(`<w:pStyle w:val="${o.style}"/>`);
  if (o.numId !== undefined) parts.push(`<w:numPr><w:ilvl w:val="${o.ilvl ?? 0}"/><w:numId w:val="${o.numId}"/></w:numPr>`);
  if (o.rule) parts.push('<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr>');
  const sp = o.spacing;
  if (sp && (sp.before !== undefined || sp.after !== undefined || sp.line !== undefined)) {
    parts.push(
      `<w:spacing${sp.before !== undefined ? ` w:before="${twips(sp.before)}"` : ''}${sp.after !== undefined ? ` w:after="${twips(sp.after)}"` : ''}${sp.line !== undefined ? ` w:line="${lineTwips(sp.line)}" w:lineRule="auto"` : ''}/>`,
    );
  }
  const jc = o.align === 'center' ? 'center' : o.align === 'right' ? 'right' : o.align === 'justify' ? 'both' : null;
  if (jc) parts.push(`<w:jc w:val="${jc}"/>`);
  return parts.length ? `<w:pPr>${parts.join('')}</w:pPr>` : '';
}

/** Run properties for a text's marks (its link is the hyperlink around it), in Word's schema order. */
function rPr(marks: readonly Mark[], linked: boolean): string {
  const has = (name: string) => marks.find((mk) => mk.type.name === name);
  const parts: string[] = [];
  if (has('code')) parts.push('<w:rStyle w:val="CodeChar"/>');
  else if (linked) parts.push('<w:rStyle w:val="Hyperlink"/>');
  const font = has('font')?.attrs.family as string | undefined;
  if (font) parts.push(`<w:rFonts w:ascii="${esc(font)}" w:hAnsi="${esc(font)}" w:eastAsia="${esc(font)}" w:cs="${esc(font)}"/>`);
  if (has('bold')) parts.push('<w:b/>');
  if (has('italic')) parts.push('<w:i/>');
  if (has('strike')) parts.push('<w:strike/>');
  const color = has('color') ? hex6(String(has('color')!.attrs.color)) : null;
  if (color) parts.push(`<w:color w:val="${color}"/>`);
  const size = has('size')?.attrs.size as number | undefined;
  if (typeof size === 'number') parts.push(`<w:sz w:val="${Math.round(size * 2)}"/><w:szCs w:val="${Math.round(size * 2)}"/>`);
  if (has('underline')) parts.push('<w:u w:val="single"/>');
  const hl = has('highlight') ? hex6(String(has('highlight')!.attrs.color)) : null;
  if (hl) parts.push(`<w:shd w:val="clear" w:color="auto" w:fill="${hl}"/>`);
  return parts.length ? `<w:rPr>${parts.join('')}</w:rPr>` : '';
}

/** Text as run content: tabs and line breaks as Word's own elements. */
function textRuns(text: string): string {
  return text
    .split(/(\t|\n)/)
    .map((s) => (s === '\t' ? '<w:tab/>' : s === '\n' ? '<w:br/>' : s ? `<w:t xml:space="preserve">${esc(s)}</w:t>` : ''))
    .join('');
}

interface Img {
  rId: string;
  width: number;
  height: number;
}

class Writer {
  private rels: string[] = [];
  private relCount = 0;
  private media = new Map<string, Promise<Img | null>>();
  private files: [string, Buffer][] = [];
  private lists: { bullet: boolean; start: number; depth: number }[] = [];
  private drawingId = 0;
  readonly usedExt = new Set<string>();
  private loadImage: DocxImageLoader;

  constructor(loadImage: DocxImageLoader) {
    this.loadImage = loadImage;
  }

  rel(type: string, target: string, external = false): string {
    const id = `rId${++this.relCount}`;
    this.rels.push(`<Relationship Id="${id}" Type="${REL}/${type}" Target="${esc(target)}"${external ? ' TargetMode="External"' : ''}/>`);
    return id;
  }

  relsXml(): string {
    return `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${this.rels.join('')}</Relationships>`;
  }

  mediaFiles(): [string, Buffer][] {
    return this.files;
  }

  hasLists(): boolean {
    return this.lists.length > 0;
  }

  /** The runs of a textblock's inline content, with linked runs inside hyperlinks. */
  inline(node: PMNode): string {
    const out: string[] = [];
    let link: { href: string; runs: string[] } | null = null;
    const flush = () => {
      if (link) out.push(`<w:hyperlink r:id="${this.rel('hyperlink', link.href, true)}">${link.runs.join('')}</w:hyperlink>`);
      link = null;
    };
    node.forEach((child) => {
      const href = child.marks.find((mk) => mk.type.name === 'link')?.attrs.href as string | undefined;
      const run = child.isText ? `<w:r>${rPr(child.marks, !!href)}${textRuns(child.text ?? '')}</w:r>` : child.type.name === 'hard_break' ? '<w:r><w:br/></w:r>' : child.type.name === 'inline_image' ? this.inlinePicture(child) : '';
      if (!run) return;
      if (href) {
        if (link?.href !== href) {
          flush();
          link = { href, runs: [] };
        }
        link!.runs.push(run);
      } else {
        flush();
        out.push(run);
      }
    });
    flush();
    return out.join('');
  }

  private inlinePicture(node: PMNode): string {
    const img = this.inlinePictures.get(node.attrs.src as string);
    return img ? `<w:r>${this.drawing(img, node)}</w:r>` : '';
  }

  private image(src: string): Promise<Img | null> {
    let p = this.media.get(src);
    if (!p) {
      p = (async () => {
        const loaded = await this.loadImage(src).catch(() => null);
        const ext = loaded && IMAGE_EXT[loaded.type];
        if (!loaded || !ext) return null;
        const file = `media/image${this.files.length + 1}.${ext}`;
        this.files.push([file, loaded.data]);
        this.usedExt.add(ext);
        const size = imageSize(loaded.data);
        return { rId: this.rel('image', file), width: size?.width ?? 0, height: size?.height ?? 0 };
      })();
      this.media.set(src, p);
    }
    return p;
  }

  private async picture(node: PMNode): Promise<string> {
    const img = await this.image(node.attrs.src as string);
    if (!img) return '';
    return `<w:p>${pPr({ align: node.attrs.align as string | null })}<w:r>${this.drawing(img, node)}</w:r></w:p>`;
  }

  /** The pictures in lines of text, loaded before writing, since a paragraph's runs are written at once. */
  private inlinePictures = new Map<string, Img | null>();

  async loadInlinePictures(doc: PMNode): Promise<void> {
    const srcs = new Set<string>();
    doc.descendants((n) => {
      if (n.type.name === 'inline_image') srcs.add(n.attrs.src as string);
    });
    for (const src of srcs) this.inlinePictures.set(src, await this.image(src));
  }

  /** A picture as Word draws it in a run, at the node's width (or its own size, as wide as the page at most). */
  private drawing(img: Img, node: PMNode): string {
    const w = (node.attrs.width as number | null) ?? (img.width ? Math.min(img.width, DOC_PAGE_WIDTH) : 480);
    const h = img.width && img.height ? Math.round((w * img.height) / img.width) : Math.round(w * 0.75);
    const [cx, cy] = [Math.round(w * EMU_PER_PX), Math.round(h * EMU_PER_PX)];
    const id = ++this.drawingId;
    const alt = esc((node.attrs.alt as string) ?? '');
    return (
      `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}" descr="${alt}"/>` +
      `<a:graphic><a:graphicData uri="${NS.pic}"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${img.rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`
    );
  }

  /** A list: its own numbering, so each list keeps its kind and start and lists side by side stay apart. */
  private async list(node: PMNode, depth: number): Promise<string> {
    const ilvl = Math.min(8, depth);
    this.lists.push({ bullet: node.type.name === 'bullet_list', start: (node.attrs.start as number | undefined) ?? 1, depth: ilvl });
    const numId = this.lists.length;
    const out: string[] = [];
    for (let i = 0; i < node.childCount; i++) {
      const item = node.child(i);
      for (let j = 0; j < item.childCount; j++) {
        const b = item.child(j);
        if (j === 0 && b.type.name === 'paragraph') out.push(`<w:p>${pPr({ numId, ilvl, spacing: b.attrs.spacing, align: b.attrs.align })}${this.inline(b)}</w:p>`);
        else if (b.type.name === 'bullet_list' || b.type.name === 'ordered_list') out.push(await this.list(b, depth + 1));
        else out.push(await this.block(b));
      }
    }
    return out.join('');
  }

  async block(node: PMNode): Promise<string> {
    const a = node.attrs as { align?: string | null; spacing?: Spacing | null };
    const para = (style?: string) => `<w:p>${pPr({ style, spacing: a.spacing, align: a.align })}${this.inline(node)}</w:p>`;
    switch (node.type.name) {
      case 'paragraph':
        return para();
      case 'title':
        return para('Title');
      case 'subtitle':
        return para('Subtitle');
      case 'heading':
        return para(`Heading${Math.min(3, Math.max(1, node.attrs.level as number))}`);
      case 'blockquote': {
        const out: string[] = [];
        for (let i = 0; i < node.childCount; i++) {
          const b = node.child(i);
          out.push(b.type.name === 'paragraph' ? `<w:p>${pPr({ style: 'Quote', spacing: b.attrs.spacing, align: b.attrs.align })}${this.inline(b)}</w:p>` : await this.block(b));
        }
        return out.join('');
      }
      case 'code_block':
        return `<w:p>${pPr({ style: 'Code' })}${node.textContent ? `<w:r>${textRuns(node.textContent)}</w:r>` : ''}</w:p>`;
      case 'horizontal_rule':
        return `<w:p>${pPr({ rule: true })}</w:p>`;
      case 'page_break':
        return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
      case 'image':
        return this.picture(node);
      case 'video': {
        const src = node.attrs.src as string;
        const text = (node.attrs.title as string) || src;
        return `<w:p>${pPr({ align: node.attrs.align as string | null })}<w:hyperlink r:id="${this.rel('hyperlink', src, true)}"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr>${textRuns(text)}</w:r></w:hyperlink></w:p>`;
      }
      case 'bullet_list':
      case 'ordered_list':
        return this.list(node, 0);
      default:
        return node.isTextblock ? para() : '';
    }
  }

  numberingXml(): string {
    const abstract = this.lists.map((l, i) => {
      const levels = Array.from({ length: 9 }, (_, lvl) => {
        const start = lvl === l.depth ? l.start : 1;
        const fmt = l.bullet ? '<w:numFmt w:val="bullet"/><w:lvlText w:val="•"/>' : `<w:numFmt w:val="decimal"/><w:lvlText w:val="%${lvl + 1}."/>`;
        return `<w:lvl w:ilvl="${lvl}"><w:start w:val="${start}"/>${fmt}<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (lvl + 1)}" w:hanging="360"/></w:pPr></w:lvl>`;
      }).join('');
      return `<w:abstractNum w:abstractNumId="${i}"><w:multiLevelType w:val="hybridMultilevel"/>${levels}</w:abstractNum>`;
    });
    const nums = this.lists.map((_, i) => `<w:num w:numId="${i + 1}"><w:abstractNumId w:val="${i}"/></w:num>`);
    return `${XML_HEAD}<w:numbering ${ROOT_NS}>${abstract.join('')}${nums.join('')}</w:numbering>`;
  }
}

/** Header or footer text with {page} and {pages} as Word's page fields. */
function marginRuns(template: string): string {
  return template
    .split(/(\{pages?\})/i)
    .map((s) => {
      const field = /^\{page\}$/i.test(s) ? 'PAGE' : /^\{pages\}$/i.test(s) ? 'NUMPAGES' : null;
      if (field) return `<w:fldSimple w:instr=" ${field} "><w:r><w:t>1</w:t></w:r></w:fldSimple>`;
      return s ? `<w:r>${textRuns(s)}</w:r>` : '';
    })
    .join('');
}

/** A header or footer part: its text, then the page number on a line of its own. */
function marginPart(tag: 'hdr' | 'ftr', text: string, number: 'center' | 'right' | null): string {
  const paras = [];
  if (text) paras.push(`<w:p>${marginRuns(text)}</w:p>`);
  if (number) paras.push(`<w:p><w:pPr><w:jc w:val="${number}"/></w:pPr>${marginRuns('{page}')}</w:p>`);
  return `${XML_HEAD}<w:${tag} ${ROOT_NS}>${paras.join('') || '<w:p/>'}</w:${tag}>`;
}

/** The document's styles: its defaults, and Word's block styles with the app's look (marked as the app's own). */
function stylesXml(style: DocStyle): string {
  const font = esc(style.font);
  const k = style.size / DOC_DEFAULTS.fontSize;
  const sz = (pt: number) => `<w:sz w:val="${Math.round(pt * k * 2)}"/><w:szCs w:val="${Math.round(pt * k * 2)}"/>`;
  const sizes = DOC_DEFAULTS.blockSizes;
  const para = (id: string, name: string, ppr: string, rpr: string) =>
    `<w:style w:type="paragraph" w:styleId="${id}" ud:look="app"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}<w:rPr>${rpr}</w:rPr></w:style>`;
  const heading = (n: number, pt: number) => para(`Heading${n}`, `heading ${n}`, `<w:keepNext/><w:spacing w:before="${twips(pt * 0.8)}" w:after="${twips(pt * 0.3)}"/><w:outlineLvl w:val="${n - 1}"/>`, `<w:b/>${sz(pt)}`);
  return (
    `${XML_HEAD}<w:styles ${ROOT_NS}>` +
    `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}" w:cs="${font}"/><w:sz w:val="${Math.round(style.size * 2)}"/><w:szCs w:val="${Math.round(style.size * 2)}"/></w:rPr></w:rPrDefault>` +
    `<w:pPrDefault><w:pPr><w:spacing w:after="${twips(style.spaceAfter)}" w:line="${lineTwips(style.lineHeight)}" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    para('Title', 'Title', `<w:spacing w:after="${twips(sizes.title * k * 0.3)}"/>`, sz(sizes.title)) +
    para('Subtitle', 'Subtitle', '', `<w:color w:val="5F6368"/>${sz(sizes.subtitle)}`) +
    heading(1, sizes.heading1) +
    heading(2, sizes.heading2) +
    heading(3, sizes.heading3) +
    para('Quote', 'Quote', '<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="DADCE0"/></w:pBdr><w:ind w:left="360"/>', '<w:i/><w:color w:val="5F6368"/>') +
    para('Code', 'Code', '<w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:shd w:val="clear" w:color="auto" w:fill="F1F3F4"/>', `<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>${sz(sizes.code_block)}`) +
    '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>' +
    '<w:style w:type="character" w:styleId="Hyperlink" ud:look="app"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:rPr><w:color w:val="1A73E8"/><w:u w:val="single"/></w:rPr></w:style>' +
    '<w:style w:type="character" w:styleId="CodeChar" ud:look="app"><w:name w:val="Code Char"/><w:basedOn w:val="DefaultParagraphFont"/><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/></w:rPr></w:style>' +
    '</w:styles>'
  );
}

/** The section: header and footer, page size, orientation and margins (and, for the app, the page mode). */
function sectPr(page: PageSetup, header: string | null, footer: string | null): string {
  const size = PAGE_SIZES[page.size];
  const landscape = page.orientation === 'landscape';
  const [w, h] = landscape ? [size.h, size.w] : [size.w, size.h];
  const m = page.margins;
  const t = (inches: number) => Math.round(inches * TWIPS_PER_INCH);
  return (
    `<w:sectPr${page.mode === 'pageless' ? ' ud:mode="pageless"' : ''}>` +
    (header ? `<w:headerReference w:type="default" r:id="${header}"/>` : '') +
    (footer ? `<w:footerReference w:type="default" r:id="${footer}"/>` : '') +
    `<w:pgSz w:w="${t(w)}" w:h="${t(h)}"${landscape ? ' w:orient="landscape"' : ''}/>` +
    `<w:pgMar w:top="${t(m.top)}" w:right="${t(m.right)}" w:bottom="${t(m.bottom)}" w:left="${t(m.left)}" w:header="720" w:footer="720" w:gutter="0"/>` +
    '</w:sectPr>'
  );
}

/** The document as a .docx file. */
export async function docDocx(doc: Doc, title: string, loadImage: DocxImageLoader): Promise<Buffer> {
  const node = docNode(doc);
  const page = pageSetupOf(node);
  const writer = new Writer(loadImage);
  writer.rel('styles', 'styles.xml');
  writer.rel('settings', 'settings.xml');
  await writer.loadInlinePictures(node);
  const blocks: string[] = [];
  for (let i = 0; i < node.childCount; i++) blocks.push(await writer.block(node.child(i)));
  if (!blocks.join('')) blocks.push('<w:p/>');

  const zip = new JSZip();
  const overrides: [string, string][] = [
    ['/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
    ['/word/styles.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml'],
    ['/word/settings.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml'],
    ['/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'],
    ['/docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml'],
  ];
  if (writer.hasLists()) {
    writer.rel('numbering', 'numbering.xml');
    zip.file('word/numbering.xml', writer.numberingXml());
    overrides.push(['/word/numbering.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml']);
  }
  const top = page.pageNumbers === 'top-right' ? 'right' : null;
  const bottom = page.pageNumbers === 'bottom-center' ? 'center' : page.pageNumbers === 'bottom-right' ? 'right' : null;
  let headerId: string | null = null;
  let footerId: string | null = null;
  if (page.header || top) {
    headerId = writer.rel('header', 'header1.xml');
    zip.file('word/header1.xml', marginPart('hdr', page.header, top));
    overrides.push(['/word/header1.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml']);
  }
  if (page.footer || bottom) {
    footerId = writer.rel('footer', 'footer1.xml');
    zip.file('word/footer1.xml', marginPart('ftr', page.footer, bottom));
    overrides.push(['/word/footer1.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml']);
  }

  zip.file('word/document.xml', `${XML_HEAD}<w:document ${ROOT_NS}><w:body>${blocks.join('')}${sectPr(page, headerId, footerId)}</w:body></w:document>`);
  zip.file('word/styles.xml', stylesXml(docStyleOf(node)));
  zip.file('word/settings.xml', `${XML_HEAD}<w:settings xmlns:w="${NS.w}"><w:defaultTabStop w:val="720"/></w:settings>`);
  for (const [file, data] of writer.mediaFiles()) zip.file(`word/${file}`, data);
  zip.file('word/_rels/document.xml.rels', writer.relsXml());
  zip.file(
    '_rels/.rels',
    `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/>` +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      `<Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`,
  );
  zip.file(
    'docProps/core.xml',
    `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title></cp:coreProperties>`,
  );
  zip.file('docProps/app.xml', `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>MCP Docs</Application></Properties>`);
  const types = [...writer.usedExt].map((ext) => `<Default Extension="${ext}" ContentType="image/${ext}"/>`).join('');
  zip.file(
    '[Content_Types].xml',
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${types}${overrides.map(([p, t]) => `<Override PartName="${p}" ContentType="${t}"/>`).join('')}</Types>`,
  );
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}
