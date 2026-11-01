// Slide deck file format (stored as one JSON file per deck on the server, next to spreadsheets).
//
// A slide is a fixed 960×540 point canvas (PowerPoint's default 16:9 size, so an export maps 1:1) with
// absolutely positioned elements. Elements are text boxes (paragraphs with per-paragraph bullets), images
// (same storage as cell images), videos, shapes, lines and tables. Slides are usually built from a layout: a handful of
// named arrangements (title, title + body, two columns, ...) that turn plain content into positioned
// elements, so both the UI and the assistant can make slides without choosing coordinates.
import { safeLinkUrl } from './links.ts';
import { SHAPE_KINDS, tightArc, type ShapeKind } from './shapes.ts';
import { checkCellImage } from './types.ts';
import { checkVideo } from './video.ts';
import { lineEnds } from './lines.ts';
import { tableOutline } from './deckTable.ts';
import { validateChartElement, chartElementOutline, type ChartData, type SlideChart } from './chart.ts';

export type { ShapeKind };

export const SLIDE_W = 960;
export const SLIDE_H = 540;

export const THEME_IDS = ['light', 'dark', 'ocean', 'forest', 'sunset', 'paper'] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export const LAYOUT_IDS = ['title', 'section', 'title-body', 'two-column', 'image', 'blank'] as const;
export type LayoutId = (typeof LAYOUT_IDS)[number];

export type TextRole = 'title' | 'subtitle' | 'body' | 'caption';

export interface TextStyle {
  /** Font size in points; defaults depend on the role. */
  size?: number;
  bold?: boolean;
  italic?: boolean;
  /** CSS color; defaults to the theme's text (or heading) color. */
  color?: string;
  align?: 'left' | 'center' | 'right';
  valign?: 'top' | 'middle' | 'bottom';
  /** Font family name (e.g. "Inter"); the theme font is the fallback. */
  font?: string;
  /** Line height as a multiple of the font size. Defaults to 1.25. */
  lineHeight?: number;
  /** Space between paragraphs in points. Defaults to 0.3 × the font size. */
  paraSpacing?: number;
  /** Draw the letters as an outline in this CSS color, with no fill. */
  outline?: string;
  /** Show the text in capitals. */
  caps?: boolean;
  /** Extra space between letters in points. */
  spacing?: number;
  /** The bullet character (default "•") and its CSS color (default: the theme accent). */
  bulletChar?: string;
  bulletColor?: string;
}

/** A styled span inside a paragraph: a hyperlink, or a few words in another weight or color. */
export interface TextRun {
  text: string;
  /** An http(s) or mailto URL; the run is drawn as a link. */
  link?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
}

export interface Paragraph {
  text: string;
  /** Styled spans of the text (links, say); their texts join to `text`. Plain paragraphs have none. */
  runs?: TextRun[];
  bullet?: boolean;
  /** Indent level for bullets, 0 to 4. */
  level?: number;
  /** Overrides of the element's text style for this paragraph (a big number over a small caption, say). */
  size?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  font?: string;
}

interface ElementBase {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Rotation about the center of the box, in degrees clockwise. */
  rot?: number;
}

export interface TextElement extends ElementBase {
  type: 'text';
  /** What the text box is for; the theme picks the default font, size and color from it. */
  role?: TextRole;
  paragraphs: Paragraph[];
  style?: TextStyle;
}

export interface ImageElement extends ElementBase {
  type: 'image';
  /** Same addresses as cell images: /api/images/<id>, a data:image URL or an http(s) URL. */
  src: string;
  /** How the image fills the box. Defaults to contain. */
  fit?: 'contain' | 'cover';
  /**
   * The part of the picture to show, as the fraction cut from each side (negative values add a margin). A
   * cropped picture is stretched to its box.
   */
  crop?: { l: number; t: number; r: number; b: number };
  /** A CSS clip-path basic shape (ellipse(), circle(), inset() or polygon() in percentages) the picture is cut to. */
  clip?: string;
  /** 0 (invisible) to 1 (opaque, the default). */
  opacity?: number;
  /** Redraw the picture in two colors: its darkest tones in the first (#rrggbb), its lightest in the second. */
  duotone?: [string, string];
}

/** A video that plays in its box: in the show, and in the editor after a double-click. */
export interface VideoElement extends ElementBase {
  type: 'video';
  /** A stored video file (/api/files/<id>) or a YouTube video's watch address (shared/video.ts). */
  src: string;
}

export interface ShapeElement extends ElementBase {
  type: 'shape';
  /**
   * A line runs across its box: horizontal when h is 0, vertical when w is 0, and diagonal (top-left to
   * bottom-right) when both are set; `flip` makes a diagonal run bottom-left to top-right.
   */
  shape: ShapeKind;
  /** Lines: arrowheads at the end (the right, or the bottom of a vertical line), the start, or both. */
  arrow?: 'start' | 'end' | 'both';
  flip?: boolean;
  /**
   * Fill color (any CSS color, including rgba() for translucency); defaults to the theme accent. "none" for no fill.
   * Rectangles, rounded rectangles and ellipses also take a CSS linear-gradient() or radial-gradient().
   */
  fill?: string;
  /**
   * A freeform outline drawn instead of the shape: SVG path data in a 100×100 box that is stretched to the
   * element's size.
   */
  path?: string;
  stroke?: string;
  strokeWidth?: number;
  /** Arc shapes: start and end angle in degrees, clockwise from 3 o'clock. Default 270 and 0 (the top-right quarter). */
  startAngle?: number;
  endAngle?: number;
  /** Arc shapes: the box tightly bounds the arc stroke (the ellipse is derived from box, angles and stroke width). Absent on old arcs whose box is the whole ellipse. */
  tight?: boolean;
  /** Optional label centered in the shape. */
  text?: string;
  textColor?: string;
  /** Label font size in points. Defaults to 18. */
  textSize?: number;
  textBold?: boolean;
  textItalic?: boolean;
  /** Label font family (e.g. "Inter"); the theme body font is the fallback. */
  textFont?: string;
}

export const ARROW_STYLE_IDS = ['none', 'arrow', 'open', 'triangle', 'circle', 'diamond'] as const;
export type ArrowStyle = (typeof ARROW_STYLE_IDS)[number];
export type LineKind = 'straight' | 'elbow' | 'curved';
export type ConnectionSite = 'top' | 'right' | 'bottom' | 'left';

export interface LineConnection {
  /** The shape (or text box or image) the end is attached to. */
  elementId: string;
  /** The middle of one side of it. */
  site: ConnectionSite;
}

/**
 * A line, arrow or connector from one point to another (see shared/lines.ts). x, y, w, h is the box around its two
 * ends; it starts at the top-left corner, or the top-right with flipH, the bottom-left with flipV, and ends at the
 * opposite corner. Ends with a connection follow that element when it moves or resizes.
 */
export interface LineElement extends ElementBase {
  type: 'line';
  kind: LineKind;
  flipH?: boolean;
  flipV?: boolean;
  /** CSS color; defaults to the theme accent. */
  strokeColor?: string;
  /** Defaults to 3. */
  strokeWidth?: number;
  dash?: 'solid' | 'dash' | 'dot';
  startArrow?: ArrowStyle;
  endArrow?: ArrowStyle;
  startConnection?: LineConnection;
  endConnection?: LineConnection;
  /** Elbow connectors: where the middle segment sits between the ends, 0 to 1 (default 0.5). */
  bend?: number;
}

/** A table cell: its text (lines separated by "\n") and how it differs from the table's own look. */
export interface TableCell {
  text: string;
  bold?: boolean;
  italic?: boolean;
  /** CSS color of the text. */
  color?: string;
  /** Background CSS color. */
  fill?: string;
  align?: 'left' | 'center' | 'right';
}

export interface TableStyle {
  /** Font size in points. Defaults to 16. */
  size?: number;
  /** Font family name (e.g. "Inter"); the theme body font is the fallback. */
  font?: string;
  /** CSS color of the text; defaults to the theme text color. */
  color?: string;
  /** CSS color of the cell borders, or "none"; defaults to a tint of the theme's muted color. */
  border?: string;
  /** Background of the header row; defaults to the theme accent. */
  headerFill?: string;
}

/** The spreadsheet range a linked table shows (shared/sheetTable.ts reads it). */
export interface TableSource {
  /** The spreadsheet's id, and its title when the table was last refreshed (for showing). */
  sheet: string;
  title?: string;
  /** The tab, by id (which survives renaming) and by name (when the id is no longer found). */
  tabId: string;
  tab: string;
  /** The range in A1 notation, e.g. "A1:D8": the one read last when `used` is set. */
  range: string;
  /** Follow the used part of the tab (it grows and shrinks with the data) rather than a fixed range. */
  used?: boolean;
  /** The spreadsheet's revision the cells were read from. */
  rev?: string;
}

/**
 * A table of text cells (shared/deckTable.ts has its operations and colors). The rows share the box's height
 * evenly (a row with more text than fits grows, as in PowerPoint) and the columns its width by `cols`.
 */
export interface TableElement extends ElementBase {
  type: 'table';
  /** Rows of cells, every row as long as the first. */
  rows: TableCell[][];
  /** Column widths as shares of the box width, adding up to 1. Absent: equal columns. */
  cols?: number[];
  /** The first row is a header: bold, on the header fill. */
  header?: boolean;
  /** Every other row below the header is shaded. */
  banded?: boolean;
  style?: TableStyle;
  /**
   * Linked to a spreadsheet range: the cells are the range's values and look as last read, refreshed while the
   * presentation is open, and are not edited on the slide.
   */
  source?: TableSource;
}

/** The spreadsheet chart a slide chart shows (shared/chart.ts): the spreadsheet, its tab and the chart's id. */
export interface ChartSource {
  sheet: string;
  title?: string;
  tabId: string;
  tab: string;
  chart: string;
  /** The spreadsheet's revision the chart was read from. */
  rev?: string;
}

/**
 * A chart on a slide: how it looks (a spreadsheet chart's type, titles, legend and axes, without its place)
 * and the data it shows, as read last. Linked to a spreadsheet's chart, it is read again as the spreadsheet
 * changes (client/src/deck/linkedTables.ts); without a source (from a PowerPoint file, say) it keeps its data.
 */
export interface ChartElement extends ElementBase {
  type: 'chart';
  chart: SlideChart;
  data: ChartData;
  source?: ChartSource;
}

export type SlideElement = TextElement | ImageElement | VideoElement | ShapeElement | LineElement | TableElement | ChartElement;

export interface Slide {
  id: string;
  /** Layout the slide was built from, for the UI's "layout" picker. */
  layout?: LayoutId;
  /** Background color (or a CSS gradient); defaults to the theme background. */
  bg?: string;
  /** Speaker notes. */
  notes?: string;
  /** In drawing order (last is on top). */
  elements: SlideElement[];
}

export interface Deck {
  version: 1;
  theme: ThemeId;
  slides: Slide[];
}

// ---------------------------------------------------------------------------
// Themes

export interface Theme {
  id: ThemeId;
  name: string;
  bg: string;
  text: string;
  heading: string;
  muted: string;
  accent: string;
  headingFont: string;
  bodyFont: string;
}

export const THEMES: Record<ThemeId, Theme> = {
  light: {
    id: 'light',
    name: 'Light',
    bg: '#ffffff',
    text: '#1f1f1f',
    heading: '#1f1f1f',
    muted: '#5f6368',
    accent: '#1a73e8',
    headingFont: "'Google Sans', Roboto, -apple-system, 'Segoe UI', Arial, sans-serif",
    bodyFont: "Roboto, -apple-system, 'Segoe UI', Arial, sans-serif",
  },
  dark: {
    id: 'dark',
    name: 'Dark',
    bg: '#1b1b1f',
    text: '#e8eaed',
    heading: '#ffffff',
    muted: '#9aa0a6',
    accent: '#8ab4f8',
    headingFont: "'Google Sans', Roboto, -apple-system, 'Segoe UI', Arial, sans-serif",
    bodyFont: "Roboto, -apple-system, 'Segoe UI', Arial, sans-serif",
  },
  ocean: {
    id: 'ocean',
    name: 'Ocean',
    bg: '#0b2545',
    text: '#e0e7f1',
    heading: '#ffffff',
    muted: '#8da9c4',
    accent: '#13a3b5',
    headingFont: "Georgia, 'Times New Roman', serif",
    bodyFont: "Roboto, -apple-system, 'Segoe UI', Arial, sans-serif",
  },
  forest: {
    id: 'forest',
    name: 'Forest',
    bg: '#f4f7f2',
    text: '#243126',
    heading: '#1e4d2b',
    muted: '#5e6f61',
    accent: '#2e7d32',
    headingFont: "'Google Sans', Roboto, -apple-system, 'Segoe UI', Arial, sans-serif",
    bodyFont: "Roboto, -apple-system, 'Segoe UI', Arial, sans-serif",
  },
  sunset: {
    id: 'sunset',
    name: 'Sunset',
    bg: '#fff7f0',
    text: '#3a2a22',
    heading: '#b23a1b',
    muted: '#8a6f63',
    accent: '#f28c28',
    headingFont: "Georgia, 'Times New Roman', serif",
    bodyFont: "Roboto, -apple-system, 'Segoe UI', Arial, sans-serif",
  },
  paper: {
    id: 'paper',
    name: 'Paper',
    bg: '#faf8f3',
    text: '#2b2b2b',
    heading: '#2b2b2b',
    muted: '#6b6b6b',
    accent: '#8d6e63',
    headingFont: "Georgia, 'Times New Roman', serif",
    bodyFont: "Georgia, 'Times New Roman', serif",
  },
};

/** Default font size (points) for a text role. */
export const ROLE_SIZE: Record<TextRole, number> = { title: 40, subtitle: 22, body: 18, caption: 14 };

// ---------------------------------------------------------------------------
// Layouts

/** Plain content for a slide; the layout decides where it goes. */
export interface SlideContent {
  title?: string;
  subtitle?: string;
  /** Body text: one string per paragraph. Lines starting with "- " or "* " become bullets. */
  body?: string[];
  /** Right column of a two-column layout. */
  body2?: string[];
  /** Image address for the image layout. */
  image?: string;
  caption?: string;
  notes?: string;
  background?: string;
}

const M = 60; // slide margin

const LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g;

/** The runs of a line written with Markdown links, "see [Fly.io](https://fly.io)"; undefined when it has none. */
export function parseLinks(line: string): TextRun[] | undefined {
  const runs: TextRun[] = [];
  let last = 0;
  for (const m of line.matchAll(LINK_RE)) {
    if (m.index > last) runs.push({ text: line.slice(last, m.index) });
    runs.push({ text: m[1], link: m[2] });
    last = m.index + m[0].length;
  }
  if (!runs.length) return undefined;
  if (last < line.length) runs.push({ text: line.slice(last) });
  return runs;
}

/** A paragraph's text with its links written as Markdown, the inverse of parseLinks. */
export function textWithLinks(p: Paragraph): string {
  return p.runs?.length ? p.runs.map((r) => (r.link ? `[${r.text}](${r.link})` : r.text)).join('') : p.text;
}

/**
 * Turn body lines into paragraphs: "- text" or "* text" is a bullet; leading two spaces per level indent it;
 * "[label](url)" is a link.
 */
export function toParagraphs(lines: string[] | undefined, bulletsByDefault = false): Paragraph[] {
  const out: Paragraph[] = [];
  for (const raw of lines ?? []) {
    for (const line of raw.split('\n')) {
      const m = /^(\s*)([-*•]\s+)?(.*)$/.exec(line)!;
      const level = Math.min(4, Math.floor(m[1].length / 2));
      const bullet = !!m[2] || (bulletsByDefault && line.trim() !== '');
      const runs = parseLinks(m[3]);
      const text = runs ? runs.map((r) => r.text).join('') : m[3];
      out.push({ text, ...(runs ? { runs } : {}), ...(bullet ? { bullet: true } : {}), ...(bullet && level ? { level } : {}) });
    }
  }
  return out;
}

/** Paragraphs back to body lines (the inverse of toParagraphs). */
export function fromParagraphs(ps: Paragraph[]): string[] {
  return ps.map((p) => (p.bullet ? `${'  '.repeat(p.level ?? 0)}- ${textWithLinks(p)}` : textWithLinks(p)));
}

function textEl(id: string, role: TextRole, paragraphs: Paragraph[], box: [number, number, number, number], style?: TextStyle): TextElement {
  const [x, y, w, h] = box;
  return { id, type: 'text', role, x, y, w, h, paragraphs, ...(style ? { style } : {}) };
}

const one = (s: string | undefined, fallback: string): Paragraph[] => [{ text: s ?? fallback }];

/**
 * Elements for a slide built from a layout. Missing content gets a placeholder so the user sees where to type.
 * `nextId` supplies element ids.
 */
export function layoutElements(layout: LayoutId, c: SlideContent, nextId: () => string): SlideElement[] {
  const W = SLIDE_W;
  const H = SLIDE_H;
  switch (layout) {
    case 'title':
      return [
        textEl(nextId(), 'title', one(c.title, 'Presentation title'), [M, 170, W - 2 * M, 110], { align: 'center', valign: 'bottom' }),
        textEl(nextId(), 'subtitle', one(c.subtitle, 'Subtitle'), [M, 290, W - 2 * M, 60], { align: 'center', valign: 'top' }),
      ];
    case 'section':
      return [
        { id: nextId(), type: 'shape', shape: 'rect', x: M, y: 300, w: 120, h: 6 },
        textEl(nextId(), 'title', one(c.title, 'Section title'), [M, 180, W - 2 * M, 110], { valign: 'bottom' }),
        ...(c.subtitle !== undefined ? [textEl(nextId(), 'subtitle', one(c.subtitle, ''), [M, 320, W - 2 * M, 60])] : []),
      ];
    case 'title-body': {
      const body = c.body?.length ? toParagraphs(c.body, true) : [{ text: 'Click to add text', bullet: true }];
      return [textEl(nextId(), 'title', one(c.title, 'Slide title'), [M, 40, W - 2 * M, 80], { valign: 'bottom' }), textEl(nextId(), 'body', body, [M, 140, W - 2 * M, H - 140 - M])];
    }
    case 'two-column': {
      const colW = (W - 2 * M - 40) / 2;
      const left = c.body?.length ? toParagraphs(c.body, true) : [{ text: 'Left column', bullet: true }];
      const right = c.body2?.length ? toParagraphs(c.body2, true) : [{ text: 'Right column', bullet: true }];
      return [
        textEl(nextId(), 'title', one(c.title, 'Slide title'), [M, 40, W - 2 * M, 80], { valign: 'bottom' }),
        textEl(nextId(), 'body', left, [M, 140, colW, H - 140 - M]),
        textEl(nextId(), 'body', right, [M + colW + 40, 140, colW, H - 140 - M]),
      ];
    }
    case 'image': {
      const els: SlideElement[] = [textEl(nextId(), 'title', one(c.title, 'Slide title'), [M, 40, W - 2 * M, 80], { valign: 'bottom' })];
      const imgBox = { x: M, y: 140, w: W - 2 * M, h: c.caption !== undefined ? H - 140 - M - 50 : H - 140 - M };
      if (c.image) els.push({ id: nextId(), type: 'image', src: c.image, ...imgBox });
      else els.push({ id: nextId(), type: 'shape', shape: 'rounded', fill: 'none', stroke: '#9aa0a6', strokeWidth: 2, text: 'Insert an image', ...imgBox });
      if (c.caption !== undefined) els.push(textEl(nextId(), 'caption', one(c.caption, ''), [M, H - M - 40, W - 2 * M, 40], { align: 'center' }));
      return els;
    }
    case 'blank':
      return [];
  }
}

/**
 * A picture element after its picture was edited (in the image editor) and stored at `src`. When the picture
 * kept its shape only the address changes. When it did not (it was cropped or turned), the element's own crop
 * no longer means anything and is dropped, and its box takes the new shape at the same width and centre, made
 * smaller if it would be taller than the slide.
 */
export function withEditedPicture(el: ImageElement, src: string, before: { width: number; height: number } | null, after: { width: number; height: number } | null): ImageElement {
  const ratio = (s: { width: number; height: number } | null) => (s && s.width > 0 && s.height > 0 ? s.width / s.height : null);
  const [was, now] = [ratio(before), ratio(after)];
  if (!was || !now || Math.abs(was - now) / was < 0.01) return { ...el, src };
  const { crop: _crop, ...rest } = el;
  let w = el.w;
  let h = w / now;
  if (h > SLIDE_H) {
    h = SLIDE_H;
    w = h * now;
  }
  [w, h] = [Math.max(1, Math.round(w)), Math.max(1, Math.round(h))];
  return { ...rest, src, x: Math.round(el.x + el.w / 2 - w / 2), y: Math.round(el.y + el.h / 2 - h / 2), w, h };
}

/** A new slide from a layout and content. */
export function buildSlide(layout: LayoutId, content: SlideContent, nextId: () => string): Slide {
  const elements = layoutElements(layout, content, nextId);
  return {
    id: nextId(),
    layout,
    elements,
    ...(content.notes ? { notes: content.notes } : {}),
    ...(content.background ? { bg: content.background } : {}),
  };
}

/** The content of a slide by role, for rebuilding it with another layout or changing one part of it. */
export function slideContent(slide: Slide): SlideContent {
  const texts = slide.elements.filter((e): e is TextElement => e.type === 'text');
  const byRole = (role: TextRole, skip = 0) => texts.filter((e) => (e.role ?? 'body') === role)[skip];
  const title = byRole('title');
  const subtitle = byRole('subtitle');
  const body = byRole('body');
  const body2 = byRole('body', 1);
  const caption = byRole('caption');
  const image = slide.elements.find((e): e is ImageElement => e.type === 'image');
  return {
    ...(title ? { title: title.paragraphs.map((p) => p.text).join('\n') } : {}),
    ...(subtitle ? { subtitle: subtitle.paragraphs.map((p) => p.text).join('\n') } : {}),
    ...(body ? { body: fromParagraphs(body.paragraphs) } : {}),
    ...(body2 ? { body2: fromParagraphs(body2.paragraphs) } : {}),
    ...(image ? { image: image.src } : {}),
    ...(caption ? { caption: caption.paragraphs.map((p) => p.text).join('\n') } : {}),
    ...(slide.notes ? { notes: slide.notes } : {}),
    ...(slide.bg ? { background: slide.bg } : {}),
  };
}

/**
 * Change parts of a slide by role without moving its elements. A text role the slide has no element for, or a
 * new layout, rebuilds the elements from the layout with the merged content.
 */
export function updateSlideContent(slide: Slide, content: SlideContent & { layout?: LayoutId }, nextId: () => string): Slide {
  const next: Slide = { ...slide };
  if (content.notes !== undefined) {
    if (content.notes) next.notes = content.notes;
    else delete next.notes;
  }
  if (content.background !== undefined) {
    if (content.background) next.bg = content.background;
    else delete next.bg;
  }
  const texts = slide.elements.filter((e): e is TextElement => e.type === 'text');
  const roleEl = (role: TextRole, skip = 0) => texts.filter((e) => (e.role ?? 'body') === role)[skip];
  const wanted: [TextRole, number, string[] | undefined][] = [
    ['title', 0, content.title === undefined ? undefined : [content.title]],
    ['subtitle', 0, content.subtitle === undefined ? undefined : [content.subtitle]],
    ['body', 0, content.body],
    ['body', 1, content.body2],
    ['caption', 0, content.caption === undefined ? undefined : [content.caption]],
  ];
  const image = slide.elements.find((e): e is ImageElement => e.type === 'image');
  const missing = wanted.some(([role, skip, lines]) => lines !== undefined && !roleEl(role, skip)) || (content.image !== undefined && !image);
  if (content.layout || missing) {
    const merged = { ...slideContent(slide), ...content };
    const layout = content.layout ?? slide.layout ?? 'title-body';
    return { ...next, layout, elements: layoutElements(layout, merged, nextId) };
  }
  let elements = slide.elements;
  for (const [role, skip, lines] of wanted) {
    if (lines === undefined) continue;
    const el = roleEl(role, skip)!;
    const paragraphs = role === 'body' ? toParagraphs(lines, true) : toParagraphs(lines);
    elements = elements.map((e) => (e.id === el.id ? { ...el, paragraphs } : e));
  }
  if (content.image !== undefined && image) elements = elements.map((e) => (e.id === image.id ? { ...image, src: content.image! } : e));
  return { ...next, elements };
}

let idCounter = 0;
/** Short unique ids for slides and elements. */
export function newId(): string {
  idCounter = (idCounter + 1) % 1296;
  return `${Date.now().toString(36)}${idCounter.toString(36).padStart(2, '0')}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;
}

export function newDeck(): Deck {
  return { version: 1, theme: 'light', slides: [buildSlide('title', {}, newId)] };
}

/** The text of a slide for the thumbnail strip and the agent: the title if any, else the first text. */
export function slideTitle(slide: Slide): string {
  const title = slide.elements.find((e): e is TextElement => e.type === 'text' && e.role === 'title');
  const first = title ?? slide.elements.find((e): e is TextElement => e.type === 'text');
  return first?.paragraphs.map((p) => p.text).join(' ').trim() ?? '';
}

// ---------------------------------------------------------------------------
// Validation (guards saved files and tool input, not a full schema)

const MAX_SLIDES = 500;
const MAX_ELEMENTS = 200;
const MAX_PARAGRAPHS = 500;
const MAX_TEXT = 20_000;
const MAX_RUNS = 200;
export const MAX_TABLE_ROWS = 100;
export const MAX_TABLE_COLS = 30;
const COORD = 20_000;

const isColor = (v: unknown) => typeof v === 'string' && v.length <= 64;
/** A color or a CSS gradient of colors. */
const isPaint = (v: unknown) => isColor(v) || (typeof v === 'string' && v.length <= 400 && GRADIENT_RE.test(v));
const GRADIENT_RE = /^(linear|radial)-gradient\([-#(),.%\w\s]*\)$/;
const CLIP_RE = /^(ellipse|circle|inset|polygon)\([-,.%\w\s]*\)$/;
const PATH_RE = /^[-MLHVCSQTAZmlhvcsqtaz\d\s,.e]*$/;
const MAX_PATH = 20_000;

/** The first plain color of a fill: the fill itself, or the first color stop of a gradient. */
export function fillColor(fill: string | undefined): string | undefined {
  if (!fill || !GRADIENT_RE.test(fill)) return fill;
  return /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/i.exec(fill)?.[0];
}
const num = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

export function validateElement(e: unknown, where: string): string | null {
  if (!e || typeof e !== 'object') return `${where}: element must be an object`;
  const el = e as SlideElement;
  if (typeof el.id !== 'string' || !el.id) return `${where}: element without id`;
  for (const k of ['x', 'y', 'w', 'h'] as const) if (!num(el[k], -COORD, COORD)) return `${where}: element ${el.id} has an invalid ${k}`;
  if (el.w < 0 || el.h < 0) return `${where}: element ${el.id} has a negative size`;
  if (el.rot !== undefined && !num(el.rot, -360, 360)) return `${where}: element ${el.id} has an invalid rotation`;
  switch (el.type) {
    case 'text': {
      if (el.role !== undefined && !['title', 'subtitle', 'body', 'caption'].includes(el.role)) return `${where}: invalid text role`;
      if (!Array.isArray(el.paragraphs) || el.paragraphs.length > MAX_PARAGRAPHS) return `${where}: invalid paragraphs`;
      let chars = 0;
      for (const p of el.paragraphs) {
        if (!p || typeof p.text !== 'string') return `${where}: invalid paragraph`;
        if (p.level !== undefined && !num(p.level, 0, 4)) return `${where}: invalid bullet level`;
        if (p.size !== undefined && !num(p.size, 4, 400)) return `${where}: invalid paragraph font size`;
        if (p.color !== undefined && !isColor(p.color)) return `${where}: invalid paragraph color`;
        if (p.font !== undefined && (typeof p.font !== 'string' || p.font.length > 64)) return `${where}: invalid paragraph font`;
        if (p.runs !== undefined) {
          if (!Array.isArray(p.runs) || p.runs.length > MAX_RUNS) return `${where}: invalid runs`;
          for (const r of p.runs) {
            if (!r || typeof r.text !== 'string') return `${where}: invalid run`;
            if (r.link !== undefined && (typeof r.link !== 'string' || !safeLinkUrl(r.link))) return `${where}: invalid link (use an http, https or mailto URL)`;
            if (r.color !== undefined && !isColor(r.color)) return `${where}: invalid run color`;
          }
          if (p.runs.map((r) => r.text).join('') !== p.text) return `${where}: the runs do not add up to the paragraph text`;
        }
        chars += p.text.length;
      }
      if (chars > MAX_TEXT) return `${where}: too much text in one element`;
      const s = el.style;
      if (s !== undefined) {
        if (!s || typeof s !== 'object') return `${where}: invalid style`;
        if (s.size !== undefined && !num(s.size, 4, 400)) return `${where}: invalid font size`;
        if (s.color !== undefined && !isColor(s.color)) return `${where}: invalid color`;
        if (s.align !== undefined && !['left', 'center', 'right'].includes(s.align)) return `${where}: invalid align`;
        if (s.valign !== undefined && !['top', 'middle', 'bottom'].includes(s.valign)) return `${where}: invalid valign`;
        if (s.font !== undefined && (typeof s.font !== 'string' || s.font.length > 64)) return `${where}: invalid font`;
        if (s.lineHeight !== undefined && !num(s.lineHeight, 0.5, 4)) return `${where}: invalid line height`;
        if (s.paraSpacing !== undefined && !num(s.paraSpacing, 0, 200)) return `${where}: invalid paragraph spacing`;
        if (s.outline !== undefined && !isColor(s.outline)) return `${where}: invalid outline color`;
        if (s.spacing !== undefined && !num(s.spacing, -20, 100)) return `${where}: invalid letter spacing`;
        if (s.bulletChar !== undefined && (typeof s.bulletChar !== 'string' || s.bulletChar.length > 4)) return `${where}: invalid bullet character`;
        if (s.bulletColor !== undefined && !isColor(s.bulletColor)) return `${where}: invalid bullet color`;
      }
      return null;
    }
    case 'image': {
      const problem = checkCellImage(el.src);
      if (problem) return `${where}: ${problem}`;
      if (el.fit !== undefined && el.fit !== 'contain' && el.fit !== 'cover') return `${where}: invalid fit`;
      if (el.crop !== undefined) {
        const c = el.crop;
        if (!c || !(['l', 't', 'r', 'b'] as const).every((k) => num(c[k], -10, 0.99)) || c.l + c.r >= 1 || c.t + c.b >= 1) return `${where}: invalid crop`;
      }
      if (el.clip !== undefined && (typeof el.clip !== 'string' || el.clip.length > MAX_PATH || !CLIP_RE.test(el.clip))) return `${where}: invalid clip`;
      if (el.opacity !== undefined && !num(el.opacity, 0, 1)) return `${where}: invalid opacity`;
      if (el.duotone !== undefined && !(Array.isArray(el.duotone) && el.duotone.length === 2 && el.duotone.every((c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)))) return `${where}: invalid duotone`;
      return null;
    }
    case 'video': {
      const problem = checkVideo(el.src);
      return problem ? `${where}: ${problem}` : null;
    }
    case 'line': {
      if (!['straight', 'elbow', 'curved'].includes(el.kind)) return `${where}: invalid line kind`;
      if (el.strokeColor !== undefined && !isColor(el.strokeColor)) return `${where}: invalid line color`;
      if (el.strokeWidth !== undefined && !num(el.strokeWidth, 0, 100)) return `${where}: invalid stroke width`;
      if (el.dash !== undefined && !['solid', 'dash', 'dot'].includes(el.dash)) return `${where}: invalid dash`;
      for (const k of ['startArrow', 'endArrow'] as const) if (el[k] !== undefined && !ARROW_STYLE_IDS.includes(el[k]!)) return `${where}: invalid arrowhead`;
      if (el.bend !== undefined && !num(el.bend, 0, 1)) return `${where}: invalid bend`;
      for (const k of ['flipH', 'flipV'] as const) if (el[k] !== undefined && typeof el[k] !== 'boolean') return `${where}: invalid flip`;
      for (const k of ['startConnection', 'endConnection'] as const) {
        const c = el[k];
        if (c !== undefined && (!c || typeof c.elementId !== 'string' || !['top', 'right', 'bottom', 'left'].includes(c.site))) return `${where}: invalid connection`;
      }
      return null;
    }
    case 'table': {
      if (!Array.isArray(el.rows) || !el.rows.length || el.rows.length > MAX_TABLE_ROWS) return `${where}: a table needs 1 to ${MAX_TABLE_ROWS} rows`;
      const n = Array.isArray(el.rows[0]) ? el.rows[0].length : 0;
      if (n < 1 || n > MAX_TABLE_COLS) return `${where}: a table needs 1 to ${MAX_TABLE_COLS} columns`;
      let chars = 0;
      for (const row of el.rows) {
        if (!Array.isArray(row) || row.length !== n) return `${where}: every row of a table needs ${n} cells`;
        for (const c of row) {
          if (!c || typeof c.text !== 'string') return `${where}: invalid table cell`;
          if (c.color !== undefined && !isColor(c.color)) return `${where}: invalid cell color`;
          if (c.fill !== undefined && !isColor(c.fill)) return `${where}: invalid cell fill`;
          if (c.align !== undefined && !['left', 'center', 'right'].includes(c.align)) return `${where}: invalid cell align`;
          chars += c.text.length;
        }
      }
      if (chars > MAX_TEXT) return `${where}: too much text in one table`;
      const src = el.source;
      if (src !== undefined) {
        const str = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max;
        if (!src || typeof src !== 'object' || !str(src.sheet, 200) || !str(src.tabId, 200) || !str(src.tab, 200) || !str(src.range, 40)) return `${where}: invalid table source`;
        if ((src.title !== undefined && typeof src.title !== 'string') || (src.rev !== undefined && typeof src.rev !== 'string') || (src.used !== undefined && typeof src.used !== 'boolean')) return `${where}: invalid table source`;
      }
      if (el.cols !== undefined && !(Array.isArray(el.cols) && el.cols.length === n && el.cols.every((w) => num(w, 0.001, 1)))) return `${where}: invalid column widths`;
      const s = el.style;
      if (s !== undefined) {
        if (!s || typeof s !== 'object') return `${where}: invalid table style`;
        if (s.size !== undefined && !num(s.size, 4, 400)) return `${where}: invalid font size`;
        if (s.font !== undefined && (typeof s.font !== 'string' || s.font.length > 64)) return `${where}: invalid font`;
        for (const k of ['color', 'border', 'headerFill'] as const) if (s[k] !== undefined && !isColor(s[k])) return `${where}: invalid table ${k}`;
      }
      return null;
    }
    case 'chart': {
      const problem = validateChartElement(el);
      return problem ? `${where}: ${problem}` : null;
    }
    case 'shape': {
      if (!SHAPE_KINDS.includes(el.shape)) return `${where}: invalid shape`;
      if (el.fill !== undefined && !isPaint(el.fill)) return `${where}: invalid fill`;
      if (el.path !== undefined && (typeof el.path !== 'string' || el.path.length > MAX_PATH || !PATH_RE.test(el.path))) return `${where}: invalid path`;
      if (el.stroke !== undefined && !isColor(el.stroke)) return `${where}: invalid stroke`;
      if (el.strokeWidth !== undefined && !num(el.strokeWidth, 0, 100)) return `${where}: invalid stroke width`;
      if (el.startAngle !== undefined && !num(el.startAngle, -360, 720)) return `${where}: invalid start angle`;
      if (el.endAngle !== undefined && !num(el.endAngle, -360, 720)) return `${where}: invalid end angle`;
      if (el.arrow !== undefined && !['start', 'end', 'both'].includes(el.arrow)) return `${where}: invalid arrow`;
      if (el.flip !== undefined && typeof el.flip !== 'boolean') return `${where}: invalid flip`;
      if (el.text !== undefined && (typeof el.text !== 'string' || el.text.length > MAX_TEXT)) return `${where}: invalid shape text`;
      if (el.textColor !== undefined && !isColor(el.textColor)) return `${where}: invalid text color`;
      if (el.textSize !== undefined && !num(el.textSize, 4, 400)) return `${where}: invalid label font size`;
      if (el.textFont !== undefined && (typeof el.textFont !== 'string' || el.textFont.length > 64)) return `${where}: invalid label font`;
      return null;
    }
    default:
      return `${where}: unknown element type`;
  }
}

export function validateDeck(d: unknown): string | null {
  if (!d || typeof d !== 'object') return 'Deck must be an object';
  const deck = d as Deck;
  if (deck.version !== 1) return 'Unsupported deck version';
  if (!THEME_IDS.includes(deck.theme)) return 'Unknown theme';
  if (!Array.isArray(deck.slides) || deck.slides.length === 0) return 'Deck must have at least one slide';
  if (deck.slides.length > MAX_SLIDES) return 'Too many slides';
  const ids = new Set<string>();
  for (let i = 0; i < deck.slides.length; i++) {
    const s = deck.slides[i];
    const where = `slide ${i + 1}`;
    if (!s || typeof s !== 'object') return `${where}: invalid slide`;
    if (typeof s.id !== 'string' || !s.id || ids.has(s.id)) return `${where}: invalid or duplicate slide id`;
    ids.add(s.id);
    if (s.layout !== undefined && !LAYOUT_IDS.includes(s.layout)) return `${where}: unknown layout`;
    if (s.bg !== undefined && !isPaint(s.bg)) return `${where}: invalid background`;
    if (s.notes !== undefined && (typeof s.notes !== 'string' || s.notes.length > MAX_TEXT)) return `${where}: invalid notes`;
    if (!Array.isArray(s.elements) || s.elements.length > MAX_ELEMENTS) return `${where}: invalid elements`;
    const eids = new Set<string>();
    for (const e of s.elements) {
      const problem = validateElement(e, where);
      if (problem) return problem;
      if (eids.has(e.id)) return `${where}: duplicate element id ${e.id}`;
      eids.add(e.id);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
/** Convert arcs stored with the whole-ellipse box to the tight box, in place. */
export function migrateArcs(deck: Deck): Deck {
  for (const s of deck.slides) {
    s.elements = s.elements.map((e) => (e.type === 'shape' && e.shape === 'arc' && !e.tight ? tightArc(e) : e));
  }
  return deck;
}

// Compact description for the assistant

export function deckOutline(deck: Deck, current?: number) {
  return {
    theme: deck.theme,
    slide_count: deck.slides.length,
    ...(current !== undefined ? { current_slide: current + 1 } : {}),
    slides: deck.slides.map((s, i) => ({
      slide: i + 1,
      ...(s.layout ? { layout: s.layout } : {}),
      ...(s.bg ? { background: s.bg } : {}),
      elements: s.elements.map((e) => {
        if (e.type === 'shape' && e.shape === 'arc') e = tightArc(e);
        const box = { id: e.id, x: e.x, y: e.y, w: e.w, h: e.h };
        if (e.type === 'text') return { ...box, type: 'text', ...(e.role ? { role: e.role } : {}), text: fromParagraphs(e.paragraphs).join('\n'), ...(e.style ? { style: e.style } : {}) };
        if (e.type === 'image') return { ...box, type: 'image', src: e.src.length > 80 ? `${e.src.slice(0, 77)}...` : e.src };
        if (e.type === 'video') return { ...box, type: 'video', src: e.src };
        if (e.type === 'table') return { ...box, ...tableOutline(e) };
        if (e.type === 'chart') return { ...box, ...chartElementOutline(e) };
        if (e.type === 'line') {
          const { x1, y1, x2, y2 } = lineEnds(e);
          const conn = (c: LineConnection | undefined) => (c ? { element_id: c.elementId, site: c.site } : undefined);
          return {
            ...box,
            type: 'line',
            kind: e.kind,
            x1,
            y1,
            x2,
            y2,
            ...(e.strokeColor ? { stroke: e.strokeColor } : {}),
            stroke_width: e.strokeWidth ?? 3,
            dash: e.dash ?? 'solid',
            start_arrow: e.startArrow ?? 'none',
            end_arrow: e.endArrow ?? 'none',
            ...(e.startConnection ? { connect_start: conn(e.startConnection) } : {}),
            ...(e.endConnection ? { connect_end: conn(e.endConnection) } : {}),
          };
        }
        const label = e.text
          ? {
              text: e.text,
              ...(e.textSize !== undefined ? { size: e.textSize } : {}),
              ...(e.textFont ? { font: e.textFont } : {}),
              ...(e.textBold ? { bold: true } : {}),
              ...(e.textItalic ? { italic: true } : {}),
              ...(e.textColor ? { color: e.textColor } : {}),
            }
          : {};
        return { ...box, type: 'shape', shape: e.shape, ...(e.fill ? { fill: e.fill } : {}), ...(e.shape === 'arc' ? { start_angle: e.startAngle ?? 270, end_angle: e.endAngle ?? 0 } : {}), ...label };
      }),
      ...(s.notes ? { notes: s.notes } : {}),
    })),
  };
}
