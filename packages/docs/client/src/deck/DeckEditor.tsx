// The editing canvas: the current slide scaled to fit, with selection outlines and resize handles. Elements
// are moved and resized with the mouse (one undo step per drag), text is edited inline on double-click, and
// image files dropped on the slide become image elements.
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useHasAgent } from '../agent/AgentProvider.tsx';
import { InlinePrompt } from '../agent/InlinePrompt.tsx';
import { fitZoomActions, useWheelZoom, ZoomControls } from '../components/ZoomControls.tsx';
import { SLIDE_H, SLIDE_W, THEMES, type LineElement, type SlideElement } from '../../../shared/deck.ts';
import { boxFromEnds, compactLine, DEFAULT_LINE_WIDTH, lineEnds, lineGeometry, nearSites, SITES, sitePoint, snapAngle, type SiteHit } from '../../../shared/lines.ts';
import { clickTarget, elementsInBox, frameUnderPointer } from '../../../shared/deckHit.ts';
import { CropOverlay } from './CropOverlay.tsx';
import { arcGeometry, arcTightBox, type ArcGeom } from '../../../shared/shapes.ts';
import { colShares } from '../../../shared/deckTable.ts';
import type { DeckController } from './controller.ts';
import { LineDrawing, SlideView, type BoxPreview, type TableCellState } from './SlideView.tsx';

/** The table cell (row, column) under a pointer event, if it is on one. */
function cellAt(e: { target: EventTarget | null }): { r: number; c: number } | null {
  const td = (e.target as Element | null)?.closest?.('[data-cell]');
  const m = td && /^(\d+):(\d+)$/.exec(td.getAttribute('data-cell') ?? '');
  return m ? { r: Number(m[1]), c: Number(m[2]) } : null;
}

/** Dragging the border between two columns of a table. */
interface ColDrag {
  id: string;
  /** The border's index: between column i - 1 and column i. */
  i: number;
  startX: number;
  shares: number[];
  /** The widths as the drag leaves them. */
  cols: number[];
}

/** The narrowest a column can be dragged, as a share of the table. */
const MIN_COL = 0.04;

/** Dragging a line: drawing a new one, moving one of its ends, or its middle (an elbow's bend). */
/** A selection box being drawn, by where the press was and where the pointer is, on the screen. */
interface Marquee {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** The selection the box adds to (Shift), or nothing. */
  base: string[];
  moved: boolean;
}

interface LineDrag {
  mode: 'draw' | 'start' | 'end' | 'mid';
  /** The line as it looks now (a draft while drawing). */
  line: LineElement;
  /** The end that stays put while the other is dragged. */
  fixed: { x: number; y: number };
  moved: boolean;
  /** Elements whose connection points are shown, and the one the dragged end snaps to. */
  near: SlideElement[];
  snap?: SiteHit;
}

const linePreview = (l: LineElement): BoxPreview => ({ x: l.x, y: l.y, w: l.w, h: l.h, flipH: l.flipH, flipV: l.flipV, startConnection: l.startConnection, endConnection: l.endConnection, bend: l.bend });

type Box = { x: number; y: number; w: number; h: number };
type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

interface Drag {
  kind: 'move' | 'resize' | 'arc';
  handle?: Handle;
  /** Arc endpoint drags: which end moves; the ellipse (center and radii) stays fixed. */
  arc?: { end: 'start' | 'end'; geom: ArcGeom; start: number; stop: number; sw: number };
  startX: number;
  startY: number;
  boxes: Record<string, Box>;
  ratios: Record<string, number | null>;
  preview: Record<string, BoxPreview>;
  moved: boolean;
  /** Set when the press began on an already-selected text box: a click without movement edits it at the click point. */
  clickEdit?: string;
  /** The same for a cell of an already-selected table: a click without movement edits the cell. */
  clickCell?: { id: string; r: number; c: number };
}

const MIN_SIZE = 10;
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

function handlePos(h: Handle, b: Box): { left: number; top: number } {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const left = h.includes('w') ? b.x : h.includes('e') ? b.x + b.w : cx;
  const top = h.includes('n') ? b.y : h.includes('s') ? b.y + b.h : cy;
  return { left, top };
}

function resizeBox(orig: Box, h: Handle, dx: number, dy: number, ratio: number | null): Box {
  let { x, y, w, h: hh } = orig;
  if (h.includes('e')) w = Math.max(MIN_SIZE, orig.w + dx);
  if (h.includes('w')) {
    w = Math.max(MIN_SIZE, orig.w - dx);
    x = orig.x + orig.w - w;
  }
  if (h.includes('s')) hh = Math.max(MIN_SIZE, orig.h + dy);
  if (h.includes('n')) {
    hh = Math.max(MIN_SIZE, orig.h - dy);
    y = orig.y + orig.h - hh;
  }
  // Corner handles keep the aspect ratio of images.
  if (ratio && h.length === 2) {
    hh = Math.max(MIN_SIZE, w * ratio);
    if (h.includes('n')) y = orig.y + orig.h - hh;
  }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(hh) };
}

export function DeckEditor({
  ctl,
  onImageFiles,
  onEditImage,
  onContextMenu,
}: {
  ctl: DeckController;
  onImageFiles(files: File[]): void;
  /** Open the image editor on a picture element (a double-click on it). */
  onEditImage?(id: string): void;
  /** A right-click on the slide, after the element under it (if any) is selected: the page shows its menu there. */
  onContextMenu?(at: { x: number; y: number }): void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 450 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const caretRef = useRef<{ x: number; y: number } | null>(null); // where a click-to-edit landed, for the caret
  // The video playing in place (a double-click on it), for as long as it alone is selected.
  const [played, setPlaying] = useState<string | null>(null);
  const playing = played && ctl.selection.length === 1 && ctl.selection[0] === played ? played : null;
  useEffect(() => {
    if (played && !playing) setPlaying(null);
  }, [played, playing]);

  // 1 fits the slide to the window. It is how the user looks at the deck, not part of it, so it is not saved.
  const [zoom, setZoom] = useState(1);
  const frameRef = useRef<HTMLDivElement>(null);

  // The frame is measured rather than the canvas inside it, whose own size changes when scrollbars come and go.
  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const scale = Math.max(0.1, Math.min((size.w - 48) / SLIDE_W, (size.h - 48) / SLIDE_H)) * zoom;

  useWheelZoom(frameRef, setZoom);
  const slide = ctl.slide;
  const selected = ctl.selected;

  // --- Lines: drawing, and dragging their ends ---
  const [lineDrag, setLineDrag] = useState<LineDrag | null>(null);
  const lineRef = useRef<LineDrag | null>(null);
  const setLd = (d: LineDrag | null) => {
    lineRef.current = d;
    setLineDrag(d);
  };

  /** A pointer position in slide points. */
  const toSlide = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = wrapRef.current?.querySelector('.slide')?.getBoundingClientRect();
    return r ? [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale] : [0, 0];
  };

  const startDraw = (e: ReactMouseEvent) => {
    const tool = ctl.tool;
    if (!tool) return;
    e.preventDefault();
    wrapRef.current?.focus();
    const [px, py] = toSlide(e);
    const { near, snap } = nearSites(slide.elements, px, py, 14 / scale, 28 / scale);
    const [x, y] = snap ? [snap.x, snap.y] : [px, py];
    const line: LineElement = {
      id: 'draft',
      type: 'line',
      kind: tool.kind,
      x,
      y,
      w: 0,
      h: 0,
      strokeWidth: DEFAULT_LINE_WIDTH,
      ...(tool.arrow ? { endArrow: 'arrow' as const } : {}),
      ...(snap ? { startConnection: { elementId: snap.elementId, site: snap.site } } : {}),
    };
    setLd({ mode: 'draw', line, fixed: { x, y }, moved: false, near, snap });
  };

  const startEndDrag = (e: ReactMouseEvent, line: LineElement, mode: LineDrag['mode']) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    wrapRef.current?.focus();
    const ends = lineEnds(line);
    const fixed = mode === 'start' ? { x: ends.x2, y: ends.y2 } : { x: ends.x1, y: ends.y1 };
    setLd({ mode, line, fixed, moved: false, near: [], snap: undefined });
  };

  useEffect(() => {
    if (!lineDrag) return;
    const onMove = (e: MouseEvent) => {
      const d = lineRef.current;
      if (!d) return;
      const [px, py] = toSlide(e);
      let { line } = d;
      let near: SlideElement[] = [];
      let snap: SiteHit | undefined;
      if (d.mode === 'mid') {
        const { x1, y1, x2, y2 } = lineEnds(line);
        const axis = lineGeometry(line).bendAxis;
        const bend = axis === 'y' ? (y2 === y1 ? 0.5 : (py - y1) / (y2 - y1)) : x2 === x1 ? 0.5 : (px - x1) / (x2 - x1);
        line = { ...line, bend: Math.round(Math.min(1, Math.max(0, bend)) * 100) / 100 };
      } else {
        ({ near, snap } = nearSites(slide.elements, px, py, 14 / scale, 28 / scale, d.mode === 'draw' ? undefined : line.id));
        const [qx, qy] = snap ? [snap.x, snap.y] : e.shiftKey ? snapAngle(d.fixed.x, d.fixed.y, px, py) : [px, py];
        const dragStart = d.mode === 'start';
        const [x1, y1, x2, y2] = dragStart ? [qx, qy, d.fixed.x, d.fixed.y] : [d.fixed.x, d.fixed.y, qx, qy];
        const conn = snap ? { elementId: snap.elementId, site: snap.site } : undefined;
        line = { ...line, flipH: undefined, flipV: undefined, ...boxFromEnds(x1, y1, x2, y2), ...(dragStart ? { startConnection: conn } : { endConnection: conn }) };
      }
      setLd({ ...d, line, near, snap, moved: d.moved || Math.hypot(px - d.fixed.x, py - d.fixed.y) >= 2 || d.mode === 'mid' });
    };
    const onUp = () => {
      const d = lineRef.current;
      setLd(null);
      if (!d) return;
      if (d.mode === 'draw') {
        ctl.setTool(null);
        const { x1, y1, x2, y2 } = lineEnds(d.line);
        if (!d.moved) return;
        ctl.addLine(d.line.kind, d.line.endArrow === 'arrow', { x1, y1, x2, y2, startConnection: d.line.startConnection, endConnection: d.line.endConnection });
        return;
      }
      if (!d.moved) return;
      ctl.updateElements([d.line.id], (el) => (el.type === 'line' ? compactLine({ ...el, ...linePreview(d.line) }) : el));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!lineDrag, scale]);

  // Escape puts the line tool away.
  useEffect(() => {
    if (!ctl.tool) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') ctl.setTool(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ctl, ctl.tool]);

  const beginDrag = (e: ReactMouseEvent, kind: Drag['kind'], ids: string[], handle?: Handle, arc?: Drag['arc']) => {
    const boxes: Record<string, Box> = {};
    const ratios: Record<string, number | null> = {};
    for (const el of slide.elements) {
      if (!ids.includes(el.id)) continue;
      boxes[el.id] = { x: el.x, y: el.y, w: el.w, h: el.h };
      ratios[el.id] = (el.type === 'image' || el.type === 'video') && el.w > 0 ? el.h / el.w : null;
    }
    const d: Drag = { kind, handle, arc, startX: e.clientX, startY: e.clientY, boxes, ratios, preview: {}, moved: false };
    dragRef.current = d;
    setDrag(d);
  };

  // Window-level listeners while dragging, so fast mouse moves outside the slide still count.
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = (e.clientX - d.startX) / scale;
      const dy = (e.clientY - d.startY) / scale;
      const preview: Record<string, BoxPreview> = {};
      if (d.arc) {
        // Rotate the dragged endpoint about the fixed ellipse center to point at the mouse.
        const { geom, sw } = d.arc;
        const rect = wrapRef.current?.querySelector('.slide')?.getBoundingClientRect();
        if (rect) {
          const px = (e.clientX - rect.left) / scale - geom.cx;
          const py = (e.clientY - rect.top) / scale - geom.cy;
          const deg = Math.round(((Math.atan2(py / (geom.ry || 1), px / (geom.rx || 1)) * 180) / Math.PI + 360) % 360);
          const start = d.arc.end === 'start' ? deg : d.arc.start;
          const stop = d.arc.end === 'end' ? deg : d.arc.stop;
          preview[Object.keys(d.boxes)[0]] = { ...arcTightBox(geom, start, stop, sw), startAngle: start, endAngle: stop };
        }
      }
      for (const id in d.arc ? {} : d.boxes) {
        const b = d.boxes[id];
        preview[id] = d.kind === 'move' ? { x: Math.round(b.x + dx), y: Math.round(b.y + dy) } : resizeBox(b, d.handle!, dx, dy, e.shiftKey ? null : d.ratios[id]);
      }
      const next = { ...d, preview, moved: d.moved || Math.abs(dx) + Math.abs(dy) >= 1 };
      dragRef.current = next;
      setDrag(next);
    };
    const onUp = (e: MouseEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (d && !d.moved && d.clickEdit && e.detail < 2) {
        caretRef.current = { x: e.clientX, y: e.clientY };
        ctl.startEditing(d.clickEdit);
      }
      if (d && !d.moved && d.clickCell && e.detail < 2) ctl.selectCell(d.clickCell.id, d.clickCell.r, d.clickCell.c, true);
      if (!d?.moved) return;
      if (d.kind === 'move') {
        const to: Record<string, { x: number; y: number }> = {};
        for (const id in d.preview) to[id] = { x: d.preview[id].x!, y: d.preview[id].y! };
        ctl.moveElements(to);
      } else ctl.updateElements(Object.keys(d.preview), (el) => ({ ...el, ...d.preview[el.id] }));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!drag, scale]);

  // --- The selection box: a drag that starts on the slide's background or the backdrop selects what it touches ---
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const marqueeRef = useRef<Marquee | null>(null);
  const setMq = (m: Marquee | null) => {
    marqueeRef.current = m;
    setMarquee(m);
  };
  /** What the box touches, with what was selected before it when Shift is held. */
  const marqueeIds = (m: Marquee): string[] => {
    const hit = elementsInBox(slide.elements, ...toSlide({ clientX: m.x0, clientY: m.y0 }), ...toSlide({ clientX: m.x1, clientY: m.y1 })).map((el) => el.id);
    return [...m.base, ...hit.filter((id) => !m.base.includes(id))];
  };
  useEffect(() => {
    if (!marquee) return;
    const onMove = (e: MouseEvent) => {
      const m = marqueeRef.current;
      if (m) setMq({ ...m, x1: e.clientX, y1: e.clientY, moved: m.moved || Math.abs(e.clientX - m.x0) + Math.abs(e.clientY - m.y0) >= 3 });
    };
    const onUp = () => {
      const m = marqueeRef.current;
      setMq(null);
      // A press that never moved was a click on the background, which has already cleared the selection.
      if (m?.moved) ctl.select(marqueeIds(m));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!marquee, scale]);

  // Around a frame (a shape that is only an outline) a click is for the frame near its line, on either side,
  // and for what lies under it in its open middle: see shared/deckHit.ts. The band is in screen pixels, so a
  // thin line is as easy to take hold of at any zoom.
  const reach = 8 / scale;
  const through = (e: { clientX: number; clientY: number }, el: SlideElement): SlideElement => clickTarget(slide.elements, el, ...toSlide(e), reach) ?? el;
  /** The frame the pointer is on the line of, shown outlined: a click there takes it. */
  const [hoverFrame, setHoverFrame] = useState<string | null>(null);
  const onPointerMove = (e: ReactMouseEvent) => {
    let over: string | null = null;
    if (!drag && !lineDrag && !marquee && !ctl.tool && !ctl.editing && !ctl.cropping) {
      const at = (e.target as Element).closest?.('[data-el]')?.getAttribute('data-el');
      const hit = at ? (slide.elements.find((el) => el.id === at) ?? null) : null;
      over = frameUnderPointer(slide.elements, hit, ...toSlide(e), reach)?.id ?? null;
    }
    if (over !== hoverFrame) setHoverFrame(over);
  };

  const onElementMouseDown = (e: ReactMouseEvent, el: SlideElement) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (ctl.tool) {
      startDraw(e);
      return;
    }
    pressElement(e, through(e, el));
  };

  /** A press that is for this element: select it (or add it to the selection) and be ready to drag it. */
  const pressElement = (e: ReactMouseEvent, el: SlideElement) => {
    const cell = el.type === 'table' ? cellAt(e) : null;
    if (ctl.editing === el.id) {
      // In a table being edited, a press on another cell edits that one.
      const cur = ctl.tableCell;
      if (cell && cur && (cell.r !== cur.r || cell.c !== cur.c)) {
        e.preventDefault();
        ctl.selectCell(el.id, cell.r, cell.c, true);
      }
      return;
    }
    const wasSelected = ctl.selection.length === 1 && ctl.selection[0] === el.id;
    caretRef.current = null;
    if (ctl.editing) ctl.stopEditing();
    // The default is prevented below (so a drag doesn't select text), which would leave focus in whatever
    // field had it; take it so Delete, arrows and ⌘Z reach the editor.
    wrapRef.current?.focus();
    let ids: string[];
    if (e.shiftKey) {
      ids = ctl.selection.includes(el.id) ? ctl.selection.filter((x) => x !== el.id) : [...ctl.selection, el.id];
      ctl.select(ids);
    } else {
      ids = ctl.selection.includes(el.id) ? ctl.selection : [el.id];
      // A press on a table's cell makes it the current cell, which the table commands act on.
      if (cell && (ids.length === 1 || !ctl.selection.includes(el.id))) {
        ids = [el.id];
        ctl.selectCell(el.id, cell.r, cell.c);
      } else if (ids !== ctl.selection) ctl.select(ids);
    }
    e.preventDefault();
    if (ids.length) {
      beginDrag(e, 'move', ids);
      // Clicking the text of an already-selected box (a link instead shows its menu) enters edit mode on release.
      if (wasSelected && !e.shiftKey && (el.type === 'text' || el.type === 'shape') && !(e.target as Element).closest?.('a.sl-link')) dragRef.current!.clickEdit = el.id;
      if (wasSelected && !e.shiftKey && cell) dragRef.current!.clickCell = { id: el.id, ...cell };
    }
  };

  const onElementDoubleClick = (e: ReactMouseEvent, hit: SlideElement) => {
    const el = through(e, hit);
    if (el.type === 'text' || el.type === 'shape') ctl.startEditing(el.id);
    else if (el.type === 'table') {
      const cell = cellAt(e);
      if (cell) ctl.selectCell(el.id, cell.r, cell.c, true);
    } else if (el.type === 'image') onEditImage?.(el.id);
    else if (el.type === 'video') setPlaying(el.id);
  };

  // The id is captured here, not read at commit time: a click outside the box ends editing first, and the
  // editor then commits as it unmounts, when ctl.editing is already null.
  const editingId = ctl.editing;
  const editing = editingId
    ? {
        id: editingId,
        caret: caretRef.current ?? undefined,
        onCommit: (paragraphs: { text: string; bullet?: boolean; level?: number }[]) => {
          const id = editingId;
          ctl.updateElements([id], (el) => {
            if (el.type === 'text') return { ...el, paragraphs };
            if (el.type === 'shape') {
              const text = paragraphs.map((p) => p.text).join('\n').trim();
              const next = { ...el };
              if (text) next.text = text;
              else delete next.text;
              return next;
            }
            return el;
          });
        },
        onStop: () => ctl.stopEditing(),
      }
    : null;

  const cur = ctl.tableCell && ctl.selection.length === 1 && ctl.selection[0] === ctl.tableCell.id ? ctl.tableCell : null;
  const tableCell: TableCellState | null = cur
    ? {
        ...cur,
        ...(ctl.editing === cur.id
          ? {
              editing: {
                onCommit: (text: string) => ctl.setCellText(cur.id, cur.r, cur.c, text),
                onMove: (step: 1 | -1) => ctl.moveCell(step),
                onStop: () => {
                  ctl.stopEditing();
                  wrapRef.current?.focus();
                },
              },
            }
          : {}),
      }
    : null;

  // --- Table columns: dragging the border between two ---
  const [colDrag, setColDrag] = useState<ColDrag | null>(null);
  const colRef = useRef<ColDrag | null>(null);
  const setCd = (d: ColDrag | null) => {
    colRef.current = d;
    setColDrag(d);
  };
  useEffect(() => {
    if (!colDrag) return;
    const onMove = (e: MouseEvent) => {
      const d = colRef.current;
      const el = slide.elements.find((x) => x.id === d?.id);
      if (!d || !el || el.w <= 0) return;
      const pair = d.shares[d.i - 1] + d.shares[d.i];
      const left = Math.max(MIN_COL, Math.min(pair - MIN_COL, d.shares[d.i - 1] + (e.clientX - d.startX) / scale / el.w));
      const cols = [...d.shares];
      cols[d.i - 1] = left;
      cols[d.i] = pair - left;
      setCd({ ...d, cols });
    };
    const onUp = () => {
      const d = colRef.current;
      setCd(null);
      if (d && d.cols.some((w, i) => Math.abs(w - d.shares[i]) > 1e-4)) ctl.setTableOptions({ cols: d.cols });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!colDrag, scale]);
  const shown = colDrag ? { ...slide, elements: slide.elements.map((x) => (x.id === colDrag.id && x.type === 'table' ? { ...x, cols: colDrag.cols } : x)) } : slide;

  // The prompt to the assistant sits under the selected elements, or at the top of the slide when nothing is selected.
  const [, setTick] = useState(0);
  const assisting = useHasAgent() && !!ctl.assistant;
  useEffect(() => {
    if (!assisting) return;
    const bump = () => setTick((t) => t + 1);
    window.addEventListener('scroll', bump, true);
    window.addEventListener('resize', bump);
    return () => {
      window.removeEventListener('scroll', bump, true);
      window.removeEventListener('resize', bump);
    };
  }, [assisting]);
  const assistAnchor = () => {
    const r = wrapRef.current?.querySelector('.slide')?.getBoundingClientRect();
    if (!r) return null;
    if (!selected.length) return { left: r.left + 48, top: r.top + 24, bottom: r.top + 24 };
    const left = Math.min(...selected.map((el) => el.x));
    const top = Math.min(...selected.map((el) => el.y));
    const bottom = Math.max(...selected.map((el) => el.y + el.h));
    return { left: r.left + left * scale + 24, top: r.top + top * scale, bottom: r.top + bottom * scale };
  };

  const cropped = ctl.cropping ? slide.elements.find((e) => e.id === ctl.cropping) : undefined;
  // A picture being cropped has its own frame and handles, not the selection's.
  const single = selected.length === 1 && !ctl.editing && !cropped ? selected[0] : null;
  const boxOf = (el: SlideElement): Box => ({ x: el.x, y: el.y, w: el.w, h: el.h, ...drag?.preview[el.id] });
  const preview: Record<string, BoxPreview> | undefined = lineDrag && lineDrag.mode !== 'draw' ? { ...drag?.preview, [lineDrag.line.id]: linePreview(lineDrag.line) } : drag?.preview;
  const boxed = marquee?.moved ? marqueeIds(marquee) : [];
  const theme = THEMES[ctl.deck.theme];
  const dot = 9 / scale;
  const hs = 10 / scale; // handles keep their screen size

  return (
    <div ref={frameRef} className="deck-canvas-frame">
    <div
      ref={wrapRef}
      className={`deck-canvas${zoom > 1 ? ' zoomed' : ''}${drag ? ` dragging ${drag.kind}` : ''}${ctl.tool ? ' drawing' : ''}${hoverFrame ? ' over-frame' : ''}`}
      onMouseMove={onPointerMove}
      onMouseLeave={() => hoverFrame && setHoverFrame(null)}
      tabIndex={-1}
      onContextMenu={(e) => {
        // Text being typed keeps the system's menu (its spelling suggestions); so does a crop in progress.
        if (!onContextMenu || ctl.editing || ctl.cropping || ctl.tool) return;
        e.preventDefault();
        const at = (e.target as Element).closest?.('[data-el]')?.getAttribute('data-el');
        const hit = at ? slide.elements.find((el) => el.id === at) : undefined;
        const el = hit ? through(e, hit) : clickTarget(slide.elements, null, ...toSlide(e), reach);
        // The element clicked is what the menu acts on: it joins the selection only if it is not in it already.
        if (el && !ctl.selection.includes(el.id)) ctl.select([el.id]);
        else if (!el) ctl.select([]);
        wrapRef.current?.focus();
        onContextMenu({ x: e.clientX, y: e.clientY });
      }}
      onMouseDown={(e) => {
        if (e.button === 0 && ctl.tool) {
          startDraw(e);
          return;
        }
        // A click on the backdrop or the slide background clears the selection, unless it is just outside a
        // frame's line, which takes the frame.
        if (e.button === 0 && (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('slide') || (e.target as HTMLElement).classList.contains('slide-scaler'))) {
          const frame = clickTarget(slide.elements, null, ...toSlide(e), reach);
          if (frame) {
            pressElement(e, frame);
            return;
          }
          if (ctl.editing) ctl.stopEditing();
          // Shift keeps the selection, for a box that adds to it.
          if (!e.shiftKey) ctl.select([]);
          wrapRef.current?.focus();
          // Dragging from here draws a selection box (and must not select the page's text on the way).
          e.preventDefault();
          setMq({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, base: e.shiftKey ? ctl.selection : [], moved: false });
        }
      }}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        const files = Array.from(e.dataTransfer.files ?? []).filter((f) => f.type.startsWith('image/'));
        if (!files.length) return;
        e.preventDefault();
        onImageFiles(files);
      }}
    >
      <SlideView slide={shown} theme={ctl.deck.theme} scale={scale} preview={preview} editing={editing} tableCell={tableCell} onElementMouseDown={onElementMouseDown} onElementDoubleClick={onElementDoubleClick} playVideo={playing} className="deck-canvas-slide">
        {lineDrag?.mode === 'draw' && (
          <div className="sl-el" style={{ left: lineDrag.line.x, top: lineDrag.line.y, width: lineDrag.line.w, height: lineDrag.line.h, pointerEvents: 'none' }}>
            <LineDrawing el={lineDrag.line} theme={theme} />
          </div>
        )}
        {lineDrag?.near.flatMap((t) =>
          SITES.map((site) => {
            const p = sitePoint(t, site);
            const active = lineDrag.snap?.elementId === t.id && lineDrag.snap.site === site;
            return <div key={`${t.id}-${site}`} className={`sl-site${active ? ' active' : ''}`} style={{ left: p.x - dot / 2, top: p.y - dot / 2, width: dot, height: dot, borderWidth: 1 / scale }} />;
          }),
        )}
        {single?.type === 'line' &&
          (() => {
            const live = { ...single, ...preview?.[single.id] };
            const { x1, y1, x2, y2 } = lineEnds(live);
            const geo = lineGeometry(live);
            const handle = (key: string, x: number, y: number, mode: LineDrag['mode'], cls = '') => (
              <div
                key={key}
                className={`sl-endpoint ${cls}`}
                style={{ left: x - hs / 2, top: y - hs / 2, width: hs, height: hs, borderWidth: 1 / scale }}
                onMouseDown={(e) => startEndDrag(e, live, mode)}
              />
            );
            return [handle('start', x1, y1, 'start'), handle('end', x2, y2, 'end'), ...(live.kind !== 'straight' && geo.bendAxis ? [handle('mid', geo.mid.x, geo.mid.y, 'mid', 'mid')] : [])];
          })()}
        {cropped?.type === 'image' && <CropOverlay key={cropped.id} el={cropped} scale={scale} toSlide={toSlide} onDone={(next) => ctl.stopCropping(next)} onCancel={() => ctl.stopCropping()} />}
        {(() => {
          // The frame a click would take, when it is not the selection already.
          const el = hoverFrame && !ctl.selection.includes(hoverFrame) ? slide.elements.find((x) => x.id === hoverFrame) : undefined;
          return el ? <div className="sl-outline sl-outline-hover" style={{ left: el.x, top: el.y, width: el.w, height: el.h, borderWidth: 2 / scale, ...(el.rot ? { transform: `rotate(${el.rot}deg)` } : {}) }} /> : null;
        })()}
        {marquee?.moved &&
          // What the box would select, outlined as it is drawn (a line shows its own ends once selected).
          slide.elements
            .filter((el) => el.type !== 'line' && !ctl.selection.includes(el.id) && boxed.includes(el.id))
            .map((el) => <div key={`mq-${el.id}`} className="sl-outline" style={{ left: el.x, top: el.y, width: el.w, height: el.h, borderWidth: 1.5 / scale, ...(el.rot ? { transform: `rotate(${el.rot}deg)` } : {}) }} />)}
        {selected.map((el) => {
          if (el.type === 'line' || el.id === cropped?.id) return null;
          const b = boxOf(el);
          return <div key={el.id} className="sl-outline" style={{ left: b.x, top: b.y, width: b.w, height: b.h, borderWidth: 1.5 / scale, ...(el.rot ? { transform: `rotate(${el.rot}deg)` } : {}) }} />;
        })}
        {single?.type === 'table' &&
          !single.rot &&
          (() => {
            // A grip on each border between two columns; dragging it moves the border.
            const b = boxOf(single);
            const shares = colDrag?.id === single.id ? colDrag.cols : colShares(single);
            let at = 0;
            return shares.slice(0, -1).map((w, k) => {
              at += w;
              const i = k + 1;
              return (
                <div
                  key={`col-${i}`}
                  className="sl-col-grip"
                  style={{ left: b.x + at * b.w - 4 / scale, top: b.y, width: 8 / scale, height: b.h }}
                  title="Drag to change the column widths"
                  onMouseDown={(e) => {
                    if (e.button !== 0) return;
                    e.stopPropagation();
                    e.preventDefault();
                    wrapRef.current?.focus();
                    const start = colShares(single);
                    setCd({ id: single.id, i, startX: e.clientX, shares: start, cols: start });
                  }}
                />
              );
            });
          })()}
        {single?.type === 'shape' &&
          single.shape === 'arc' &&
          (['start', 'end'] as const).map((end) => {
            // Two endpoint handles; dragging one rotates it about the fixed ellipse center.
            const b = boxOf(single);
            const sw = single.strokeWidth ?? 2;
            const start = drag?.preview[single.id]?.startAngle ?? single.startAngle ?? 270;
            const stop = drag?.preview[single.id]?.endAngle ?? single.endAngle ?? 0;
            const geom = drag?.arc?.geom ?? arcGeometry({ ...single, ...b, startAngle: start, endAngle: stop }, sw);
            const a = ((end === 'start' ? start : stop) * Math.PI) / 180;
            const left = geom.cx + geom.rx * Math.cos(a);
            const top = geom.cy + geom.ry * Math.sin(a);
            return (
              <div
                key={end}
                className="sl-handle"
                style={{ left: left - hs / 2, top: top - hs / 2, width: hs, height: hs, borderWidth: 1 / scale }}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  e.stopPropagation();
                  e.preventDefault();
                  wrapRef.current?.focus();
                  beginDrag(e, 'arc', [single.id], undefined, { end, geom: arcGeometry(single, sw), start: single.startAngle ?? 270, stop: single.endAngle ?? 0, sw });
                }}
              />
            );
          })}
        {single &&
          single.type !== 'line' &&
          !single.rot && // a rotated box moves but has no resize handles
          !(single.type === 'shape' && single.shape === 'arc') && // an arc has its endpoint handles instead
          (single.type === 'shape' && single.shape === 'line' && !(single.w > 0 && single.h > 0) ? ((single.h > single.w ? ['n', 's'] : ['e', 'w']) as Handle[]) : HANDLES).map((h) => {
            const b = boxOf(single);
            const p = handlePos(h, b);
            return (
              <div
                key={h}
                className={`sl-handle sl-handle-${h}`}
                style={{ left: p.left - hs / 2, top: p.top - hs / 2, width: hs, height: hs, borderWidth: 1 / scale }}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  e.stopPropagation();
                  e.preventDefault();
                  wrapRef.current?.focus();
                  beginDrag(e, 'resize', [single.id], h);
                }}
              />
            );
          })}
      </SlideView>
    </div>
      {marquee?.moved && <div className="deck-marquee" style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }} />}
      <ZoomControls percent={scale * 100} {...fitZoomActions(zoom, setZoom)} />
      {assisting && ctl.assistant && (
        <InlinePrompt
          anchor={assistAnchor()}
          placeholder={ctl.assistant.text ? 'Ask the assistant about the selected text…' : selected.length ? `Ask the assistant about the selected element${selected.length === 1 ? '' : 's'}…` : 'Ask the assistant about this slide…'}
          onClose={() => {
            ctl.setAssistant(null);
            wrapRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}
