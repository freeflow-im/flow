// Deck state with patch-based undo/redo, mirroring WorkbookStore. Unlike the workbook (mutated in place for
// speed), the deck is small and replaced immutably on every change, so React components can compare by
// reference. An undo step records whole slides before and after, which keeps the patch set tiny.
import { migrateArcs, type Deck, type Slide, type ThemeId } from '../../../shared/deck.ts';
import { reconnectLines } from '../../../shared/lines.ts';
import { newPptxGap } from '../../../shared/pptxFormat.ts';
import { TransactionRefused } from '../state/store.ts';

export type DeckPatch =
  | { k: 'theme'; before: ThemeId; after: ThemeId }
  /** Insert (before undefined), remove (after undefined) or replace the slide at index. */
  | { k: 'slide'; index: number; before: Slide | undefined; after: Slide | undefined }
  | { k: 'move'; from: number; to: number };

export interface DeckUndoEntry<M = unknown> {
  patches: DeckPatch[];
  metaBefore?: M;
  metaAfter?: M;
  /** Transactions with the same group that follow each other merge into one undo step (one agent request). */
  group?: string;
}

const MAX_UNDO = 200;

function applyPatch(deck: Deck, p: DeckPatch, reverse: boolean): Deck {
  switch (p.k) {
    case 'theme':
      return { ...deck, theme: reverse ? p.before : p.after };
    case 'slide': {
      const slides = [...deck.slides];
      const value = reverse ? p.before : p.after;
      const removed = reverse ? p.after : p.before;
      if (removed === undefined) slides.splice(p.index, 0, value!);
      else if (value === undefined) slides.splice(p.index, 1);
      else slides[p.index] = value;
      return { ...deck, slides };
    }
    case 'move': {
      const slides = [...deck.slides];
      const [from, to] = reverse ? [p.to, p.from] : [p.from, p.to];
      const [s] = slides.splice(from, 1);
      slides.splice(to, 0, s);
      return { ...deck, slides };
    }
  }
}

/** Records patches while building the next deck. */
export class DeckTx {
  readonly patches: DeckPatch[] = [];
  private store: DeckStore;

  constructor(store: DeckStore) {
    this.store = store;
  }

  get deck(): Deck {
    return this.store.deck;
  }

  private push(p: DeckPatch): void {
    this.store.deck = applyPatch(this.store.deck, p, false);
    this.patches.push(p);
  }

  setTheme(theme: ThemeId): void {
    if (theme !== this.deck.theme) this.push({ k: 'theme', before: this.deck.theme, after: theme });
  }

  insertSlide(index: number, slide: Slide): void {
    this.push({ k: 'slide', index: Math.max(0, Math.min(index, this.deck.slides.length)), before: undefined, after: slide });
  }

  removeSlide(index: number): void {
    const before = this.deck.slides[index];
    if (before) this.push({ k: 'slide', index, before, after: undefined });
  }

  replaceSlide(index: number, next: Slide): void {
    const before = this.deck.slides[index];
    const slide = reconnectLines(next); // connected lines follow their shapes
    if (!before || before === slide) return;
    if (JSON.stringify(before) === JSON.stringify(slide)) return;
    this.push({ k: 'slide', index, before, after: slide });
  }

  /** Replace a slide (by index or id) with the result of fn. */
  updateSlide(at: number | string, fn: (slide: Slide) => Slide): void {
    const index = typeof at === 'number' ? at : this.deck.slides.findIndex((s) => s.id === at);
    const slide = this.deck.slides[index];
    if (slide) this.replaceSlide(index, fn(slide));
  }

  moveSlide(from: number, to: number): void {
    const n = this.deck.slides.length;
    if (from === to || from < 0 || from >= n || to < 0 || to >= n) return;
    this.push({ k: 'move', from, to });
  }
}

export class DeckStore<M = unknown> {
  deck: Deck;
  version = 0;
  private undoStack: DeckUndoEntry<M>[] = [];
  private redoStack: DeckUndoEntry<M>[] = [];
  private listeners = new Set<() => void>();
  /**
   * When set, every change is checked before it takes effect (the deck before and after): a string refuses it
   * (the reason), the change is undone and transact throws TransactionRefused. A PowerPoint file's (desktop app).
   */
  guard: ((before: Deck, after: Deck) => string | null) | null = null;

  constructor(deck: Deck) {
    this.deck = migrateArcs(deck);
  }

  /** The document the AutoSaver saves. */
  get document(): Deck {
    return this.deck;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  /** Run a mutation as one undoable step (merged into the previous step when both share a group). */
  transact(fn: (tx: DeckTx) => void, meta?: { before?: M; after?: M }, group?: string): boolean {
    const prev = this.deck;
    const tx = new DeckTx(this);
    fn(tx);
    if (!tx.patches.length) return false;
    const refused = this.guard?.(prev, this.deck);
    if (refused) {
      this.deck = prev;
      throw new TransactionRefused(refused);
    }
    const top = this.undoStack[this.undoStack.length - 1];
    if (group && top?.group === group && !this.redoStack.length) {
      top.patches.push(...tx.patches);
      top.metaAfter = meta?.after;
    } else {
      this.undoStack.push({ patches: tx.patches, metaBefore: meta?.before, metaAfter: meta?.after, group });
      if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    }
    this.redoStack = [];
    this.emit();
    return true;
  }

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

  undo(): DeckUndoEntry<M> | null {
    const e = this.undoStack.pop();
    if (!e) return null;
    for (const p of [...e.patches].reverse()) this.deck = applyPatch(this.deck, p, true);
    this.redoStack.push(e);
    this.emit();
    return e;
  }

  redo(): DeckUndoEntry<M> | null {
    const e = this.redoStack.pop();
    if (!e) return null;
    for (const p of e.patches) this.deck = applyPatch(this.deck, p, false);
    this.undoStack.push(e);
    this.emit();
    return e;
  }
}

/** The guard of a PowerPoint file (shared/pptxFormat.ts): refuses adding what the file can only approximate. */
export const pptxGuard = (before: Deck, after: Deck): string | null => newPptxGap(before, after);
