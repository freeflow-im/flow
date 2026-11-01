// Tells the editors open on a file when it is saved, so another tab, device or the ChatGPT plugin's edits show
// up without waiting for the next save to be refused. Each message is only the new revision (`updatedAt`); the
// editor loads the file itself when it has nothing unsaved.
//
// The watchers live in this process. With more than one server process, a save on one would reach only the
// editors connected to it: publish would need to go through shared pub/sub (Redis or Postgres LISTEN/NOTIFY),
// or every file's requests would have to land on the same process.

type Watcher = (rev: string) => void;

export class RevisionFeed {
  private watchers = new Map<string, Set<Watcher>>();

  /** Call `fn` with each new revision of the file. Returns the function that stops it. */
  watch(id: string, fn: Watcher): () => void {
    let set = this.watchers.get(id);
    if (!set) this.watchers.set(id, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (!set.size) this.watchers.delete(id);
    };
  }

  publish(id: string, rev: string): void {
    for (const fn of this.watchers.get(id) ?? []) fn(rev);
  }

  /** How many editors are watching the file (for tests). */
  watching(id: string): number {
    return this.watchers.get(id)?.size ?? 0;
  }
}
