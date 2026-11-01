// Editor state for an open Markdown document: the text, the autosaver that writes it, and what the page and
// the assistant's context need to know about it. Editing happens in a plain textarea (the browser keeps the
// undo history), so the controller only tracks the text and its version.
import { useSyncExternalStore } from 'react';
import type { TextEdit } from '../../../shared/agent/markdownBlocks.ts';
import { applyEdit } from '../../../shared/agent/markdownBlocks.ts';
import type { MarkdownDoc } from '../../../shared/markdown.ts';
import { AutoSaver } from '../state/store.ts';

export class MarkdownController {
  text: string;
  /** Counts text changes (what the AutoSaver watches). */
  version = 0;
  /** How many times replaceWith brought in a version saved elsewhere (the page can tell the user). */
  externalChanges = 0;
  readonly saver: AutoSaver<MarkdownDoc>;
  /** Character offset of the cursor in the editor (the page keeps it current). */
  cursor = 0;
  /**
   * The page registers how to apply an edit through the textarea (so it joins the browser's undo history);
   * without it edits go straight to the text.
   */
  onApplyEdit: ((edit: TextEdit) => void) | null = null;
  private listeners = new Set<() => void>();
  private cached: MarkdownDoc | null = null;

  constructor(doc: MarkdownDoc, save: (doc: MarkdownDoc) => Promise<void>) {
    this.text = doc.text;
    this.saver = new AutoSaver<MarkdownDoc>(this, save);
  }

  dispose(): void {
    this.saver.dispose();
  }

  /** The document the AutoSaver saves (built once per version). */
  get document(): MarkdownDoc {
    if (!this.cached || this.cached.text !== this.text) this.cached = { version: 1, text: this.text };
    return this.cached;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  private emit(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  /** The user typed: take the textarea's text. */
  setText(text: string): void {
    if (text === this.text) return;
    this.text = text;
    this.emit();
  }

  /** Take a version saved elsewhere (another tab); the saver then writes it back under the newer revision. */
  replaceWith(doc: MarkdownDoc): boolean {
    if (doc.text === this.text) return false;
    this.text = doc.text;
    this.externalChanges++;
    this.emit();
    return true;
  }

  /** Apply an assistant edit: through the editor when mounted, else to the text. */
  applyEdit(edit: TextEdit): void {
    if (this.onApplyEdit) this.onApplyEdit(edit);
    else this.setText(applyEdit(this.text, edit));
    this.cursor = edit.from + edit.insert.length;
  }

  lineCount(): number {
    return this.text === '' ? 0 : this.text.split('\n').length;
  }
}

/** Re-render on every change to the controller. */
export function useMarkdownController(ctl: MarkdownController): number {
  return useSyncExternalStore(ctl.subscribe, ctl.getVersion);
}
