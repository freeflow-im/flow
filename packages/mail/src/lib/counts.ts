// The folders' unread counts the sidebar shows, kept right by the client as the user reads, flags, moves and deletes,
// instead of asking the server again after each change. One quiet refresh a few seconds after the last change puts the
// server's numbers back, so a burst of j/k presses is one.
import type { MailFolder } from '../api';

/** Folders' unread and total, each moved by a delta (never below zero). */
export function adjustFolders(folders: MailFolder[], deltas: { path: string; unread?: number; total?: number }[]): MailFolder[] {
  const by = new Map<string, { unread: number; total: number }>();
  for (const d of deltas) {
    const cur = by.get(d.path) ?? { unread: 0, total: 0 };
    by.set(d.path, { unread: cur.unread + (d.unread ?? 0), total: cur.total + (d.total ?? 0) });
  }
  return folders.map((f) => {
    const d = by.get(f.path);
    return d ? { ...f, unread: Math.max(0, f.unread + d.unread), total: Math.max(0, f.total + d.total) } : f;
  });
}

/**
 * A debounced refresh: `schedule` asks for one `delayMs` after the last call, and it waits further while `busy()` (a
 * change is still on its way to the server, which would make the refresh read the old numbers).
 */
export function debounced(run: () => void, delayMs: number, busy: () => boolean = () => false) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    timer = null;
    if (busy()) timer = setTimeout(fire, delayMs);
    else run();
  };
  return {
    schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fire, delayMs);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
