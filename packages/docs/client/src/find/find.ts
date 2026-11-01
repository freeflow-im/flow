// Find in the document, Markdown, JSON and presentation editors (the spreadsheet has its own, state/search.ts): the
// state of a find bar, matching text, and ⌘F.
import { useEffect, useState } from 'react';
import { isMac } from '../commands.ts';

export interface FindState {
  query: string;
  matchCase: boolean;
  /** The match shown, an index into the editor's matches; -1 before one is. */
  current: number;
  /** Bumped by each ⌘F, so the input is focused (and its text selected) again. */
  focusSeq: number;
}

/** Where `query` is in `text`: the start of each match, not overlapping. */
export function findAll(text: string, query: string, matchCase: boolean): number[] {
  if (!query) return [];
  const hay = matchCase ? text : text.toLowerCase();
  const needle = matchCase ? query : query.toLowerCase();
  const out: number[] = [];
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

/** The next match from `current` in direction `dir`, wrapping around; the first (or last) when none is shown. */
export const stepIndex = (current: number, count: number, dir: 1 | -1): number => (count ? (current < 0 ? (dir > 0 ? 0 : count - 1) : (current + dir + count) % count) : -1);

/** Whether a key event is ⌘F (Ctrl+F elsewhere). */
export const isFindKey = (e: KeyboardEvent): boolean => (isMac ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f';

/**
 * A find bar's state for an editor that keeps it in its page: ⌘F opens it (or focuses it again) instead of the
 * browser's page search while `enabled`. Changing the query or case shows no match until the page picks one.
 */
export function useFind(enabled = true) {
  const [find, setFind] = useState<FindState | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isFindKey(e)) return;
      e.preventDefault();
      setFind((cur) => (cur ? { ...cur, focusSeq: cur.focusSeq + 1 } : { query: '', matchCase: false, current: -1, focusSeq: 1 }));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [enabled]);
  return {
    find,
    open: () => setFind((cur) => (cur ? { ...cur, focusSeq: cur.focusSeq + 1 } : { query: '', matchCase: false, current: -1, focusSeq: 1 })),
    close: () => setFind(null),
    set: (patch: Partial<FindState>) => setFind((cur) => (cur ? { ...cur, ...patch } : cur)),
  };
}
