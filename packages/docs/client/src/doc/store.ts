// Document state with command-based undo/redo, mirroring DeckStore. Every change is a ProseMirror
// transaction: a list of steps, each of which knows how to invert itself. The store records the steps of
// each applied transaction (plus their inverses) as one undo entry; undo applies the inverses in reverse
// order, redo applies the steps again. Entries merge when they share a group (one agent request) or when
// they follow each other quickly (typing), so a sentence undoes in one go rather than a letter at a time.
import { EditorState, Selection, Transaction, type Plugin } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import type { Step } from 'prosemirror-transform';
import { docFromNode, docNode, type Doc } from '../../../shared/doc.ts';
import { TransactionRefused } from '../state/store.ts';

export interface DocUndoEntry {
  steps: Step[];
  inverse: Step[];
  /** Selection to restore after undoing / redoing (as JSON, mapped by position). */
  selBefore: unknown;
  selAfter: unknown;
  /** Entries with the same group that follow each other merge into one undo step (one agent request). */
  group?: string;
  time: number;
}

const MAX_UNDO = 500;
/** Changes closer together than this (typing) merge into one undo step. */
const MERGE_DELAY_MS = 500;

/** Transaction meta set by undo/redo so the store does not record them. */
export const HISTORY_META = 'doc-history';
/** Transaction meta that forces a new undo step. */
export const CLOSE_HISTORY_META = 'doc-close-history';

export class DocStore {
  state: EditorState;
  /** Counts document changes (what the AutoSaver watches). */
  version = 0;
  /** Counts every state change, including selection moves (what the UI watches). */
  tick = 0;
  private undoStack: DocUndoEntry[] = [];
  private redoStack: DocUndoEntry[] = [];
  private listeners = new Set<() => void>();
  private cached: { doc: EditorState['doc']; json: Doc } | null = null;
  /**
   * When set, every change to the document is checked before it takes effect (the document before and after):
   * a string refuses it (the reason) and apply throws TransactionRefused. A Word file's (desktop app).
   */
  guard: ((before: PMNode, after: PMNode) => string | null) | null = null;

  constructor(doc: Doc, plugins: Plugin[] = []) {
    this.state = EditorState.create({ doc: docNode(doc), plugins });
  }

  /** The document the AutoSaver saves (built once per version). */
  get document(): Doc {
    if (!this.cached || this.cached.doc !== this.state.doc) this.cached = { doc: this.state.doc, json: docFromNode(this.state.doc) };
    return this.cached.json;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit(docChanged: boolean): void {
    if (docChanged) this.version++;
    this.tick++;
    for (const l of this.listeners) l();
  }

  /** Apply a transaction. Returns whether the document changed. */
  apply(tr: Transaction, group?: string): boolean {
    const before = this.state;
    const refused = tr.docChanged && !tr.getMeta(HISTORY_META) ? this.guard?.(before.doc, tr.doc) : null;
    if (refused) throw new TransactionRefused(refused);
    this.state = before.apply(tr);
    if (!tr.docChanged) {
      this.emit(false);
      return false;
    }
    if (!tr.getMeta(HISTORY_META)) {
      const inverse = tr.steps.map((s, i) => s.invert(tr.docs[i]));
      const now = Date.now();
      const top = this.undoStack[this.undoStack.length - 1];
      const merge =
        top &&
        !this.redoStack.length &&
        !tr.getMeta(CLOSE_HISTORY_META) &&
        (group ? top.group === group : !top.group && now - top.time < MERGE_DELAY_MS);
      if (merge) {
        top.steps.push(...tr.steps);
        top.inverse.push(...inverse);
        top.selAfter = this.state.selection.toJSON();
        top.time = now;
      } else {
        this.undoStack.push({ steps: [...tr.steps], inverse, selBefore: before.selection.toJSON(), selAfter: this.state.selection.toJSON(), group, time: now });
        if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
      }
      this.redoStack = [];
    }
    this.emit(true);
    return true;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Start a new undo step for whatever comes next (e.g. when the editor loses focus). */
  closeHistory(): void {
    const top = this.undoStack[this.undoStack.length - 1];
    if (top) top.time = 0;
  }

  private replay(steps: Step[], selection: unknown): void {
    const tr = this.state.tr.setMeta(HISTORY_META, true);
    for (const s of steps) {
      const r = tr.maybeStep(s);
      if (r.failed) throw new Error(`Cannot undo: ${r.failed}`);
    }
    try {
      tr.setSelection(Selection.fromJSON(tr.doc, selection as Parameters<typeof Selection.fromJSON>[1]));
    } catch {
      // The old selection no longer fits; keep the mapped one.
    }
    tr.scrollIntoView();
    this.state = this.state.apply(tr);
  }

  undo(): DocUndoEntry | null {
    const e = this.undoStack.pop();
    if (!e) return null;
    this.replay([...e.inverse].reverse(), e.selBefore);
    this.redoStack.push(e);
    this.emit(true);
    return e;
  }

  redo(): DocUndoEntry | null {
    const e = this.redoStack.pop();
    if (!e) return null;
    this.replay(e.steps, e.selAfter);
    this.undoStack.push(e);
    this.emit(true);
    return e;
  }
}

const hasVideo = (node: PMNode): boolean => {
  let found = false;
  node.descendants((n) => {
    if (n.type.name === 'video') found = true;
    return !found;
  });
  return found;
};

/** The guard of a Word file (shared/docxFormat.ts): refuses adding a video, which a Word file cannot hold. */
export const docxGuard = (before: PMNode, after: PMNode): string | null => (hasVideo(after) && !hasVideo(before) ? 'Videos' : null);
