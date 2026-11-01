import { cellKey } from '../../../shared/cellref.ts';
import { Engine } from '../../../shared/formula/engine.ts';
import { csvCellProblem, csvProblem, csvTabPropProblem } from '../../../shared/csv.ts';
import type { CellData, Tab, Workbook } from '../../../shared/types.ts';
import { xlsxCellProblem, xlsxProblem } from '../../../shared/xlsxFormat.ts';
import { formatValue, type Scalar } from '../../../shared/values.ts';

export type Patch =
  | { k: 'cell'; tabId: string; key: string; before: CellData | undefined; after: CellData | undefined }
  | { k: 'tab'; tabId: string; prop: keyof Tab; before: unknown; after: unknown }
  | { k: 'tabs'; before: Tab[]; after: Tab[] };

export interface UndoEntry<M = unknown> {
  patches: Patch[];
  /** Opaque UI state (e.g. selection) captured before/after the change, restored on undo/redo. */
  metaBefore?: M;
  metaAfter?: M;
  /** Transactions with the same group that follow each other merge into one undo step (e.g. one agent request). */
  group?: string;
}

/** Thrown by transact when the store's guard refuses a change; the change has been rolled back. */
export class TransactionRefused extends Error {}

/**
 * The guard of a CSV file (shared/csv.ts): refuses a change that adds something CSV cannot store, and returns
 * what that is (e.g. "Cell formatting").
 */
export function csvGuard(patches: Patch[]): string | null {
  for (const p of patches) {
    const problem =
      p.k === 'cell' ? csvCellProblem(p.after) : p.k === 'tab' ? csvTabPropProblem(p.prop, p.after) : csvProblem({ version: 1, tabs: p.after });
    if (problem) return problem;
  }
  return null;
}

/** The guard of an Excel file (shared/xlsxFormat.ts): refuses what an Excel file cannot store (a picture in a cell). */
export function xlsxGuard(patches: Patch[]): string | null {
  for (const p of patches) {
    const problem = p.k === 'cell' ? xlsxCellProblem(p.after) : p.k === 'tabs' ? xlsxProblem({ version: 1, tabs: p.after }) : null;
    if (problem) return problem;
  }
  return null;
}

/** What the guard of an Office file holding things the app cannot keep answers until the user allows editing it. */
export const EDIT_NOT_ALLOWED = 'Editing this file';
/** Refuses every change: an Office file whose saving would remove things (charts, say) waits for the user's yes. */
export const lockedGuard = (): string => EDIT_NOT_ALLOWED;

const STRUCTURAL_PROPS = new Set<keyof Tab>(['name', 'rows', 'cols']);
const MAX_UNDO = 200;

/** Records patches while mutating the workbook in place. */
export class Tx {
  readonly patches: Patch[] = [];
  structural = false;
  readonly changedCells: { tabId: string; key: string }[] = [];
  private store: WorkbookStore;

  constructor(store: WorkbookStore) {
    this.store = store;
  }

  get workbook(): Workbook {
    return this.store.workbook;
  }

  tab(tabId: string): Tab {
    const t = this.store.getTab(tabId);
    if (!t) throw new Error(`Unknown tab ${tabId}`);
    return t;
  }

  setCell(tabId: string, key: string, cell: CellData | undefined): void {
    const tab = this.tab(tabId);
    const before = tab.cells[key];
    if (cell && cell.v === '' && !cell.img && (!cell.st || Object.keys(cell.st).length === 0)) cell = undefined;
    if (before === cell) return;
    if (before && cell && before.v === cell.v && before.img === cell.img && JSON.stringify(before.st) === JSON.stringify(cell.st)) return;
    applyCell(tab, key, cell);
    this.patches.push({ k: 'cell', tabId, key, before, after: cell });
    this.changedCells.push({ tabId, key });
  }

  setCellAt(tabId: string, r: number, c: number, cell: CellData | undefined): void {
    this.setCell(tabId, cellKey(r, c), cell);
  }

  setTabProp<K extends keyof Tab>(tabId: string, prop: K, value: Tab[K]): void {
    const tab = this.tab(tabId);
    const before = tab[prop];
    if (before === value) return;
    applyTabProp(tab, prop, value);
    this.patches.push({ k: 'tab', tabId, prop, before, after: value });
    if (STRUCTURAL_PROPS.has(prop)) this.structural = true;
  }

  setTabs(tabs: Tab[]): void {
    const before = this.store.workbook.tabs;
    this.store.workbook.tabs = tabs;
    this.patches.push({ k: 'tabs', before, after: tabs });
    this.structural = true;
  }
}

function applyCell(tab: Tab, key: string, cell: CellData | undefined) {
  if (cell) tab.cells[key] = cell;
  else delete tab.cells[key];
}

function applyTabProp(tab: Tab, prop: keyof Tab, value: unknown) {
  if (value === undefined) delete (tab as unknown as Record<string, unknown>)[prop];
  else (tab as unknown as Record<string, unknown>)[prop] = value;
}

export class WorkbookStore<M = unknown> {
  workbook: Workbook;
  readonly engine: Engine;
  version = 0;
  private undoStack: UndoEntry<M>[] = [];
  private redoStack: UndoEntry<M>[] = [];
  private listeners = new Set<() => void>();
  /**
   * When set, every transaction is checked before it takes effect: a string refuses it (the reason), the
   * change is rolled back and transact throws TransactionRefused.
   */
  guard: ((patches: Patch[]) => string | null) | null = null;

  constructor(workbook: Workbook) {
    this.workbook = workbook;
    this.engine = new Engine(workbook);
  }

  /** The document the AutoSaver saves. */
  get document(): Workbook {
    return this.workbook;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  getTab(id: string): Tab | undefined {
    return this.workbook.tabs.find((t) => t.id === id);
  }

  cell(tabId: string, r: number, c: number): CellData | undefined {
    return this.getTab(tabId)?.cells[cellKey(r, c)];
  }

  value(tabId: string, r: number, c: number): Scalar {
    return this.engine.getValue(tabId, r, c);
  }

  /** URL the cell links to (HYPERLINK formula or a plain-text http(s) URL), or null. */
  link(tabId: string, r: number, c: number): string | null {
    return this.engine.getLink(tabId, r, c);
  }

  display(tabId: string, r: number, c: number): string {
    const cell = this.cell(tabId, r, c);
    if (!cell) return '';
    const v = this.engine.getValue(tabId, r, c);
    const implied = typeof v === 'number' ? this.engine.getImpliedFormat(tabId, r, c) : undefined;
    return formatValue(v, cell.st, implied);
  }

  /**
   * Run a mutation as one undoable step. Returns false if nothing changed.
   * With a group, the step merges into the previous one if that is the most recent step and has the same group.
   */
  transact(fn: (tx: Tx) => void, meta?: { before?: M; after?: M }, undoable = true, group?: string): boolean {
    const tx = new Tx(this);
    fn(tx);
    if (!tx.patches.length) return false;
    const refused = this.guard?.(tx.patches);
    if (refused) {
      this.applyPatches(tx.patches, true);
      throw new TransactionRefused(refused);
    }
    this.recalc(tx.structural, tx.changedCells);
    if (undoable) {
      const top = this.undoStack[this.undoStack.length - 1];
      if (group && top?.group === group && !this.redoStack.length) {
        top.patches.push(...tx.patches);
        top.metaAfter = meta?.after;
      } else {
        this.undoStack.push({ patches: tx.patches, metaBefore: meta?.before, metaAfter: meta?.after, group });
        if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
      }
      this.redoStack = [];
    }
    this.emit();
    return true;
  }

  /** Update the "after" metadata of the most recent undo entry (e.g. the selection after an operation). */
  amendLastMeta(after: M): void {
    const e = this.undoStack[this.undoStack.length - 1];
    if (e) e.metaAfter = after;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): UndoEntry<M> | null {
    const e = this.undoStack.pop();
    if (!e) return null;
    this.applyPatches(e.patches, true);
    this.redoStack.push(e);
    this.emit();
    return e;
  }

  redo(): UndoEntry<M> | null {
    const e = this.redoStack.pop();
    if (!e) return null;
    this.applyPatches(e.patches, false);
    this.undoStack.push(e);
    this.emit();
    return e;
  }

  private applyPatches(patches: Patch[], reverse: boolean): void {
    const list = reverse ? [...patches].reverse() : patches;
    let structural = false;
    const changed: { tabId: string; key: string }[] = [];
    for (const p of list) {
      const val = reverse ? p.before : p.after;
      switch (p.k) {
        case 'cell': {
          const tab = this.getTab(p.tabId);
          if (tab) applyCell(tab, p.key, val as CellData | undefined);
          changed.push({ tabId: p.tabId, key: p.key });
          break;
        }
        case 'tab': {
          const tab = this.getTab(p.tabId);
          if (tab) applyTabProp(tab, p.prop, val);
          if (STRUCTURAL_PROPS.has(p.prop)) structural = true;
          break;
        }
        case 'tabs':
          this.workbook.tabs = val as Tab[];
          structural = true;
          break;
      }
    }
    this.recalc(structural, changed);
  }

  private recalc(structural: boolean, changed: { tabId: string; key: string }[]): void {
    if (structural) this.engine.load(this.workbook);
    else if (changed.length) this.engine.update(changed);
  }
}

// ---------------------------------------------------------------------------
// Autosave

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error';

/** A store whose document can be autosaved: a WorkbookStore or a DeckStore. */
export interface SaveSource<D> {
  readonly document: D;
  readonly version: number;
  subscribe(fn: () => void): () => void;
}

export class AutoSaver<D = Workbook> {
  status: SaveStatus = 'saved';
  error: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private pending = false;
  private listeners = new Set<() => void>();
  private lastVersion: number;
  private store: SaveSource<D>;
  private saveFn: (doc: D) => Promise<void>;
  private unsub: () => void;
  private delay: number;

  constructor(store: SaveSource<D>, saveFn: (doc: D) => Promise<void>, delay = 800) {
    this.store = store;
    this.saveFn = saveFn;
    this.delay = delay;
    this.lastVersion = store.version;
    this.unsub = store.subscribe(() => {
      if (store.version === this.lastVersion) return;
      this.lastVersion = store.version;
      this.markDirty();
    });
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private setStatus(s: SaveStatus, error: string | null = null) {
    this.status = s;
    this.error = error;
    for (const l of this.listeners) l();
  }

  markDirty(): void {
    this.pending = true;
    if (this.status !== 'saving') this.setStatus('dirty');
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.delay);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight) {
      await this.inFlight;
      if (!this.pending) return;
    }
    if (!this.pending) return;
    this.pending = false;
    this.setStatus('saving');
    this.inFlight = this.saveFn(this.store.document)
      .then(() => {
        this.setStatus(this.pending ? 'dirty' : 'saved');
      })
      .catch((e: unknown) => {
        this.pending = true;
        this.setStatus('error', e instanceof Error ? e.message : String(e));
        this.timer = setTimeout(() => void this.flush(), 5000);
      })
      .finally(() => {
        this.inFlight = null;
      });
    await this.inFlight;
    if (this.pending && this.status !== 'error') await this.flush();
  }

  /** The document as it is now is what is stored (it was just loaded): forget any change waiting to be saved. */
  adopt(): void {
    this.lastVersion = this.store.version;
    this.pending = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.status !== 'saving') this.setStatus('saved');
  }

  hasUnsavedChanges(): boolean {
    return this.pending || this.status === 'saving';
  }

  dispose(): void {
    this.unsub();
    if (this.timer) clearTimeout(this.timer);
  }
}
