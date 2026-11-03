// The unread counts the sidebar and the inbox tabs show, kept right by the client as the user reads, flags, moves and
// deletes, instead of asking the server again after each change (which, on a large Gmail account, is the slow part). One
// quiet refresh a few seconds after the last change puts the server's numbers back, so a burst of j/k presses is one.
import type { Category, MailFolder, TabCount } from '../api';

/** A message an action changes, as the client last saw it. */
export interface Seen {
  uid: number;
  seen: boolean;
  /** Its inbox tab, when known (INBOX with tabs on). */
  category: Category | null;
}

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
 * The tabs' counts after some unread messages became read (`delta` < 0 per tab) or unread (> 0). A tab's "new" never
 * exceeds its unread; a message of a tab not shown counts in Primary, where the server puts it.
 */
export function adjustTabs(counts: TabCount[], deltas: Map<Category, number>): TabCount[] {
  const shown = new Set(counts.map((c) => c.id));
  const by = new Map<Category, number>();
  for (const [tab, d] of deltas) {
    const id = shown.has(tab) ? tab : 'primary';
    by.set(id, (by.get(id) ?? 0) + d);
  }
  return counts.map((c) => {
    const d = by.get(c.id);
    if (!d) return c;
    const unread = Math.max(0, c.unread + d);
    return { ...c, unread, new: Math.min(c.new, unread) };
  });
}

/** Per tab, how unread changes when these messages are marked `seen`; for messages leaving the inbox, pass `true`. */
export function tabDeltas(messages: Seen[], seen: boolean): Map<Category, number> {
  const out = new Map<Category, number>();
  for (const m of messages) {
    if (m.seen === seen) continue;
    const tab = m.category ?? 'primary';
    out.set(tab, (out.get(tab) ?? 0) + (seen ? -1 : 1));
  }
  return out;
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
