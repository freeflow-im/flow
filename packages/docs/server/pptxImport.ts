// Convert an uploaded .pptx file into a deck. Keeps text boxes (with bullets, sizes, colors, alignment, rotation,
// outlined and capitalised text, including what they inherit from the master and layout), pictures (cropped and
// cut to their shape), shapes, freeforms, gradients, lines with arrowheads, slide backgrounds, the artwork of the
// slide's layout and master, and speaker notes. Tables become tables (ones with merged cells, which ours cannot
// hold, text boxes with rules between them), charts become charts with the data the file keeps for them (of the
// kinds ours can be), and SmartArt the shapes PowerPoint last drew for it. Other charts, picture color effects and
// animations are dropped and reported as warnings.
import { XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';
import {
  fillColor as firstColor,
  SLIDE_H,
  SLIDE_W,
  validateDeck,
  validateElement,
  MAX_TABLE_COLS,
  MAX_TABLE_ROWS,
  type ArrowStyle,
  type ChartElement,
  type ConnectionSite,
  type Deck,
  type ImageElement,
  type LayoutId,
  type LineElement,
  type Paragraph,
  type ShapeElement,
  type Slide,
  type SlideElement,
  type TableCell,
  type TableElement,
  type TableStyle,
  type TextElement,
  type TextRole,
  type TextRun,
  type TextStyle,
} from '../shared/deck.ts';
import { safeLinkUrl } from '../shared/links.ts';
import { CHART_SOURCE_EXT, SHAPE_ID_RE, TABLE_SOURCE_EXT } from '../shared/pptxExport.ts';
import { readChartWithData } from './xlsxCharts.ts';
import { shapeFromPptx, tightArc } from '../shared/shapes.ts';
import { MAX_CELL_IMAGE_BYTES } from '../shared/types.ts';
import { normalShares } from '../shared/deckTable.ts';
import { ImportError, IMPORT_LIMITS } from './xlsxImport.ts';

/** Stores an image for the importing user; returns its /api/images/... URL. */
export type ImageSink = (type: string, data: Buffer) => Promise<string>;

export interface PptxImportResult {
  deck: Deck;
  warnings: string[];
}

const EMU_PER_PX = 9525; // 914400 EMU per inch / 96 px per inch
const MAX_SLIDES = 500;
const MAX_SHAPES = 200;
const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

// --- Tiny helpers over fast-xml-parser's ordered output ------------------------------------------------

type XNode = Record<string, unknown>;

const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '', parseTagValue: false, parseAttributeValue: false, trimValues: false });

const tagOf = (n: XNode): string => Object.keys(n).find((k) => k !== ':@') ?? '';
const kids = (n: XNode | undefined): XNode[] => (n ? ((n[tagOf(n)] as XNode[] | undefined) ?? []) : []);
const attrs = (n: XNode | undefined): Record<string, string> => ((n?.[':@'] as Record<string, string> | undefined) ?? {});
const child = (n: XNode | undefined, name: string): XNode | undefined => kids(n).find((c) => tagOf(c) === name);
const children = (n: XNode | undefined, name: string): XNode[] => kids(n).filter((c) => tagOf(c) === name);
/** Follow a path of child tag names. */
const path = (n: XNode | undefined, ...names: string[]): XNode | undefined => names.reduce<XNode | undefined>((cur, name) => child(cur, name), n);
const textOf = (n: XNode | undefined): string =>
  kids(n)
    .map((c) => ('#text' in c ? String(c['#text']) : ''))
    .join('');
const num = (v: string | undefined): number | undefined => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);

/** The first node with a tag anywhere under the given nodes. */
function findDeep(nodes: XNode[], name: string): XNode | undefined {
  for (const n of nodes) {
    if ('#text' in n) continue;
    if (tagOf(n) === name) return n;
    const found = findDeep(kids(n), name);
    if (found) return found;
  }
  return undefined;
}

/** A copy of a tree with one namespace prefix swapped for another (SmartArt drawings are slide shapes under dsp:). */
function retag(n: XNode, from: string, to: string): XNode {
  if ('#text' in n) return n;
  const tag = tagOf(n);
  const out: XNode = { [tag.startsWith(from) ? to + tag.slice(from.length) : tag]: kids(n).map((c) => retag(c, from, to)) };
  if (n[':@']) out[':@'] = n[':@'];
  return out;
}

const truthy = (v: string | undefined) => v === '1' || v === 'true';

function parseXml(xml: string): XNode[] {
  return parser.parse(xml) as XNode[];
}

function root(doc: XNode[], name: string): XNode | undefined {
  return doc.find((n) => tagOf(n) === name);
}

/** Resolve a relationship target against the directory of the part that holds the .rels file. */
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

// --- The importer -----------------------------------------------------------------------------------

class Importer {
  private zip: JSZip;
  private sink: ImageSink;
  private warn = new Map<string, number>();
  private imageCache = new Map<string, Promise<string | null>>();
  private xmlCache = new Map<string, Promise<XNode[] | null>>();
  private themeCache = new Map<string, ThemeInfo>();
  /** Color scheme and fonts of the master of the slide being converted. */
  private colors: Record<string, string> = {};
  private fonts: ThemeInfo['fonts'] = {};
  // Scale and offset from the file's slide size to our 960×540 canvas.
  private scale = 1;
  private ox = 0;
  private oy = 0;
  /** Per slide: our element id for each shape id in the file, and the connector ends waiting to be attached to them. */
  private idMap = new Map<string, string>();
  private pending: { el: LineElement; start?: [string, number]; end?: [string, number] }[] = [];
  /**
   * Ids are the same each time the same file is read, so an agent's read and its next edit of a presentation
   * loaded afresh agree on them: by slide and order, or the id of ours a shape's name keeps (shapeName).
   */
  private slideNo = 0;
  private seq = 0;
  private usedIds = new Set<string>();

  constructor(zip: JSZip, sink: ImageSink) {
    this.zip = zip;
    this.sink = sink;
  }

  private nextId(): string {
    let id: string;
    do id = `s${this.slideNo}e${++this.seq}`;
    while (this.usedIds.has(id));
    this.usedIds.add(id);
    return id;
  }

  /** Give the element the id of ours its shape's name keeps (written by the export), when it has one not yet used. */
  private keepId(name: string | undefined, el: SlideElement | undefined): void {
    const id = name ? SHAPE_ID_RE.exec(name)?.[1] : undefined;
    if (!el || !id || this.usedIds.has(id)) return;
    this.usedIds.add(id);
    el.id = id;
  }

  private note(msg: string): void {
    this.warn.set(msg, (this.warn.get(msg) ?? 0) + 1);
  }

  warnings(): string[] {
    return [...this.warn.entries()].map(([msg, n]) => (n > 1 ? `${msg} (${n}×)` : msg));
  }

  private xml(file: string): Promise<XNode[] | null> {
    let p = this.xmlCache.get(file);
    if (!p) {
      p = (async () => {
        const f = this.zip.file(file);
        if (!f) return null;
        try {
          return parseXml(await f.async('string'));
        } catch {
          return null;
        }
      })();
      this.xmlCache.set(file, p);
    }
    return p;
  }

  private async rels(partFile: string): Promise<Rel[]> {
    const dir = partFile.includes('/') ? partFile.slice(0, partFile.lastIndexOf('/')) : '';
    const name = partFile.slice(dir.length + (dir ? 1 : 0));
    const doc = await this.xml(`${dir ? `${dir}/` : ''}_rels/${name}.rels`);
    if (!doc) return [];
    return children(root(doc, 'Relationships'), 'Relationship').map((r) => {
      const a = attrs(r);
      // Hyperlinks and linked pictures point outside the file; everything else is a part next to this one.
      const external = a.TargetMode === 'External' || /^[a-z][a-z0-9+.-]*:/i.test(a.Target ?? '');
      return { id: a.Id, type: a.Type, target: external ? (a.Target ?? '') : resolvePath(dir, a.Target) };
    });
  }

  async run(): Promise<Deck> {
    const presDoc = await this.xml('ppt/presentation.xml');
    const pres = presDoc && root(presDoc, 'p:presentation');
    if (!pres) throw new ImportError('This file is not a valid PowerPoint presentation (.pptx).');
    const size = attrs(child(pres, 'p:sldSz'));
    const w = (num(size.cx) ?? 9144000) / EMU_PER_PX;
    const h = (num(size.cy) ?? 5143500) / EMU_PER_PX;
    this.scale = Math.min(SLIDE_W / w, SLIDE_H / h);
    this.ox = (SLIDE_W - w * this.scale) / 2;
    this.oy = (SLIDE_H - h * this.scale) / 2;
    if (Math.abs(w / h - 16 / 9) > 0.05) this.note('The slides were not 16:9; they were scaled to fit and centered.');

    const presRels = await this.rels('ppt/presentation.xml');
    const ids = children(child(pres, 'p:sldIdLst'), 'p:sldId').map((s) => attrs(s)['r:id']);
    const files = ids.map((id) => presRels.find((r) => r.id === id)?.target).filter((t): t is string => !!t);
    if (!files.length) throw new ImportError('This presentation has no slides.');
    if (files.length > MAX_SLIDES) throw new ImportError(`This presentation has too many slides to import (${MAX_SLIDES} maximum).`);

    const slides: Slide[] = [];
    for (const file of files) slides.push(await this.slide(file));
    const deck: Deck = { version: 1, theme: 'light', slides };
    const problem = validateDeck(deck);
    if (problem) throw new ImportError(`The presentation could not be converted: ${problem}.`);
    return deck;
  }

  private async slide(file: string): Promise<Slide> {
    this.slideNo++;
    this.seq = 0;
    const doc = await this.xml(file);
    const sld = doc && root(doc, 'p:sld');
    const rels = await this.rels(file);
    const layoutFile = rels.find((r) => r.type.endsWith('/slideLayout'))?.target;
    const layoutDoc = layoutFile ? await this.xml(layoutFile) : null;
    const layout = layoutDoc && root(layoutDoc, 'p:sldLayout');
    const masterFile = layoutFile ? (await this.rels(layoutFile)).find((r) => r.type.endsWith('/slideMaster'))?.target : undefined;
    const masterDoc = masterFile ? await this.xml(masterFile) : null;
    const master = masterDoc && root(masterDoc, 'p:sldMaster');
    const inherit = [layout, master].filter((n): n is XNode => !!n);
    const theme = await this.theme(masterFile, master ?? undefined);
    this.colors = theme.colors;
    this.fonts = theme.fonts;

    const elements: SlideElement[] = [];
    const cSld = child(sld ?? undefined, 'p:cSld');
    this.idMap = new Map();
    this.pending = [];
    // The artwork of the master and the layout (everything that is not a placeholder) sits under the slide's own shapes.
    if (sld && attrs(sld).showMasterSp !== '0') {
      if (master && masterFile && attrs(layout ?? undefined).showMasterSp !== '0') await this.shapes(path(master, 'p:cSld', 'p:spTree'), await this.rels(masterFile), [], elements, null, true);
      if (layout && layoutFile) await this.shapes(path(layout, 'p:cSld', 'p:spTree'), await this.rels(layoutFile), master ? [master] : [], elements, null, true);
      this.connect(elements);
    }
    if (sld) await this.shapes(child(cSld, 'p:spTree'), rels, inherit, elements, null);
    this.connect(elements);
    if (elements.length > MAX_SHAPES) {
      this.note(`Slides with more than ${MAX_SHAPES} elements were truncated.`);
      elements.length = MAX_SHAPES;
    }

    assignRoles(elements);
    const slide: Slide = { id: this.nextId(), layout: guessLayout(elements), elements };
    // The slide's own background, else its layout's, else its master's.
    const parts: [XNode | null | undefined, string | undefined][] = [[sld, file], [layout, layoutFile], [master, masterFile]];
    for (const [part, partFile] of parts) {
      const bgNode = path(part ?? undefined, 'p:cSld', 'p:bg');
      if (!bgNode || !partFile) continue;
      const own = part === sld;
      const bgPr = child(bgNode, 'p:bgPr');
      const bg = bgPr ? this.colorOf(bgPr) : this.colorNode(child(bgNode, 'p:bgRef'));
      // A plain white background from the master is our theme's own.
      if (bg && bg !== 'none') {
        if (own || bg !== '#ffffff') slide.bg = bg;
      } else if (bgPr) {
        // A picture background becomes a full-slide image behind everything.
        const embed = attrs(path(bgPr, 'a:blipFill', 'a:blip'))['r:embed'];
        const target = embed ? (await this.rels(partFile)).find((r) => r.id === embed)?.target : undefined;
        const src = target ? await this.image(target) : null;
        const gradient = this.gradientOf(bgPr, false, false);
        if (src) elements.unshift({ id: this.nextId(), type: 'image', x: 0, y: 0, w: SLIDE_W, h: SLIDE_H, src, fit: 'cover' });
        else if (gradient) slide.bg = gradient;
        else if (!bg) this.note('Some slide backgrounds could not be converted and were dropped.');
      }
      break;
    }

    const notesFile = rels.find((r) => r.type.endsWith('/notesSlide'))?.target;
    if (notesFile) {
      const notes = await this.notes(notesFile);
      if (notes) slide.notes = notes;
    }
    return slide;
  }

  private async notes(file: string): Promise<string> {
    const doc = await this.xml(file);
    const tree = path(root(doc ?? [], 'p:notes'), 'p:cSld', 'p:spTree');
    for (const sp of children(tree, 'p:sp')) {
      if (attrs(path(sp, 'p:nvSpPr', 'p:nvPr', 'p:ph')).type !== 'body') continue;
      return children(child(sp, 'p:txBody'), 'a:p')
        .map((p) => paragraphText(p))
        .join('\n')
        .trim();
    }
    return '';
  }

  /** Convert a shape tree (a slide's spTree or a group) into elements. */
  private async shapes(tree: XNode | undefined, rels: Rel[], inherit: XNode[], out: SlideElement[], group: GroupTransform | null, decor = false): Promise<void> {
    for (const node of kids(tree)) {
      const tag = tagOf(node);
      // Of a layout or master only the artwork is drawn: its placeholders are what the slide's own shapes fill in.
      if (decor && (path(node, 'p:nvSpPr', 'p:nvPr', 'p:ph') || path(node, 'p:nvPicPr', 'p:nvPr', 'p:ph'))) continue;
      if (tag === 'p:sp') {
        const made = await this.shape(node, rels, inherit, group);
        out.push(...made);
        if (!decor) this.keepId(attrs(path(node, 'p:nvSpPr', 'p:cNvPr')).name, made[0]);
        this.remember(attrs(path(node, 'p:nvSpPr', 'p:cNvPr')).id, made[0]);
      } else if (tag === 'p:pic') {
        const el = await this.picture(node, rels, inherit, group);
        if (el) out.push(el);
        if (!decor) this.keepId(attrs(path(node, 'p:nvPicPr', 'p:cNvPr')).name, el ?? undefined);
        this.remember(attrs(path(node, 'p:nvPicPr', 'p:cNvPr')).id, el ?? undefined);
        // A picture's outline is a frame drawn over it.
        const ln = path(node, 'p:spPr', 'a:ln');
        const stroke = this.solidColor(ln);
        if (el && stroke && !el.clip) {
          const frame: ShapeElement = { id: this.nextId(), type: 'shape', shape: 'rect', x: el.x, y: el.y, w: el.w, h: el.h, fill: 'none', stroke, strokeWidth: Math.max(1, Math.round((((num(attrs(ln).w) ?? 9525) / EMU_PER_PX) * this.scale))) };
          if (el.rot) frame.rot = el.rot;
          out.push(frame);
        }
      } else if (tag === 'p:cxnSp') {
        const el = this.connector(node, group);
        if (el) out.push(el);
        if (!decor) this.keepId(attrs(path(node, 'p:nvCxnSpPr', 'p:cNvPr')).name, el ?? undefined);
      } else if (tag === 'p:grpSp') {
        const inner = this.groupTransform(child(node, 'p:grpSpPr'), group);
        await this.shapes(node, rels, inherit, out, inner, decor);
      } else if (tag === 'p:graphicFrame') {
        const data = path(node, 'a:graphic', 'a:graphicData');
        const uri = attrs(data).uri ?? '';
        if (uri.includes('/table')) {
          const made = out.length;
          this.table(node, child(data, 'a:tbl'), rels, inherit, group, out);
          const made1 = out[made];
          if (out.length === made + 1 && made1.type === 'table') {
            this.keepId(attrs(path(node, 'p:nvGraphicFramePr', 'p:cNvPr')).name, made1);
            const source = tableSourceOf(node);
            if (source) made1.source = source;
          }
        }
        else if (uri.includes('/diagram')) await this.diagram(node, data, rels, group, out);
        else if (uri.includes('/chart')) {
          const el = await this.chart(node, data, rels, group);
          if (el) {
            out.push(el);
            this.keepId(attrs(path(node, 'p:nvGraphicFramePr', 'p:cNvPr')).name, el);
          } else this.note('Some charts are of a kind this app cannot show and were dropped.');
        } else this.note('Embedded objects were dropped.');
      }
    }
  }

  /** A table: a filled rectangle per colored cell, a text box per cell with text, and the cell borders as lines. */
  private table(frame: XNode, tbl: XNode | undefined, rels: Rel[], inherit: XNode[], group: GroupTransform | null, out: SlideElement[]): void {
    const inner = this.frameTransform(child(frame, 'p:xfrm'), group);
    const cols = children(child(tbl, 'a:tblGrid'), 'a:gridCol').map((c) => (num(attrs(c).w) ?? 0) / EMU_PER_PX);
    const rows = children(tbl, 'a:tr');
    const heights = rows.map((r) => (num(attrs(r).h) ?? 0) / EMU_PER_PX);
    if (!inner || !cols.length || !rows.length) {
      this.note('Some tables could not be converted and were dropped.');
      return;
    }
    const xs = cols.reduce<number[]>((acc, w) => [...acc, acc[acc.length - 1] + w], [0]);
    const ys = heights.reduce<number[]>((acc, h) => [...acc, acc[acc.length - 1] + h], [0]);
    const at = (x0: number, y0: number, x1: number, y1: number) => this.place({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, 0, false, false, inner);
    const whole = this.tableElement(tbl, rows, cols, at(0, 0, xs[xs.length - 1], ys[ys.length - 1]), inherit);
    if (whole) {
      out.push(whole);
      return;
    }
    const fills: SlideElement[] = [];
    const texts: SlideElement[] = [];
    // Borders by position, so the edge two cells share is drawn once (the later cell's wins, as in PowerPoint).
    const edges = new Map<string, { vertical: boolean; at: number; from: number; to: number; color: string; width: number }>();
    const defaults = this.textDefaults(undefined, undefined, 'body', inherit);
    rows.forEach((row, r) => {
      let c = 0;
      for (const tc of children(row, 'a:tc')) {
        const a = attrs(tc);
        const span = Math.max(1, num(a.gridSpan) ?? 1);
        const rowSpan = Math.max(1, num(a.rowSpan) ?? 1);
        const col = c;
        c += span;
        if (truthy(a.hMerge) || truthy(a.vMerge) || col >= cols.length) continue;
        const [x0, y0, x1, y1] = [xs[col], ys[r], xs[Math.min(cols.length, col + span)], ys[Math.min(rows.length, r + rowSpan)]];
        const tcPr = child(tc, 'a:tcPr');
        const fill = this.colorOf(tcPr);
        if (fill && fill !== 'none') fills.push({ id: this.nextId(), type: 'shape', shape: 'rect', ...boxOf(at(x0, y0, x1, y1)), fill });
        const sides: [string, boolean, number, number, number][] = [['a:lnL', true, x0, y0, y1], ['a:lnR', true, x1, y0, y1], ['a:lnT', false, y0, x0, x1], ['a:lnB', false, y1, x0, x1]];
        for (const [name, vertical, pos, from, to] of sides) {
          const ln = child(tcPr, name);
          if (!ln) continue;
          const key = `${vertical ? 'v' : 'h'}:${Math.round(pos)}:${Math.round(from)}`;
          const color = this.solidColor(ln);
          if (color) edges.set(key, { vertical, at: pos, from, to, color, width: Math.max(1, Math.round((((num(attrs(ln).w) ?? 12700) / EMU_PER_PX) * this.scale))) });
          else if (child(ln, 'a:noFill')) edges.delete(key);
        }
        const txBody = child(tc, 'a:txBody');
        if (!children(txBody, 'a:p').some((p) => paragraphText(p).trim() !== '')) continue;
        const ta = attrs(tcPr);
        const bp = { lIns: ta.marL ?? '91440', rIns: ta.marR ?? '91440', tIns: ta.marT ?? '45720', bIns: ta.marB ?? '45720', ...(ta.anchor ? { anchor: ta.anchor } : {}) };
        texts.push(this.textElement(txBody, at(x0, y0, x1, y1), 'body', { size: 1800, ...defaults, bullet: false }, rels, bp, false));
      }
    });
    const lines: SlideElement[] = [];
    if (!edges.size && !fills.length) {
      // A table that leaves its look to a table style: a plain grid.
      for (const x of xs) lines.push(this.rule(at(x, 0, x, ys[ys.length - 1]), '#9aa0a6', 1));
      for (const y of ys) lines.push(this.rule(at(0, y, xs[xs.length - 1], y), '#9aa0a6', 1));
    }
    // Borders that continue each other in the same color and width join into one line.
    const sorted = [...edges.values()].sort((a, b) => Number(a.vertical) - Number(b.vertical) || a.at - b.at || a.from - b.from);
    for (let i = 0; i < sorted.length; i++) {
      const e = { ...sorted[i] };
      while (i + 1 < sorted.length) {
        const n = sorted[i + 1];
        if (n.vertical !== e.vertical || Math.abs(n.at - e.at) > 0.5 || Math.abs(n.from - e.to) > 0.5 || n.color !== e.color || n.width !== e.width) break;
        e.to = n.to;
        i++;
      }
      lines.push(this.rule(e.vertical ? at(e.at, e.from, e.at, e.to) : at(e.from, e.at, e.to, e.at), e.color, e.width));
    }
    out.push(...fills, ...texts, ...lines);
  }

  /**
   * A table as one of our tables, with each cell's text, fill, alignment and the look of its first run. Null
   * for what ours cannot hold (merged cells, a turned or mirrored frame, too many rows or columns); the caller
   * then draws it from boxes and lines.
   */
  private tableElement(tbl: XNode | undefined, rows: XNode[], cols: number[], at: Placed, inherit: XNode[]): TableElement | null {
    if (at.rot || at.flipH || at.flipV || rows.length > MAX_TABLE_ROWS || cols.length > MAX_TABLE_COLS) return null;
    const defaults = { size: 1800, ...this.textDefaults(undefined, undefined, 'body', inherit), bullet: false };
    const tblPr = attrs(child(tbl, 'a:tblPr'));
    const header = truthy(tblPr.firstRow);
    const banded = truthy(tblPr.bandRow);
    const cells: TableCell[][] = [];
    const sizes: number[] = [];
    const fonts: string[] = [];
    const borders: string[] = [];
    let noBorders = 0;
    for (const [r, row] of rows.entries()) {
      const tcs = children(row, 'a:tc');
      if (tcs.length !== cols.length) return null;
      const out: TableCell[] = [];
      for (const tc of tcs) {
        const a = attrs(tc);
        if ((num(a.gridSpan) ?? 1) > 1 || (num(a.rowSpan) ?? 1) > 1 || truthy(a.hMerge) || truthy(a.vMerge)) return null;
        const tcPr = child(tc, 'a:tcPr');
        const paragraphs = children(child(tc, 'a:txBody'), 'a:p');
        const cell: TableCell = { text: paragraphs.map(paragraphText).join('\n').replace(/\n+$/, '') };
        const first = paragraphs.find((p) => paragraphText(p).trim() !== '') ?? paragraphs[0];
        const props = first ? this.runProps(first, defaults, 1) : null;
        if (props?.size) sizes.push(props.size);
        if (props?.font) fonts.push(props.font);
        if (props?.bold !== undefined && props.bold !== (header && r === 0)) cell.bold = props.bold;
        if (props?.italic) cell.italic = true;
        if (props?.color && !this.isTextColor(props.color)) cell.color = props.color;
        const algn = attrs(child(first, 'a:pPr')).algn;
        if (algn === 'ctr') cell.align = 'center';
        else if (algn === 'r') cell.align = 'right';
        const fill = this.colorOf(tcPr);
        if (fill && fill !== 'none') cell.fill = fill;
        for (const side of ['a:lnL', 'a:lnR', 'a:lnT', 'a:lnB']) {
          const ln = child(tcPr, side);
          const color = this.solidColor(ln);
          if (color) borders.push(color);
          else if (child(ln, 'a:noFill')) noBorders++;
        }
        out.push(cell);
      }
      cells.push(out);
    }
    const common = <T,>(list: T[]): T | undefined => {
      const counts = new Map<T, number>();
      for (const v of list) counts.set(v, (counts.get(v) ?? 0) + 1);
      return [...counts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
    };
    const style: TableStyle = {};
    const size = common(sizes);
    if (size && size !== 16) style.size = size;
    const font = common(fonts);
    if (font) style.font = font;
    // The borders most cells have; none when the file turns them all off.
    const border = common(borders);
    if (border) style.border = border;
    else if (noBorders) style.border = 'none';
    const el: TableElement = { id: this.nextId(), type: 'table', ...boxOf(at), rows: cells };
    const shares = normalShares(cols);
    if (shares) el.cols = shares;
    if (header) el.header = true;
    if (banded) el.banded = true;
    if (Object.keys(style).length) el.style = style;
    return validateElement(el, 'table') ? null : el;
  }

  private rule(p: Placed, color: string, width: number): LineElement {
    return { id: this.nextId(), type: 'line', kind: 'straight', ...boxOf(p), strokeColor: color, strokeWidth: width };
  }

  /**
   * A chart: a slide chart with the data the file keeps for it (the chart's caches), and, for one the app
   * wrote, the spreadsheet chart it shows. Null for a kind ours cannot be, or a turned frame.
   */
  private async chart(frame: XNode, data: XNode | undefined, rels: Rel[], group: GroupTransform | null): Promise<ChartElement | null> {
    const rid = attrs(child(data, 'c:chart'))['r:id'];
    const target = rels.find((r) => r.id === rid)?.target;
    const xml = target ? await this.zip.file(target)?.async('string') : undefined;
    const read = xml ? readChartWithData(xml) : null;
    const at = this.placed(child(frame, 'p:xfrm'), group);
    if (!read || !at || at.rot) return null;
    const el: ChartElement = { id: this.nextId(), type: 'chart', ...boxOf(at), chart: read.chart, data: read.data };
    const ext = children(path(frame, 'p:nvGraphicFramePr', 'p:nvPr', 'p:extLst'), 'p:ext').find((e) => attrs(e).uri === CHART_SOURCE_EXT);
    const link = attrs(child(ext, 'ud:chartSource')).data;
    if (link) {
      try {
        const source = JSON.parse(decodeURIComponent(link)) as ChartElement['source'];
        if (!validateElement({ ...el, source }, 'chart')) el.source = source;
      } catch {
        // not a link of ours
      }
    }
    return validateElement(el, 'chart') ? null : el;
  }

  /** SmartArt: the shapes PowerPoint saved for it (its drawing part), placed inside the frame. */
  private async diagram(frame: XNode, data: XNode | undefined, rels: Rel[], group: GroupTransform | null, out: SlideElement[]): Promise<void> {
    const drawings = rels.filter((r) => r.type.endsWith('/diagramDrawing'));
    let file = drawings.length === 1 ? drawings[0].target : undefined;
    if (!file && drawings.length) {
      // Several diagrams on the slide: each one's data part names its drawing.
      const dataFile = rels.find((r) => r.id === attrs(child(data, 'dgm:relIds'))['r:dm'])?.target;
      const ext = findDeep((dataFile && (await this.xml(dataFile))) || [], 'dsp:dataModelExt');
      file = drawings.find((r) => r.id === attrs(ext).relId)?.target;
    }
    const doc = file ? await this.xml(file) : null;
    const tree = child(root(doc ?? [], 'dsp:drawing'), 'dsp:spTree');
    const inner = this.frameTransform(child(frame, 'p:xfrm'), group);
    if (!file || !tree || !inner) {
      this.note('SmartArt without a saved drawing was dropped.');
      return;
    }
    await this.shapes(retag(tree, 'dsp:', 'p:'), await this.rels(file), [], out, inner);
  }

  /** The transform of a graphic frame: what is inside is measured from the frame's corner. */
  private frameTransform(xfrm: XNode | undefined, parent: GroupTransform | null): GroupTransform | null {
    const off = attrs(child(xfrm, 'a:off'));
    const x = num(off.x);
    const y = num(off.y);
    if (x === undefined || y === undefined) return null;
    return { parent, cx: 0, cy: 0, rot: 0, flipH: false, flipV: false, apply: (b) => ({ ...b, x: b.x + x / EMU_PER_PX, y: b.y + y / EMU_PER_PX }) };
  }

  /**
   * Where an xfrm puts its shape in our slide units, through any group transforms: the box before rotation, the
   * rotation about the box's center in degrees clockwise, and whether the shape is mirrored.
   */
  private placed(xfrm: XNode | undefined, group: GroupTransform | null): Placed | null {
    const off = attrs(child(xfrm, 'a:off'));
    const ext = attrs(child(xfrm, 'a:ext'));
    const x = num(off.x);
    const y = num(off.y);
    const cx = num(ext.cx);
    const cy = num(ext.cy);
    if (x === undefined || y === undefined || cx === undefined || cy === undefined) return null;
    const a = attrs(xfrm);
    return this.place({ x: x / EMU_PER_PX, y: y / EMU_PER_PX, w: cx / EMU_PER_PX, h: cy / EMU_PER_PX }, (num(a.rot) ?? 0) / 60000, truthy(a.flipH), truthy(a.flipV), group);
  }

  /** A box in the file's pixels (inside `group`) as a placement on our slide. */
  private place(b: { x: number; y: number; w: number; h: number }, rot: number, flipH: boolean, flipV: boolean, group: GroupTransform | null): Placed {
    for (let g = group; g; g = g.parent) {
      b = g.apply(b);
      // A mirrored or rotated group moves its members around its own center and turns them with it.
      let mx = b.x + b.w / 2;
      let my = b.y + b.h / 2;
      if (g.flipH) {
        mx = 2 * g.cx - mx;
        flipH = !flipH;
        rot = -rot;
      }
      if (g.flipV) {
        my = 2 * g.cy - my;
        flipV = !flipV;
        rot = -rot;
      }
      if (g.rot) {
        const t = (g.rot * Math.PI) / 180;
        const [dx, dy] = [mx - g.cx, my - g.cy];
        mx = g.cx + dx * Math.cos(t) - dy * Math.sin(t);
        my = g.cy + dx * Math.sin(t) + dy * Math.cos(t);
        rot += g.rot;
      }
      b = { x: mx - b.w / 2, y: my - b.h / 2, w: b.w, h: b.h };
    }
    rot = ((rot % 360) + 360) % 360;
    return {
      x: Math.round(this.ox + b.x * this.scale),
      y: Math.round(this.oy + b.y * this.scale),
      w: Math.round(b.w * this.scale),
      h: Math.round(b.h * this.scale),
      rot: Math.round((rot > 180 ? rot - 360 : rot) * 100) / 100,
      flipH,
      flipV,
    };
  }

  private groupTransform(grpSpPr: XNode | undefined, parent: GroupTransform | null): GroupTransform | null {
    const xfrm = child(grpSpPr, 'a:xfrm');
    const off = attrs(child(xfrm, 'a:off'));
    const ext = attrs(child(xfrm, 'a:ext'));
    const chOff = attrs(child(xfrm, 'a:chOff'));
    const chExt = attrs(child(xfrm, 'a:chExt'));
    const ox = num(off.x);
    const oy = num(off.y);
    const cw = num(chExt.cx);
    const ch = num(chExt.cy);
    if (ox === undefined || oy === undefined || !cw || !ch) return parent;
    const sx = (num(ext.cx) ?? cw) / cw;
    const sy = (num(ext.cy) ?? ch) / ch;
    const cox = num(chOff.x) ?? 0;
    const coy = num(chOff.y) ?? 0;
    const px = EMU_PER_PX;
    const xa = attrs(xfrm);
    return {
      parent,
      cx: (ox + (num(ext.cx) ?? cw) / 2) / px,
      cy: (oy + (num(ext.cy) ?? ch) / 2) / px,
      rot: (num(xa.rot) ?? 0) / 60000,
      flipH: truthy(xa.flipH),
      flipV: truthy(xa.flipV),
      apply: (b) => ({ x: (ox + (b.x * px - cox) * sx) / px, y: (oy + (b.y * px - coy) * sy) / px, w: b.w * sx, h: b.h * sy }),
    };
  }

  /** The placeholder's placement from the layout or master when the slide's shape has no xfrm of its own. */
  private inheritedPlace(ph: Record<string, string>, inherit: XNode[], group: GroupTransform | null): Placed | null {
    for (const part of inherit) {
      const sp = this.placeholderIn(part, ph);
      const b = sp && this.placed(path(sp, 'p:spPr', 'a:xfrm'), group);
      if (b) return b;
    }
    return null;
  }

  /**
   * The theme of a master: its color scheme (dk1, lt1, accent1, ... plus the bg1/tx1 aliases from the master's
   * clrMap) and its heading and body fonts.
   */
  private async theme(masterFile: string | undefined, master: XNode | undefined): Promise<ThemeInfo> {
    if (!masterFile) return { colors: {}, fonts: {} };
    const cached = this.themeCache.get(masterFile);
    if (cached) return cached;
    const colors: Record<string, string> = {};
    const themeFile = (await this.rels(masterFile)).find((r) => r.type.endsWith('/theme'))?.target;
    const themeDoc = themeFile ? await this.xml(themeFile) : null;
    const elements = path(root(themeDoc ?? [], 'a:theme'), 'a:themeElements');
    for (const c of kids(child(elements, 'a:clrScheme'))) {
      const name = tagOf(c).replace('a:', '');
      const v = attrs(child(c, 'a:srgbClr')).val ?? attrs(child(c, 'a:sysClr')).lastClr;
      if (v && /^[0-9A-Fa-f]{6}$/.test(v)) colors[name] = v.toLowerCase();
    }
    const clrMap = attrs(child(master, 'p:clrMap'));
    for (const k of ['bg1', 'tx1', 'bg2', 'tx2']) if (clrMap[k] && colors[clrMap[k]]) colors[k] = colors[clrMap[k]];
    const fontScheme = child(elements, 'a:fontScheme');
    const fonts: ThemeInfo['fonts'] = {};
    const major = attrs(path(fontScheme, 'a:majorFont', 'a:latin')).typeface;
    const minor = attrs(path(fontScheme, 'a:minorFont', 'a:latin')).typeface;
    if (major) fonts.major = major;
    if (minor) fonts.minor = minor;
    const info = { colors, fonts };
    this.themeCache.set(masterFile, info);
    return info;
  }

  /**
   * The solid fill of a node (its a:solidFill child) as a CSS color: "#rrggbb", "rgba(...)" when it has an alpha,
   * "none" when fully transparent, or undefined when there is no solid fill. Theme colors resolve through the
   * master's color scheme.
   */
  private colorOf(parent: XNode | undefined): string | undefined {
    const fill = child(parent, 'a:solidFill');
    return fill ? this.colorNode(fill) : undefined;
  }

  /** The color child of `parent` (a:srgbClr, a:schemeClr, ...) with its lightness and alpha changes applied. */
  private rgba(parent: XNode | undefined): Rgba | undefined {
    const node = kids(parent).find((c) => ['a:srgbClr', 'a:schemeClr', 'a:sysClr', 'a:prstClr', 'a:scrgbClr'].includes(tagOf(c)));
    if (!node) return undefined;
    const a = attrs(node);
    const tag = tagOf(node);
    let rgb: number[];
    if (tag === 'a:scrgbClr') rgb = [a.r, a.g, a.b].map((v) => Math.round(((num(v) ?? 0) / 100000) * 255));
    else {
      const hex = tag === 'a:srgbClr' ? a.val : tag === 'a:schemeClr' ? this.colors[a.val] : tag === 'a:sysClr' ? a.lastClr : PRESET_COLORS[a.val];
      if (!hex || !/^[0-9A-Fa-f]{6}$/.test(hex)) return undefined;
      rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    }
    let alpha = 1;
    for (const m of kids(node)) {
      const v = (num(attrs(m).val) ?? 100000) / 100000;
      const mod = tagOf(m);
      if (mod === 'a:alpha') alpha = Math.max(0, Math.min(1, v));
      else if (mod === 'a:lumMod') rgb = retone(rgb, (sat, l) => [sat, l * v]);
      else if (mod === 'a:lumOff') rgb = retone(rgb, (sat, l) => [sat, l + v]);
      else if (mod === 'a:satMod') rgb = retone(rgb, (sat, l) => [sat * v, l]);
      else if (mod === 'a:shade') rgb = rgb.map((c) => c * v);
      else if (mod === 'a:tint') rgb = rgb.map((c) => c * v + 255 * (1 - v));
    }
    const [r, g, b] = rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))));
    return { r, g, b, a: Math.round(alpha * 100) / 100 };
  }

  /** The color given by a color child of `parent` (see colorOf for the result). */
  private colorNode(parent: XNode | undefined): string | undefined {
    const c = this.rgba(parent);
    if (!c) return undefined;
    return c.a <= 0 ? 'none' : cssColor(c);
  }

  /**
   * The gradient fill of a node (its a:gradFill child) as a CSS gradient. Flips mirror a gradient that turns
   * with its shape.
   */
  private gradientOf(parent: XNode | undefined, flipH: boolean, flipV: boolean): string | undefined {
    const grad = child(parent, 'a:gradFill');
    const stops = children(child(grad, 'a:gsLst'), 'a:gs')
      .map((gs) => ({ pos: (num(attrs(gs).pos) ?? 0) / 1000, color: this.rgba(gs) }))
      .filter((s): s is { pos: number; color: Rgba } => !!s.color)
      .sort((a, b) => a.pos - b.pos)
      .slice(0, 10);
    if (stops.length < 2) return undefined;
    const list = stops.map((s) => `${cssColor(s.color)} ${Math.round(s.pos * 10) / 10}%`).join(', ');
    if (child(grad, 'a:path')) return `radial-gradient(${list})`;
    // PowerPoint measures the angle clockwise from "left to right"; CSS from "bottom to top".
    let ang = (num(attrs(child(grad, 'a:lin')).ang) ?? 5400000) / 60000;
    if (flipH) ang = 180 - ang;
    if (flipV) ang = -ang;
    return `linear-gradient(${Math.round(((((ang + 90) % 360) + 360) % 360) * 10) / 10}deg, ${list})`;
  }

  /** colorOf without the "none" case, for text and outlines. */
  private solidColor(parent: XNode | undefined): string | undefined {
    const c = this.colorOf(parent);
    return c === 'none' ? undefined : c;
  }

  /** True for the theme's main text color (dk1/tx1): text in it keeps our theme's text color instead. */
  private isTextColor(color: string | undefined): boolean {
    if (!color || !/^#[0-9a-f]{6}$/.test(color)) return false;
    const hex = color.slice(1);
    // A light text color (a dark deck) is kept: our theme's text would vanish on the deck's own background.
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    if (0.299 * r + 0.587 * g + 0.114 * b > 128) return false;
    return hex === this.colors.tx1 || hex === this.colors.dk1 || hex === '000000';
  }

  /** The font family a run property names: an explicit typeface, or the theme's heading/body font for +mj-lt/+mn-lt. */
  private fontName(rPr: XNode | undefined): { name?: string; bold: boolean } {
    const typeface = attrs(child(rPr, 'a:latin')).typeface;
    if (!typeface) return { bold: false };
    if (typeface.startsWith('+mj')) return { ...(this.fonts.major ? { name: this.fonts.major } : {}), bold: false };
    if (typeface.startsWith('+mn')) return { ...(this.fonts.minor ? { name: this.fonts.minor } : {}), bold: false };
    return fontOf(typeface);
  }

  /** Fold a list-style level (an a:lvlNpPr or a:defPPr node) into inherited text defaults. */
  private applyLevel(d: TextDefaults, lvl: XNode | undefined): void {
    if (!lvl) return;
    const a = attrs(lvl);
    if (a.algn) d.algn = a.algn;
    const pct = num(attrs(path(lvl, 'a:lnSpc', 'a:spcPct')).val);
    const pts = num(attrs(path(lvl, 'a:lnSpc', 'a:spcPts')).val);
    if (pct !== undefined) [d.lineSpc, d.linePts] = [pct, undefined];
    else if (pts !== undefined) [d.lineSpc, d.linePts] = [undefined, pts];
    const bef = num(attrs(path(lvl, 'a:spcBef', 'a:spcPts')).val);
    if (bef !== undefined) d.spcBef = bef;
    const aft = num(attrs(path(lvl, 'a:spcAft', 'a:spcPts')).val);
    if (aft !== undefined) d.spcAft = aft;
    if (child(lvl, 'a:buNone')) d.bullet = false;
    else if (child(lvl, 'a:buChar') || child(lvl, 'a:buAutoNum')) {
      d.bullet = true;
      d.bulletChar = attrs(child(lvl, 'a:buChar')).char;
    }
    const buFont = attrs(child(lvl, 'a:buFont')).typeface;
    if (buFont) d.bulletFont = buFont;
    const buColor = this.colorNode(child(lvl, 'a:buClr'));
    if (buColor && buColor !== 'none') d.bulletColor = buColor;
    const rPr = child(lvl, 'a:defRPr');
    if (!rPr) return;
    const r = attrs(rPr);
    const sz = num(r.sz);
    if (sz) d.size = sz;
    if (r.b !== undefined) d.bold = r.b === '1';
    if (r.i !== undefined) d.italic = r.i === '1';
    if (r.cap !== undefined) d.caps = r.cap !== 'none';
    if (num(r.spc) !== undefined) d.spc = num(r.spc);
    const outline = this.outlineOf(rPr);
    if (outline !== undefined) d.outline = outline ?? undefined;
    const color = this.solidColor(rPr);
    if (color) d.color = this.isTextColor(color) ? undefined : color;
    const face = this.fontName(rPr);
    if (face.name) d.font = face.name;
    if (face.bold) d.bold = true;
  }

  /**
   * What a text box inherits when its runs say nothing: the master's text styles (title, body or other), then
   * the master's and the layout's matching placeholder, then the shape's own list style. A styled shape's font
   * reference (the light text PowerPoint draws on filled shapes) sits underneath all of them.
   */
  private textDefaults(sp: XNode | undefined, ph: Record<string, string> | undefined, role: TextRole, inherit: XNode[]): TextDefaults {
    const d: TextDefaults = {};
    const styles = inherit.map((n) => child(n, 'p:txStyles')).find((n) => !!n);
    // Footers and slide numbers are placeholders, but not part of the title or the body.
    const styleName = !ph || role === 'caption' ? 'p:otherStyle' : role === 'title' ? 'p:titleStyle' : 'p:bodyStyle';
    this.applyLevel(d, child(child(styles, styleName), 'a:lvl1pPr'));
    if (ph) {
      // The master first, then the layout: the layout's placeholder overrides the master's.
      for (const part of [...inherit].reverse()) {
        const match = this.placeholderIn(part, ph);
        this.applyLevel(d, path(match, 'p:txBody', 'a:lstStyle', 'a:lvl1pPr'));
      }
    }
    this.applyLevel(d, path(sp, 'p:txBody', 'a:lstStyle', 'a:lvl1pPr'));
    // The master's "other" style names the plain text color, which the font reference of a styled shape beats.
    const refColor = this.colorNode(path(sp, 'p:style', 'a:fontRef'));
    if (!d.color && refColor && refColor !== 'none' && !this.isTextColor(refColor)) d.color = refColor;
    return d;
  }

  /**
   * Outlined text: the color of a run's outline when its letters have no fill, null when the run sets a fill (so
   * it is not outlined whatever it inherits), and undefined when it says nothing.
   */
  private outlineOf(rPr: XNode | undefined): string | null | undefined {
    if (child(rPr, 'a:solidFill') || child(rPr, 'a:gradFill')) return null;
    const color = this.solidColor(child(rPr, 'a:ln'));
    return color && child(rPr, 'a:noFill') ? color : undefined;
  }

  /** The placeholder shape in a layout or master that a slide's placeholder inherits from. */
  private placeholderIn(part: XNode, ph: Record<string, string>): XNode | undefined {
    const sps = children(path(part, 'p:cSld', 'p:spTree'), 'p:sp');
    const match = (byIdx: boolean) =>
      sps.find((sp) => {
        const node = path(sp, 'p:nvSpPr', 'p:nvPr', 'p:ph');
        if (!node) return false;
        const a = attrs(node);
        return byIdx ? ph.idx !== undefined && a.idx === ph.idx : sameType(a.type, ph.type);
      });
    // An idx pairs a slide's placeholder with its layout's; the master's are found by type (its idx 4 is the slide number).
    return (tagOf(part) === 'p:sldMaster' ? undefined : match(true)) ?? match(false);
  }

  /**
   * A shape becomes a shape element, a text element, or both (a filled shape with text keeps its text styling);
   * one filled with a picture becomes an image.
   */
  private async shape(sp: XNode, rels: Rel[], inherit: XNode[], group: GroupTransform | null): Promise<SlideElement[]> {
    const ph = path(sp, 'p:nvSpPr', 'p:nvPr', 'p:ph');
    const phAttrs = attrs(ph);
    const phType = ph ? (phAttrs.type ?? 'body') : undefined;
    // Dates and empty picture placeholders are chrome, not content.
    if (phType && ['dt', 'pic', 'media', 'clipArt', 'tbl', 'chart', 'dgm'].includes(phType)) return [];
    const chrome = phType === 'ftr' || phType === 'sldNum';
    const txBody = child(sp, 'p:txBody');
    const paragraphs = children(txBody, 'a:p');
    const hasText = paragraphs.some((p) => paragraphText(p).trim() !== '');
    if (chrome && !hasText) return [];

    // A placeholder takes what it leaves unsaid from the matching placeholder of the layout, then the master.
    const phShapes = ph ? inherit.map((part) => this.placeholderIn(part, phAttrs)).filter((n): n is XNode => !!n) : [];
    const spPr = child(sp, 'p:spPr');
    const spPrs = [spPr, ...phShapes.map((n) => child(n, 'p:spPr'))];
    const having = (...names: string[]) => spPrs.find((pr) => kids(pr).some((c) => names.includes(tagOf(c))));
    const xfrm = child(spPr, 'a:xfrm');
    let at = this.placed(xfrm, group);
    if (!at && ph) at = this.inheritedPlace(phAttrs, inherit, group);
    if (!at) return [];
    if (at.w <= 0 && at.h <= 0) return [];
    const role: TextRole = chrome ? 'caption' : phType === 'title' || phType === 'ctrTitle' ? 'title' : phType === 'subTitle' ? 'subtitle' : 'body';

    const geomPr = having('a:prstGeom', 'a:custGeom');
    const prst = attrs(child(geomPr, 'a:prstGeom')).prst;
    const custom = child(geomPr, 'a:custGeom');
    const fillPr = having('a:solidFill', 'a:noFill', 'a:gradFill', 'a:blipFill', 'a:pattFill', 'a:grpFill');
    const fillRaw = this.colorOf(fillPr);
    const fillColor = fillRaw === 'none' ? undefined : fillRaw;
    const gradient = this.gradientOf(fillPr, at.flipH, at.flipV);
    const noFill = !!child(fillPr, 'a:noFill') || fillRaw === 'none';
    const style = child(sp, 'p:style');
    const styledFill = !fillPr && !!style && attrs(child(style, 'a:fillRef')).idx !== '0' && !!attrs(child(style, 'a:fillRef')).idx;
    const ln = child(having('a:ln'), 'a:ln');
    const strokeColor = this.solidColor(ln);
    const noLine = !!child(ln, 'a:noFill');
    const styledLine = !!style && attrs(child(style, 'a:lnRef')).idx !== '0' && !!attrs(child(style, 'a:lnRef')).idx;
    const filled = !!fillColor || !!gradient || (!noFill && styledFill);
    const stroked = !!strokeColor || (!noLine && styledLine);
    const geometric = (!!prst && prst !== 'rect') || !!custom;

    if (!ph && prst && LINE_PRESETS.test(prst)) {
      const line = this.lineElement(prst, at, ln, style);
      if (!line.strokeColor && stroked) line.strokeColor = '#5f6368';
      return [line];
    }

    const made: SlideElement[] = [];
    const picture = fillPr === spPr ? child(spPr, 'a:blipFill') : undefined;
    if (picture) {
      const img = await this.imageElement(picture, rels, at, geomPr);
      if (img) made.push(img);
    }

    let onShape: ShapeElement | null = null;
    if (!picture && (filled || stroked || (!ph && geometric && !custom))) {
      const el: ShapeElement = { id: this.nextId(), type: 'shape', shape: custom ? 'rect' : shapeKind(prst, (m) => this.note(m)), ...boxOf(at) };
      const outline = custom ? customPath(custom, at.flipH, at.flipV, at.w, at.h) : undefined;
      if (outline) el.path = outline.d;
      const plain = !outline && ['rect', 'rounded', 'ellipse'].includes(el.shape);
      const refFill = this.colorNode(child(style, 'a:fillRef'));
      if (fillColor) el.fill = fillColor;
      else if (gradient) el.fill = plain ? gradient : (firstColor(gradient) ?? 'none');
      else if (!filled) el.fill = 'none';
      else if (refFill && refFill !== 'none') el.fill = refFill;
      const refLine = this.colorNode(child(style, 'a:lnRef'));
      if (strokeColor) el.stroke = strokeColor;
      else if (stroked && refLine && refLine !== 'none') el.stroke = refLine;
      else if (stroked && !filled) el.stroke = '#5f6368';
      const w = num(attrs(ln).w);
      if (w !== undefined && (el.stroke || el.shape === 'line')) el.strokeWidth = Math.max(1, Math.round((w / EMU_PER_PX) * this.scale));
      if (el.shape === 'arc') {
        // An arc is stroke only. Rotation and flips are folded into the angles (the box is rotated about its center).
        el.fill = 'none';
        if (!el.stroke) el.stroke = '#5f6368';
        const xfrm = attrs(child(spPr, 'a:xfrm'));
        const adj = (name: string, dflt: number) => {
          const gd = children(child(child(spPr, 'a:prstGeom'), 'a:avLst'), 'a:gd').find((g) => attrs(g).name === name);
          const m = /^val\s+(-?\d+)/.exec(attrs(gd).fmla ?? '');
          return (m ? Number(m[1]) : dflt) / 60000;
        };
        let [a1, a2] = prst === 'blockArc' ? [adj('adj1', 180), adj('adj2', 0)] : [adj('adj1', 270), adj('adj2', 0)];
        if (xfrm.flipH === '1' || xfrm.flipH === 'true') [a1, a2] = [180 - a1, 180 - a2];
        if (xfrm.flipV === '1' || xfrm.flipV === 'true') [a1, a2] = [-a1, -a2];
        // Flips mirror the sweep direction, so swap the ends when exactly one flip applies.
        const flips = Number(xfrm.flipH === '1' || xfrm.flipH === 'true') + Number(xfrm.flipV === '1' || xfrm.flipV === 'true');
        if (flips === 1) [a1, a2] = [a2, a1];
        const rot = (num(xfrm.rot) ?? 0) / 60000;
        const norm = (a: number) => Math.round((((a + rot) % 360) + 360) % 360 * 100) / 100;
        el.startAngle = norm(a1);
        el.endAngle = norm(a2);
        // Store the tight box around the visible stroke (PowerPoint's box is the whole ellipse).
        Object.assign(el, tightArc(el));
      } else if (at.rot) el.rot = at.rot;
      made.push(el);
      onShape = el; // the text goes in its own element on top, so sizes, fonts and colors survive
    }
    if (!hasText && (made.length || !ph)) return made;

    // SmartArt says where a shape's text goes; text set vertically is a box turned on its side.
    let textAt = this.placed(child(sp, 'p:txXfrm'), group) ?? at;
    const bp: Record<string, string> = Object.assign({}, ...[...phShapes].reverse().map((n) => attrs(path(n, 'p:txBody', 'a:bodyPr'))), attrs(child(txBody, 'a:bodyPr')));
    if (bp.vert === 'vert' || bp.vert === 'eaVert' || bp.vert === 'vert270') {
      const turn = bp.vert === 'vert270' ? -90 : 90;
      const rot = (((textAt.rot + turn) % 360) + 360) % 360;
      textAt = { ...textAt, x: Math.round(textAt.x + textAt.w / 2 - textAt.h / 2), y: Math.round(textAt.y + textAt.h / 2 - textAt.w / 2), w: textAt.h, h: textAt.w, rot: rot > 180 ? rot - 360 : rot };
    }
    const defaults = this.textDefaults(sp, ph ? phAttrs : undefined, role, inherit);
    made.push(this.textElement(txBody, textAt, role, defaults, rels, bp, !!onShape, role === 'body' && !!ph));
    return made;
  }

  /**
   * The text element of a text body in a box. `bp` is the body's properties (insets, anchor) with what it inherits;
   * `phBullets` is true for body placeholders, whose paragraphs are bullets unless something says otherwise.
   */
  private textElement(txBody: XNode | undefined, at: Placed, role: TextRole, defaults: TextDefaults, rels: Rel[], bp: Record<string, string>, onShape: boolean, phBullets = false): TextElement {
    const paragraphs = children(txBody, 'a:p');
    let box = boxOf(at);
    // Text sits inside the box's insets (PowerPoint's defaults are 0.1in left/right and 0.05in top/bottom).
    if (txBody) {
      const inset = (k: string, dflt: number) => ((num(bp[k]) ?? dflt) / EMU_PER_PX) * this.scale;
      const [l, r, t, b] = [inset('lIns', 91440), inset('rIns', 91440), inset('tIns', 45720), inset('bIns', 45720)];
      box = { x: Math.round(box.x + l), y: Math.round(box.y + t), w: Math.max(1, Math.round(box.w - l - r)), h: Math.max(1, Math.round(box.h - t - b)) };
    }
    // Shrink-on-overflow text is stored at its full size with the scale PowerPoint last applied.
    const fontScale = (num(attrs(path(txBody, 'a:bodyPr', 'a:normAutofit')).fontScale) ?? 100000) / 100000;

    const ps: Paragraph[] = [];
    let bulletChar = defaults.bulletChar;
    let bulletFont = defaults.bulletFont;
    let bulletColor = defaults.bulletColor;
    let bulletSeen = false;
    for (const p of paragraphs) {
      const pPr = child(p, 'a:pPr');
      const text = paragraphText(p);
      let bullet: boolean;
      if (child(pPr, 'a:buNone')) bullet = false;
      else if (child(pPr, 'a:buChar') || child(pPr, 'a:buAutoNum') || child(pPr, 'a:buBlip')) bullet = text.trim() !== '';
      else bullet = phBullets && (defaults.bullet ?? true) && text.trim() !== '';
      if (bullet && !bulletSeen) {
        // The first bullet's look stands for the box.
        bulletSeen = true;
        bulletChar = attrs(child(pPr, 'a:buChar')).char ?? (child(pPr, 'a:buAutoNum') ? undefined : bulletChar);
        bulletFont = attrs(child(pPr, 'a:buFont')).typeface ?? bulletFont;
        const own = this.colorNode(child(pPr, 'a:buClr'));
        if (own && own !== 'none') bulletColor = own;
      }
      const level = Math.min(4, num(attrs(pPr).lvl) ?? 0);
      const runs = this.linkRuns(p, rels, defaults);
      ps.push({ text, ...(runs ? { runs } : {}), ...(bullet ? { bullet: true } : {}), ...(bullet && level ? { level } : {}) });
    }
    // Trailing empty paragraphs are noise.
    while (ps.length > 1 && ps[ps.length - 1].text.trim() === '') ps.pop();
    if (!ps.length) ps.push({ text: '' });

    const el: TextElement = { id: this.nextId(), type: 'text', role, ...box, paragraphs: ps };
    if (at.rot) el.rot = at.rot;
    const st = this.textStyle(paragraphs, bp, role, defaults, fontScale) ?? {};
    if (bulletSeen) {
      // Bullets from a symbol font (Wingdings' "§" is a square) only mean something in that font.
      if (bulletChar && bulletChar !== '•' && bulletChar.length <= 2 && !/wingdings|webdings|symbol/i.test(bulletFont ?? '')) st.bulletChar = bulletChar;
      if (bulletColor) st.bulletColor = bulletColor;
    }
    if (onShape) {
      // PowerPoint centers text in shapes.
      st.align ??= 'center';
      st.valign ??= 'middle';
    }
    if (Object.keys(st).length) el.style = st;
    // Paragraphs styled differently from the box (a big figure over a small caption) keep their own look.
    const base = { size: st?.size, bold: st?.bold ?? role === 'title', italic: !!st?.italic, color: st?.color, font: st?.font };
    paragraphs.forEach((p, k) => {
      const run = this.runProps(p, defaults, fontScale);
      if (!run || !ps[k] || ps[k].text.trim() === '') return;
      if (run.size !== undefined && run.size !== base.size) ps[k].size = run.size;
      if (run.bold !== undefined && run.bold !== base.bold) ps[k].bold = run.bold;
      if (run.italic !== undefined && run.italic !== base.italic) ps[k].italic = run.italic;
      if (run.color && run.color !== base.color) ps[k].color = run.color;
      if (run.font && run.font !== base.font) ps[k].font = run.font;
    });
    // Runs only keep what differs from their paragraph (PowerPoint repeats the box's look on every run).
    for (const p of ps) {
      for (const r of p.runs ?? []) {
        if (r.color === (p.color ?? st.color)) delete r.color;
        if (r.bold === (p.bold ?? base.bold)) delete r.bold;
        if (r.italic === (p.italic ?? base.italic)) delete r.italic;
      }
    }
    return el;
  }

  /**
   * The runs of a paragraph that holds a hyperlink or words in different colors or weights, so the look of each
   * run survives; undefined for paragraphs that look the same throughout, which stay plain text.
   */
  private linkRuns(p: XNode, rels: Rel[], d: TextDefaults): TextRun[] | undefined {
    const nodes = kids(p).filter((n) => ['a:r', 'a:fld', 'a:br'].includes(tagOf(n)));
    const linked = nodes.some((n) => child(child(n, 'a:rPr'), 'a:hlinkClick'));
    const runs: TextRun[] = [];
    for (const n of nodes) {
      if (tagOf(n) === 'a:br') {
        runs.push({ text: '\n' });
        continue;
      }
      const text = textOf(child(n, 'a:t'));
      if (!text) continue;
      const rPrNode = child(n, 'a:rPr');
      const rPr = attrs(rPrNode);
      const rid = attrs(child(rPrNode, 'a:hlinkClick'))['r:id'];
      const link = rid ? safeLinkUrl(rels.find((r) => r.id === rid)?.target ?? '') : null;
      const run: TextRun = { text };
      if (link) run.link = link;
      if (rPr.b !== undefined) run.bold = rPr.b === '1';
      if (rPr.i !== undefined) run.italic = rPr.i === '1';
      if (!link && rPr.u && rPr.u !== 'none') run.underline = true;
      // A run that names no color has the box's inherited one, whatever its neighbours say.
      const own = this.solidColor(rPrNode);
      const color = own ? (this.isTextColor(own) && !link ? d.color : own) : link ? undefined : d.color;
      if (color) run.color = color;
      // Neighbouring runs that look the same (PowerPoint splits text at spelling marks and edits) join up.
      const prev = runs[runs.length - 1];
      const same = (a: TextRun, b: TextRun) => a.link === b.link && a.bold === b.bold && a.italic === b.italic && a.underline === b.underline && a.color === b.color;
      if (prev && same(prev, run)) prev.text += text;
      else runs.push(run);
    }
    if (!linked && runs.filter((r) => r.text !== '\n').length < 2) return undefined;
    return runs.length ? runs : undefined;
  }

  /** A font size in our units (points on the 960-wide canvas) from PowerPoint's hundredths of a point. */
  private fontSize(sz: number, fontScale: number): number {
    return Math.max(4, Math.round((sz / 100) * (4 / 3) * fontScale * this.scale));
  }

  /** Size, weight, slant, color and font of a paragraph's first run, with the inherited defaults filled in. */
  private runProps(p: XNode, d: TextDefaults, fontScale: number): { size?: number; bold?: boolean; italic?: boolean; color?: string; font?: string } | null {
    const run = firstRun(p);
    if (!run) return null;
    const rPrNode = child(run, 'a:rPr');
    const rPr = attrs(rPrNode);
    const sz = num(rPr.sz) ?? d.size;
    const face = this.fontName(rPrNode);
    const bold = rPr.b !== undefined ? rPr.b === '1' : face.bold ? true : d.bold;
    const italic = rPr.i !== undefined ? rPr.i === '1' : d.italic;
    const color = this.solidColor(rPrNode) ?? d.color;
    const font = face.name ?? d.font;
    return {
      ...(sz ? { size: this.fontSize(sz, fontScale) } : {}),
      ...(bold !== undefined ? { bold } : {}),
      ...(italic !== undefined ? { italic } : {}),
      ...(color ? { color } : {}),
      ...(font ? { font } : {}),
    };
  }

  /** The style of the first run (sizes and colors are per run in PowerPoint; we keep one per text box). */
  private textStyle(paragraphs: XNode[], bp: Record<string, string>, role: TextRole, d: TextDefaults, fontScale: number): TextStyle | undefined {
    const st: TextStyle = {};
    const first = paragraphs.find((p) => paragraphText(p).trim() !== '') ?? paragraphs[0];
    const run = firstRun(first);
    const rPrNode = child(run, 'a:rPr');
    const rPr = attrs(rPrNode);
    const sz = num(rPr.sz) ?? d.size;
    if (sz) st.size = this.fontSize(sz, fontScale);
    // Font families such as "Poppins Black" carry their weight in the name.
    const face = this.fontName(rPrNode);
    const font = face.name ?? d.font;
    if (font) st.font = font;
    const bold = rPr.b !== undefined ? rPr.b === '1' : face.bold ? true : d.bold;
    // Our titles are bold unless told otherwise; other text is regular unless told otherwise.
    if (bold === true && role !== 'title') st.bold = true;
    if (bold !== true && role === 'title') st.bold = false;
    // Titling fonts have capitals only; whatever stands in for them should too.
    if (font && CAPS_FONTS.test(font)) st.caps = true;
    if ((rPr.i !== undefined ? rPr.i === '1' : d.italic) === true) st.italic = true;
    const color = this.runColor(paragraphs) ?? d.color;
    if (color) st.color = color;
    // Our subtitles and captions are gray; PowerPoint's are the text color unless they say otherwise.
    else if (role === 'subtitle' || role === 'caption') st.color = `#${this.colors.tx1 ?? '000000'}`;
    const outline = this.outlineOf(rPrNode);
    if (outline ?? (outline === undefined ? d.outline : undefined)) st.outline = (outline ?? d.outline)!;
    if (rPr.cap !== undefined ? rPr.cap !== 'none' : d.caps) st.caps = true;
    const spc = num(rPr.spc) ?? d.spc;
    if (spc) st.spacing = Math.max(-20, Math.min(100, Math.round((spc / 100) * (4 / 3) * this.scale * 10) / 10));
    const pPr = child(first, 'a:pPr');
    const algn = attrs(pPr).algn ?? d.algn;
    if (algn === 'ctr') st.align = 'center';
    else if (algn === 'r') st.align = 'right';
    // Line spacing: PowerPoint's 100% is about 1.2 × the font size.
    const ownPct = num(attrs(path(pPr, 'a:lnSpc', 'a:spcPct')).val);
    const ownPts = num(attrs(path(pPr, 'a:lnSpc', 'a:spcPts')).val);
    const pct = ownPct ?? (ownPts === undefined ? d.lineSpc : undefined);
    // An exact line pitch in points is a multiple of the font size for us.
    const exact = ownPts ?? (ownPct === undefined ? d.linePts : undefined);
    const lh = pct ? (pct / 100000) * 1.2 : exact && sz ? exact / (sz * fontScale) : undefined;
    if (lh && Math.abs(lh - 1.25) > 0.06) st.lineHeight = Math.min(4, Math.max(0.5, Math.round(lh * 100) / 100)); // single spacing is ours
    // Space between paragraphs is per paragraph in PowerPoint; the widest gap stands for the box.
    if (paragraphs.length > 1) {
      let gap: number | undefined;
      let prevAfter = 0;
      paragraphs.forEach((p, k) => {
        const pp = child(p, 'a:pPr');
        const before = num(attrs(path(pp, 'a:spcBef', 'a:spcPts')).val) ?? d.spcBef;
        const after = num(attrs(path(pp, 'a:spcAft', 'a:spcPts')).val) ?? d.spcAft;
        if (k > 0 && (before !== undefined || after !== undefined || gap !== undefined)) gap = Math.max(gap ?? 0, (before ?? 0) + prevAfter);
        prevAfter = after ?? 0;
      });
      if (gap !== undefined) st.paraSpacing = Math.min(200, Math.round((gap / 100) * (4 / 3) * this.scale * 10) / 10);
    }
    const anchor = bp.anchor;
    if (anchor === 'ctr') st.valign = 'middle';
    else if (anchor === 'b') st.valign = 'bottom';
    return Object.keys(st).length ? st : undefined;
  }

  /**
   * The first explicit run color in a box. Hyperlink runs carry the link color, so they only count when the box
   * holds nothing but links.
   */
  private runColor(paragraphs: XNode[]): string | undefined {
    let link: string | undefined;
    let plain = false;
    for (const p of paragraphs) {
      for (const r of children(p, 'a:r')) {
        if (textOf(child(r, 'a:t')).trim() === '') continue;
        const rPr = child(r, 'a:rPr');
        const c = this.solidColor(rPr);
        if (child(rPr, 'a:hlinkClick')) link ??= c;
        else if (c) return plain ? undefined : this.isTextColor(c) ? undefined : c;
        else plain = true;
      }
    }
    return plain ? undefined : link;
  }

  /** A line, arrow or connector (preset `prst`) in a box: its route, flips, arrowheads, dash, color and width. */
  private lineElement(prst: string | undefined, at: Placed, ln: XNode | undefined, style?: XNode): LineElement {
    const kind = /^bentConnector/.test(prst ?? '') ? 'elbow' : /^curvedConnector/.test(prst ?? '') ? 'curved' : 'straight';
    let { x, y, w, h, flipH, flipV } = at;
    if (at.rot) {
      // A turned line is the line between its two ends, each turned about the middle of the box.
      const t = (at.rot * Math.PI) / 180;
      const [cx, cy] = [x + w / 2, y + h / 2];
      const turn = (px: number, py: number) => [cx + (px - cx) * Math.cos(t) - (py - cy) * Math.sin(t), cy + (px - cx) * Math.sin(t) + (py - cy) * Math.cos(t)];
      const a = turn(flipH ? x + w : x, flipV ? y + h : y);
      const b = turn(flipH ? x : x + w, flipV ? y : y + h);
      [x, y, w, h] = [Math.round(Math.min(a[0], b[0])), Math.round(Math.min(a[1], b[1])), Math.round(Math.abs(a[0] - b[0])), Math.round(Math.abs(a[1] - b[1]))];
      flipH = a[0] > b[0] + 0.5;
      flipV = a[1] > b[1] + 0.5;
    }
    const el: LineElement = { id: this.nextId(), type: 'line', kind, x, y, w, h };
    if (kind === 'straight' && !(el.w > 2 && el.h > 2)) {
      // A horizontal or vertical line: the thin side is the stroke, not a size.
      if (el.h > el.w) el.w = 0;
      else el.h = 0;
    }
    // The line starts at the top-left corner of its box (headEnd is there); a flip moves the start to the other side.
    if (flipH && el.w > 0) el.flipH = true;
    if (flipV && el.h > 0) el.flipV = true;
    const head = (end: string): ArrowStyle | undefined => {
      const type = attrs(child(ln, end)).type;
      return !type || type === 'none' ? undefined : ({ triangle: 'triangle', stealth: 'arrow', arrow: 'open', oval: 'circle', diamond: 'diamond' } as Record<string, ArrowStyle>)[type] ?? 'arrow';
    };
    const start = head('a:headEnd');
    const end = head('a:tailEnd');
    if (start) el.startArrow = start;
    if (end) el.endArrow = end;
    const dash = attrs(child(ln, 'a:prstDash')).val;
    if (dash && dash !== 'solid') el.dash = /dot/i.test(dash) && !/dash/i.test(dash) ? 'dot' : 'dash';
    // A line that names no color takes the one its style refers to.
    const refColor = child(ln, 'a:noFill') ? undefined : this.colorNode(child(style, 'a:lnRef'));
    const color = this.solidColor(ln) ?? (refColor === 'none' ? undefined : refColor);
    if (color) el.strokeColor = color;
    const lw = num(attrs(ln).w);
    if (lw !== undefined) el.strokeWidth = Math.max(1, Math.round((lw / EMU_PER_PX) * this.scale));
    return el;
  }

  /** Remember a shape's id from the file so connectors can be attached to it. */
  private remember(id: string | undefined, el: SlideElement | undefined): void {
    if (id && el) this.idMap.set(id, el.id);
  }

  /** Queue the stCxn / endCxn of a connector; connect() attaches them once the whole slide is read. */
  private queueConnections(el: LineElement, cxn: XNode): void {
    const c = child(child(cxn, 'p:nvCxnSpPr'), 'p:cNvCxnSpPr');
    const ref = (tag: string): [string, number] | undefined => {
      const a = attrs(child(c, tag));
      return a.id !== undefined && a.idx !== undefined ? [a.id, Number(a.idx)] : undefined;
    };
    const start = ref('a:stCxn');
    const end = ref('a:endCxn');
    if (start || end) this.pending.push({ el, ...(start ? { start } : {}), ...(end ? { end } : {}) });
  }

  /** Attach queued connector ends to the elements they referred to. */
  private connect(elements: SlideElement[]): void {
    const byId = new Map(elements.map((e) => [e.id, e]));
    for (const { el, start, end } of this.pending) {
      for (const [key, ref] of [['startConnection', start], ['endConnection', end]] as const) {
        const target = ref && byId.get(this.idMap.get(ref[0]) ?? '');
        const site = target && siteOf(target, ref[1]);
        if (target && site) el[key] = { elementId: target.id, site };
      }
    }
    this.pending = [];
  }

  private connector(cxn: XNode, group: GroupTransform | null): SlideElement | null {
    const spPr = child(cxn, 'p:spPr');
    const at = this.placed(child(spPr, 'a:xfrm'), group);
    if (!at) return null;
    const el = this.lineElement(attrs(child(spPr, 'a:prstGeom')).prst, at, child(spPr, 'a:ln'), child(cxn, 'p:style'));
    this.queueConnections(el, cxn);
    return el;
  }

  private async picture(pic: XNode, rels: Rel[], inherit: XNode[], group: GroupTransform | null): Promise<ImageElement | null> {
    // A picture in a placeholder takes its box and its outline from the layout when it has none of its own.
    const ph = path(pic, 'p:nvPicPr', 'p:nvPr', 'p:ph');
    const phShapes = ph ? inherit.map((part) => this.placeholderIn(part, attrs(ph))).filter((n): n is XNode => !!n) : [];
    const spPr = child(pic, 'p:spPr');
    const at = this.placed(child(spPr, 'a:xfrm'), group) ?? (ph ? this.inheritedPlace(attrs(ph), inherit, group) : null);
    if (!at) return null;
    const geomPr = [spPr, ...phShapes.map((n) => child(n, 'p:spPr'))].find((pr) => child(pr, 'a:prstGeom') || child(pr, 'a:custGeom'));
    return this.imageElement(child(pic, 'p:blipFill'), rels, at, geomPr);
  }

  /** The image of a picture fill: cropped to its source rectangle and cut to the outline of its shape. */
  private async imageElement(blipFill: XNode | undefined, rels: Rel[], at: Placed, geomPr: XNode | undefined): Promise<ImageElement | null> {
    const blip = child(blipFill, 'a:blip');
    const target = rels.find((r) => r.id === attrs(blip)['r:embed'])?.target;
    if (!target) {
      this.note('Linked pictures (not stored in the file) were dropped.');
      return null;
    }
    const src = await this.image(target);
    if (!src) return null;
    const el: ImageElement = { id: this.nextId(), type: 'image', ...boxOf(at), src };
    if (at.rot) el.rot = at.rot;
    const sr = attrs(child(blipFill, 'a:srcRect'));
    const side = (v: string | undefined) => Math.max(-10, Math.min(0.99, Math.round(((num(v) ?? 0) / 100000) * 10000) / 10000));
    const crop = { l: side(sr.l), t: side(sr.t), r: side(sr.r), b: side(sr.b) };
    if ((crop.l || crop.t || crop.r || crop.b) && crop.l + crop.r < 1 && crop.t + crop.b < 1) el.crop = crop;
    const prst = attrs(child(geomPr, 'a:prstGeom')).prst;
    const custom = child(geomPr, 'a:custGeom');
    if (prst === 'ellipse') el.clip = 'ellipse(50% 50% at 50% 50%)';
    else if (prst === 'roundRect') el.clip = 'inset(0 round 10%)';
    else if (custom) {
      const outline = customPath(custom, at.flipH, at.flipV, at.w, at.h);
      if (outline && outline.poly.length >= 3) el.clip = `polygon(${outline.poly.map(([x, y]) => `${x}% ${y}%`).join(', ')})`;
    }
    const alpha = num(attrs(child(blip, 'a:alphaModFix')).amt);
    if (alpha !== undefined && alpha < 100000) el.opacity = Math.max(0, Math.round(alpha / 1000) / 100);
    // Duotone redraws the picture from its dark color to its light one; grayscale is the same from black to white.
    const duo = child(blip, 'a:duotone');
    const tones = duo ? kids(duo).map((c) => this.rgba({ 'a:duotone': [c] })).filter((c): c is Rgba => !!c) : [];
    if (tones.length === 2) el.duotone = [cssColor({ ...tones[0], a: 1 }), cssColor({ ...tones[1], a: 1 })];
    else if (child(blip, 'a:grayscl')) el.duotone = ['#000000', '#ffffff'];
    if (kids(blip).some((c) => ['a:biLevel', 'a:clrChange'].includes(tagOf(c)))) this.note('Picture recoloring effects were dropped.');
    return el;
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
}

interface ThemeInfo {
  colors: Record<string, string>;
  fonts: { major?: string; minor?: string };
}

/** Text properties inherited from masters, layouts and list styles (sizes and spacing in PowerPoint's units). */
interface TextDefaults {
  /** Hundredths of a point. */
  size?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  font?: string;
  algn?: string;
  /** Line spacing in thousandths of a percent. */
  lineSpc?: number;
  /** Line spacing as an exact pitch, in hundredths of a point. */
  linePts?: number;
  /** Space before and after a paragraph, in hundredths of a point. */
  spcBef?: number;
  spcAft?: number;
  /** The color of outlined (unfilled) letters. */
  outline?: string;
  caps?: boolean;
  /** Letter spacing in hundredths of a point. */
  spc?: number;
  /** Whether paragraphs are bullets, and the bullet's character, font and color. */
  bullet?: boolean;
  bulletChar?: string;
  bulletFont?: string;
  bulletColor?: string;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A box on our slide with its rotation (degrees clockwise about its center) and mirroring. */
interface Placed extends Box {
  rot: number;
  flipH: boolean;
  flipV: boolean;
}

const boxOf = (p: Placed): Box => ({ x: p.x, y: p.y, w: p.w, h: p.h });

interface GroupTransform {
  parent: GroupTransform | null;
  /** The group's center in its parent's pixels, its rotation in degrees and its mirroring. */
  cx: number;
  cy: number;
  rot: number;
  flipH: boolean;
  flipV: boolean;
  /** A member's box in the group's pixels, in the parent's. */
  apply(b: Box): Box;
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const cssColor = (c: Rgba): string => (c.a >= 1 ? `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}` : `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`);

const PRESET_COLORS: Record<string, string> = { black: '000000', white: 'ffffff', red: 'ff0000', green: '008000', blue: '0000ff', yellow: 'ffff00', gray: '808080', grey: '808080' };

/** Change the saturation and lightness (0 to 1, in HSL) of an RGB color. */
function retone(rgb: number[], change: (sat: number, l: number) => [number, number]): number[] {
  const [r, g, b] = rgb.map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const sat = d === 0 || l === 0 || l === 1 ? 0 : d / (1 - Math.abs(2 * l - 1));
  const hue = d === 0 ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const [ns, nl] = change(sat, l).map((v) => Math.max(0, Math.min(1, v)));
  const c = (1 - Math.abs(2 * nl - 1)) * ns;
  const x = c * (1 - Math.abs((hue % 2) - 1));
  const m = nl - c / 2;
  const [r1, g1, b1] = hue < 1 ? [c, x, 0] : hue < 2 ? [x, c, 0] : hue < 3 ? [0, c, x] : hue < 4 ? [0, x, c] : hue < 5 ? [x, 0, c] : [c, 0, x];
  return [r1, g1, b1].map((v) => (v + m) * 255);
}

/**
 * A freeform's outline (a:custGeom) as SVG path data in a 100×100 box, plus its first figure flattened to points
 * (percentages) for cutting a picture to it. Undefined when the path uses formulas instead of plain coordinates.
 */
function customPath(custGeom: XNode, flipH: boolean, flipV: boolean, boxW: number, boxH: number): { d: string; poly: [number, number][] } | undefined {
  const out: string[] = [];
  const poly: [number, number][] = [];
  let figures = 0;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  for (const p of children(child(custGeom, 'a:pathLst'), 'a:path')) {
    const pw = num(attrs(p).w) || boxW || 1;
    const ph = num(attrs(p).h) || boxH || 1;
    const X = (v: number) => (flipH ? 100 - (v / pw) * 100 : (v / pw) * 100);
    const Y = (v: number) => (flipV ? 100 - (v / ph) * 100 : (v / ph) * 100);
    let cur: [number, number] = [0, 0]; // in path units
    const points = (cmd: XNode): [number, number][] | undefined => {
      const pts = children(cmd, 'a:pt').map((pt) => [num(attrs(pt).x), num(attrs(pt).y)]);
      return pts.every((q) => q[0] !== undefined && q[1] !== undefined) ? (pts as [number, number][]) : undefined;
    };
    const mark = (q: [number, number]) => {
      if (figures === 1) poly.push([r2(X(q[0])), r2(Y(q[1]))]);
    };
    for (const cmd of kids(p)) {
      const tag = tagOf(cmd);
      if (tag === 'a:close') {
        out.push('Z');
        continue;
      }
      if (tag === 'a:arcTo') {
        const a = attrs(cmd);
        const [wR, hR, st, sw] = [num(a.wR), num(a.hR), num(a.stAng), num(a.swAng)];
        if (wR === undefined || hR === undefined || st === undefined || sw === undefined) return undefined;
        const t0 = (st / 60000) * (Math.PI / 180);
        const [ox, oy] = [cur[0] - wR * Math.cos(t0), cur[1] - hR * Math.sin(t0)];
        // In pieces of at most a quarter turn, so a full circle is drawn too.
        const steps = Math.max(1, Math.ceil(Math.abs(sw) / 60000 / 90));
        for (let i = 1; i <= steps; i++) {
          const t = t0 + ((sw / 60000) * (Math.PI / 180) * i) / steps;
          cur = [ox + wR * Math.cos(t), oy + hR * Math.sin(t)];
          const clockwise = sw > 0 !== (flipH !== flipV);
          out.push(`A${r2((wR / pw) * 100)},${r2((hR / ph) * 100)} 0 0 ${clockwise ? 1 : 0} ${r2(X(cur[0]))},${r2(Y(cur[1]))}`);
          mark(cur);
        }
        continue;
      }
      const pts = points(cmd);
      if (!pts) return undefined;
      const xy = pts.map((q) => `${r2(X(q[0]))},${r2(Y(q[1]))}`).join(' ');
      if (tag === 'a:moveTo' && pts.length === 1) {
        figures++;
        out.push(`M${xy}`);
        mark(pts[0]);
      } else if (tag === 'a:lnTo' && pts.length === 1) {
        out.push(`L${xy}`);
        mark(pts[0]);
      } else if ((tag === 'a:cubicBezTo' && pts.length === 3) || (tag === 'a:quadBezTo' && pts.length === 2)) {
        out.push(`${pts.length === 3 ? 'C' : 'Q'}${xy}`);
        // Flattened for the clip outline: points along the curve.
        const ctrl = [cur, ...pts];
        for (let i = 1; i <= 6; i++) {
          const t = i / 6;
          let level = ctrl;
          while (level.length > 1) level = level.slice(1).map((q, k) => [level[k][0] + (q[0] - level[k][0]) * t, level[k][1] + (q[1] - level[k][1]) * t] as [number, number]);
          mark(level[0]);
        }
      } else continue;
      cur = pts[pts.length - 1];
    }
  }
  return out.length ? { d: out.join(' '), poly: poly.slice(0, 400) } : undefined;
}

const CAPS_FONTS = /^(felix titling|trajan( pro)?|castellar|engravers mt|copperplate gothic( bold| light)?|stencil)$/i;
const FONT_WEIGHT = /\s+(Black|Extra ?Bold|Heavy|Bold|Semi ?Bold|Medium|Regular|Light|Extra ?Light|Thin)$/i;

/** Split "Poppins Black" into the family and whether that weight counts as bold. */
function fontOf(typeface: string | undefined): { name?: string; bold: boolean } {
  if (!typeface) return { bold: false };
  const m = FONT_WEIGHT.exec(typeface);
  const name = (m ? typeface.slice(0, m.index) : typeface).trim();
  const weight = m?.[1].toLowerCase().replace(/\s/g, '');
  return { ...(name ? { name } : {}), bold: !!weight && ['black', 'extrabold', 'heavy', 'bold', 'semibold'].includes(weight) };
}

function sameType(a: string | undefined, b: string | undefined): boolean {
  const norm = (t: string | undefined) => (t === 'ctrTitle' ? 'title' : t === 'obj' || t === 'subTitle' || t === undefined ? 'body' : t);
  return norm(a) === norm(b);
}

/** The run whose properties stand for a paragraph: the first one with text that is not a hyperlink, else the first. */
function firstRun(p: XNode | undefined): XNode | undefined {
  const runs = children(p, 'a:r');
  const texts = runs.filter((r) => textOf(child(r, 'a:t')).trim() !== '');
  return texts.find((r) => !child(child(r, 'a:rPr'), 'a:hlinkClick')) ?? texts[0] ?? runs[0] ?? children(p, 'a:fld')[0];
}

/** The text of one paragraph: runs and fields, with line breaks as newlines. */
function paragraphText(p: XNode): string {
  let out = '';
  for (const c of kids(p)) {
    const t = tagOf(c);
    if (t === 'a:r' || t === 'a:fld') out += textOf(child(c, 'a:t'));
    else if (t === 'a:br') out += '\n';
  }
  return out;
}

/** The spreadsheet range a table written by the app is linked to (shared/pptxExport.ts writePptx), if it is. */
function tableSourceOf(frame: XNode): TableElement['source'] {
  const ext = children(path(frame, 'p:nvGraphicFramePr', 'p:nvPr', 'p:extLst'), 'p:ext').find((e) => attrs(e).uri === TABLE_SOURCE_EXT);
  const data = attrs(child(ext, 'ud:tableSource')).data;
  if (!data) return undefined;
  try {
    const source = JSON.parse(decodeURIComponent(data)) as TableElement['source'];
    const probe: TableElement = { id: 'probe', type: 'table', x: 0, y: 0, w: 10, h: 10, rows: [[{ text: '' }]], source };
    return validateElement(probe, 'table') ? undefined : source;
  } catch {
    return undefined;
  }
}

/** Presets that are lines or connectors. */
const LINE_PRESETS = /^(line|straightConnector1|(bent|curved)Connector[2-5])$/;

/** The side of an element that a connection site index of the file means (rectangles: top, left, bottom, right; ellipses have eight). */
function siteOf(el: SlideElement, idx: number): ConnectionSite | undefined {
  const rect: ConnectionSite[] = ['top', 'left', 'bottom', 'right'];
  if (el.type === 'shape' && el.shape === 'ellipse') return rect[idx / 2];
  return rect[idx];
}

function shapeKind(prst: string | undefined, note: (m: string) => void): ShapeElement['shape'] {
  const kind = shapeFromPptx(prst);
  if (kind) return kind;
  note(`Shapes of type "${prst}" were drawn as rectangles.`);
  return 'rect';
}

/**
 * Decks made without placeholders (including our own exports) have only plain text boxes. Treat the largest
 * big text as the title, and a single short line under it as the subtitle, so themes and update_slide apply.
 */
function assignRoles(elements: SlideElement[]): void {
  const texts = elements.filter((e): e is TextElement => e.type === 'text');
  if (texts.some((t) => t.role === 'title')) return;
  // The topmost big text is the title (a big figure further down a slide is not).
  const sized = texts.filter((t) => (t.style?.size ?? 0) >= 28).sort((a, b) => a.y - b.y || (b.style?.size ?? 0) - (a.style?.size ?? 0));
  const title = sized[0];
  if (!title) return;
  title.role = 'title';
  const rest = texts.filter((t) => t !== title);
  const single = rest.filter((t) => {
    const size = t.style?.size ?? 18;
    return t.paragraphs.length === 1 && !t.paragraphs[0].bullet && size >= 16 && size <= 26;
  });
  if (rest.length === 1 && single.length === 1) single[0].role = 'subtitle';
}

/** A layout for the UI's layout picker, from what the slide holds. */
function guessLayout(elements: SlideElement[]): LayoutId {
  const texts = elements.filter((e): e is TextElement => e.type === 'text');
  const title = texts.some((t) => t.role === 'title');
  const subtitle = texts.some((t) => t.role === 'subtitle');
  const bodies = texts.filter((t) => (t.role ?? 'body') === 'body').length;
  const image = elements.some((e) => e.type === 'image');
  if (!elements.length) return 'blank';
  if (title && subtitle && !bodies) return 'title';
  if (title && bodies >= 2) return 'two-column';
  if (title && image && !bodies) return 'image';
  if (title && bodies === 1) return 'title-body';
  if (title && !bodies && !image) return 'section';
  return 'blank';
}

/** Reject anything that is not a reasonably sized .pptx archive. */
async function openArchive(buf: Buffer): Promise<JSZip> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    throw new ImportError('This file is not a valid PowerPoint presentation (.pptx).');
  }
  const entries = Object.values(zip.files);
  if (entries.length > IMPORT_LIMITS.maxZipEntries) throw new ImportError('This presentation contains too many parts to import.');
  let total = 0;
  for (const f of entries) total += (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
  if (total > IMPORT_LIMITS.maxUncompressedBytes) throw new ImportError('This presentation is too large to import.');
  if (!zip.file('ppt/presentation.xml')) throw new ImportError('This file is not a valid PowerPoint presentation (.pptx).');
  return zip;
}

/** True if the bytes look like a .pptx (a zip holding ppt/presentation.xml). */
export async function isPptx(buf: Buffer): Promise<boolean> {
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) return false;
  try {
    const zip = await JSZip.loadAsync(buf);
    return !!zip.file('ppt/presentation.xml');
  } catch {
    return false;
  }
}

export async function importPptx(buf: Buffer, storeImage: ImageSink): Promise<PptxImportResult> {
  const zip = await openArchive(buf);
  const imp = new Importer(zip, storeImage);
  const deck = await imp.run();
  return { deck, warnings: imp.warnings() };
}
