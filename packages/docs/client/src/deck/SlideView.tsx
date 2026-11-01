// Renders one slide at a scale. The same component draws the editor canvas, the thumbnails, the present mode
// and the print layout, so a slide always looks the same. Elements are absolutely positioned in a 960×540 box
// that is scaled with a CSS transform.
import { VideoPlayer, VideoPoster } from '../components/VideoPlayer.tsx';
import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import {
  ROLE_SIZE,
  SLIDE_H,
  SLIDE_W,
  THEMES,
  fillColor,
  type ChartElement,
  type ImageElement,
  type LineElement,
  type Paragraph,
  type ShapeElement,
  type Slide,
  type SlideElement,
  type TableElement,
  type TextElement,
  type TextRun,
  type Theme,
  type ThemeId,
} from '../../../shared/deck.ts';
import { createPortal } from 'react-dom';
import { fontFamilies } from './fonts.ts';
import { dashArray, DEFAULT_LINE_WIDTH, lineGeometry as routeGeometry } from '../../../shared/lines.ts';
import { arcGeometry, arcPathOn, isDrawn, polygonPoints, SHAPES } from '../../../shared/shapes.ts';
import { cellLook, colShares, mixColor, TABLE_PAD, TABLE_SIZE, tableColors } from '../../../shared/deckTable.ts';
import { chartOfSlide } from '../../../shared/chart.ts';
import { ChartView } from '../chart/ChartView.tsx';

/** A box override while an element is being dragged or resized. */
export type BoxPreview = Partial<Pick<SlideElement, 'x' | 'y' | 'w' | 'h'>> & Partial<Pick<LineElement, 'flipH' | 'flipV' | 'startConnection' | 'endConnection' | 'bend'>> & { startAngle?: number; endAngle?: number };

export interface SlideViewProps {
  slide: Slide;
  theme: ThemeId;
  scale: number;
  /** Live positions during a drag, by element id. */
  preview?: Record<string, BoxPreview>;
  /** Element whose text is being edited inline, with the callback that commits the text. */
  editing?: { id: string; caret?: { x: number; y: number }; onCommit(paragraphs: Paragraph[]): void; onStop(): void } | null;
  onElementMouseDown?(e: MouseEvent, el: SlideElement): void;
  onElementDoubleClick?(e: MouseEvent, el: SlideElement): void;
  /** The current cell of a table (outlined), and, while its text is being edited, the callbacks of the cell editor. */
  tableCell?: TableCellState | null;
  /** The videos that are players rather than stills: all of them (the show), or the one with this id. */
  playVideo?: true | string | null;
  /** Drawn on top of the elements (selection handles). */
  children?: ReactNode;
  className?: string;
}

export interface TableCellState {
  id: string;
  r: number;
  c: number;
  editing?: {
    onCommit(text: string): void;
    /** Tab and Shift-Tab: go to the next or the previous cell (the text is committed first). */
    onMove(step: 1 | -1): void;
    onStop(): void;
  };
}

export function themeVars(t: Theme): CSSProperties {
  return {
    '--sl-bg': t.bg,
    '--sl-text': t.text,
    '--sl-heading': t.heading,
    '--sl-muted': t.muted,
    '--sl-accent': t.accent,
    '--sl-heading-font': t.headingFont,
    '--sl-body-font': t.bodyFont,
  } as CSSProperties;
}

export function textStyleOf(el: TextElement, theme: Theme): CSSProperties {
  const role = el.role ?? 'body';
  const s = el.style ?? {};
  const heading = role === 'title' || role === 'subtitle';
  const size = s.size ?? ROLE_SIZE[role];
  const themeFont = heading ? theme.headingFont : theme.bodyFont;
  return {
    fontSize: size,
    fontFamily: s.font ? `${fontFamilies(s.font)}, ${themeFont}` : themeFont,
    lineHeight: s.lineHeight ?? 1.25,
    ['--sl-para' as string]: `${s.paraSpacing ?? size * 0.3}px`,
    fontWeight: s.bold ?? role === 'title' ? 700 : 400,
    fontStyle: s.italic ? 'italic' : 'normal',
    color: s.color ?? (role === 'title' ? theme.heading : role === 'caption' || role === 'subtitle' ? theme.muted : theme.text),
    // Links follow a color the box sets; otherwise they take the theme accent (styles.css, .sl-link).
    ...(s.color ? { ['--sl-link' as string]: s.color } : {}),
    textAlign: s.align ?? 'left',
    ...(s.outline ? { color: 'transparent', WebkitTextStroke: `${Math.max(0.75, size / 60)}px ${s.outline}` } : {}),
    ...(s.caps ? { textTransform: 'uppercase' as const } : {}),
    ...(s.spacing ? { letterSpacing: s.spacing } : {}),
    ...(s.bulletChar ? { ['--sl-bullet' as string]: JSON.stringify(s.bulletChar) } : {}),
    ...(s.bulletColor ? { ['--sl-bullet-color' as string]: s.bulletColor } : {}),
    justifyContent: s.valign === 'middle' ? 'center' : s.valign === 'bottom' ? 'flex-end' : 'flex-start',
  };
}

function boxStyle(el: SlideElement, preview?: BoxPreview): CSSProperties {
  const b = { x: el.x, y: el.y, w: el.w, h: el.h, ...preview };
  const style: CSSProperties = { left: b.x, top: b.y, width: b.w, height: b.h };
  if (el.rot) style.transform = `rotate(${el.rot}deg)`;
  // A straight line's thickness comes from its stroke; the vertical/horizontal style overrides the zero dimension.
  if (el.type === 'shape' && el.shape === 'line' && !isDiagonal(el)) {
    const sw = el.strokeWidth ?? 3;
    if (el.h > el.w) {
      style.width = sw;
      style.left = b.x - sw / 2;
    } else {
      style.height = sw;
      style.top = b.y - sw / 2;
    }
  }
  return style;
}

/** How the picture sits in its box: fitted whole, covering it, or (cropped) its visible part stretched over it. */
function imageStyle(el: ImageElement): CSSProperties {
  const c = el.crop;
  if (!c) return { objectFit: el.fit ?? 'contain' };
  const w = 1 - c.l - c.r;
  const h = 1 - c.t - c.b;
  return { position: 'absolute', objectFit: 'fill', width: `${100 / w}%`, height: `${100 / h}%`, left: `${(-c.l / w) * 100}%`, top: `${(-c.t / h) * 100}%` };
}

/** An SVG filter that maps a picture's brightness onto the line from one color to another. */
function DuotoneFilter({ id, tones }: { id: string; tones: [string, string] }) {
  const ch = (i: number) => tones.map((c) => (parseInt(c.slice(1 + i * 2, 3 + i * 2), 16) / 255).toFixed(3)).join(' ');
  return (
    <svg width={0} height={0} style={{ position: 'absolute' }} aria-hidden="true">
      <filter id={id} colorInterpolationFilters="sRGB">
        <feColorMatrix type="saturate" values="0" />
        <feComponentTransfer>
          <feFuncR type="table" tableValues={ch(0)} />
          <feFuncG type="table" tableValues={ch(1)} />
          <feFuncB type="table" tableValues={ch(2)} />
        </feComponentTransfer>
      </filter>
    </svg>
  );
}

/** A line that runs corner to corner of its box rather than along one edge. */
function isDiagonal(el: ShapeElement): boolean {
  return el.shape === 'line' && el.w > 0 && el.h > 0;
}

/** Lines with arrowheads or a diagonal run are drawn by an SVG (see ShapeDrawing); plain ones are a CSS rule. */
function isDrawnLine(el: ShapeElement): boolean {
  return el.shape === 'line' && (!!el.arrow || isDiagonal(el));
}

function shapeStyle(el: ShapeElement, theme: Theme): CSSProperties {
  const fill = el.fill === 'none' ? 'transparent' : (el.fill ?? theme.accent);
  const stroke = el.stroke ?? (el.shape === 'line' ? theme.accent : undefined);
  const sw = el.strokeWidth ?? (el.shape === 'line' ? 3 : stroke ? 2 : 0);
  if (el.shape === 'line') return isDrawnLine(el) ? {} : { background: el.stroke ?? el.fill ?? theme.accent };
  const text: CSSProperties = {
    color: el.textColor ?? (el.fill === 'none' ? theme.text : '#fff'),
    fontFamily: el.textFont ? `${fontFamilies(el.textFont)}, ${theme.bodyFont}` : theme.bodyFont,
    fontSize: el.textSize ?? 18,
    ...(el.textBold ? { fontWeight: 700 } : {}),
    ...(el.textItalic ? { fontStyle: 'italic' } : {}),
  };
  // Polygon and path shapes are drawn by an SVG inside the box (see ShapeDrawing); the box itself stays transparent.
  if (isDrawn(el.shape) || el.path) return text;
  return {
    background: fill,
    borderRadius: el.shape === 'ellipse' ? '50%' : el.shape === 'rounded' ? 16 : 0,
    border: sw ? `${sw}px solid ${stroke ?? fill}` : undefined,
    ...text,
  };
}

/**
 * A line element's stroke and arrowheads. Drawn in slide coordinates inside a zero-size SVG at the slide's origin
 * (the caller's box is positioned at the line's own corner, hence the offset), so it works for horizontal and
 * vertical lines whose box has no width or height. The wide transparent stroke is the click target.
 */
export function LineDrawing({ el, theme, hit }: { el: LineElement; theme: Theme; hit?: boolean }) {
  const g = routeGeometry(el);
  const sw = el.strokeWidth ?? DEFAULT_LINE_WIDTH;
  const color = el.strokeColor ?? theme.accent;
  return (
    <svg className="sl-line-svg" width={1} height={1} style={{ left: -el.x, top: -el.y }} aria-hidden="true">
      <path d={g.d} fill="none" stroke={color} strokeWidth={sw} strokeDasharray={dashArray(el.dash, sw)} />
      {g.heads.map((h, i) =>
        h.type === 'circle' ? (
          <circle key={i} cx={h.cx} cy={h.cy} r={h.r} fill={color} />
        ) : h.type === 'polygon' ? (
          <polygon key={i} points={h.points} fill={color} stroke={color} strokeWidth={1} strokeLinejoin="round" />
        ) : (
          <polyline key={i} points={h.points} fill="none" stroke={color} strokeWidth={sw} strokeLinejoin="round" strokeLinecap="round" />
        ),
      )}
      {hit && <path d={g.d} fill="none" stroke="transparent" strokeWidth={Math.max(sw, 14)} style={{ pointerEvents: 'stroke' }} />}
    </svg>
  );
}

/** The arrowhead length for a line of a stroke width. */
export function arrowSize(strokeWidth: number): number {
  return strokeWidth * 3 + 6;
}

/**
 * The geometry of a line with arrowheads, in its box's coordinates: the stroke (shortened so it does not poke
 * through the arrow tips) and the arrowhead polygons. The box is the line's own box (a straight line's box is
 * stroke-width tall or wide).
 */
export function lineGeometry(el: ShapeElement, w: number, h: number, sw: number): { x1: number; y1: number; x2: number; y2: number; heads: string[] } {
  const diagonal = w > 0 && h > 0;
  let [x1, y1, x2, y2] = diagonal ? [0, el.flip ? h : 0, w, el.flip ? 0 : h] : h >= w ? [w / 2, 0, w / 2, h] : [0, h / 2, w, h / 2];
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  const size = Math.min(arrowSize(sw), len / 2);
  const heads: string[] = [];
  const head = (tx: number, ty: number, dx: number, dy: number) => {
    // A triangle with its tip at (tx, ty), pointing along (dx, dy).
    const bx = tx - dx * size;
    const by = ty - dy * size;
    const hw = size / 2;
    heads.push(`${tx},${ty} ${bx - dy * hw},${by + dx * hw} ${bx + dy * hw},${by - dx * hw}`);
  };
  if (el.arrow === 'end' || el.arrow === 'both') {
    head(x2, y2, ux, uy);
    x2 -= ux * size * 0.8;
    y2 -= uy * size * 0.8;
  }
  if (el.arrow === 'start' || el.arrow === 'both') {
    head(x1, y1, -ux, -uy);
    x1 += ux * size * 0.8;
    y1 += uy * size * 0.8;
  }
  return { x1, y1, x2, y2, heads };
}

/** The SVG of a non-CSS shape (a polygon, a path, or a line with arrowheads), in the element's own coordinates so strokes scale with the slide. */
function ShapeDrawing({ el, theme, box }: { el: ShapeElement; theme: Theme; box: BoxPreview }) {
  const w = box.w ?? el.w;
  const h = box.h ?? el.h;
  if (el.shape === 'arc') {
    // The ellipse follows the live box (so resizing scales the arc); old arcs are drawn on their whole-ellipse box.
    const sw = el.strokeWidth ?? 2;
    const start = box.startAngle ?? el.startAngle;
    const end = box.endAngle ?? el.endAngle;
    const g = arcGeometry({ ...el, startAngle: start, endAngle: end, x: 0, y: 0, w, h }, sw);
    return (
      <svg className="sl-shape-svg" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true">
        <path d={arcPathOn(g, 0, 0, start, end)} fill="none" stroke={el.stroke ?? theme.accent} strokeWidth={sw} />
      </svg>
    );
  }
  if (el.shape === 'line') {
    if (!isDrawnLine(el)) return null;
    const sw = el.strokeWidth ?? 3;
    const color = el.stroke ?? el.fill ?? theme.accent;
    // A straight line's box is as thin as its stroke (see boxStyle); a diagonal one spans its box.
    const bw = w > 0 && h > 0 ? w : h >= w ? sw : w;
    const bh = w > 0 && h > 0 ? h : h >= w ? h : sw;
    const g = lineGeometry(el, bw, bh, sw);
    return (
      <svg className="sl-shape-svg" viewBox={`0 0 ${bw} ${bh}`} width={bw} height={bh} aria-hidden="true">
        <line x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} stroke={color} strokeWidth={sw} />
        {g.heads.map((pts, i) => (
          <polygon key={i} points={pts} fill={color} />
        ))}
      </svg>
    );
  }
  const def = SHAPES[el.shape];
  const fill = el.fill === 'none' ? 'none' : (fillColor(el.fill) ?? theme.accent);
  const sw = el.strokeWidth ?? (el.stroke ? 2 : 0);
  const stroke = sw ? (el.stroke ?? fill) : 'none';
  if (el.path) {
    // A freeform is given in a 100×100 box; the stroke keeps its width however the box is stretched.
    return (
      <svg className="sl-shape-svg" viewBox="0 0 100 100" preserveAspectRatio="none" width={w} height={h} aria-hidden="true">
        <path d={el.path} fill={fill} stroke={stroke} strokeWidth={sw} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
    );
  }
  return (
    <svg className="sl-shape-svg" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true">
      {def.path ? (
        <path d={def.path(w, h)} fill={fill} stroke={stroke} strokeWidth={sw} strokeLinejoin="round" />
      ) : (
        <polygon points={polygonPoints(el.shape, w, h)} fill={fill} stroke={stroke} strokeWidth={sw} strokeLinejoin="round" />
      )}
    </svg>
  );
}

/** Inline style for a paragraph's own overrides (size, weight, color, font). */
function paragraphStyle(p: Paragraph): CSSProperties {
  const s: CSSProperties = { paddingLeft: p.bullet ? 28 + (p.level ?? 0) * 28 : (p.level ?? 0) * 28 };
  if (p.size !== undefined) s.fontSize = p.size;
  if (p.bold !== undefined) s.fontWeight = p.bold ? 700 : 400;
  if (p.italic !== undefined) s.fontStyle = p.italic ? 'italic' : 'normal';
  if (p.color) {
    s.color = p.color;
    (s as Record<string, string>)['--sl-link'] = p.color;
  }
  if (p.font) s.fontFamily = `${fontFamilies(p.font)}, inherit`;
  return s;
}

function runStyle(r: TextRun): CSSProperties {
  const s: CSSProperties = {};
  if (r.bold !== undefined) s.fontWeight = r.bold ? 700 : 400;
  if (r.italic !== undefined) s.fontStyle = r.italic ? 'italic' : 'normal';
  if (r.underline) s.textDecoration = 'underline';
  if (r.color) s.color = r.color;
  return s;
}

/**
 * A run of a paragraph. Links open when the slide is shown (present mode, thumbnails are too small to matter);
 * on the editor canvas a click selects the box as usual and cmd/ctrl-click opens the link.
 */
function Run({ run, index, live }: { run: TextRun; index: number; live: boolean }) {
  const style = runStyle(run);
  if (!run.link) {
    return (
      <span data-r={index} style={style}>
        {run.text}
      </span>
    );
  }
  return (
    <a
      className="sl-link"
      data-r={index}
      href={run.link}
      target="_blank"
      rel="noopener noreferrer"
      style={style}
      onMouseDown={(e) => {
        if (!live && (e.metaKey || e.ctrlKey)) e.stopPropagation(); // open, don't start a drag
      }}
      onClick={(e) => {
        if (live) e.stopPropagation(); // don't also advance the slide
        else if (!(e.metaKey || e.ctrlKey)) e.preventDefault();
      }}
    >
      {run.text}
    </a>
  );
}

export const Paragraphs = memo(function Paragraphs({ paragraphs, live = false }: { paragraphs: Paragraph[]; live?: boolean }) {
  return (
    <>
      {paragraphs.map((p, i) => (
        <div key={i} className={`sl-p${p.bullet ? ' bullet' : ''}`} data-bullet={p.bullet ? '1' : undefined} data-level={p.level || undefined} data-p={i} style={paragraphStyle(p)}>
          {p.runs?.length ? p.runs.map((r, k) => <Run key={k} run={r} index={k} live={live} />) : p.text || '​'}
        </div>
      ))}
    </>
  );
});

/**
 * The runs of an edited paragraph block, so links survive retyping: a span or anchor the editor made keeps the
 * look of the original run it came from; anything else is plain text. Undefined when the block has no links.
 */
function editedRuns(block: HTMLElement, source: Paragraph | undefined): TextRun[] | undefined {
  if (!block.querySelector('a[data-r]')) return undefined;
  const runs: TextRun[] = [];
  const walk = (node: Node) => {
    if (node instanceof HTMLElement && node.dataset.r !== undefined) {
      const text = (node.textContent ?? '').replace(/​/g, '');
      const orig = source?.runs?.[Number(node.dataset.r)];
      const link = node.tagName === 'A' ? (node.getAttribute('href') ?? undefined) : undefined;
      if (text) runs.push({ ...(orig ?? {}), text, ...(link ? { link } : {}) });
      return;
    }
    if (node instanceof HTMLElement && node.tagName === 'BR') {
      runs.push({ text: '\n' });
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? '').replace(/​/g, '');
      const prev = runs[runs.length - 1];
      if (!text) return;
      if (prev && Object.keys(prev).length === 1) prev.text += text;
      else runs.push({ text });
      return;
    }
    for (const c of Array.from(node.childNodes)) walk(c);
  };
  walk(block);
  return runs.length ? runs : undefined;
}

/**
 * Read paragraphs back from an edited contentEditable: each block is a paragraph. Blocks keep their bullet, and
 * their style overrides come from the original paragraph with the same data-p index (a block the browser made
 * by splitting one inherits from the paragraph before it).
 */
function parseEditedText(root: HTMLElement, original: Paragraph[]): Paragraph[] {
  const out: Paragraph[] = [];
  const blocks = Array.from(root.children).filter((c) => c instanceof HTMLElement) as HTMLElement[];
  if (!blocks.length) {
    for (const line of (root.textContent ?? '').split('\n')) out.push({ ...overridesOf(original[0]), text: line });
    return out.length ? out : [{ text: '' }];
  }
  let prev: Paragraph | undefined;
  for (const b of blocks) {
    const bullet = b.dataset.bullet !== undefined ? b.dataset.bullet === '1' : !!prev?.bullet;
    const level = b.dataset.level !== undefined ? Number(b.dataset.level) || 0 : (prev?.level ?? 0);
    const source = b.dataset.p !== undefined ? original[Number(b.dataset.p)] : prev;
    const runs = editedRuns(b, source);
    const text = runs ? runs.map((r) => r.text).join('') : (b.innerText ?? b.textContent ?? '').replace(/​/g, '').replace(/\n$/, '');
    const p: Paragraph = { ...overridesOf(source), text, ...(runs ? { runs } : {}), ...(bullet ? { bullet: true } : {}), ...(bullet && level ? { level } : {}) };
    out.push(p);
    prev = p;
  }
  return out;
}

function overridesOf(p: Paragraph | undefined): Partial<Paragraph> {
  if (!p) return {};
  const o: Partial<Paragraph> = {};
  if (p.size !== undefined) o.size = p.size;
  if (p.bold !== undefined) o.bold = p.bold;
  if (p.italic !== undefined) o.italic = p.italic;
  if (p.color !== undefined) o.color = p.color;
  if (p.font !== undefined) o.font = p.font;
  return o;
}

const PLACEHOLDERS = new Set(['Presentation title', 'Subtitle', 'Section title', 'Slide title', 'Click to add text', 'Left column', 'Right column', 'Title', 'Text']);

/** A link URL as typed: bare domains get https://; empty or script-like input is rejected (null). */
export function normalizeLinkUrl(input: string): string | null {
  const v = input.trim();
  if (!v) return null;
  if (/^(https?:|mailto:)/i.test(v)) return v;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v) && !/^[^/\s]+:\d+/.test(v)) return null;
  return `https://${v}`;
}

/** A URL shortened for the link menu. */
export function linkLabel(href: string): string {
  return href.replace(/^mailto:/, '').replace(/^https?:\/\//, '');
}

/** A small card under the link at the caret: open it in a new tab, edit it, or remove it. */
function LinkBubble({ anchor, onChange }: { anchor: HTMLAnchorElement; onChange(): void }) {
  const href = anchor.getAttribute('href') ?? '';
  const r = anchor.getBoundingClientRect();
  const width = 360;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
  return createPortal(
    <div className="doc-link-bubble" style={{ left, top: r.bottom + 6, maxWidth: width }} onMouseDown={(e) => e.preventDefault()} role="dialog" aria-label="Link">
      <span title={href}>{linkLabel(href)}</span>
      <button className="link" title="Open the link in a new tab" onClick={() => window.open(href, '_blank', 'noopener,noreferrer')}>
        Open link
      </button>
      <button
        className="link"
        title="Change the link"
        onClick={() => {
          const url = window.prompt('Link URL', href);
          if (url === null) return;
          const next = normalizeLinkUrl(url);
          if (!next) return;
          const label = window.prompt('Link text', anchor.textContent ?? '');
          anchor.setAttribute('href', next);
          if (label) anchor.textContent = label;
          onChange();
        }}
      >
        Edit
      </button>
      <button
        className="link"
        title="Remove the link, keeping the text"
        onClick={() => {
          anchor.replaceWith(document.createTextNode(anchor.textContent ?? ''));
          onChange();
        }}
      >
        Remove link
      </button>
    </div>,
    document.body,
  );
}

/** The collapsed range under a viewport point, if the browser can tell. */
export function caretAt(x: number, y: number): Range | null {
  const d = document as Document & { caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null };
  const pos = d.caretPositionFromPoint?.(x, y);
  if (pos) {
    const r = document.createRange();
    r.setStart(pos.offsetNode, pos.offset);
    return r;
  }
  return document.caretRangeFromPoint?.(x, y) ?? null;
}

/** Inline editor for a text element. Uncontrolled: the DOM is the draft; the text is committed on blur. */
function TextEditor({ initial, onCommit, onStop, style, caret }: { initial: Paragraph[]; onCommit(p: Paragraph[]): void; onStop(): void; style: CSSProperties; caret?: { x: number; y: number } }) {
  const ref = useRef<HTMLDivElement>(null);
  const committed = useRef(false);
  const [anchor, setAnchor] = useState<HTMLAnchorElement | null>(null);
  // Show the link menu while the caret is inside a link; it hides when the caret leaves or on Escape.
  useEffect(() => {
    const check = () => {
      const sel = window.getSelection();
      const node = sel?.anchorNode;
      const el = node instanceof Element ? node : (node?.parentElement ?? null);
      const a = el?.closest('a[data-r]') ?? null;
      setAnchor(a && ref.current?.contains(a) && sel?.isCollapsed !== false ? (a as HTMLAnchorElement) : null);
    };
    document.addEventListener('selectionchange', check);
    return () => document.removeEventListener('selectionchange', check);
  }, []);
  const commit = () => {
    if (committed.current || !ref.current) return;
    committed.current = true;
    onCommit(parseEditedText(ref.current, initial));
  };
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    // Placeholder text is replaced by typing; real text gets the caret at the end.
    if (!(initial.length === 1 && PLACEHOLDERS.has(initial[0].text))) range.collapse(false);
    // A click on the text puts the caret where it landed.
    const at = caret ? caretAt(caret.x, caret.y) : null;
    if (at && el.contains(at.startContainer)) {
      range.setStart(at.startContainer, at.startOffset);
      range.collapse(true);
    }
    sel?.removeAllRanges();
    sel?.addRange(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => () => commit(), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div
      ref={ref}
      className="sl-text sl-editing"
      style={style}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      onBlur={() => {
        commit();
        onStop();
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          setAnchor(null);
          commit();
          onStop();
        } else if (e.key === 'Tab') {
          // Indent or outdent the bullet the caret is in.
          e.preventDefault();
          const node = window.getSelection()?.anchorNode;
          let block: HTMLElement | null = node instanceof HTMLElement ? node : (node?.parentElement ?? null);
          while (block && block.parentElement !== ref.current) block = block.parentElement;
          if (!block) return;
          const level = Math.max(0, Math.min(4, (Number(block.dataset.level) || 0) + (e.shiftKey ? -1 : 1)));
          block.dataset.level = level ? String(level) : '';
          if (!level) delete block.dataset.level;
          if (block.dataset.bullet === undefined && !e.shiftKey) block.dataset.bullet = '1';
          const bullet = block.dataset.bullet === '1';
          block.style.paddingLeft = `${(bullet ? 28 : 0) + level * 28}px`;
          block.classList.toggle('bullet', bullet);
        } else if ((e.metaKey || e.ctrlKey) && ['b', 'i', 'u'].includes(e.key.toLowerCase())) {
          e.preventDefault(); // Styling applies to the whole element from the toolbar.
        }
      }}
      onPaste={(e) => {
        // Plain text only, as paragraphs.
        e.preventDefault();
        const text = e.clipboardData.getData('text/plain');
        const sel = window.getSelection();
        if (!sel?.rangeCount) return;
        sel.deleteFromDocument();
        const lines = text.split(/\r?\n/);
        const range = sel.getRangeAt(0);
        range.insertNode(document.createTextNode(lines.join(' ')));
        range.collapse(false);
      }}
    >
      <Paragraphs paragraphs={initial} />
      {anchor && anchor.isConnected && <LinkBubble anchor={anchor} onChange={() => setAnchor(null)} />}
    </div>
  );
}

/** Inline editor for a table cell's text: plain text, lines kept. Uncontrolled, committed on blur, Tab or Escape. */
function CellEditor({ initial, editing }: { initial: string; editing: NonNullable<TableCellState['editing']> }) {
  const ref = useRef<HTMLDivElement>(null);
  const committed = useRef(false);
  const commit = () => {
    if (committed.current || !ref.current) return;
    committed.current = true;
    editing.onCommit((ref.current.innerText ?? '').replace(/\u200b/g, '').replace(/\n$/, ''));
  };
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.textContent = initial;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => () => commit(), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div
      ref={ref}
      className="sl-cell-editor sl-editing"
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck={false}
      onBlur={() => {
        commit();
        editing.onStop();
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          commit();
          editing.onStop();
        } else if (e.key === 'Tab') {
          e.preventDefault();
          commit();
          editing.onMove(e.shiftKey ? -1 : 1);
        }
      }}
    />
  );
}

/** A chart element, drawn in the deck's colors on the slide's background. */
function SlideChartView({ el, theme, w, h }: { el: ChartElement; theme: Theme; w: number; h: number }) {
  return <ChartView chart={chartOfSlide(el.chart, w, h)} data={el.data} width={w} height={h} look={{ background: 'none', text: theme.text, muted: theme.muted, grid: mixColor(theme.muted, theme.bg, 0.3), font: theme.bodyFont }} />;
}

/** A table element: an HTML table filling its box, its rows sharing the height and its columns the width by their shares. */
function TableView({ el, theme, bg, cell }: { el: TableElement; theme: Theme; bg?: string; cell?: TableCellState | null }) {
  const colors = tableColors(el, theme, bg);
  const shares = colShares(el);
  const size = el.style?.size ?? TABLE_SIZE;
  const border = colors.border === 'none' ? 'none' : `1px solid ${colors.border}`;
  return (
    <table className="sl-table-grid" style={{ fontSize: size, fontFamily: el.style?.font ? `${fontFamilies(el.style.font)}, ${theme.bodyFont}` : theme.bodyFont, color: colors.text }}>
      <colgroup>
        {shares.map((w, i) => (
          <col key={i} style={{ width: `${w * 100}%` }} />
        ))}
      </colgroup>
      <tbody>
        {el.rows.map((row, r) => (
          <tr key={r} style={{ height: `${100 / el.rows.length}%` }}>
            {row.map((c, ci) => {
              const look = cellLook(el, r, ci, colors);
              const current = cell && cell.r === r && cell.c === ci;
              return (
                <td
                  key={ci}
                  data-cell={`${r}:${ci}`}
                  className={current ? 'current' : undefined}
                  style={{
                    border,
                    padding: `${TABLE_PAD.y}px ${TABLE_PAD.x}px`,
                    background: look.fill,
                    color: look.color,
                    fontWeight: look.bold ? 700 : 400,
                    fontStyle: look.italic ? 'italic' : 'normal',
                    textAlign: look.align,
                  }}
                >
                  {current && cell.editing ? <CellEditor initial={c.text} editing={cell.editing} /> : c.text || '\u200b'}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function SlideView({ slide, theme: themeId, scale, preview, editing, tableCell, onElementMouseDown, onElementDoubleClick, playVideo, children, className }: SlideViewProps) {
  const theme = THEMES[themeId];
  // On the editor canvas (not present mode or thumbnails) a plain click on a link of a non-editing box shows the link menu.
  const [linkAnchor, setLinkAnchor] = useState<HTMLAnchorElement | null>(null);
  useEffect(() => {
    if (!linkAnchor) return;
    const down = (e: globalThis.MouseEvent) => {
      const t = e.target as Element | null;
      if (!t?.closest?.('.doc-link-bubble') && !linkAnchor.contains(t)) setLinkAnchor(null);
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setLinkAnchor(null);
    document.addEventListener('mousedown', down, true);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('mousedown', down, true);
      document.removeEventListener('keydown', key, true);
    };
  }, [linkAnchor]);
  useEffect(() => setLinkAnchor(null), [editing?.id]);
  return (
    <div
      className={`slide-scaler${className ? ` ${className}` : ''}`}
      style={{ width: SLIDE_W * scale, height: SLIDE_H * scale }}
      onClick={(e) => {
        if (!onElementMouseDown || e.metaKey || e.ctrlKey) return;
        const a = (e.target as Element).closest?.('a.sl-link');
        if (a && !a.closest('.sl-editing')) setLinkAnchor(a as HTMLAnchorElement);
      }}
    >
      {linkAnchor && linkAnchor.isConnected && <LinkBubble anchor={linkAnchor} onChange={() => setLinkAnchor(null)} />}
      <div className="slide" style={{ ...themeVars(theme), width: SLIDE_W, height: SLIDE_H, transform: `scale(${scale})`, background: slide.bg ?? theme.bg }}>
        {slide.elements.map((el) => {
          const box = boxStyle(el, preview?.[el.id]);
          const common = {
            'data-el': el.id,
            onMouseDown: onElementMouseDown ? (e: MouseEvent) => onElementMouseDown(e, el) : undefined,
            onDoubleClick: onElementDoubleClick ? (e: MouseEvent) => onElementDoubleClick(e, el) : undefined,
          };
          if (el.type === 'text') {
            const style = { ...box, ...textStyleOf(el, theme) };
            if (editing?.id === el.id) {
              return (
                <div key={el.id} className="sl-el" style={box} data-el={el.id}>
                  <TextEditor initial={el.paragraphs} onCommit={editing.onCommit} onStop={editing.onStop} caret={editing.caret} style={{ ...textStyleOf(el, theme), width: '100%', height: '100%' }} />
                </div>
              );
            }
            return (
              <div key={el.id} {...common} className="sl-el sl-text" style={style}>
                <Paragraphs paragraphs={el.paragraphs} live={!onElementMouseDown} />
              </div>
            );
          }
          if (el.type === 'line') {
            const live = { ...el, ...preview?.[el.id] };
            return (
              <div key={el.id} {...common} className="sl-el sl-line-el" style={{ left: live.x, top: live.y, width: live.w, height: live.h }}>
                <LineDrawing el={live} theme={theme} hit={!!onElementMouseDown} />
              </div>
            );
          }
          if (el.type === 'image') {
            return (
              <div key={el.id} {...common} className="sl-el sl-image" style={{ ...box, ...(el.clip ? { clipPath: el.clip } : {}), ...(el.crop ? { overflow: 'hidden' } : {}), ...(el.opacity !== undefined ? { opacity: el.opacity } : {}) }}>
                {el.duotone && <DuotoneFilter id={`sl-duo-${el.id}`} tones={el.duotone} />}
                <img src={el.src} alt="" draggable={false} style={{ ...imageStyle(el), ...(el.duotone ? { filter: `url(#sl-duo-${el.id})` } : {}) }} />
              </div>
            );
          }
          if (el.type === 'chart') {
            return (
              <div key={el.id} {...common} className="sl-el sl-chart" style={box}>
                <SlideChartView el={el} theme={theme} w={preview?.[el.id]?.w ?? el.w} h={preview?.[el.id]?.h ?? el.h} />
              </div>
            );
          }
          if (el.type === 'table') {
            return (
              <div key={el.id} {...common} className="sl-el sl-table" style={box}>
                <TableView el={el} theme={theme} bg={slide.bg} cell={tableCell?.id === el.id ? tableCell : null} />
              </div>
            );
          }
          if (el.type === 'video') {
            // A player takes its own clicks (they must not move the element or advance the show).
            if (playVideo === true || playVideo === el.id) {
              return (
                <div key={el.id} className="sl-el sl-video" style={box} data-el={el.id} onClick={(e) => e.stopPropagation()}>
                  <VideoPlayer src={el.src} autoPlay={playVideo === el.id} />
                </div>
              );
            }
            return (
              <div key={el.id} {...common} className="sl-el sl-video" style={box}>
                <VideoPoster src={el.src} />
              </div>
            );
          }
          const style = { ...box, ...shapeStyle(el, theme) };
          const polygon = <ShapeDrawing el={el} theme={theme} box={preview?.[el.id] ?? {}} />;
          if (editing?.id === el.id) {
            return (
              <div key={el.id} className="sl-el sl-shape" style={style} data-el={el.id}>
                {polygon}
                <TextEditor
                  initial={[{ text: el.text ?? '' }]}
                  onCommit={(ps) => editing.onCommit(ps)}
                  onStop={editing.onStop}
                  caret={editing.caret}
                  style={{ width: '100%', height: '100%', justifyContent: 'center', textAlign: 'center', fontSize: el.textSize ?? 18 }}
                />
              </div>
            );
          }
          return (
            <div key={el.id} {...common} className={`sl-el sl-shape sl-${el.shape}`} style={style}>
              {polygon}
              {el.text ? <span>{el.text}</span> : null}
            </div>
          );
        })}
        {children}
      </div>
    </div>
  );
}
