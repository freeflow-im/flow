// Keeps an open editor on the latest revision of its file. Saves name the revision loaded, and the server refuses
// (409) one made after something else saved (another tab or device, the ChatGPT plugin); the editor then takes
// the newer version. Between saves the server's feed (`/api/revisions/:id`, server/revisionFeed.ts) announces each
// new revision, and an editor with nothing unsaved loads it straight away.
import type { SheetMeta } from '../../../shared/types.ts';
import { ApiError } from '../api.ts';
import type { AutoSaver } from './store.ts';

export interface RevisionSource<D> {
  save(doc: D, rev: string): Promise<{ meta: SheetMeta }>;
  load(): Promise<{ meta: SheetMeta; doc: D }>;
}

/** A newer version the editor took: whether its content changed, and whether edits of the user's were lost. */
export interface Taken {
  meta: SheetMeta;
  changed: boolean;
  lostEdits: boolean;
}

/** What to tell the user when the editor took a newer version. */
export function takenMessage(t: Taken): string {
  return t.lostEdits
    ? 'This file was changed somewhere else (another tab or app, say) before your last edit was saved, so it now shows that version.'
    : 'Updated with changes saved somewhere else, such as another tab or app.';
}

/** The editor: its saver, and how it swaps in a version saved elsewhere. */
export interface RevisionTarget<D> {
  saver: AutoSaver<D>;
  replaceWith(doc: D): boolean;
}

export class RevisionSync<D> {
  rev: string;
  private id: string;
  private source: RevisionSource<D>;
  private target: RevisionTarget<D> | null = null;
  private loading = false;
  private listeners = new Set<(t: Taken) => void>();

  constructor(id: string, rev: string, source: RevisionSource<D>) {
    this.id = id;
    this.rev = rev;
    this.source = source;
  }

  /** The save function for the editor's AutoSaver. */
  save = async (doc: D): Promise<void> => {
    try {
      this.rev = (await this.source.save(doc, this.rev)).meta.updatedAt;
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409)) throw e;
      this.take(await this.source.load(), true);
    }
  };

  /** Hear about each newer version the editor takes. Returns the function that stops. */
  onTaken(fn: (t: Taken) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Follow the server's announcements for the editor. Returns the function that stops. */
  attach(target: RevisionTarget<D>): () => void {
    this.target = target;
    const events = typeof EventSource === 'undefined' ? null : new EventSource(`/api/revisions/${encodeURIComponent(this.id)}`);
    if (events) events.onmessage = (e: MessageEvent<string>) => void this.heard(e.data);
    return () => {
      events?.close();
      this.target = null;
    };
  }

  /** One announcement from the feed: `{ rev }`. */
  async heard(data: string): Promise<void> {
    let rev: unknown;
    try {
      rev = (JSON.parse(data) as { rev?: unknown }).rev;
    } catch {
      return;
    }
    if (typeof rev !== 'string' || rev === this.rev || this.loading || !this.target || this.target.saver.hasUnsavedChanges()) return;
    this.loading = true;
    try {
      const latest = await this.source.load();
      // An edit made while loading is saved, and refused, as usual rather than replaced here.
      if (this.target && !this.target.saver.hasUnsavedChanges()) this.take(latest, false);
    } catch {
      // The next announcement or save tries again.
    } finally {
      this.loading = false;
    }
  }

  /** Take the stored version; `refused` when it comes from a save of the editor's that was refused. */
  private take(latest: { meta: SheetMeta; doc: D }, refused: boolean): void {
    this.rev = latest.meta.updatedAt;
    if (!this.target) return;
    const changed = this.target.replaceWith(latest.doc);
    // The editor now holds what is stored: nothing to write back.
    this.target.saver.adopt();
    const taken = { meta: latest.meta, changed, lostEdits: refused && changed };
    for (const fn of this.listeners) fn(taken);
  }
}
