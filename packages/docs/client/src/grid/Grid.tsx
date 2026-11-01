import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { cellKey, type CellPos, type Range } from '../../../shared/cellref.ts';
import { FUNCTION_DOCS } from '../../../shared/formula/functions.ts';
import type { SheetController } from '../state/controller.ts';
import { autocompleteAt, formulaRefs, functionHint } from '../state/formulaEdit.ts';
import { existingKeysIn } from '../state/ops.ts';
import type { WorkbookStore } from '../state/store.ts';
import { useController } from '../state/useController.ts';
import {
  COL_HEADER_H,
  DEFAULT_COL_W,
  DEFAULT_ROW_H,
  FOOTER_H,
  Layout,
  ROW_HEADER_W,
  cellRect,
  colAtX,
  colX,
  rowAtY,
  rowY,
  type Viewport,
} from './layout.ts';
import {
  CHANGE_COLORS,
  cellFont,
  drawGrid,
  fillHandleRect,
  filterButtonRect,
  linkAt,
  measure,
  onCellImageLoad,
  rangeRect,
  FONT_FAMILY,
  FONT_SIZE,
  type ChangeSide,
  type CompareOverlay,
} from './render.ts';
import type { CellDiff } from '../../../shared/diff.ts';
import { hasContent } from '../../../shared/types.ts';
import { clipboardImage, uploadImageFile } from '../cellImage.ts';
import { ChartLayer } from '../chart/ChartLayer.tsx';

type Hit =
  | { area: 'corner' }
  | { area: 'freeze'; axis: 'row' | 'col' }
  | { area: 'colHeader'; c: number; edge?: number }
  | { area: 'rowHeader'; r: number; edge?: number }
  | { area: 'cell'; r: number; c: number; fillHandle?: boolean; selEdge?: boolean; filterCol?: number };

type Drag =
  | { kind: 'select' }
  | { kind: 'cols' }
  | { kind: 'rows' }
  | { kind: 'colMove'; c: number; moved: boolean; before: number | null }
  | { kind: 'resize'; axis: 'col' | 'row'; idx: number[]; start: number; startSize: number; size: number }
  | { kind: 'fill'; src: Range; target: Range | null }
  | { kind: 'move'; src: Range; grab: CellPos; dest: CellPos | null }
  | { kind: 'point'; anchor: CellPos }
  | { kind: 'freeze'; axis: 'row' | 'col'; n: number };

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Open a cell link in a new browser tab, without giving the page access to this one. */
function openLink(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.click();
}

export function Grid({ ctl, notify }: { ctl: SheetController; notify?: (msg: string) => void }) {
  useController(ctl);
  // Redraw when a cell image finishes loading.
  const [, setImagesLoaded] = useState(0);
  useEffect(() => onCellImageLoad(() => setImagesLoaded((n) => n + 1)), []);
  const tab = ctl.tab;
  const sel = ctl.sel;
  const edit = ctl.edit;
  const store = ctl.store as WorkbookStore<unknown>;

  const scrollerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [size, setSize] = useState({ width: 800, height: 500 });
  const [scroll, setScroll] = useState({ x: 0, y: 0 });
  const [freezeGuide, setFreezeGuide] = useState<{ axis: 'row' | 'col'; pos: number } | null>(null);
  const [resizePreview, setResizePreview] = useState<{ axis: 'col' | 'row'; idx: number[]; size: number } | null>(null);
  const [previews, setPreviews] = useState<{ fill: Range | null; move: Range | null }>({ fill: null, move: null });
  /** Column boundary where dragged columns would be dropped (drop indicator), or null. */
  const [colDrop, setColDrop] = useState<number | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; title: string; lines: string[]; kind: 'error' | ChangeSide } | null>(null);
  const [acIndex, setAcIndex] = useState(0);
  const [acDismissed, setAcDismissed] = useState<string | null>(null);
  const [addRowsCount, setAddRowsCount] = useState('1000');
  const dragRef = useRef<Drag | null>(null);
  const scrollByTab = useRef(new Map<string, { x: number; y: number }>());
  const pasteValuesOnly = useRef(false);

  const hidden = ctl.hiddenRows();
  const layout = useMemo(() => {
    const colOverride = resizePreview?.axis === 'col' ? { ...tab.colWidths, ...Object.fromEntries(resizePreview.idx.map((i) => [i, resizePreview.size])) } : undefined;
    const rowOverride = resizePreview?.axis === 'row' ? { ...tab.rowHeights, ...Object.fromEntries(resizePreview.idx.map((i) => [i, resizePreview.size])) } : undefined;
    return new Layout(tab, hidden, colOverride, rowOverride);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, hidden, tab.rows, tab.cols, tab.colWidths, tab.rowHeights, tab.frozenRows, tab.frozenCols, resizePreview]);
  const vp: Viewport = { width: size.width, height: size.height, scrollX: scroll.x, scrollY: scroll.y };

  // Latest values for window-level event handlers.
  const live = useRef({ layout, vp });
  live.current = { layout, vp };

  // ---------------------------------------------------------------------------
  // Sizing & scrolling

  useLayoutEffect(() => {
    const el = scrollerRef.current!;
    const ro = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    ctl.pageRows = Math.max(1, Math.floor((size.height - COL_HEADER_H) / DEFAULT_ROW_H) - 1);
  }, [ctl, size.height]);

  // Restore per-tab scroll position when switching tabs.
  const prevTab = useRef(tab.id);
  useLayoutEffect(() => {
    if (prevTab.current === tab.id) return;
    scrollByTab.current.set(prevTab.current, { x: scroll.x, y: scroll.y });
    prevTab.current = tab.id;
    const s = scrollByTab.current.get(tab.id) ?? { x: 0, y: 0 };
    const el = scrollerRef.current!;
    el.scrollLeft = s.x;
    el.scrollTop = s.y;
    setScroll({ x: el.scrollLeft, y: el.scrollTop });
  }, [tab.id, scroll.x, scroll.y]);

  const onScroll = () => {
    const el = scrollerRef.current!;
    setScroll({ x: el.scrollLeft, y: el.scrollTop });
    setTip(null);
  };

  const ensureVisible = useCallback((r: number, c: number) => {
    const el = scrollerRef.current;
    if (!el) return;
    const { layout: l, vp: v } = live.current;
    const dataW = v.width - ROW_HEADER_W;
    const dataH = v.height - COL_HEADER_H;
    if (r >= l.frozenRows && r < l.rows.count) {
      const top = l.rows.start(r) - l.frozenH;
      const bottom = l.rows.end(r);
      if (top < el.scrollTop) el.scrollTop = top;
      else if (bottom - el.scrollTop > dataH) el.scrollTop = bottom - dataH;
    }
    if (c >= l.frozenCols && c < l.cols.count) {
      const left = l.cols.start(c) - l.frozenW;
      const right = l.cols.end(c);
      if (left < el.scrollLeft) el.scrollLeft = left;
      else if (right - el.scrollLeft > dataW) el.scrollLeft = right - dataW;
    }
  }, []);

  const scrollSeq = ctl.scrollRequest?.seq;
  useLayoutEffect(() => {
    const req = ctl.scrollRequest;
    if (req) ensureVisible(req.r, req.c);
  }, [scrollSeq, ctl, ensureVisible, layout]);

  // ---------------------------------------------------------------------------
  // Drawing

  const refs = useMemo(() => {
    if (!edit || edit.tabId !== tab.id) return [];
    return formulaRefs(edit.text)
      .filter((f) => f.ref.sheet === undefined || f.ref.sheet.toLowerCase() === tab.name.toLowerCase())
      .map((f) => {
        const ref = f.ref;
        const range: Range =
          ref.kind === 'cols'
            ? { r1: 0, r2: tab.rows - 1, c1: Math.min(ref.c1, ref.c2), c2: Math.max(ref.c1, ref.c2) }
            : ref.kind === 'rows'
              ? { c1: 0, c2: tab.cols - 1, r1: Math.min(ref.r1, ref.r2), r2: Math.max(ref.r1, ref.r2) }
              : { r1: Math.min(ref.r1, ref.r2), r2: Math.max(ref.r1, ref.r2), c1: Math.min(ref.c1, ref.c2), c2: Math.max(ref.c1, ref.c2) };
        return { ...f, range };
      });
  }, [edit, tab]);

  // Branch comparison marks for this tab (respecting the Yours / Original / Conflict filters).
  const cmp = ctl.compare;
  const tabDiff = cmp?.diff?.tabs.find((t) => t.tabId === tab.id);
  const { compareOverlay, compareCells } = useMemo(() => {
    const cells = new Map<string, CellDiff>();
    if (!cmp || !tabDiff) return { compareOverlay: null as CompareOverlay | null, compareCells: cells };
    const visible = tabDiff.cells.filter((c) => cmp.show[c.side]);
    for (const c of visible) cells.set(`${c.r},${c.c}`, c);
    const overlay: CompareOverlay = {
      cells: visible.map((c) => ({ r: c.r, c: c.c, side: c.side })),
      rows: tabDiff.rows.filter((r) => cmp.show[r.side]).map((r) => ({ at: r.at, side: r.side, inBranch: r.inBranch })),
    };
    return { compareOverlay: overlay, compareCells: cells };
  }, [cmp, tabDiff]);

  const search = ctl.search;
  const allHits = search ? ctl.searchMatches() : null;
  const searchHits = useMemo(() => {
    if (!allHits) return null;
    const cells = allHits.filter((h) => h.tabId === tab.id);
    const cur = search && search.current >= 0 ? allHits[search.current] : undefined;
    return { cells, current: cur && cur.tabId === tab.id ? cur : null };
  }, [allHits, search, tab.id]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current!;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(size.width * dpr);
    const h = Math.round(size.height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d')!;
    drawGrid(ctx, {
      tab,
      store,
      layout,
      vp,
      sel,
      edit,
      copyMark: ctl.copyMark && ctl.copyMark.tabId === tab.id ? ctl.copyMark.range : null,
      fillPreview: previews.fill,
      movePreview: previews.move,
      colDrop,
      refs,
      compare: compareOverlay,
      searchHits,
      dpr,
    });
  });

  // ---------------------------------------------------------------------------
  // Focus

  const focusSink = useCallback(() => {
    const ta = taRef.current;
    if (!ta || document.activeElement === ta) return;
    if (ctl.edit?.source === 'bar') return;
    ta.focus({ preventScroll: true });
  }, [ctl]);

  // Reclaiming focus is only right while the user is in this document. Inside ChatGPT the grid is an
  // iframe beside the composer: taking focus from there on a re-render (the revision poll) would pull the
  // user's typing into a cell.
  const reclaimFocus = useCallback(() => {
    if (document.hasFocus()) focusSink();
  }, [focusSink]);

  useEffect(() => {
    // Return focus to the grid when menus/dialogs close.
    if (!ctl.menu && !ctl.filterMenu && !ctl.renamingTabId && (document.activeElement === document.body || !document.activeElement)) {
      reclaimFocus();
    }
  });

  useEffect(() => {
    reclaimFocus();
  }, [reclaimFocus]);

  // Keep the textarea caret in sync with controller-driven text changes (autocomplete, pointing).
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta || !edit || edit.source !== 'cell') return;
    if (ta.selectionStart !== edit.caret || ta.selectionEnd !== edit.caret) {
      if (document.activeElement === ta) ta.setSelectionRange(edit.caret, edit.caret);
    }
  }, [edit]);

  // ---------------------------------------------------------------------------
  // Hit testing

  const pointOf = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const prevVisibleRow = (l: Layout, r: number) => {
    let p = r - 1;
    while (p >= 0 && l.rows.size(p) === 0) p--;
    return p;
  };

  const hitTest = (x: number, y: number): Hit => {
    const { layout: l, vp: v } = live.current;
    if (x < ROW_HEADER_W && y < COL_HEADER_H) return { area: 'corner' };
    if (l.frozenRows && Math.abs(y - (COL_HEADER_H + l.frozenH)) <= 3) return { area: 'freeze', axis: 'row' };
    if (l.frozenCols && Math.abs(x - (ROW_HEADER_W + l.frozenW)) <= 3) return { area: 'freeze', axis: 'col' };
    const c = colAtX(l, v, Math.max(x, ROW_HEADER_W));
    const r = rowAtY(l, v, Math.max(y, COL_HEADER_H));
    if (y < COL_HEADER_H) {
      const left = colX(l, v, c);
      const right = left + l.cols.size(c);
      if (Math.abs(x - right) <= 4) return { area: 'colHeader', c, edge: c };
      if (Math.abs(x - left) <= 3 && c > 0) return { area: 'colHeader', c, edge: c - 1 };
      return { area: 'colHeader', c };
    }
    if (x < ROW_HEADER_W) {
      const top = rowY(l, v, r);
      const bottom = top + l.rows.size(r);
      if (Math.abs(y - bottom) <= 3) return { area: 'rowHeader', r, edge: r };
      const pr = prevVisibleRow(l, r);
      if (Math.abs(y - top) <= 3 && pr >= 0) return { area: 'rowHeader', r, edge: pr };
      return { area: 'rowHeader', r };
    }
    const f = ctl.tab.filter;
    if (f && r === f.r1 && c >= f.c1 && c <= f.c2) {
      const b = filterButtonRect(l, v, f, c);
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return { area: 'cell', r, c, filterCol: c };
    }
    const s = ctl.sel;
    if (!ctl.edit && s.ranges.length === 1) {
      const fh = fillHandleRect(l, v, s.ranges[0]);
      if (x >= fh.x - 3 && x <= fh.x + fh.w + 3 && y >= fh.y - 3 && y <= fh.y + fh.h + 3) return { area: 'cell', r, c, fillHandle: true };
      const rr = rangeRect(l, v, s.ranges[0]);
      const nearV = (Math.abs(x - rr.x) <= 3 || Math.abs(x - (rr.x + rr.w)) <= 3) && y >= rr.y - 3 && y <= rr.y + rr.h + 3;
      const nearH = (Math.abs(y - rr.y) <= 3 || Math.abs(y - (rr.y + rr.h)) <= 3) && x >= rr.x - 3 && x <= rr.x + rr.w + 3;
      const whole = s.ranges[0].r1 === 0 && s.ranges[0].r2 === ctl.tab.rows - 1;
      if ((nearV || nearH) && !whole) return { area: 'cell', r, c, selEdge: true };
    }
    return { area: 'cell', r, c };
  };

  // ---------------------------------------------------------------------------
  // Drag handling with auto-scroll

  const lastMouse = useRef({ x: 0, y: 0 });
  const autoScrollRaf = useRef<number | null>(null);

  const updateDrag = (x: number, y: number) => {
    const d = dragRef.current;
    if (!d) return;
    const { layout: l, vp: v } = live.current;
    const cx = Math.min(Math.max(x, ROW_HEADER_W + 1), v.width - 1);
    const cy = Math.min(Math.max(y, COL_HEADER_H + 1), v.height - 1);
    const r = rowAtY(l, v, cy);
    const c = colAtX(l, v, cx);
    switch (d.kind) {
      case 'select': {
        const f = ctl.sel.focus;
        if (f.r !== r || f.c !== c) ctl.selectCell({ r, c }, { extend: true });
        break;
      }
      case 'cols':
        ctl.selectCols(c, c, { extend: true });
        break;
      case 'rows':
        ctl.selectRows(r, r, { extend: true });
        break;
      case 'colMove': {
        const boundary = cx < colX(l, v, c) + l.cols.size(c) / 2 ? c : c + 1;
        const rg = ctl.primary;
        d.moved ||= c !== d.c;
        d.before = d.moved && (boundary < rg.c1 || boundary > rg.c2 + 1) ? boundary : null;
        setColDrop(d.before);
        break;
      }
      case 'freeze': {
        const row = d.axis === 'row';
        const lay = row ? l.rows : l.cols;
        const scroll = row ? v.scrollY : v.scrollX;
        let p = row ? y - COL_HEADER_H : x - ROW_HEADER_W;
        if (p > (row ? l.frozenH : l.frozenW)) p += scroll;
        p = Math.min(Math.max(p, 0), Math.max(0, lay.total - 1));
        const i = lay.indexAt(p);
        d.n = Math.min(lay.count, p < lay.start(i) + lay.size(i) / 2 ? i : i + 1);
        const shown = d.n > (row ? l.frozenRows : l.frozenCols) ? scroll : 0;
        setFreezeGuide({ axis: d.axis, pos: (row ? COL_HEADER_H : ROW_HEADER_W) + lay.start(d.n) - shown });
        break;
      }
      case 'resize': {
        const pos = d.axis === 'col' ? x : y;
        const min = d.axis === 'col' ? 20 : 12;
        d.size = Math.max(min, d.startSize + pos - d.start);
        setResizePreview({ axis: d.axis, idx: d.idx, size: d.size });
        break;
      }
      case 'fill': {
        const s = d.src;
        const below = r - s.r2;
        const above = s.r1 - r;
        const right = c - s.c2;
        const left = s.c1 - c;
        const vDist = Math.max(below, above, 0);
        const hDist = Math.max(right, left, 0);
        let target: Range | null = null;
        if (vDist > 0 && vDist >= hDist) target = below > 0 ? { ...s, r2: r } : { ...s, r1: r };
        else if (hDist > 0) target = right > 0 ? { ...s, c2: c } : { ...s, c1: c };
        d.target = target;
        setPreviews({ fill: target, move: null });
        break;
      }
      case 'move': {
        const dest = { r: Math.max(0, r - d.grab.r), c: Math.max(0, c - d.grab.c) };
        d.dest = dest;
        setPreviews({ fill: null, move: { r1: dest.r, c1: dest.c, r2: dest.r + d.src.r2 - d.src.r1, c2: dest.c + d.src.c2 - d.src.c1 } });
        break;
      }
      case 'point':
        ctl.pointAt(d.anchor, { r, c });
        break;
    }
  };

  const autoScrollTick = () => {
    autoScrollRaf.current = null;
    const d = dragRef.current;
    const el = scrollerRef.current;
    if (!d || !el || d.kind === 'resize' || d.kind === 'freeze') return;
    const { x, y } = lastMouse.current;
    const { layout: l, vp: v } = live.current;
    let dx = 0;
    let dy = 0;
    if (d.kind !== 'rows') {
      if (x > v.width) dx = Math.min(40, (x - v.width) / 2 + 4);
      else if (x < ROW_HEADER_W + l.frozenW && el.scrollLeft > 0) dx = -Math.min(40, (ROW_HEADER_W + l.frozenW - x) / 2 + 4);
    }
    if (d.kind !== 'cols' && d.kind !== 'colMove') {
      if (y > v.height) dy = Math.min(60, (y - v.height) / 2 + 4);
      else if (y < COL_HEADER_H + l.frozenH && el.scrollTop > 0) dy = -Math.min(60, (COL_HEADER_H + l.frozenH - y) / 2 + 4);
    }
    if (!dx && !dy) return;
    el.scrollLeft += dx;
    el.scrollTop += dy;
    live.current = { ...live.current, vp: { ...live.current.vp, scrollX: el.scrollLeft, scrollY: el.scrollTop } };
    updateDrag(x, y);
    autoScrollRaf.current = requestAnimationFrame(autoScrollTick);
  };

  const onWindowMove = (e: globalThis.MouseEvent) => {
    const p = pointOf(e);
    lastMouse.current = p;
    updateDrag(p.x, p.y);
    if (autoScrollRaf.current === null) autoScrollRaf.current = requestAnimationFrame(autoScrollTick);
  };

  const stopDragListeners = () => {
    window.removeEventListener('mousemove', onWindowMove);
    window.removeEventListener('mouseup', onWindowUp);
    window.removeEventListener('keydown', onDragKey, true);
    if (autoScrollRaf.current !== null) cancelAnimationFrame(autoScrollRaf.current);
    autoScrollRaf.current = null;
  };

  /** Escape cancels a column drag. */
  const onDragKey = (e: globalThis.KeyboardEvent) => {
    if (e.key !== 'Escape' || dragRef.current?.kind !== 'colMove') return;
    e.preventDefault();
    e.stopPropagation();
    stopDragListeners();
    dragRef.current = null;
    setColDrop(null);
  };

  const onWindowUp = () => {
    stopDragListeners();
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (d.kind === 'freeze') {
      setFreezeGuide(null);
      if (d.axis === 'row') ctl.setFrozen(d.n, undefined);
      else ctl.setFrozen(undefined, d.n);
    } else if (d.kind === 'resize') {
      setResizePreview(null);
      if (d.size !== d.startSize) {
        if (d.axis === 'col') ctl.setColWidth(d.idx, d.size);
        else ctl.setRowHeight(d.idx, d.size);
      }
    } else if (d.kind === 'colMove') {
      setColDrop(null);
      if (d.before !== null) ctl.moveCols(d.before);
      else if (!d.moved) ctl.selectCols(d.c, d.c);
    } else if (d.kind === 'fill') {
      setPreviews({ fill: null, move: null });
      if (d.target) ctl.fill(d.src, d.target);
    } else if (d.kind === 'move') {
      setPreviews({ fill: null, move: null });
      if (d.dest && (d.dest.r !== d.src.r1 || d.dest.c !== d.src.c1)) ctl.moveSelection(d.dest.r, d.dest.c);
    }
    focusSink();
  };

  const startDrag = (d: Drag) => {
    dragRef.current = d;
    window.addEventListener('mousemove', onWindowMove);
    window.addEventListener('mouseup', onWindowUp);
    if (d.kind === 'colMove') window.addEventListener('keydown', onDragKey, true);
  };

  // ---------------------------------------------------------------------------
  // Mouse events

  const onMouseDown = (e: MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setTip(null);
    const { x, y } = pointOf(e);
    lastMouse.current = { x, y };
    const h = hitTest(x, y);
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (ctl.menu) ctl.openMenu(null);

    // Clicking a link's text opens it; while editing, Cmd/Ctrl+click opens a link in any cell.
    if (h.area === 'cell' && h.filterCol === undefined && !h.fillHandle && !h.selEdge && !e.shiftKey && (ctl.edit ? mod : !mod)) {
      const url = ctl.edit ? store.link(ctl.tab.id, h.r, h.c) : linkUnder(x, h.r, h.c);
      if (url) {
        if (!ctl.edit) ctl.selectCell({ r: h.r, c: h.c });
        openLink(url);
        return;
      }
    }

    if (ctl.edit && h.area === 'cell' && h.filterCol === undefined && ctl.canPoint()) {
      const anchor = e.shiftKey && ctl.edit.point ? ctl.edit.point.anchor : { r: h.r, c: h.c };
      ctl.pointAt(anchor, { r: h.r, c: h.c });
      startDrag({ kind: 'point', anchor });
      return;
    }
    if (ctl.edit) {
      if (h.area === 'cell' && h.r === ctl.edit.r && h.c === ctl.edit.c && ctl.edit.tabId === tab.id) return;
      ctl.commitEdit();
    }

    switch (h.area) {
      case 'freeze':
        startDrag({ kind: 'freeze', axis: h.axis, n: h.axis === 'row' ? layout.frozenRows : layout.frozenCols });
        break;
      case 'corner':
        ctl.selectAll();
        break;
      case 'colHeader':
        if (h.edge !== undefined) {
          const size0 = layout.cols.size(h.edge);
          startDrag({ kind: 'resize', axis: 'col', idx: ctl.columnsForResize(h.edge), start: x, startSize: size0, size: size0 });
          setResizePreview({ axis: 'col', idx: ctl.columnsForResize(h.edge), size: layout.cols.size(h.edge) });
        } else if (!e.shiftKey && !mod && ctl.canDragCols(h.c)) {
          // Pressing on an already selected column header drags the selected columns to a new position.
          startDrag({ kind: 'colMove', c: h.c, moved: false, before: null });
        } else {
          ctl.selectCols(h.c, h.c, { extend: e.shiftKey, add: mod });
          startDrag({ kind: 'cols' });
        }
        break;
      case 'rowHeader':
        if (h.edge !== undefined) {
          const size0 = layout.rows.size(h.edge);
          startDrag({ kind: 'resize', axis: 'row', idx: ctl.rowsForResize(h.edge), start: y, startSize: size0, size: size0 });
          setResizePreview({ axis: 'row', idx: ctl.rowsForResize(h.edge), size: layout.rows.size(h.edge) });
        } else {
          ctl.selectRows(h.r, h.r, { extend: e.shiftKey, add: mod });
          startDrag({ kind: 'rows' });
        }
        break;
      case 'cell':
        if (h.filterCol !== undefined) {
          const b = filterButtonRect(layout, vp, ctl.tab.filter!, h.filterCol);
          const cr = canvasRef.current!.getBoundingClientRect();
          ctl.openFilterMenu(ctl.filterMenu?.col === h.filterCol ? null : { col: h.filterCol, x: cr.left + b.x + b.w, y: cr.top + b.y + b.h + 2 });
          return;
        }
        if (h.fillHandle) startDrag({ kind: 'fill', src: ctl.primary, target: null });
        else if (h.selEdge) {
          const p = ctl.primary;
          startDrag({ kind: 'move', src: p, grab: { r: Math.min(Math.max(h.r, p.r1), p.r2) - p.r1, c: Math.min(Math.max(h.c, p.c1), p.c2) - p.c1 }, dest: null });
        } else {
          ctl.selectCell({ r: h.r, c: h.c }, { extend: e.shiftKey, add: mod });
          startDrag({ kind: 'select' });
        }
        break;
    }
    if (ctl.filterMenu) ctl.openFilterMenu(null);
    focusSink();
  };

  const linkUnder = (x: number, r: number, c: number) => {
    const { layout: l, vp: v } = live.current;
    return linkAt(canvasRef.current!.getContext('2d')!, store, ctl.tab, l, v, r, c, x);
  };

  const autofitCols = (cols: number[]) => {
    const ctx = canvasRef.current!.getContext('2d')!;
    for (const c of cols) {
      let max = 0;
      for (const { r, c: cc } of existingKeysIn(ctl.tab, { r1: 0, r2: ctl.tab.rows - 1, c1: c, c2: c })) {
        const text = store.display(ctl.tab.id, r, cc);
        if (!text) continue;
        const st = ctl.tab.cells[cellKey(r, cc)]?.st;
        const extra = ctl.tab.filter && r === ctl.tab.filter.r1 ? 18 : 0;
        max = Math.max(max, ...text.split('\n').map((ln) => measure(ctx, cellFont(st), ln) + extra));
      }
      ctl.setColWidth([c], max ? max + 10 : DEFAULT_COL_W);
    }
  };

  const onDoubleClick = (e: MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = pointOf(e);
    const h = hitTest(x, y);
    if (h.area === 'colHeader' && h.edge !== undefined) {
      autofitCols(ctl.columnsForResize(h.edge));
    } else if (h.area === 'rowHeader' && h.edge !== undefined) {
      ctl.setRowHeight(ctl.rowsForResize(h.edge), DEFAULT_ROW_H);
    } else if (h.area === 'cell' && h.filterCol === undefined) {
      if (h.fillHandle) {
        fillToAdjacent();
        return;
      }
      if (ctl.edit) return;
      ctl.beginEdit({ mode: 'edit' });
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
        }
      });
    }
  };

  /** Double-clicking the fill handle fills down alongside the adjacent column's data. */
  const fillToAdjacent = () => {
    const p = ctl.primary;
    const t = ctl.tab;
    const has = (r: number, c: number) => c >= 0 && c < t.cols && hasContent(t.cells[cellKey(r, c)]);
    const adj = has(p.r2 + 1, p.c1 - 1) ? p.c1 - 1 : has(p.r2 + 1, p.c2 + 1) ? p.c2 + 1 : -1;
    if (adj < 0) return;
    let last = p.r2;
    while (last + 1 < t.rows && has(last + 1, adj)) last++;
    if (last > p.r2) ctl.fill(p, { ...p, r2: last });
  };

  const onContextMenu = (e: MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const { x, y } = pointOf(e);
    const h = hitTest(x, y);
    if (ctl.edit) ctl.commitEdit();
    const s = ctl.sel;
    const inSel = (r: number, c: number) => s.ranges.some((rg) => r >= rg.r1 && r <= rg.r2 && c >= rg.c1 && c <= rg.c2);
    let kind: 'cell' | 'row' | 'col' | 'corner' = 'cell';
    if (h.area === 'cell') {
      if (!inSel(h.r, h.c)) ctl.selectCell({ r: h.r, c: h.c });
    } else if (h.area === 'colHeader') {
      kind = 'col';
      const full = s.ranges.some((rg) => rg.r1 === 0 && rg.r2 === ctl.tab.rows - 1 && h.c >= rg.c1 && h.c <= rg.c2);
      if (!full) ctl.selectCols(h.c, h.c);
    } else if (h.area === 'rowHeader') {
      kind = 'row';
      const full = s.ranges.some((rg) => rg.c1 === 0 && rg.c2 === ctl.tab.cols - 1 && h.r >= rg.r1 && h.r <= rg.r2);
      if (!full) ctl.selectRows(h.r, h.r);
    } else kind = 'corner';
    ctl.openMenu({ kind, x: e.clientX, y: e.clientY });
  };

  const onMouseMove = (e: MouseEvent<HTMLCanvasElement>) => {
    if (dragRef.current) return;
    const { x, y } = pointOf(e);
    const h = hitTest(x, y);
    let cursor = 'default';
    if (h.area === 'freeze') cursor = h.axis === 'row' ? 'row-resize' : 'col-resize';
    else if (h.area === 'colHeader' && h.edge !== undefined) cursor = 'col-resize';
    else if (h.area === 'colHeader' && ctl.canDragCols(h.c)) cursor = 'grab';
    else if (h.area === 'rowHeader' && h.edge !== undefined) cursor = 'row-resize';
    else if (h.area === 'cell' && h.fillHandle) cursor = 'crosshair';
    else if (h.area === 'cell' && h.selEdge) cursor = 'grab';
    else if (h.area === 'cell' && h.filterCol !== undefined) cursor = 'pointer';
    else if (h.area === 'cell' && !ctl.edit && linkUnder(x, h.r, h.c)) cursor = 'pointer';
    else if (h.area === 'cell') cursor = 'cell';
    canvasRef.current!.style.cursor = cursor;
    if (h.area === 'cell' && !h.fillHandle) {
      const rect = cellRect(layout, vp, h.r, h.c);
      const show = (t: NonNullable<typeof tip>) => {
        if (!tip || tip.title !== t.title || tip.x !== t.x || tip.y !== t.y || tip.lines.join() !== t.lines.join()) setTip(t);
      };
      const change = compareCells.get(`${h.r},${h.c}`);
      if (change) {
        show({ x: rect.x + rect.w, y: rect.y, kind: change.side, title: CHANGE_TITLES[change.side] + (change.formatOnly ? ' (formatting)' : ''), lines: describeChange(change) });
        return;
      }
      const msg = store.engine.getErrorMessage(ctl.tab.id, h.r, h.c);
      if (msg) {
        show({ x: rect.x + rect.w, y: rect.y, kind: 'error', title: 'Error', lines: [msg] });
        return;
      }
    }
    if (tip) setTip(null);
  };

  // ---------------------------------------------------------------------------
  // Editor (hidden textarea doubles as the keyboard / clipboard sink)

  const ac = edit && edit.source === 'cell' && acDismissed !== edit.text ? autocompleteAt(edit.text, edit.caret) : null;
  const hint = edit && !ac ? functionHint(edit.text, edit.caret) : null;

  useEffect(() => setAcIndex(0), [ac?.prefix]);

  const acceptAutocomplete = (name: string) => {
    if (!edit || !ac) return;
    const text = edit.text.slice(0, ac.start) + name + '(' + edit.text.slice(edit.caret);
    ctl.setEditText(text, ac.start + name.length + 1);
  };

  const onEditorKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const ed = ctl.edit;
    const arrows: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };

    if (ed) {
      if (ac) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          setAcIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : ac.matches.length - 1)) % ac.matches.length);
          return;
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.altKey)) {
          e.preventDefault();
          acceptAutocomplete(ac.matches[acIndex] ?? ac.matches[0]);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setAcDismissed(ed.text);
          return;
        }
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.altKey || (e.ctrlKey && isMac)) {
          const ta = e.currentTarget;
          const s = ta.selectionStart;
          const text = ed.text.slice(0, s) + '\n' + ed.text.slice(ta.selectionEnd);
          ctl.setEditText(text, s + 1);
        } else if (mod) {
          ctl.commitEditToSelection();
        } else {
          ctl.commitEdit(e.shiftKey ? [-1, 0] : [1, 0]);
        }
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        ctl.commitEdit([0, e.shiftKey ? -1 : 1]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        ctl.cancelEdit();
        return;
      }
      if (e.key === 'F2') {
        e.preventDefault();
        ctl.setEditMode(ed.mode === 'enter' ? 'edit' : 'enter');
        return;
      }
      if (arrows[e.key] && ed.mode === 'enter' && !mod) {
        e.preventDefault();
        const [dr, dc] = arrows[e.key];
        if (ed.text.startsWith('=') && ctl.canPoint()) ctl.movePoint(dr, dc, e.shiftKey);
        else ctl.commitEdit([dr, dc]);
        return;
      }
      return;
    }

    // --- Not editing -----------------------------------------------------------
    if (mod) {
      const k = e.key.toLowerCase();
      if (k === 'z') {
        e.preventDefault();
        if (e.shiftKey) ctl.redo();
        else ctl.undo();
        return;
      }
      if (k === 'y') {
        e.preventDefault();
        ctl.redo();
        return;
      }
      if (k === 'b' || k === 'i' || k === 'u') {
        e.preventDefault();
        ctl.toggleStyle(k);
        return;
      }
      if (k === 'x' && e.shiftKey) {
        e.preventDefault();
        ctl.toggleStyle('s');
        return;
      }
      if (k === 'a') {
        e.preventDefault();
        ctl.selectAll();
        return;
      }
      if (k === 'd') {
        e.preventDefault();
        ctl.fillDown();
        return;
      }
      if (k === 'r' && !e.shiftKey) {
        e.preventDefault();
        ctl.fillRight();
        return;
      }
      if (k === '\\') {
        e.preventDefault();
        ctl.clearFormatting();
        return;
      }
      if (k === 'v' && e.shiftKey) {
        pasteValuesOnly.current = true;
        return;
      }
      if (e.key === 'Home') {
        e.preventDefault();
        ctl.selectCell({ r: 0, c: 0 });
        return;
      }
      if (e.key === 'End') {
        e.preventDefault();
        const ext = store.engine.extent(ctl.tab.id);
        ctl.selectCell({ r: Math.max(0, ext.rows - 1), c: Math.max(0, ext.cols - 1) });
        return;
      }
    }
    if (e.altKey && e.shiftKey && e.key === '5') {
      e.preventDefault();
      ctl.toggleStyle('s');
      return;
    }
    if (arrows[e.key]) {
      e.preventDefault();
      const [dr, dc] = arrows[e.key];
      ctl.move(dr, dc, { extend: e.shiftKey, jump: mod });
      return;
    }
    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        if (e.shiftKey) ctl.advance(-1, 0);
        else ctl.beginEdit({ mode: 'edit' });
        return;
      case 'Tab':
        e.preventDefault();
        ctl.advance(0, e.shiftKey ? -1 : 1);
        return;
      case 'F2':
        e.preventDefault();
        ctl.beginEdit({ mode: 'edit' });
        return;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        ctl.clearSelection();
        return;
      case 'Escape':
        if (ctl.copyMark) ctl.clearCopyMark();
        else ctl.closeSearch();
        return;
      case 'PageDown':
        e.preventDefault();
        ctl.move(ctl.pageRows, 0, { extend: e.shiftKey });
        return;
      case 'PageUp':
        e.preventDefault();
        ctl.move(-ctl.pageRows, 0, { extend: e.shiftKey });
        return;
      case 'Home':
        e.preventDefault();
        ctl.selectCell({ r: ctl.sel.active.r, c: 0 }, { extend: e.shiftKey });
        return;
      case 'End': {
        e.preventDefault();
        const ext = store.engine.extent(ctl.tab.id);
        ctl.selectCell({ r: ctl.sel.active.r, c: Math.max(0, ext.cols - 1) }, { extend: e.shiftKey });
        return;
      }
    }
  };

  const onEditorChange = (text: string, caret: number) => {
    if (!ctl.edit) ctl.beginEdit({ text, mode: 'enter' });
    else ctl.setEditText(text, caret);
  };

  const onCopy = (e: ClipboardEvent, cut: boolean) => {
    if (ctl.edit) return;
    e.preventDefault();
    const { text, html } = ctl.copy(cut);
    e.clipboardData.setData('text/plain', text);
    e.clipboardData.setData('text/html', html);
  };

  const onPaste = (e: ClipboardEvent) => {
    if (ctl.edit) return;
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    const valuesOnly = pasteValuesOnly.current;
    pasteValuesOnly.current = false;
    if (text) return ctl.paste(text, valuesOnly);
    // No text: paste an image (e.g. a screenshot) into the active cell.
    const file = clipboardImage(e.clipboardData);
    if (!file) {
      // Cells copied here that have no text (e.g. only images) put an empty string on the clipboard.
      if (ctl.internalClipboardText() === '') ctl.paste('', valuesOnly);
      return;
    }
    const at = { tabId: ctl.tab.id, ...ctl.sel.active };
    uploadImageFile(file)
      .then((src) => {
        const problem = ctl.insertImage(src, at);
        if (problem) notify?.(problem);
      })
      .catch((err: Error) => notify?.(err.message));
  };

  // Editor geometry
  const editing = edit && edit.tabId === tab.id;
  const editRect = editing ? cellRect(layout, vp, edit.r, edit.c) : cellRect(layout, vp, sel.active.r, sel.active.c);
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    if (!editing) {
      ta.style.width = '2px';
      ta.style.height = '2px';
      return;
    }
    const maxW = Math.max(editRect.w, size.width - editRect.x - 4);
    ta.style.width = `${editRect.w}px`;
    ta.style.height = `${editRect.h}px`;
    if (ta.scrollWidth > ta.clientWidth) ta.style.width = `${Math.min(maxW, ta.scrollWidth + 8)}px`;
    if (ta.scrollHeight > ta.clientHeight) ta.style.height = `${ta.scrollHeight + 2}px`;
  });

  const editCell = editing ? tab.cells[cellKey(edit.r, edit.c)] : undefined;
  const editorStyle: CSSProperties = editing
    ? {
        left: editRect.x - 1,
        top: editRect.y - 1,
        minWidth: editRect.w + 1,
        minHeight: editRect.h + 1,
        font: cellFont(editCell?.st),
        color: editCell?.st?.color,
        background: editCell?.st?.bg ?? '#fff',
        opacity: 1,
      }
    : { left: Math.max(0, editRect.x), top: Math.max(0, editRect.y), opacity: 0, font: `${FONT_SIZE}px ${FONT_FAMILY}` };

  const popupPos = { left: editRect.x, top: editRect.y + editRect.h + 4 };

  return (
    <div className="grid-wrap">
      <div className="grid-scroller" ref={scrollerRef} onScroll={onScroll}>
        <div
          className="grid-content"
          style={{ width: ROW_HEADER_W + layout.cols.total, height: COL_HEADER_H + layout.rows.total + FOOTER_H }}
        >
          <canvas
            ref={canvasRef}
            className="grid-canvas"
            style={{ width: size.width, height: size.height }}
            onMouseDown={onMouseDown}
            onDoubleClick={onDoubleClick}
            onContextMenu={onContextMenu}
            onMouseMove={onMouseMove}
            onMouseLeave={() => setTip(null)}
          />
          <div className="add-rows" style={{ top: COL_HEADER_H + layout.rows.total + 16, left: 16 }}>
            <button
              className="btn"
              onClick={() => {
                const n = Math.min(10000, Math.max(1, parseInt(addRowsCount, 10) || 0));
                ctl.appendRows(n);
              }}
            >
              Add
            </button>
            <input value={addRowsCount} onChange={(e) => setAddRowsCount(e.target.value.replace(/\D/g, ''))} aria-label="Number of rows to add" />
            <span>more rows at bottom</span>
          </div>
        </div>
      </div>
      <ChartLayer ctl={ctl} layout={layout} vp={vp} scroller={scrollerRef} />
      {freezeGuide && (
        <div
          className="freeze-guide"
          style={freezeGuide.axis === 'row' ? { left: 0, right: 0, top: freezeGuide.pos - 1, height: 3 } : { top: 0, bottom: 0, left: freezeGuide.pos - 1, width: 3 }}
        />
      )}
      <textarea
        ref={taRef}
        className="cell-editor"
        // Holds the focus while the grid is selected; only typing in a cell is text being typed (historyKeys.ts).
        data-typing={edit ? '' : undefined}
        style={editorStyle}
        value={edit?.text ?? ''}
        spellCheck={false}
        autoComplete="off"
        aria-label="Cell editor"
        wrap="off"
        readOnly={!!edit && edit.source === 'bar'}
        onChange={(e) => onEditorChange(e.target.value, e.target.selectionStart)}
        onKeyDown={onEditorKeyDown}
        onKeyUp={(e) => ctl.setEditCaret(e.currentTarget.selectionStart)}
        onClick={(e) => {
          ctl.setEditCaret(e.currentTarget.selectionStart);
          if (ctl.edit?.mode === 'enter') ctl.setEditMode('edit');
        }}
        onCompositionStart={() => {
          if (!ctl.edit) ctl.beginEdit({ text: '', mode: 'enter' });
        }}
        onCopy={(e) => onCopy(e, false)}
        onCut={(e) => onCopy(e, true)}
        onPaste={onPaste}
      />
      {ac && (
        <div className="ac-popup" style={popupPos} onMouseDown={(e) => e.preventDefault()}>
          {ac.matches.map((m, i) => (
            <div key={m} className={`ac-item${i === acIndex ? ' active' : ''}`} onMouseEnter={() => setAcIndex(i)} onClick={() => acceptAutocomplete(m)}>
              <span className="ac-name">{m}</span>
              <span className="ac-desc">{FUNCTION_DOCS[m]?.desc}</span>
            </div>
          ))}
        </div>
      )}
      {hint && editing && (
        <div className="fn-hint" style={popupPos}>
          <HintSyntax syntax={hint.syntax} arg={hint.arg} />
          <div className="fn-hint-desc">{hint.desc}</div>
        </div>
      )}
      {tip && (
        <div
          className="cell-tip"
          style={{ left: Math.min(tip.x + 4, size.width - 330), top: tip.y, borderLeftColor: tip.kind === 'error' ? undefined : CHANGE_COLORS[tip.kind].solid }}
        >
          <strong style={{ color: tip.kind === 'error' ? undefined : CHANGE_COLORS[tip.kind].solid }}>{tip.title}</strong>
          {tip.lines.map((ln, i) => (
            <div key={i}>{ln}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function HintSyntax({ syntax, arg }: { syntax: string; arg: number }) {
  const m = /^([^(]+)\((.*)\)$/.exec(syntax);
  if (!m) return <div className="fn-hint-syntax">{syntax}</div>;
  const parts = m[2].split(/,\s*/);
  const idx = parts.length ? Math.min(arg, parts.length - 1) : -1;
  const repeating = parts.some((p) => p.includes('...'));
  const current = repeating && arg >= parts.length - 1 ? parts.length - 1 : idx;
  return (
    <div className="fn-hint-syntax">
      {m[1]}(
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && ', '}
          <span className={i === current ? 'fn-hint-arg' : undefined}>{p}</span>
        </span>
      ))}
      )
    </div>
  );
}

const CHANGE_TITLES: Record<ChangeSide, string> = { mine: 'Changed in your branch', theirs: 'Changed in the original', conflict: 'Changed in both' };

function describeChange(c: CellDiff): string[] {
  const v = (x: { v: string } | undefined) => (x?.v ? x.v : '(empty)');
  if (c.side === 'mine') return [`Original: ${v(c.base)}`, `Yours: ${v(c.branch)}`];
  if (c.side === 'theirs') return [`Yours (unchanged): ${v(c.branch)}`, `Original now: ${v(c.original)}`];
  return [`When branched: ${v(c.base)}`, `Yours: ${v(c.branch)}`, `Original now: ${v(c.original)}`];
}
