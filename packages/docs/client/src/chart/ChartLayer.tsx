// The charts of the active tab, over the grid's canvas: each one placed from its anchor cell with the grid's
// layout (so it scrolls with the cells and follows row and column sizes), drawn by ChartView. A click selects
// a chart, a drag moves it, the corner handle resizes it, a double-click opens its editor, and Delete removes
// it. The wheel over a chart scrolls the grid.
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';
import { chartData, type Chart } from '../../../shared/chart.ts';
import { COL_HEADER_H, ROW_HEADER_W, colX, rowY, type Layout, type Viewport } from '../grid/layout.ts';
import type { SheetController } from '../state/controller.ts';
import { ChartView } from './ChartView.tsx';

/** A chart being moved or resized: its box in the grid's content coordinates as the drag leaves it. */
interface Drag {
  id: string;
  kind: 'move' | 'resize';
  startX: number;
  startY: number;
  /** Where the chart was: content x and y of its corner, and its size. */
  x: number;
  y: number;
  w: number;
  h: number;
  now: { x: number; y: number; w: number; h: number };
  moved: boolean;
}

const MIN_W = 120;
const MIN_H = 80;

/** A chart's corner in the grid's content coordinates (the scrolled sheet, frozen panes left out). */
function contentPos(layout: Layout, ch: Chart): { x: number; y: number } {
  return { x: layout.cols.start(ch.anchor.c) + ch.anchor.dx, y: layout.rows.start(ch.anchor.r) + ch.anchor.dy };
}

/** The anchor (cell and offset into it) of a point in content coordinates. */
function anchorAt(layout: Layout, x: number, y: number): Chart['anchor'] {
  const cx = Math.max(0, x);
  const cy = Math.max(0, y);
  const c = layout.cols.indexAt(cx);
  const r = layout.rows.indexAt(cy);
  return { r, c, dx: Math.round(cx - layout.cols.start(c)), dy: Math.round(cy - layout.rows.start(r)) };
}

export function ChartLayer({ ctl, layout, vp, scroller }: { ctl: SheetController; layout: Layout; vp: Viewport; scroller: RefObject<HTMLDivElement | null> }) {
  const charts = ctl.charts;
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const set = (d: Drag | null) => {
    dragRef.current = d;
    setDrag(d);
  };

  // A press anywhere but on a chart (the cells, a menu) leaves the chart selected no more.
  useEffect(() => {
    if (!ctl.selectedChart) return;
    const down = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t?.closest?.('.sheet-chart, .chart-editor, .menu, .modal-backdrop')) ctl.selectChart(null);
    };
    window.addEventListener('mousedown', down, true);
    return () => window.removeEventListener('mousedown', down, true);
  }, [ctl, ctl.selectedChart]);

  useEffect(() => {
    if (!drag) return;
    const move = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      const now = d.kind === 'move' ? { x: Math.max(0, d.x + dx), y: Math.max(0, d.y + dy), w: d.w, h: d.h } : { x: d.x, y: d.y, w: Math.max(MIN_W, d.w + dx), h: Math.max(MIN_H, d.h + dy) };
      set({ ...d, now, moved: d.moved || Math.abs(dx) + Math.abs(dy) > 2 });
    };
    const up = () => {
      const d = dragRef.current;
      set(null);
      if (!d?.moved) return;
      const { x, y, w, h } = d.now;
      ctl.updateChart(d.id, (c) => (d.kind === 'move' ? { ...c, anchor: anchorAt(layout, x, y) } : { ...c, w: Math.round(w), h: Math.round(h) }));
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [ctl, drag, layout]);

  if (!charts.length) return null;
  const begin = (e: ReactMouseEvent, ch: Chart, kind: Drag['kind']) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    ctl.selectChart(ch.id);
    (e.currentTarget.closest('.sheet-chart') as HTMLElement | null)?.focus();
    const p = contentPos(layout, ch);
    set({ id: ch.id, kind, startX: e.clientX, startY: e.clientY, x: p.x, y: p.y, w: ch.w, h: ch.h, now: { ...p, w: ch.w, h: ch.h }, moved: false });
  };

  return (
    <div className="chart-layer" style={{ left: ROW_HEADER_W, top: COL_HEADER_H, width: Math.max(0, vp.width - ROW_HEADER_W), height: Math.max(0, vp.height - COL_HEADER_H) }}>
      {charts.map((ch) => {
        const d = drag?.id === ch.id ? drag.now : null;
        // On the screen: the anchor's cell where the grid draws it (a frozen row or column does not scroll), plus the offset.
        const sx = ch.anchor.c < layout.frozenCols ? 0 : vp.scrollX;
        const sy = ch.anchor.r < layout.frozenRows ? 0 : vp.scrollY;
        const x = d ? ROW_HEADER_W + d.x - sx : colX(layout, vp, ch.anchor.c) + ch.anchor.dx;
        const y = d ? COL_HEADER_H + d.y - sy : rowY(layout, vp, ch.anchor.r) + ch.anchor.dy;
        const w = d?.w ?? ch.w;
        const h = d?.h ?? ch.h;
        const left = x - ROW_HEADER_W;
        const top = y - COL_HEADER_H;
        if (left > vp.width || top > vp.height || left + w < 0 || top + h < 0) return null;
        const selected = ctl.selectedChart === ch.id;
        return (
          <div
            key={ch.id}
            className={`sheet-chart${selected ? ' selected' : ''}`}
            style={{ left, top, width: w, height: h }}
            tabIndex={-1}
            role="figure"
            aria-label={ch.title ? `Chart: ${ch.title}` : 'Chart'}
            onMouseDown={(e) => begin(e, ch, 'move')}
            onDoubleClick={() => ctl.editChart(ch.id)}
            onWheel={(e) => scroller.current?.scrollBy({ left: e.deltaX, top: e.deltaY })}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                ctl.deleteChart(ch.id);
              } else if (e.key === 'Escape') ctl.selectChart(null);
              else if (e.key === 'Enter') ctl.editChart(ch.id);
            }}
          >
            <SheetChart ctl={ctl} chart={ch} w={w - 2} h={h - 2} />
            {selected && <div className="sheet-chart-handle" onMouseDown={(e) => begin(e, ch, 'resize')} title="Drag to resize" />}
          </div>
        );
      })}
    </div>
  );
}

/** One chart with its data read from the workbook (again whenever the workbook changes). */
function SheetChart({ ctl, chart, w, h }: { ctl: SheetController; chart: Chart; w: number; h: number }) {
  const version = ctl.store.version;
  const tab = ctl.tab;
  const data = useMemo(() => chartData(ctl.store.workbook, ctl.store.engine, tab, chart), [ctl.store, tab, chart, version]); // eslint-disable-line react-hooks/exhaustive-deps
  return <ChartView chart={chart} data={data} width={w} height={h} />;
}
