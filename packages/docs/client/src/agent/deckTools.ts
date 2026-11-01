// Deck tools the agent calls, run in the browser against the open presentation's live store, so edits render,
// autosave and undo (as one step per agent request) like the user's own.
import { videoAddress, youtubeId } from '../../../shared/video.ts';
import { MAX_IMAGE_BYTES, MAX_IMAGES_PER_MESSAGE, type AgentImage, type ClientToolCall } from '../../../shared/agent/protocol.ts';
import {
  buildSlide,
  type Deck,
  type Slide,
  deckOutline,
  newId,
  toParagraphs,
  updateSlideContent,
  validateElement,
  type ArrowStyle,
  type ConnectionSite,
  type LayoutId,
  type LineElement,
  type LineKind,
  type ShapeElement,
  type SlideContent,
  type ChartElement,
  type TableCell,
  type TableElement,
  type TableStyle,
  type SlideElement,
  type TextElement,
  type TextStyle,
  type ThemeId,
} from '../../../shared/deck.ts';
import { boxFromEnds, lineEnds, lineFromShape } from '../../../shared/lines.ts';
import { checkCellImage, type StoredFile } from '../../../shared/types.ts';
import { cellsFromTexts, columnCount, normalShares, patchCell, TABLE_ROW_H } from '../../../shared/deckTable.ts';
import { sourceOf, type LinkedTable, type SheetTableRef } from '../../../shared/sheetTable.ts';
import { chartSourceOf, type LinkedChart } from '../../../shared/chart.ts';
import { splitTabRange } from '../../../shared/agent/sheetRead.ts';
import { arcGeometry, arcTightBox, type ArcGeom } from '../../../shared/shapes.ts';
import type { DeckController } from '../deck/controller.ts';
import type { SlideRender } from '../deck/renderSlide.ts';
import { refusedChange, ToolError } from './toolError.ts';
import { TransactionRefused } from '../state/store.ts';
import { appName } from '../brand.ts';

export const DECK_TOOLS: ReadonlySet<string> = new Set(['read_deck', 'add_slides', 'update_slide', 'edit_elements', 'delete_slides', 'move_slide', 'set_deck_theme']);

export interface DeckToolEnv {
  deck: DeckController | null;
  group: string;
}

type Input = Record<string, unknown>;

function requireDeck(env: DeckToolEnv): DeckController {
  if (!env.deck) throw new ToolError('No presentation is open. Use list_decks to find one and open_deck to open it, or create_deck.');
  return env.deck;
}

/** 0-based index of a 1-based slide number, checked against the deck. */
function slideIndex(ctl: DeckController, n: unknown): number {
  const i = Number(n) - 1;
  if (!Number.isInteger(i) || i < 0 || i >= ctl.deck.slides.length) {
    throw new ToolError(`There is no slide ${n}. The presentation has ${ctl.deck.slides.length} slide${ctl.deck.slides.length === 1 ? '' : 's'}.`);
  }
  return i;
}

const spec = (s: Input): SlideContent & { layout?: LayoutId } => ({
  ...(s.layout !== undefined ? { layout: s.layout as LayoutId } : {}),
  ...(typeof s.title === 'string' ? { title: s.title } : {}),
  ...(typeof s.subtitle === 'string' ? { subtitle: s.subtitle } : {}),
  ...(Array.isArray(s.body) ? { body: s.body as string[] } : {}),
  ...(Array.isArray(s.body2) ? { body2: s.body2 as string[] } : {}),
  ...(typeof s.image === 'string' ? { image: s.image } : {}),
  ...(typeof s.caption === 'string' ? { caption: s.caption } : {}),
  ...(typeof s.notes === 'string' ? { notes: s.notes } : {}),
  ...(typeof s.background === 'string' ? { background: s.background } : {}),
});

/**
 * The call with every picture that is at a web address replaced by a stored copy of it (`keep` stores one and
 * returns its /api/images/... address). A picture the assistant found for a slide then belongs to the
 * presentation: it does not break when the site moves it, it draws in render_slide and the PDF, and it never
 * needs to be saved as a file in the user's library to be used.
 */
export async function keepDeckPictures(call: ClientToolCall, keep: (url: string) => Promise<string>): Promise<ClientToolCall> {
  if (call.name !== 'add_slides' && call.name !== 'update_slide' && call.name !== 'edit_elements') return call;
  const kept = new Map<string, string>();
  const stored = async (src: unknown): Promise<unknown> => {
    // A YouTube link is a video's address, not a picture to keep.
    if (typeof src !== 'string' || !/^https?:\/\/\S+$/i.test(src) || youtubeId(src)) return src;
    if (!kept.has(src)) {
      try {
        kept.set(src, await keep(src));
      } catch (e) {
        throw new ToolError(`The picture at ${src} could not be fetched (${e instanceof Error ? e.message : String(e)}) Use another picture, such as another image_search result.`);
      }
    }
    return kept.get(src);
  };
  const each = async (list: unknown, key: 'image' | 'src'): Promise<unknown> => {
    if (!Array.isArray(list)) return list;
    const out: unknown[] = [];
    for (const item of list) out.push(item && typeof item === 'object' && key in item ? { ...item, [key]: await stored((item as Input)[key]) } : item);
    return out;
  };
  const i = call.input;
  if (call.name === 'add_slides') return { ...call, input: { ...i, slides: await each(i.slides, 'image') } };
  if (call.name === 'update_slide') return i.image === undefined ? call : { ...call, input: { ...i, image: await stored(i.image) } };
  return { ...call, input: { ...i, set: await each(i.set, 'src') } };
}

/** Where linkDeckTables puts a range it read, in the element spec it read it for. */
const LINKED = '__linked_table';
/** And a chart. */
const LINKED_CHART = '__linked_chart';

/**
 * The call with every table it links to a spreadsheet range (edit_elements, link: {sheet_id, range}) given the
 * range's cells and source, read with `read` (it throws when the spreadsheet or range is not there). The deck
 * tools themselves do not wait on the network; this runs before them, wherever they run.
 */
export async function linkDeckTables(
  call: ClientToolCall,
  read: (sheetId: string, ref: SheetTableRef) => Promise<LinkedTable>,
  readChart: (sheetId: string, chartId: string) => Promise<LinkedChart> = async () => Promise.reject(new Error('Charts cannot be linked here.')),
): Promise<ClientToolCall> {
  if (call.name !== 'edit_elements' || !Array.isArray(call.input.set)) return call;
  const set: unknown[] = [];
  for (const item of call.input.set as unknown[]) {
    const link = item && typeof item === 'object' ? (item as Input).link : undefined;
    if (!link || typeof link !== 'object') {
      set.push(item);
      continue;
    }
    const { sheet_id, range, chart_id } = link as { sheet_id?: unknown; range?: unknown; chart_id?: unknown };
    if (typeof sheet_id !== 'string' || !sheet_id) throw new ToolError('link needs sheet_id: the id of a spreadsheet (list_sheets).');
    // A chart shows a chart of the spreadsheet; a table, a range of it.
    if ((item as Input).type === 'chart' || typeof chart_id === 'string') {
      if (typeof chart_id !== 'string' || !chart_id) throw new ToolError("A chart's link needs chart_id: one of the spreadsheet's charts (read_other_sheet lists them under each tab's charts).");
      let c: LinkedChart;
      try {
        c = await readChart(sheet_id, chart_id);
      } catch (e) {
        throw new ToolError(`Could not read the chart to link: ${e instanceof Error ? e.message : String(e)}`);
      }
      const { link: _link, ...rest } = item as Input;
      set.push({ ...rest, [LINKED_CHART]: { chart: c.chart, data: c.data, source: chartSourceOf(sheet_id, chart_id, c), w: c.w, h: c.h } });
      continue;
    }
    let table: LinkedTable;
    try {
      table = await read(sheet_id, typeof range === 'string' && range ? { range } : {});
    } catch (e) {
      throw new ToolError(`Could not read the range to link: ${e instanceof Error ? e.message : String(e)}`);
    }
    const { link: _link, ...rest } = item as Input;
    // Without a range the table follows the tab's used part as the data grows.
    set.push({ ...rest, [LINKED]: { rows: table.rows, source: sourceOf(sheet_id, table, !(typeof range === 'string' && splitTabRange(range).range)) } });
  }
  return { ...call, input: { ...call.input, set } };
}

function checkImage(src: unknown): string {
  const problem = checkCellImage(src);
  if (problem) throw new ToolError(`${problem}.`);
  return src as string;
}

/** A line element from an edit_elements spec (x1,y1,x2,y2, kind, dash, arrowheads, connections), merged into the line it changes. */
function applyLineSpec(id: string, prev: LineElement | undefined, s: Input, byId: Map<string, SlideElement>): LineElement {
  const given = (k: string) => (typeof s[k] === 'number' ? (s[k] as number) : undefined);
  const old = prev ? lineEnds(prev) : undefined;
  let ends: { x1: number; y1: number; x2: number; y2: number };
  const hasPoints = ['x1', 'y1', 'x2', 'y2'].some((k) => given(k) !== undefined);
  if (!hasPoints && prev && ['x', 'y', 'w', 'h'].some((k) => given(k) !== undefined)) {
    // Moved or resized by its box: keep the direction.
    const box = { x: given('x') ?? prev.x, y: given('y') ?? prev.y, w: given('w') ?? prev.w, h: given('h') ?? prev.h, flipH: prev.flipH, flipV: prev.flipV };
    ends = lineEnds(box);
  } else {
    const x1 = given('x1') ?? old?.x1 ?? given('x') ?? 80;
    const y1 = given('y1') ?? old?.y1 ?? given('y') ?? 80;
    ends = { x1, y1, x2: given('x2') ?? old?.x2 ?? x1 + (given('w') ?? 200), y2: given('y2') ?? old?.y2 ?? y1 + (given('h') ?? 0) };
  }
  const el: LineElement = { id, type: 'line', kind: (s.kind as LineKind | undefined) ?? prev?.kind ?? 'straight', ...boxFromEnds(ends.x1, ends.y1, ends.x2, ends.y2) };
  const color = s.stroke !== undefined ? s.stroke : prev?.strokeColor;
  const width = s.stroke_width !== undefined ? s.stroke_width : prev?.strokeWidth;
  const dash = (s.dash as LineElement['dash'] | undefined) ?? prev?.dash;
  if (color) el.strokeColor = color as string;
  if (typeof width === 'number') el.strokeWidth = width;
  if (dash && dash !== 'solid') el.dash = dash;
  // `arrow` is the older input: the "arrow" style at the end, the start or both.
  const legacy = s.arrow as string | undefined;
  const start = (s.start_arrow as ArrowStyle | undefined) ?? (legacy ? (legacy === 'start' || legacy === 'both' ? 'arrow' : 'none') : prev?.startArrow);
  const end = (s.end_arrow as ArrowStyle | undefined) ?? (legacy ? (legacy === 'end' || legacy === 'both' ? 'arrow' : 'none') : prev?.endArrow);
  if (start && start !== 'none') el.startArrow = start;
  if (end && end !== 'none') el.endArrow = end;
  if (prev?.bend !== undefined) el.bend = prev.bend;
  for (const [key, input, old] of [
    ['startConnection', s.connect_start, prev?.startConnection],
    ['endConnection', s.connect_end, prev?.endConnection],
  ] as const) {
    const c = input === undefined ? old : input === null ? undefined : { elementId: String((input as Input).element_id), site: (input as Input).site as ConnectionSite };
    if (!c) continue;
    const target = byId.get(c.elementId);
    if (!target || target.type === 'line') throw new ToolError(`Cannot connect to "${c.elementId}": it is not a text, image or shape element on this slide. Use read_deck for the ids.`);
    el[key] = c;
  }
  return el;
}

/** A table from an edit_elements spec (rows, cells, header, banded, col_widths and its text style), merged into the table it changes. */
function applyTableSpec(prev: TableElement | undefined, s: Input): TableElement {
  let rows: TableCell[][] | undefined = prev?.rows;
  const linked = s[LINKED] as { rows: TableCell[][]; source: TableElement['source'] } | undefined;
  const source = linked ? linked.source : s.link === null ? undefined : prev?.source;
  if (s.link && !linked) throw new ToolError('This link was not read. Try again.');
  if (source && (Array.isArray(s.rows) || Array.isArray(s.cells))) {
    throw new ToolError(`The table shows the spreadsheet range ${source.tab}!${source.range}, so its cells cannot be changed here: change the spreadsheet, link another range, or pass link: null to unlink it first.`);
  }
  if (linked) rows = linked.rows;
  if (Array.isArray(s.rows)) {
    const texts = (s.rows as unknown[][]).map((r) => r.map((t) => String(t ?? '')));
    if (!texts.length) throw new ToolError('A table needs at least one row.');
    // The new texts keep the look of the cells they land on.
    rows = cellsFromTexts(texts).map((row, r) => row.map((cell, c) => ({ ...prev?.rows[r]?.[c], text: cell.text })));
  }
  if (!rows) throw new ToolError('A new table needs rows (the text of its cells, row by row) or link (a spreadsheet range to show).');
  if (Array.isArray(s.cells)) {
    rows = rows.map((row) => [...row]);
    for (const spec of s.cells as Input[]) {
      const r = Number(spec.row) - 1;
      const c = Number(spec.col) - 1;
      if (!rows[r]?.[c]) throw new ToolError(`There is no cell at row ${spec.row}, column ${spec.col}: the table has ${rows.length} rows and ${rows[0].length} columns.`);
      const patch: Partial<TableCell> = {};
      for (const k of ['text', 'bold', 'italic', 'color', 'fill', 'align'] as const) if (spec[k] !== undefined) (patch as Record<string, unknown>)[k] = spec[k];
      rows[r][c] = patchCell(rows[r][c], patch);
    }
  }
  const n = rows[0].length;
  const box = {
    x: typeof s.x === 'number' ? s.x : (prev?.x ?? 80),
    y: typeof s.y === 'number' ? s.y : (prev?.y ?? 80),
    w: typeof s.w === 'number' ? s.w : (prev?.w ?? Math.min(800, n * 160)),
    // A table that gains or loses rows keeps its rows' height unless a height is given.
    h: typeof s.h === 'number' ? s.h : prev ? Math.round((prev.h / prev.rows.length) * rows.length) : rows.length * TABLE_ROW_H,
  };
  const el: TableElement = { id: prev?.id ?? newId(), type: 'table', ...box, rows, ...(source ? { source } : {}) };
  const header = s.header !== undefined ? !!s.header : prev ? !!prev.header : true;
  const banded = s.banded !== undefined ? !!s.banded : !!prev?.banded;
  if (header) el.header = true;
  if (banded) el.banded = true;
  if (Array.isArray(s.col_widths)) {
    const widths = s.col_widths as number[];
    if (widths.length && widths.length !== n) throw new ToolError(`col_widths needs ${n} widths, one per column (or [] for equal columns).`);
    const cols = widths.length ? normalShares(widths) : undefined;
    if (cols) el.cols = cols;
  } else if (prev?.cols && columnCount(prev) === n) el.cols = prev.cols;
  const style: Record<string, unknown> = { ...prev?.style };
  const set = (k: keyof TableStyle, v: unknown) => {
    if (v === undefined) return;
    if (v === '') delete style[k];
    else style[k] = v;
  };
  set('size', s.size);
  set('font', s.font);
  set('color', s.color);
  set('border', s.stroke);
  set('headerFill', s.header_fill);
  if (Object.keys(style).length) el.style = style as TableStyle;
  return el;
}

/** A slide chart from an edit_elements spec: one shows a spreadsheet's chart (link), and is moved, resized or unlinked here. */
function applyChartSpec(prev: ChartElement | undefined, s: Input): ChartElement {
  const linked = s[LINKED_CHART] as { chart: ChartElement['chart']; data: ChartElement['data']; source: ChartElement['source']; w: number; h: number } | undefined;
  if (s.link && !linked) throw new ToolError('This link was not read. Try again.');
  if (!prev && !linked) throw new ToolError('A new chart needs link: {sheet_id, chart_id}, a chart of a spreadsheet (make one there with add_chart first).');
  const scale = linked ? Math.min(1, 800 / Math.max(1, linked.w), 440 / Math.max(1, linked.h)) : 1;
  const w = typeof s.w === 'number' ? s.w : (prev?.w ?? Math.round((linked?.w ?? 600) * scale));
  const h = typeof s.h === 'number' ? s.h : (prev?.h ?? Math.round((linked?.h ?? 371) * scale));
  const el: ChartElement = {
    id: prev?.id ?? newId(),
    type: 'chart',
    x: typeof s.x === 'number' ? s.x : (prev?.x ?? Math.round((960 - w) / 2)),
    y: typeof s.y === 'number' ? s.y : (prev?.y ?? Math.round((540 - h) / 2)),
    w,
    h,
    chart: linked?.chart ?? prev!.chart,
    data: linked?.data ?? prev!.data,
  };
  const source = linked ? linked.source : s.link === null ? undefined : prev?.source;
  if (source) el.source = source;
  return el;
}

/** Merge an element spec from edit_elements into an existing element, or build a new one. */
function applyElementSpec(existing: SlideElement | undefined, s: Input, byId: Map<string, SlideElement> = new Map()): SlideElement {
  if (existing?.type === 'shape' && existing.shape === 'line') existing = lineFromShape(existing);
  if (s.type === 'shape' && s.shape === 'line') s = { ...s, type: 'line' };
  const type = (s.type ?? existing?.type) as SlideElement['type'] | undefined;
  if (type === 'line') {
    if (existing && existing.type !== 'line') throw new ToolError(`Element ${existing.id} is a ${existing.type}; its type cannot change. Remove it and add a new one.`);
    return applyLineSpec(existing?.id ?? newId(), existing as LineElement | undefined, s, byId);
  }
  if (existing?.type === 'line') throw new ToolError(`Element ${existing.id} is a line; its type cannot change. Remove it and add a new one.`);
  if (!type) throw new ToolError('A new element needs a type: text, image, video, shape, line or table.');
  if (existing && s.type && s.type !== existing.type) throw new ToolError(`Element ${existing.id} is a ${existing.type}; its type cannot change. Remove it and add a new one.`);
  if (type === 'table') return applyTableSpec(existing as TableElement | undefined, s);
  if (type === 'chart') return applyChartSpec(existing as ChartElement | undefined, s);
  const box = {
    x: typeof s.x === 'number' ? s.x : (existing?.x ?? 80),
    y: typeof s.y === 'number' ? s.y : (existing?.y ?? 80),
    w: typeof s.w === 'number' ? s.w : (existing?.w ?? (type === 'text' ? 400 : type === 'image' || type === 'video' ? 320 : 200)),
    h: typeof s.h === 'number' ? s.h : (existing?.h ?? (type === 'text' ? 80 : type === 'image' || type === 'video' ? 180 : 120)),
  };
  const id = existing?.id ?? newId();
  if (type === 'text') {
    const prev = existing as TextElement | undefined;
    const style: Record<string, unknown> = { ...prev?.style };
    const set = (k: keyof TextStyle, v: unknown) => {
      if (v === undefined) return;
      if (v === '' || v === false) delete style[k];
      else style[k] = v;
    };
    set('size', s.size);
    set('bold', s.bold);
    set('italic', s.italic);
    set('color', s.color);
    set('align', s.align);
    set('valign', s.valign);
    set('font', s.font);
    set('lineHeight', s.line_height);
    const role = (s.role as TextElement['role']) ?? prev?.role;
    const paragraphs = typeof s.text === 'string' ? toParagraphs(s.text.split('\n')) : (prev?.paragraphs ?? [{ text: '' }]);
    const el: TextElement = { id, type: 'text', ...box, paragraphs, ...(role ? { role } : {}), ...(Object.keys(style).length ? { style: style as TextStyle } : {}) };
    return el;
  }
  if (type === 'image') {
    const prev = existing?.type === 'image' ? existing : undefined;
    const src = s.src !== undefined ? checkImage(s.src) : prev?.src;
    if (!src) throw new ToolError('An image element needs src.');
    const fit = (s.fit as 'contain' | 'cover' | undefined) ?? prev?.fit;
    return { id, type: 'image', ...box, src, ...(fit ? { fit } : {}) };
  }
  if (type === 'video') {
    const prev = existing?.type === 'video' ? existing : undefined;
    const src = s.src !== undefined ? (typeof s.src === 'string' ? videoAddress(s.src) : null) : prev?.src;
    if (!src) throw new ToolError('A video element needs src: a YouTube link, or the /api/files/... address of a video among the stored files (list_files).');
    return { id, type: 'video', ...box, src };
  }
  const prev = existing?.type === 'shape' ? existing : undefined;
  const shape = (s.shape as ShapeElement['shape'] | undefined) ?? prev?.shape ?? 'rect';
  const el: ShapeElement = { id, type: 'shape', shape, ...box };
  const fill = s.fill !== undefined ? s.fill : prev?.fill;
  const stroke = s.stroke !== undefined ? s.stroke : prev?.stroke;
  const strokeWidth = s.stroke_width !== undefined ? s.stroke_width : prev?.strokeWidth;
  const text = s.text !== undefined ? s.text : prev?.text;
  const textColor = s.color !== undefined ? s.color : prev?.textColor;
  if (fill) el.fill = fill as string;
  if (stroke) el.stroke = stroke as string;
  if (typeof strokeWidth === 'number') el.strokeWidth = strokeWidth;
  const startAngle = s.start_angle !== undefined ? s.start_angle : prev?.startAngle;
  const endAngle = s.end_angle !== undefined ? s.end_angle : prev?.endAngle;
  if (shape === 'arc' && typeof startAngle === 'number') el.startAngle = startAngle;
  if (shape === 'arc' && typeof endAngle === 'number') el.endAngle = endAngle;
  const arrow = s.arrow !== undefined ? s.arrow : prev?.arrow;
  if (arrow && arrow !== 'none') el.arrow = arrow as ShapeElement['arrow'];
  if (prev?.flip) el.flip = true;
  if (shape === 'arc') {
    // x/y/w/h are the arc's own bounding box. Give cx/cy/rx/ry instead to place it by its ellipse; changing only
    // the angles or stroke of an existing arc keeps its ellipse.
    const sw = el.strokeWidth ?? 2;
    const a = el.startAngle ?? 270;
    const b = el.endAngle ?? 0;
    const has = (k: string) => typeof s[k] === 'number';
    const boxGiven = ['x', 'y', 'w', 'h'].some(has);
    let g: ArcGeom | undefined;
    if (['cx', 'cy', 'rx', 'ry', 'radius'].some(has)) {
      const old = prev ? arcGeometry(prev) : { cx: 480, cy: 270, rx: 100, ry: 100 };
      const radius = typeof s.radius === 'number' ? s.radius : undefined;
      g = {
        cx: has('cx') ? (s.cx as number) : old.cx,
        cy: has('cy') ? (s.cy as number) : old.cy,
        rx: has('rx') ? (s.rx as number) : (radius ?? old.rx),
        ry: has('ry') ? (s.ry as number) : (radius ?? (has('rx') ? (s.rx as number) : old.ry)),
      };
    } else if (prev && !boxGiven) g = arcGeometry(prev);
    if (g) Object.assign(el, arcTightBox(g, a, b, sw));
    el.tight = true;
  }
  if (text) el.text = text as string;
  if (textColor) el.textColor = textColor as string;
  // Label style; "" or false clears a property, as for text elements.
  const label = <T,>(v: unknown, old: T | undefined): T | undefined => (v === undefined ? old : v === '' || v === false ? undefined : (v as T));
  const textSize = label<number>(s.size, prev?.textSize);
  const textFont = label<string>(s.font, prev?.textFont);
  if (textSize !== undefined) el.textSize = textSize;
  if (textFont) el.textFont = textFont;
  if (label<boolean>(s.bold, prev?.textBold)) el.textBold = true;
  if (label<boolean>(s.italic, prev?.textItalic)) el.textItalic = true;
  return el;
}

export interface RenderSlideEnv {
  deck: DeckController | null;
  /** Id of the open presentation. */
  deckId?: string | null;
  /** Load a saved presentation by id. */
  loadDeck?(id: string): Promise<Deck>;
  /** Draw a slide with the app's renderer (client/src/deck/renderSlide.ts). */
  renderSlide?(slide: Slide, theme: ThemeId, scale: number): Promise<SlideRender>;
  uploadImage(file: Blob): Promise<string>;
  /** Title of the open presentation. */
  deckTitle?: string | null;
  /** Title of a saved presentation by id. */
  loadDeckTitle?(id: string): Promise<string>;
  /** Assemble a PDF of every slide (client/src/deck/pdf.ts). */
  makePdf?(deck: Deck): Promise<Blob>;
  /** Store a file on the server (the chat shows it as a file button). */
  uploadFile?(name: string, file: Blob): Promise<StoredFile>;
  /** Attach a picture to the message that carries the tool results back to Claude; false if no room is left. */
  attachImage?(image: AgentImage): boolean;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let k = 0; k < bytes.length; k += 0x8000) bin += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
  return btoa(bin);
}

/** render_slide: a PNG of a slide as the app draws it, attached for Claude to look at, plus overflowing text. */
export async function renderSlideTool(call: ClientToolCall, env: RenderSlideEnv): Promise<string> {
  const i = call.input;
  if (!env.renderSlide || !env.attachImage) throw new ToolError('Rendering slides is not available here.');
  const deckId = typeof i.deck_id === 'string' && i.deck_id ? i.deck_id : null;
  let deck: Deck;
  if (env.deck && (!deckId || deckId === env.deckId)) deck = env.deck.deck;
  else if (deckId) {
    if (!env.loadDeck) throw new ToolError('Only the open presentation can be rendered here.');
    try {
      deck = await env.loadDeck(deckId);
    } catch {
      throw new ToolError(`No presentation with id "${deckId}". Use list_decks to find ids.`);
    }
  } else throw new ToolError('No presentation is open. Pass deck_id, or open one with open_deck.');
  const n = Number(i.slide);
  if (!Number.isInteger(n) || n < 1 || n > deck.slides.length) {
    throw new ToolError(`There is no slide ${i.slide}. The presentation has ${deck.slides.length} slide${deck.slides.length === 1 ? '' : 's'}.`);
  }
  const scale = typeof i.scale === 'number' ? i.scale : 1;
  const r = await env.renderSlide(deck.slides[n - 1], deck.theme, scale);
  if (r.blob.size > MAX_IMAGE_BYTES) throw new ToolError(`The image is too large (${Math.round(r.blob.size / 1e6)} MB). Use a smaller scale.`);
  let url: string | null = null;
  try {
    url = await env.uploadImage(r.blob);
  } catch {
    // The picture is still attached; only the stored address is missing.
  }
  const attached = env.attachImage({ mediaType: 'image/png', data: await blobToBase64(r.blob), ...(url ? { url } : {}) });
  return JSON.stringify({
    slide: n,
    width: r.width,
    height: r.height,
    ...(url ? { image_url: url } : {}),
    image: attached
      ? 'Attached to this message after the tool results, labeled render_slide. Look at it before reporting back.'
      : `Not attached: at most ${MAX_IMAGES_PER_MESSAGE} pictures fit in one message. Call render_slide again for this slide.`,
    overflow: r.overflow,
    ...(r.missingImages.length ? { images_not_rendered: r.missingImages } : {}),
  });
}

/** export_deck: download the deck as a PDF, one slide per page. */
export async function exportDeckTool(call: ClientToolCall, env: RenderSlideEnv): Promise<string> {
  const i = call.input;
  if (!env.makePdf || !env.uploadFile) throw new ToolError('Exporting presentations is not available here.');
  const deckId = typeof i.deck_id === 'string' && i.deck_id ? i.deck_id : null;
  let deck: Deck;
  let title: string;
  if (env.deck && (!deckId || deckId === env.deckId)) {
    deck = env.deck.deck;
    title = env.deckTitle ?? 'Presentation';
  } else if (deckId) {
    if (!env.loadDeck) throw new ToolError('Only the open presentation can be exported here.');
    try {
      deck = await env.loadDeck(deckId);
      title = (await env.loadDeckTitle?.(deckId)) ?? 'Presentation';
    } catch {
      throw new ToolError(`No presentation with id "${deckId}". Use list_decks to find ids.`);
    }
  } else throw new ToolError('No presentation is open. Pass deck_id, or open one with open_deck.');
  const pdf = await env.makePdf(deck);
  const base = title.replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '') || 'Presentation';
  const filename = `${base}.pdf`;
  const file = await env.uploadFile(filename, pdf.type ? pdf : new Blob([pdf], { type: 'application/pdf' }));
  return JSON.stringify({
    file_id: file.id,
    filename,
    pages: deck.slides.length,
    url: file.url,
    download_url: file.downloadUrl,
    note: 'The PDF is stored and shown in the chat as a file button; clicking it opens a preview tab with a Download button.',
  });
}

/** A question to ask before a destructive deck call, or null. */
export function deckConfirmationFor(call: ClientToolCall, deck: DeckController | null): string | null {
  if (call.name !== 'delete_slides' || !deck) return null;
  const nums = (call.input.slides as number[]).filter((n) => n >= 1 && n <= deck.deck.slides.length);
  if (!nums.length) return null;
  return nums.length === 1 ? `Delete slide ${nums[0]}?` : `Delete ${nums.length} slides (${nums.join(', ')})?`;
}

export function runDeckTool(call: ClientToolCall, env: DeckToolEnv): string {
  const i = call.input;
  const ctl = requireDeck(env);
  const run = (fn: Parameters<DeckController['runAgent']>[1]) => {
    try {
      return ctl.runAgent(env.group, fn);
    } catch (e) {
      if (e instanceof TransactionRefused) throw refusedChange(e.message, 'PowerPoint', `${appName()} presentation`);
      throw e;
    }
  };

  switch (call.name) {
    case 'read_deck':
      return JSON.stringify({ ...deckOutline(ctl.deck, ctl.current), ...(ctl.selection.length ? { selected_elements: ctl.selection } : {}) });

    case 'add_slides': {
      const specs = (i.slides as Input[]).map(spec);
      for (const s of specs) if (s.image) checkImage(s.image);
      const at = i.at === undefined ? ctl.deck.slides.length : slideIndex(ctl, i.at);
      const slides = specs.map((s) => buildSlide(s.layout ?? 'title-body', s, newId));
      run((tx) => slides.forEach((s, k) => tx.insertSlide(at + k, s)));
      ctl.goTo(at + slides.length - 1);
      return JSON.stringify({ added_slides: slides.map((_, k) => at + k + 1), slide_count: ctl.deck.slides.length });
    }

    case 'update_slide': {
      const index = slideIndex(ctl, i.slide);
      const content = spec(i);
      if (content.image) checkImage(content.image);
      if (!Object.keys(content).length) throw new ToolError('Pass at least one property to change (title, body, notes, layout, ...).');
      run((tx) => tx.updateSlide(index, (s) => updateSlideContent(s, content, newId)));
      ctl.goTo(index);
      return JSON.stringify({ updated_slide: index + 1, changed: Object.keys(content) });
    }

    case 'edit_elements': {
      const index = slideIndex(ctl, i.slide);
      const sets = (i.set as Input[] | undefined) ?? [];
      const removes = new Set((i.remove as string[] | undefined) ?? []);
      if (!sets.length && !removes.size) throw new ToolError('Pass elements to set and/or ids to remove.');
      const slide = ctl.deck.slides[index];
      const byId = new Map(slide.elements.map((e) => [e.id, e]));
      for (const id of removes) if (!byId.has(id)) throw new ToolError(`Slide ${index + 1} has no element "${id}". Use read_deck for the ids.`);
      const changed: SlideElement[] = [];
      for (const s of sets) {
        const existing = typeof s.id === 'string' ? byId.get(s.id) : undefined;
        if (typeof s.id === 'string' && !existing) throw new ToolError(`Slide ${index + 1} has no element "${s.id}". Omit id to add a new element.`);
        const el = applyElementSpec(existing, s, byId);
        const problem = validateElement(el, `slide ${index + 1}`);
        if (problem) throw new ToolError(problem);
        changed.push(el);
      }
      run((tx) =>
        tx.updateSlide(index, (s) => {
          let elements = s.elements.filter((e) => !removes.has(e.id));
          for (const el of changed) {
            const k = elements.findIndex((e) => e.id === el.id);
            if (k >= 0) elements = elements.map((e, j) => (j === k ? el : e));
            else elements = [...elements, el];
          }
          return { ...s, elements };
        }),
      );
      ctl.goTo(index);
      ctl.select(changed.map((e) => e.id));
      // Connected lines were moved to their shapes' sides when the slide was updated: report them as stored.
      const stored = new Map(ctl.deck.slides[index].elements.map((e) => [e.id, e]));
      return JSON.stringify({
        slide: index + 1,
        set: changed.map((c) => {
          const e = stored.get(c.id) ?? c;
          return e.type === 'line' ? { id: e.id, type: e.type, ...lineEnds(e) } : { id: e.id, type: e.type, x: e.x, y: e.y, w: e.w, h: e.h };
        }),
        removed: [...removes],
      });
    }

    case 'delete_slides': {
      const indices = [...new Set((i.slides as number[]).map((n) => slideIndex(ctl, n)))];
      if (indices.length >= ctl.deck.slides.length) throw new ToolError('Cannot delete every slide; a presentation keeps at least one.');
      const n = ctl.deleteSlidesAgent(env.group, indices);
      return JSON.stringify({ deleted: n, slide_count: ctl.deck.slides.length });
    }

    case 'move_slide': {
      const from = slideIndex(ctl, i.slide);
      const to = slideIndex(ctl, i.to);
      run((tx) => tx.moveSlide(from, to));
      ctl.goTo(to);
      return JSON.stringify({ moved_slide: from + 1, to: to + 1 });
    }

    case 'set_deck_theme': {
      run((tx) => tx.setTheme(i.theme as ThemeId));
      return JSON.stringify({ theme: ctl.deck.theme });
    }

    default:
      throw new ToolError(`Unknown tool ${call.name}.`);
  }
}
