import {
  cellKey,
  rangeFromPoints,
  rangeToString,
  type CellPos,
  type Range,
} from '../../../shared/cellref.ts';
import { isFormula, shiftFormula } from '../../../shared/formula/adjust.ts';
import { checkCellImage, hasContent, type CellStyle, type ColumnFilter, type Tab, type Workbook } from '../../../shared/types.ts';
import { CellError, scalarToText } from '../../../shared/values.ts';
import { parseTSV, toHTML, toTSV } from './clipboard.ts';
import { isRefInsertPoint, normalizeFormula } from './formulaEdit.ts';
import * as ops from './ops.ts';
import { findMatches, type SearchHit, type SearchOptions } from './search.ts';
import { diffWorkbooks, type Side, type WorkbookDiff } from '../../../shared/diff.ts';
import { AutoSaver, TransactionRefused, WorkbookStore, type Tx } from './store.ts';
import { MAX_CHARTS, suggestChart, type Chart } from '../../../shared/chart.ts';

export interface Selection {
  ranges: Range[]; // last one is the primary range
  active: CellPos; // the active (anchor) cell
  focus: CellPos; // the corner of the primary range opposite the anchor
}

export interface EditState {
  tabId: string;
  r: number;
  c: number;
  text: string;
  original: string;
  /** 'enter': started by typing, arrows commit; 'edit': F2/double-click, arrows move the caret. */
  mode: 'enter' | 'edit';
  source: 'cell' | 'bar';
  caret: number;
  /** Reference currently being pointed at with mouse/keyboard while typing a formula. */
  point?: { start: number; end: number; anchor: CellPos; cursor: CellPos };
}

export type MenuState =
  | { kind: 'cell' | 'row' | 'col' | 'corner'; x: number; y: number }
  | { kind: 'tab'; tabId: string; x: number; y: number };

export interface FilterMenuState {
  col: number;
  x: number;
  y: number;
}

type SelMeta = { tabId: string; sel: Selection };

export interface CompareData {
  base: Workbook;
  /** The original's current state, or null when it has been deleted (compare against the base only). */
  original: Workbook | null;
  parentTitle: string;
  fetchedAt: number;
}

export interface CompareState {
  status: 'loading' | 'ready' | 'error';
  error?: string;
  data?: CompareData;
  diff?: WorkbookDiff;
  /** Which kinds of change are shown on the grid and in the list. */
  show: Record<Side, boolean>;
}

export interface SearchState extends SearchOptions {
  /** Index into the current matches, or -1 when none is selected. */
  current: number;
  /** Bumped to ask the find bar to (re)focus its input. */
  focusSeq: number;
}

interface InternalClipboard {
  text: string;
  clip: ops.ClipData;
  cut: boolean;
  tabId: string;
  range: Range;
}

const single = (p: CellPos): Selection => ({ ranges: [{ r1: p.r, c1: p.c, r2: p.r, c2: p.c }], active: p, focus: p });

export class SheetController {
  readonly store: WorkbookStore<SelMeta>;
  readonly saver: AutoSaver;
  activeTabId: string;
  edit: EditState | null = null;
  copyMark: { tabId: string; range: Range; cut: boolean } | null = null;
  menu: MenuState | null = null;
  filterMenu: FilterMenuState | null = null;
  renamingTabId: string | null = null;
  /** Find bar state; null when closed. */
  search: SearchState | null = null;
  /** Branch comparison state; null when not comparing. */
  compare: CompareState | null = null;
  /** Fetches comparison data for this sheet (set by the page for branches). */
  compareLoader: (() => Promise<CompareData>) | null = null;
  /**
   * Called when the store's guard refuses a change of the user's (a CSV file asked for something CSV cannot
   * store), with the reason and a function that tries the change again.
   */
  onRefused: ((reason: string, retry: () => void) => void) | null = null;
  private compareTimer: ReturnType<typeof setTimeout> | null = null;
  scrollRequest: { r: number; c: number; seq: number } | null = null;
  /** Number of rows that fit in the viewport; maintained by the grid for PageUp/PageDown. */
  pageRows = 20;
  /** How many times replaceWith brought in a version saved elsewhere (the page can tell the user). */
  externalChanges = 0;
  version = 0;
  /** The chart of the active tab that is selected (outlined, moved and resized on the grid), if any. */
  selectedChart: string | null = null;
  /** The chart whose editor panel is open, if any. */
  chartEditor: string | null = null;

  private sels = new Map<string, Selection>();
  private clipboard: InternalClipboard | null = null;
  private listeners = new Set<() => void>();
  private hiddenCache: { version: number; tab: Tab; set: Set<number> } | null = null;
  private searchCache: { key: string; hits: SearchHit[] } | null = null;

  constructor(workbook: Workbook, save: (wb: Workbook) => Promise<void>) {
    this.store = new WorkbookStore<SelMeta>(workbook);
    this.saver = new AutoSaver(this.store, save);
    this.activeTabId = workbook.tabs[0].id;
    this.store.subscribe(() => {
      this.clampSelections();
      // Keep the comparison current with edits to the branch (debounced; diffing is O(cells)).
      if (this.compare?.status === 'ready') {
        if (this.compareTimer) clearTimeout(this.compareTimer);
        this.compareTimer = setTimeout(() => this.recomputeDiff(), 250);
      }
      this.emit();
    });
  }

  dispose(): void {
    this.saver.dispose();
    if (this.compareTimer) clearTimeout(this.compareTimer);
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  emit(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  // -------------------------------------------------------------------------
  // Accessors

  get tab(): Tab {
    return this.store.getTab(this.activeTabId) ?? this.store.workbook.tabs[0];
  }

  get sel(): Selection {
    return this.sels.get(this.tab.id) ?? single({ r: 0, c: 0 });
  }

  get primary(): Range {
    const s = this.sel;
    return s.ranges[s.ranges.length - 1];
  }

  hiddenRows(): Set<number> {
    const tab = this.tab;
    const c = this.hiddenCache;
    if (c && c.version === this.store.version && c.tab === tab) return c.set;
    const set = ops.computeHiddenRows(this.store as WorkbookStore<unknown>, tab);
    this.hiddenCache = { version: this.store.version, tab, set };
    return set;
  }

  activeCellStyle(): CellStyle {
    const { r, c } = this.sel.active;
    return this.store.cell(this.tab.id, r, c)?.st ?? {};
  }

  // -------------------------------------------------------------------------
  // Selection

  setSelection(sel: Selection, scroll = true): void {
    this.sels.set(this.tab.id, sel);
    if (scroll) this.requestScroll(sel.focus);
    this.emit();
  }

  requestScroll(p: CellPos): void {
    this.scrollRequest = { r: p.r, c: p.c, seq: (this.scrollRequest?.seq ?? 0) + 1 };
  }

  private clampPos(p: CellPos): CellPos {
    const t = this.tab;
    return { r: Math.max(0, Math.min(t.rows - 1, p.r)), c: Math.max(0, Math.min(t.cols - 1, p.c)) };
  }

  private clampSelections(): void {
    for (const t of this.store.workbook.tabs) {
      const s = this.sels.get(t.id);
      if (!s) continue;
      const cl = (p: CellPos) => ({ r: Math.min(p.r, t.rows - 1), c: Math.min(p.c, t.cols - 1) });
      if (s.active.r < t.rows && s.active.c < t.cols && s.ranges.every((r) => r.r2 < t.rows && r.c2 < t.cols)) continue;
      this.sels.set(t.id, {
        active: cl(s.active),
        focus: cl(s.focus),
        ranges: s.ranges.map((r) => ({ r1: Math.min(r.r1, t.rows - 1), c1: Math.min(r.c1, t.cols - 1), r2: Math.min(r.r2, t.rows - 1), c2: Math.min(r.c2, t.cols - 1) })),
      });
    }
    if (!this.store.getTab(this.activeTabId)) this.activeTabId = this.store.workbook.tabs[0].id;
    const charts = this.store.getTab(this.activeTabId)?.charts ?? [];
    if (this.selectedChart && !charts.some((c) => c.id === this.selectedChart)) this.selectedChart = null;
    if (this.chartEditor && !charts.some((c) => c.id === this.chartEditor)) this.chartEditor = null;
  }

  selectCell(p: CellPos, opts: { extend?: boolean; add?: boolean } = {}): void {
    p = this.clampPos(p);
    const s = this.sel;
    if (opts.extend) {
      const ranges = [...s.ranges.slice(0, -1), rangeFromPoints(s.active, p)];
      this.setSelection({ ranges, active: s.active, focus: p });
    } else if (opts.add) {
      this.setSelection({ ranges: [...s.ranges, { r1: p.r, c1: p.c, r2: p.r, c2: p.c }], active: p, focus: p });
    } else {
      this.setSelection(single(p));
    }
  }

  selectRange(rg: Range, active?: CellPos, scroll = true): void {
    const a = active ?? { r: rg.r1, c: rg.c1 };
    const focus = { r: a.r === rg.r1 ? rg.r2 : rg.r1, c: a.c === rg.c1 ? rg.c2 : rg.c1 };
    this.setSelection({ ranges: [rg], active: a, focus }, scroll);
  }

  selectRows(r1: number, r2: number, opts: { extend?: boolean; add?: boolean } = {}): void {
    const t = this.tab;
    const s = this.sel;
    if (opts.extend) {
      const a = s.active.r;
      const rg = { r1: Math.min(a, r2), r2: Math.max(a, r2), c1: 0, c2: t.cols - 1 };
      this.setSelection({ ranges: [...s.ranges.slice(0, -1), rg], active: s.active, focus: { r: r2, c: t.cols - 1 } }, false);
      return;
    }
    const rg = { r1: Math.min(r1, r2), r2: Math.max(r1, r2), c1: 0, c2: t.cols - 1 };
    const active = { r: r1, c: 0 };
    const ranges = opts.add ? [...s.ranges, rg] : [rg];
    this.setSelection({ ranges, active, focus: { r: r2, c: t.cols - 1 } }, false);
  }

  selectCols(c1: number, c2: number, opts: { extend?: boolean; add?: boolean } = {}): void {
    const t = this.tab;
    const s = this.sel;
    if (opts.extend) {
      const a = s.active.c;
      const rg = { c1: Math.min(a, c2), c2: Math.max(a, c2), r1: 0, r2: t.rows - 1 };
      this.setSelection({ ranges: [...s.ranges.slice(0, -1), rg], active: s.active, focus: { r: t.rows - 1, c: c2 } }, false);
      return;
    }
    const rg = { c1: Math.min(c1, c2), c2: Math.max(c1, c2), r1: 0, r2: t.rows - 1 };
    const active = { r: 0, c: c1 };
    const ranges = opts.add ? [...s.ranges, rg] : [rg];
    this.setSelection({ ranges, active, focus: { r: t.rows - 1, c: c2 } }, false);
  }

  selectAll(): void {
    const t = this.tab;
    this.setSelection({ ranges: [{ r1: 0, c1: 0, r2: t.rows - 1, c2: t.cols - 1 }], active: this.sel.active, focus: this.sel.active }, false);
  }

  private stepRow(r: number, dr: number): number {
    const hidden = this.hiddenRows();
    const max = this.tab.rows - 1;
    let n = r + dr;
    while (n >= 0 && n <= max && hidden.has(n)) n += Math.sign(dr);
    if (n < 0 || n > max) return r;
    return n;
  }

  private hasValue(r: number, c: number): boolean {
    return hasContent(this.tab.cells[cellKey(r, c)]);
  }

  /** Ctrl+Arrow: jump to the edge of the current data block, or the next non-empty cell. */
  private jump(p: CellPos, dr: number, dc: number): CellPos {
    const t = this.tab;
    const step = (q: CellPos): CellPos | null => {
      const r = dr ? this.stepRow(q.r, dr) : q.r;
      const c = q.c + dc;
      if ((dr && r === q.r) || c < 0 || c >= t.cols) return null;
      return { r, c };
    };
    let cur = p;
    let next = step(cur);
    if (!next) return cur;
    if (this.hasValue(cur.r, cur.c) && this.hasValue(next.r, next.c)) {
      while (next && this.hasValue(next.r, next.c)) {
        cur = next;
        next = step(cur);
      }
      return cur;
    }
    cur = next;
    while (!this.hasValue(cur.r, cur.c)) {
      const n = step(cur);
      if (!n) return cur;
      cur = n;
    }
    return cur;
  }

  move(dr: number, dc: number, opts: { extend?: boolean; jump?: boolean } = {}): void {
    const s = this.sel;
    const from = opts.extend ? s.focus : s.active;
    let to: CellPos;
    if (opts.jump) to = this.jump(from, dr, dc);
    else {
      let r = from.r;
      if (dr) {
        const steps = Math.abs(dr);
        for (let i = 0; i < steps; i++) r = this.stepRow(r, Math.sign(dr));
      }
      to = this.clampPos({ r, c: from.c + dc });
    }
    if (opts.extend) {
      this.setSelection({ ranges: [...s.ranges.slice(0, -1), rangeFromPoints(s.active, to)], active: s.active, focus: to });
    } else {
      this.setSelection(single(to));
    }
  }

  /** Enter/Tab movement: stays within a multi-cell selection like Sheets. */
  advance(dr: number, dc: number): void {
    const s = this.sel;
    const rg = this.primary;
    if (s.ranges.length === 1 && (rg.r1 !== rg.r2 || rg.c1 !== rg.c2)) {
      let { r, c } = s.active;
      if (dr) {
        r += dr;
        if (r > rg.r2) (r = rg.r1), (c = c + 1 > rg.c2 ? rg.c1 : c + 1);
        if (r < rg.r1) (r = rg.r2), (c = c - 1 < rg.c1 ? rg.c2 : c - 1);
      } else {
        c += dc;
        if (c > rg.c2) (c = rg.c1), (r = r + 1 > rg.r2 ? rg.r1 : r + 1);
        if (c < rg.c1) (c = rg.c2), (r = r - 1 < rg.r1 ? rg.r2 : r - 1);
      }
      this.setSelection({ ranges: s.ranges, active: { r, c }, focus: s.focus });
      this.requestScroll({ r, c });
      return;
    }
    this.move(dr, dc);
  }

  // -------------------------------------------------------------------------
  // Mutations (all undoable, with selection restored on undo)

  private meta(): SelMeta {
    return { tabId: this.tab.id, sel: this.sel };
  }

  run(fn: (tx: Tx) => void, after?: () => void): boolean {
    const before = this.meta();
    let changed: boolean;
    try {
      changed = this.store.transact(fn, { before });
    } catch (e) {
      if (!(e instanceof TransactionRefused) || !this.onRefused) throw e;
      this.onRefused(e.message, () => this.run(fn, after));
      this.emit();
      return false;
    }
    after?.();
    if (changed) this.store.amendLastMeta(this.meta());
    this.emit();
    return changed;
  }

  /** A change made by the agent. All changes with the same group (one agent request) undo as one step. */
  runAgent(group: string, fn: (tx: Tx) => void): boolean {
    if (this.edit) this.commitEdit();
    const before = this.meta();
    const changed = this.store.transact(fn, { before }, true, group);
    if (changed) this.store.amendLastMeta(this.meta());
    this.emit();
    return changed;
  }

  undo(): void {
    this.cancelEdit();
    const e = this.store.undo();
    if (e?.metaBefore) this.restoreMeta(e.metaBefore);
  }

  redo(): void {
    this.cancelEdit();
    const e = this.store.redo();
    if (e?.metaAfter) this.restoreMeta(e.metaAfter);
  }

  private restoreMeta(m: SelMeta): void {
    if (this.store.getTab(m.tabId)) {
      this.activeTabId = m.tabId;
      this.sels.set(m.tabId, m.sel);
      this.clampSelections();
      this.requestScroll(this.sel.active);
    }
    this.emit();
  }

  // -------------------------------------------------------------------------
  // Editing

  beginEdit(opts: { text?: string; mode: 'enter' | 'edit'; source?: 'cell' | 'bar' }): void {
    if (this.edit) return;
    const { r, c } = this.sel.active;
    const original = this.store.cell(this.tab.id, r, c)?.v ?? '';
    const text = opts.text ?? original;
    this.edit = { tabId: this.tab.id, r, c, text, original, mode: opts.mode, source: opts.source ?? 'cell', caret: text.length };
    this.copyMark = null;
    this.requestScroll({ r, c });
    this.emit();
  }

  setEditText(text: string, caret: number): void {
    if (!this.edit) return;
    this.edit = { ...this.edit, text, caret, point: undefined };
    this.emit();
  }

  setEditCaret(caret: number): void {
    if (!this.edit || this.edit.caret === caret) return;
    const point = this.edit.point && caret === this.edit.point.end ? this.edit.point : undefined;
    this.edit = { ...this.edit, caret, point };
    this.emit();
  }

  setEditMode(mode: 'enter' | 'edit', source?: 'cell' | 'bar'): void {
    if (!this.edit) return;
    this.edit = { ...this.edit, mode, source: source ?? this.edit.source };
    this.emit();
  }

  canPoint(): boolean {
    const e = this.edit;
    if (!e || e.tabId !== this.tab.id) return false;
    return !!e.point || isRefInsertPoint(e.text, e.caret);
  }

  /** Insert or update the pointed reference while composing a formula. */
  pointAt(anchor: CellPos, cursor: CellPos): void {
    const e = this.edit;
    if (!e) return;
    const refText = rangeToString(rangeFromPoints(anchor, cursor));
    const start = e.point ? e.point.start : e.caret;
    const end = e.point ? e.point.end : e.caret;
    const text = e.text.slice(0, start) + refText + e.text.slice(end);
    const newEnd = start + refText.length;
    this.edit = { ...e, text, caret: newEnd, point: { start, end: newEnd, anchor, cursor } };
    this.emit();
  }

  /** Arrow keys while pointing (formula entry in 'enter' mode). */
  movePoint(dr: number, dc: number, extend: boolean): void {
    const e = this.edit!;
    const cur = e.point?.cursor ?? { r: e.r, c: e.c };
    const next = this.clampPos({ r: dr ? this.stepRow(cur.r, dr) : cur.r, c: cur.c + dc });
    const anchor = extend ? (e.point?.anchor ?? { r: e.r, c: e.c }) : next;
    this.pointAt(anchor, next);
    this.requestScroll(next);
  }

  commitEdit(move?: [number, number]): void {
    const e = this.edit;
    if (!e) return;
    this.edit = null;
    const raw = isFormula(e.text) ? normalizeFormula(e.text) : e.text;
    if (raw !== e.original && this.store.getTab(e.tabId)) {
      this.activeTabId = e.tabId;
      this.run((tx) => ops.setInput(tx, e.tabId, e.r, e.c, raw));
    }
    if (move) this.advance(move[0], move[1]);
    else this.emit();
  }

  /** Ctrl+Enter style: write the same input into every selected cell. */
  commitEditToSelection(): void {
    const e = this.edit;
    if (!e) return;
    this.edit = null;
    const raw = isFormula(e.text) ? normalizeFormula(e.text) : e.text;
    this.run((tx) => {
      for (const rg of this.sel.ranges)
        for (let r = rg.r1; r <= rg.r2; r++)
          for (let c = rg.c1; c <= rg.c2; c++) {
            const v = isFormula(raw) ? shiftFormula(raw, r - e.r, c - e.c) : raw;
            ops.setInput(tx, e.tabId, r, c, v);
          }
    });
  }

  cancelEdit(): void {
    if (!this.edit) return;
    this.edit = null;
    this.emit();
  }

  // -------------------------------------------------------------------------
  // Content & formatting

  clearSelection(): void {
    this.run((tx) => ops.clearContents(tx, this.tab.id, this.sel.ranges));
  }

  /**
   * Put an image (data URL or http(s) URL) in a cell, by default the active cell.
   * Returns an error message, or null on success.
   */
  insertImage(src: string, at: { tabId: string; r: number; c: number } = { tabId: this.tab.id, ...this.sel.active }): string | null {
    const problem = checkCellImage(src);
    if (problem) return problem;
    if (!this.store.getTab(at.tabId)) return 'The sheet tab no longer exists';
    if (this.edit) this.commitEdit();
    if (this.activeTabId !== at.tabId) this.switchTab(at.tabId);
    this.run((tx) => ops.setImage(tx, at.tabId, at.r, at.c, src));
    return null;
  }

  setStyle(patch: Partial<CellStyle>): void {
    this.run((tx) => ops.applyStyle(tx, this.tab.id, this.sel.ranges, patch));
  }

  toggleStyle(key: 'b' | 'i' | 'u' | 's' | 'wrap'): void {
    this.setStyle({ [key]: !this.activeCellStyle()[key] });
  }

  clearFormatting(): void {
    this.run((tx) => ops.clearFormatting(tx, this.tab.id, this.sel.ranges));
  }

  adjustDecimals(delta: number): void {
    const st = this.activeCellStyle();
    const fmt = st.fmt && st.fmt !== 'general' ? st.fmt : 'number';
    if (fmt === 'date' || fmt === 'time' || fmt === 'datetime' || fmt === 'text') return;
    const cur = st.dp ?? (fmt === 'number' || fmt === 'currency' || fmt === 'percent' ? 2 : 0);
    this.setStyle({ fmt, dp: Math.max(0, Math.min(10, cur + delta)) });
  }

  // -------------------------------------------------------------------------
  // Clipboard

  copy(cut: boolean): { text: string; html: string } {
    const tab = this.tab;
    const rg = this.primary;
    const hidden = this.hiddenRows();
    const clip = ops.readClip(tab, rg, hidden);
    const rows: string[][] = [];
    for (let r = rg.r1; r <= rg.r2; r++) {
      if (hidden.has(r)) continue;
      const row: string[] = [];
      for (let c = rg.c1; c <= rg.c2; c++) row.push(this.store.display(tab.id, r, c));
      rows.push(row);
    }
    const text = toTSV(rows);
    this.clipboard = { text, clip, cut: cut && hidden.size === 0, tabId: tab.id, range: rg };
    this.copyMark = { tabId: tab.id, range: rg, cut };
    this.emit();
    return { text, html: toHTML(rows) };
  }

  paste(text: string, valuesOnly = false): void {
    const norm = (s: string) => s.replace(/\r\n?/g, '\n').replace(/\n$/, '');
    const cb = this.clipboard;
    const tabId = this.tab.id;
    const sel = this.primary;
    const internal = cb && norm(cb.text) === norm(text) && this.store.getTab(cb.tabId);
    let written: Range | null = null;
    this.run(
      (tx) => {
        if (internal && cb.cut) {
          written = ops.moveRange(tx, cb.tabId, cb.range, tabId, sel.r1, sel.c1);
        } else if (internal) {
          written = ops.pasteClip(tx, tabId, sel, cb.clip, {
            valuesOnly: valuesOnly
              ? (_cell, r, c) => {
                  const v = this.store.value(cb.tabId, r, c);
                  return v instanceof CellError ? v.code : scalarToText(v);
                }
              : undefined,
          });
        } else {
          const cells = parseTSV(text).map((row) => row.map((v) => ({ v })));
          written = ops.pasteClip(tx, tabId, sel, { cells });
        }
      },
      () => {
        if (written) this.selectRange(written, undefined, false);
      },
    );
    if (internal && cb.cut) {
      this.clipboard = null;
      this.copyMark = null;
    }
    this.emit();
  }

  hasInternalClipboard(): boolean {
    return !!this.clipboard;
  }

  internalClipboardText(): string | null {
    return this.clipboard?.text ?? null;
  }

  clearCopyMark(): void {
    if (!this.copyMark) return;
    this.copyMark = null;
    this.emit();
  }

  // -------------------------------------------------------------------------
  // Rows & columns

  insertRows(where: 'above' | 'below'): void {
    const rg = this.primary;
    const n = rg.r2 - rg.r1 + 1;
    const at = where === 'above' ? rg.r1 : rg.r2 + 1;
    this.run(
      (tx) => ops.insertLines(tx, this.tab.id, 'row', at, n),
      () => this.selectRange({ r1: at, r2: at + n - 1, c1: 0, c2: this.tab.cols - 1 }, undefined, false),
    );
  }

  insertCols(where: 'left' | 'right'): void {
    const rg = this.primary;
    const n = rg.c2 - rg.c1 + 1;
    const at = where === 'left' ? rg.c1 : rg.c2 + 1;
    this.run(
      (tx) => ops.insertLines(tx, this.tab.id, 'col', at, n),
      () => this.selectRange({ c1: at, c2: at + n - 1, r1: 0, r2: this.tab.rows - 1 }, undefined, false),
    );
  }

  deleteRows(): void {
    const rg = this.primary;
    this.run(
      (tx) => ops.deleteLines(tx, this.tab.id, 'row', rg.r1, rg.r2),
      () => this.selectCell({ r: Math.min(rg.r1, this.tab.rows - 1), c: this.sel.active.c }),
    );
  }

  deleteCols(): void {
    const rg = this.primary;
    this.run(
      (tx) => ops.deleteLines(tx, this.tab.id, 'col', rg.c1, rg.c2),
      () => this.selectCell({ r: this.sel.active.r, c: Math.min(rg.c1, this.tab.cols - 1) }),
    );
  }

  /** True if the selection is a single block of whole columns that includes column `c` (it can be dragged). */
  canDragCols(c: number): boolean {
    const s = this.sel;
    const rg = this.primary;
    return s.ranges.length === 1 && rg.r1 === 0 && rg.r2 === this.tab.rows - 1 && c >= rg.c1 && c <= rg.c2;
  }

  /** Move the selected whole columns so they sit immediately left of column `before`; selects them afterwards. */
  moveCols(before: number): void {
    const rg = this.primary;
    let start: number | null = null;
    this.run(
      (tx) => {
        start = ops.moveColumns(tx, this.tab.id, rg.c1, rg.c2, before);
      },
      () => {
        if (start !== null) this.selectCols(start, start + rg.c2 - rg.c1);
      },
    );
  }

  appendRows(n: number): void {
    this.run((tx) => ops.appendRows(tx, this.tab.id, n));
  }

  setColWidth(cols: number[], width: number): void {
    const w = Math.max(20, Math.round(width));
    this.run((tx) => {
      const next = { ...this.tab.colWidths };
      for (const c of cols) next[c] = w;
      tx.setTabProp(this.tab.id, 'colWidths', next);
    });
  }

  setRowHeight(rows: number[], height: number): void {
    const h = Math.max(12, Math.round(height));
    this.run((tx) => {
      const next = { ...this.tab.rowHeights };
      for (const r of rows) next[r] = h;
      tx.setTabProp(this.tab.id, 'rowHeights', next);
    });
  }

  /** Columns covered by full-column selections that include `c`, or just `c`. */
  columnsForResize(c: number): number[] {
    const t = this.tab;
    for (const rg of this.sel.ranges) {
      if (rg.r1 === 0 && rg.r2 === t.rows - 1 && c >= rg.c1 && c <= rg.c2) {
        return Array.from({ length: rg.c2 - rg.c1 + 1 }, (_, i) => rg.c1 + i);
      }
    }
    return [c];
  }

  rowsForResize(r: number): number[] {
    const t = this.tab;
    for (const rg of this.sel.ranges) {
      if (rg.c1 === 0 && rg.c2 === t.cols - 1 && r >= rg.r1 && r <= rg.r2) {
        return Array.from({ length: rg.r2 - rg.r1 + 1 }, (_, i) => rg.r1 + i);
      }
    }
    return [r];
  }

  setFrozen(rows: number | undefined, cols: number | undefined): void {
    this.run((tx) => {
      if (rows !== undefined) tx.setTabProp(this.tab.id, 'frozenRows', rows || undefined);
      if (cols !== undefined) tx.setTabProp(this.tab.id, 'frozenCols', cols || undefined);
    });
  }

  // -------------------------------------------------------------------------
  // Sort & filter

  private sortTarget(): Range {
    const rg = this.primary;
    if (rg.r1 === rg.r2 && rg.c1 === rg.c2) {
      const f = this.tab.filter;
      if (f && rg.r1 > f.r1 && rg.r1 <= f.r2 && rg.c1 >= f.c1 && rg.c1 <= f.c2) return { ...f, r1: f.r1 + 1 };
      return ops.detectDataRegion(this.tab, rg.r1, rg.c1);
    }
    return rg;
  }

  sortSelection(asc: boolean): void {
    const rg = this.sortTarget();
    const col = this.sel.active.c;
    this.run((tx) => ops.sortRange(tx, this.store as WorkbookStore<unknown>, this.tab.id, rg, col, asc));
  }

  sortSheetByColumn(col: number, asc: boolean): void {
    const t = this.tab;
    const ext = this.store.engine.extent(t.id);
    const r1 = t.frozenRows ?? 0;
    if (ext.rows <= r1) return;
    this.run((tx) => ops.sortRange(tx, this.store as WorkbookStore<unknown>, t.id, { r1, r2: ext.rows - 1, c1: 0, c2: Math.max(ext.cols - 1, col) }, col, asc));
  }

  createFilter(): void {
    const rg = this.primary;
    const region = rg.r1 === rg.r2 && rg.c1 === rg.c2 ? ops.detectDataRegion(this.tab, rg.r1, rg.c1) : rg;
    const t = this.tab;
    const ext = this.store.engine.extent(t.id);
    // Whole-column selections: limit to the used rows.
    const r2 = region.r2 === t.rows - 1 ? Math.max(region.r1 + 1, ext.rows - 1) : Math.max(region.r2, region.r1 + 1);
    this.run((tx) => tx.setTabProp(t.id, 'filter', { r1: region.r1, c1: region.c1, r2, c2: region.c2, cols: {} }));
  }

  removeFilter(): void {
    this.filterMenu = null;
    this.run((tx) => tx.setTabProp(this.tab.id, 'filter', undefined));
  }

  setColumnFilter(col: number, cf: ColumnFilter | undefined): void {
    const f = this.tab.filter;
    if (!f) return;
    const cols = { ...f.cols };
    if (cf && (cf.hidden?.length || (cf.cond && cf.cond.type !== 'none'))) cols[col] = cf;
    else delete cols[col];
    this.run((tx) => tx.setTabProp(this.tab.id, 'filter', { ...f, cols }));
  }

  sortFilterColumn(col: number, asc: boolean): void {
    const f = this.tab.filter;
    if (!f || f.r2 <= f.r1) return;
    this.run((tx) => ops.sortRange(tx, this.store as WorkbookStore<unknown>, this.tab.id, { r1: f.r1 + 1, r2: f.r2, c1: f.c1, c2: f.c2 }, col, asc));
  }

  /** Distinct display values in a filter column (for the "filter by values" list). */
  filterValues(col: number): { value: string; count: number }[] {
    const f = this.tab.filter;
    if (!f) return [];
    const counts = new Map<string, number>();
    for (let r = f.r1 + 1; r <= f.r2; r++) {
      const d = this.store.display(this.tab.id, r, col);
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => (a.value === '' ? 1 : b.value === '' ? -1 : a.value.localeCompare(b.value, undefined, { numeric: true })));
  }

  // -------------------------------------------------------------------------
  // Fill & move

  fill(src: Range, target: Range): void {
    this.run(
      (tx) => ops.fillRange(tx, this.tab.id, src, target),
      () => this.selectRange(target, this.sel.active, false),
    );
  }

  fillDown(): void {
    const rg = this.primary;
    if (rg.r1 === rg.r2) {
      if (rg.r1 === 0) return;
      this.fillFrom({ ...rg, r1: rg.r1 - 1, r2: rg.r1 - 1 }, { ...rg, r1: rg.r1 - 1 }, rg);
    } else this.fillFrom({ ...rg, r2: rg.r1 }, rg, rg);
  }

  fillRight(): void {
    const rg = this.primary;
    if (rg.c1 === rg.c2) {
      if (rg.c1 === 0) return;
      this.fillFrom({ ...rg, c1: rg.c1 - 1, c2: rg.c1 - 1 }, { ...rg, c1: rg.c1 - 1 }, rg);
    } else this.fillFrom({ ...rg, c2: rg.c1 }, rg, rg);
  }

  private fillFrom(src: Range, target: Range, keepSel: Range): void {
    this.run(
      (tx) => {
        // Ctrl+D/R copy rather than extend a series.
        const tab = tx.tab(this.tab.id);
        const vertical = src.r1 === src.r2 && target.r1 !== target.r2;
        for (let r = target.r1; r <= target.r2; r++)
          for (let c = target.c1; c <= target.c2; c++) {
            const sr = vertical ? src.r1 : r;
            const sc = vertical ? c : src.c1;
            if (sr === r && sc === c) continue;
            const cell = tab.cells[cellKey(sr, sc)];
            tx.setCellAt(tab.id, r, c, cell && isFormula(cell.v) ? { ...cell, v: shiftFormula(cell.v, r - sr, c - sc) } : cell);
          }
      },
      () => this.selectRange(keepSel, this.sel.active, false),
    );
  }

  moveSelection(destR: number, destC: number): void {
    const src = this.primary;
    const tabId = this.tab.id;
    let dest: Range | null = null;
    this.run(
      (tx) => {
        dest = ops.moveRange(tx, tabId, src, tabId, destR, destC);
      },
      () => {
        if (dest) this.selectRange(dest, undefined, false);
      },
    );
  }

  // -------------------------------------------------------------------------
  // Tabs

  switchTab(id: string): void {
    if (this.edit) this.commitEdit();
    if (!this.store.getTab(id)) return;
    this.activeTabId = id;
    this.filterMenu = null;
    this.selectedChart = null;
    this.chartEditor = null;
    this.requestScroll(this.sel.active);
    this.emit();
  }

  // -------------------------------------------------------------------------
  // Charts (shared/chart.ts)

  /** The active tab's charts. */
  get charts(): Chart[] {
    return this.tab.charts ?? [];
  }

  selectChart(id: string | null): void {
    if (this.selectedChart === id) return;
    if (id && this.edit) this.commitEdit();
    this.selectedChart = id;
    this.emit();
  }

  /** Open (or, with null, close) the chart editor on a chart of the active tab. */
  editChart(id: string | null): void {
    this.chartEditor = id;
    if (id) this.selectedChart = id;
    this.emit();
  }

  /**
   * Add a chart of the selection (a single cell stands for the block of data around it) next to it, and open
   * its editor. A message when there is nothing to chart.
   */
  insertChart(): string | null {
    if (this.edit) this.commitEdit();
    const tab = this.tab;
    if (this.charts.length >= MAX_CHARTS) return `A sheet holds at most ${MAX_CHARTS} charts.`;
    const ranges = this.sel.ranges;
    let rg = this.primary;
    // Columns picked one by one (Ctrl-click) over the same rows: the chart of the block they span, of them only.
    const columns = ranges.length > 1 && ranges.every((r) => r.r1 === ranges[0].r1 && r.r2 === ranges[0].r2) ? ranges : null;
    if (columns) rg = { r1: columns[0].r1, r2: columns[0].r2, c1: Math.min(...columns.map((r) => r.c1)), c2: Math.max(...columns.map((r) => r.c2)) };
    else if (rg.r1 === rg.r2 && rg.c1 === rg.c2) rg = ops.dataRegion(tab, rg.r1, rg.c1);
    const id = crypto.randomUUID();
    const picked = (c: number) => !columns || columns.some((r) => c >= r.c1 && c <= r.c2);
    const chart = suggestChart(this.store.engine, tab, rg, id, { r: rg.r1, c: Math.min(rg.c2 + 1, tab.cols - 1), dx: 12, dy: 0 }, picked);
    if (!chart) return 'Select the cells with the numbers to chart (with their labels and headers), then insert the chart.';
    this.addChart(chart);
    this.editChart(id);
    return null;
  }

  /** Add a chart to the active tab and select it. */
  addChart(chart: Chart): boolean {
    const tabId = this.tab.id;
    const done = this.run((tx) => tx.setTabProp(tabId, 'charts', [...(tx.tab(tabId).charts ?? []), chart]));
    if (done) this.selectChart(chart.id);
    return done;
  }

  /** Change a chart of the active tab, as one undo step. */
  updateChart(id: string, fn: (c: Chart) => Chart): boolean {
    const tabId = this.tab.id;
    const charts = this.charts;
    const at = charts.findIndex((c) => c.id === id);
    if (at < 0) return false;
    const next = fn(charts[at]);
    if (JSON.stringify(next) === JSON.stringify(charts[at])) return false;
    return this.run((tx) => tx.setTabProp(tabId, 'charts', charts.map((c, i) => (i === at ? next : c))));
  }

  deleteChart(id: string): void {
    const tabId = this.tab.id;
    const charts = this.charts.filter((c) => c.id !== id);
    if (charts.length === this.charts.length) return;
    this.run((tx) => tx.setTabProp(tabId, 'charts', charts.length ? charts : undefined));
  }

  addTab(): void {
    let id = '';
    this.run(
      (tx) => {
        id = ops.addTab(tx, this.store.workbook.tabs.indexOf(this.tab));
      },
      () => {
        this.activeTabId = id;
      },
    );
  }

  duplicateTab(tabId: string): void {
    let id = '';
    this.run(
      (tx) => {
        id = ops.duplicateTab(tx, tabId);
      },
      () => {
        this.activeTabId = id;
      },
    );
  }

  /**
   * Replace the workbook with a version saved elsewhere (the assistant, another window) as one undoable
   * step. The active tab and selections survive where they still exist.
   */
  replaceWith(next: Workbook): boolean {
    if (JSON.stringify(this.store.workbook) === JSON.stringify(next)) return false;
    const changed = this.run(
      (tx) => tx.setTabs(next.tabs),
      () => {
        if (!this.store.workbook.tabs.some((t) => t.id === this.activeTabId)) this.activeTabId = this.store.workbook.tabs[0].id;
      },
    );
    if (changed) this.externalChanges++;
    return changed;
  }

  /** Add tabs from an imported workbook (one undoable step) and show the first of them. */
  importTabs(tabs: Tab[]): { from: string; to: string }[] {
    if (this.edit) this.commitEdit();
    let result: ReturnType<typeof ops.appendTabs> = { ids: [], renamed: [] };
    this.run(
      (tx) => {
        result = ops.appendTabs(tx, tabs);
      },
      () => {
        if (result.ids[0]) this.activeTabId = result.ids[0];
      },
    );
    return result.renamed;
  }

  deleteTab(tabId: string): void {
    const tabs = this.store.workbook.tabs;
    if (tabs.length <= 1) return;
    const idx = tabs.findIndex((t) => t.id === tabId);
    this.run(
      (tx) => ops.deleteTab(tx, tabId),
      () => {
        if (this.activeTabId === tabId) this.activeTabId = this.store.workbook.tabs[Math.max(0, idx - 1)].id;
      },
    );
  }

  renameTab(tabId: string, name: string): string | null {
    const problem = ops.validateTabName(this.store.workbook.tabs, tabId, name);
    if (problem) return problem;
    this.run((tx) => ops.renameTab(tx, tabId, name.trim()));
    return null;
  }

  moveTab(from: number, to: number): void {
    if (from === to) return;
    this.run((tx) => ops.moveTab(tx, from, to));
  }

  // -------------------------------------------------------------------------
  // Menus

  openMenu(m: MenuState | null): void {
    this.menu = m;
    this.emit();
  }

  openFilterMenu(m: FilterMenuState | null): void {
    this.filterMenu = m;
    this.emit();
  }

  setRenamingTab(id: string | null): void {
    this.renamingTabId = id;
    this.emit();
  }

  // -------------------------------------------------------------------------
  // Branch comparison

  async openCompare(): Promise<void> {
    if (!this.compareLoader) return;
    if (this.edit) this.commitEdit();
    this.compare = { status: 'loading', show: this.compare?.show ?? { mine: true, theirs: true, conflict: true }, data: this.compare?.data, diff: this.compare?.diff };
    this.emit();
    try {
      const data = await this.compareLoader();
      if (!this.compare) return; // closed while loading
      this.compare = { ...this.compare, status: 'ready', data, error: undefined };
      this.recomputeDiff();
    } catch (e) {
      if (!this.compare) return;
      this.compare = { ...this.compare, status: 'error', error: e instanceof Error ? e.message : String(e) };
      this.emit();
    }
  }

  closeCompare(): void {
    if (this.compareTimer) clearTimeout(this.compareTimer);
    this.compare = null;
    this.emit();
  }

  setCompareFilter(side: Side, on: boolean): void {
    if (!this.compare) return;
    this.compare = { ...this.compare, show: { ...this.compare.show, [side]: on } };
    this.emit();
  }

  private recomputeDiff(): void {
    const c = this.compare;
    if (!c?.data) return;
    const { base, original } = c.data;
    // A detached branch (original deleted) is compared with the base alone: every difference is "mine".
    const diff = diffWorkbooks(base, this.store.workbook, original ?? base);
    this.compare = { ...c, diff };
    this.emit();
  }

  /** Jump to a cell in the branch (used by the change list). */
  revealCell(tabId: string, r: number, c: number): void {
    if (tabId !== this.tab.id) this.switchTab(tabId);
    this.selectCell({ r: Math.min(r, this.tab.rows - 1), c: Math.min(c, this.tab.cols - 1) });
  }

  // -------------------------------------------------------------------------
  // Find

  openSearch(): void {
    if (this.edit) this.commitEdit();
    this.menu = null;
    this.filterMenu = null;
    const prev = this.search;
    this.search = prev
      ? { ...prev, focusSeq: prev.focusSeq + 1 }
      : { query: '', matchCase: false, wholeCell: false, formulas: false, allTabs: false, current: -1, focusSeq: 1 };
    this.emit();
  }

  closeSearch(): void {
    if (!this.search) return;
    this.search = null;
    this.emit();
  }

  /** Current matches (cached per workbook version, options, and active tab). */
  searchMatches(): SearchHit[] {
    const s = this.search;
    if (!s || !s.query) return [];
    const tabs = s.allTabs ? this.store.workbook.tabs : [this.tab];
    const key = JSON.stringify([this.store.version, s.query, s.matchCase, s.wholeCell, s.formulas, s.allTabs, s.allTabs ? '' : this.tab.id]);
    if (this.searchCache?.key === key) return this.searchCache.hits;
    const hits = findMatches(
      {
        display: (t, r, c) => this.store.display(t, r, c),
        hiddenRows: (tab) => (tab === this.tab ? this.hiddenRows() : ops.computeHiddenRows(this.store as WorkbookStore<unknown>, tab)),
      },
      tabs,
      s,
    );
    this.searchCache = { key, hits };
    return hits;
  }

  /** Update the query/options and jump to the first match at or after the active cell. */
  setSearchOptions(patch: Partial<SearchOptions>): void {
    if (!this.search) return;
    this.search = { ...this.search, ...patch, current: -1 };
    const hits = this.searchMatches();
    if (hits.length) {
      const tabs = this.store.workbook.tabs;
      const tabIdx = (id: string) => tabs.findIndex((t) => t.id === id);
      const here = tabIdx(this.tab.id);
      const { r, c } = this.sel.active;
      let i = hits.findIndex((h) => {
        const ti = tabIdx(h.tabId);
        return ti > here || (ti === here && (h.r > r || (h.r === r && h.c >= c)));
      });
      if (i < 0) i = 0;
      this.goToMatch(i);
    } else {
      this.emit();
    }
  }

  /** Move to the next (1) or previous (-1) match, wrapping around. */
  searchStep(dir: 1 | -1): void {
    const hits = this.searchMatches();
    if (!this.search || !hits.length) return;
    const cur = this.search.current;
    const next = cur < 0 ? (dir > 0 ? 0 : hits.length - 1) : (cur + dir + hits.length) % hits.length;
    this.goToMatch(next);
  }

  private goToMatch(i: number): void {
    const hit = this.searchMatches()[i];
    if (!hit || !this.search) return;
    this.search = { ...this.search, current: i };
    if (hit.tabId !== this.tab.id) this.switchTab(hit.tabId);
    this.selectCell({ r: hit.r, c: hit.c });
  }

  // -------------------------------------------------------------------------
  // Status bar aggregates

  selectionStats(): { sum: number; avg: number; min: number; max: number; count: number; numCount: number } | null {
    const s = this.sel;
    const tab = this.tab;
    const hidden = this.hiddenRows();
    let cells = 0;
    for (const rg of s.ranges) cells += (rg.r2 - rg.r1 + 1) * (rg.c2 - rg.c1 + 1);
    if (cells <= 1) return null;
    let sum = 0;
    let count = 0;
    let numCount = 0;
    let min = Infinity;
    let max = -Infinity;
    const seen = new Set<string>();
    for (const rg of s.ranges) {
      for (const { key, r, c } of ops.existingKeysIn(tab, rg)) {
        if (seen.has(key) || hidden.has(r)) continue;
        seen.add(key);
        const v = this.store.value(tab.id, r, c);
        if (v === null || v === '') continue;
        count++;
        if (typeof v === 'number') {
          numCount++;
          sum += v;
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
    }
    if (!count) return null;
    return { sum, avg: numCount ? sum / numCount : 0, min, max, count, numCount };
  }
}
