// The desktop app's view of changes other programs make in its folder. Only the directories something is
// looking at are watched (the folder a list shows, the folder of a file an editor has open), each once however
// many are looking, and not recursively: a folder can be the home directory, whose tree is vast and busy.
// A burst of events (a program writing a file through a temporary one and renaming it, say) is told once, after
// a moment of quiet, with the names of the entries that changed; changes that do not stop (a log being written)
// are told every `longest` milliseconds.
import { watch, type FSWatcher } from 'node:fs';

/** The names of the entries that changed in the directory; null when the system did not say which. */
type Listener = (names: Set<string> | null) => void;

interface Watched {
  watcher: FSWatcher;
  listeners: Set<Listener>;
}

export class DirWatchers {
  private dirs = new Map<string, Watched>();
  private abs: (dir: string) => string;
  private quiet: number;
  private longest: number;

  /** `abs` turns a folder path (`Reports/2026`, '' for the top) into the directory's absolute path. */
  constructor(abs: (dir: string) => string, quiet = 200, longest = 2000) {
    this.abs = abs;
    this.quiet = quiet;
    this.longest = longest;
  }

  /** Call `fn` after changes in the directory. Returns the function that stops. */
  watch(dir: string, fn: Listener): () => void {
    let w = this.dirs.get(dir);
    if (!w) {
      let watcher: FSWatcher;
      try {
        watcher = watch(this.abs(dir), { persistent: false });
      } catch {
        return () => {}; // Gone or unreadable: nothing to hear.
      }
      const listeners = new Set<Listener>();
      watcher.on('change', (_event, name) => {
        for (const l of listeners) l(name == null ? null : new Set([String(name)]));
      });
      // The directory removed, say: it stays quiet, and whoever watches it moves on.
      watcher.on('error', () => {});
      this.dirs.set(dir, (w = { watcher, listeners }));
    }
    let names: Set<string> | null = new Set();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let since = 0;
    const listener: Listener = (changed) => {
      if (names && changed) for (const n of changed) names.add(n);
      else names = null;
      if (timer) clearTimeout(timer);
      else since = Date.now();
      timer = setTimeout(() => {
        const told = names;
        names = new Set();
        timer = null;
        fn(told);
      }, Math.max(0, Math.min(this.quiet, since + this.longest - Date.now())));
    };
    const watched = w;
    watched.listeners.add(listener);
    return () => {
      if (timer) clearTimeout(timer);
      watched.listeners.delete(listener);
      if (!watched.listeners.size && this.dirs.get(dir) === watched) {
        watched.watcher.close();
        this.dirs.delete(dir);
      }
    };
  }

  /** Stop watching everything. */
  close(): void {
    for (const w of this.dirs.values()) w.watcher.close();
    this.dirs.clear();
  }

  /** How many directories are watched (for tests). */
  get size(): number {
    return this.dirs.size;
  }
}
