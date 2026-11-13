// Inline chat find (#518): cmd-F opens a find bar under the channel header
// that searches the messages already on screen. No server round-trip and no
// history paging — what is loaded is what is searchable, which is the whole
// point of it being instant.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { matchLabel, stepIndex } from '../lib/chatSearch';
import { clearHighlights, collectMatches, paintHighlights, type FoundMatch } from '../lib/findHighlight';

export type ChatFind = {
  open: boolean;
  query: string;
  setQuery: (q: string) => void;
  total: number;
  index: number;
  step: (dir: 1 | -1) => void;
  close: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
};

/**
 * The find-bar state machine, wired to cmd-F (ctrl-F off a Mac).
 *
 * `containerRef` is the pane whose `[data-search-body]` elements get searched;
 * `revision` is anything that changes when the transcript does (the newest
 * message id will do), so an arriving message re-finds rather than leaving the
 * counter and the highlights describing a list that has moved on.
 */
export function useChatFind(
  containerRef: React.RefObject<HTMLElement | null>,
  revision: string | null,
): ChatFind {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(-1);
  const [total, setTotal] = useState(0);
  const matchesRef = useRef<FoundMatch[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setIndex(-1);
    setTotal(0);
    matchesRef.current = [];
    clearHighlights();
  }, []);

  // cmd-F / ctrl-F: open (or refocus) the bar, and swallow the event so the
  // browser's own find never opens over it (AC 1).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'f' && e.key !== 'F') return;
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      e.preventDefault();
      setOpen(true);
      // Already open: put the caret back in the box with the query selected,
      // so a second cmd-F starts a new search rather than doing nothing.
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);


  // Esc closes the bar from anywhere in the chat, not only from inside the box
  // — the caret is often back in the composer by then (AC 5). Skipped while a
  // modal is up: Esc belongs to the thing on top.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('[role="dialog"]')) return;
      close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  // Unmounting the pane (channel switch, sign-out) must not leave the last
  // channel's highlights painted over the new one.
  useEffect(() => clearHighlights, []);

  // Re-find whenever the query, the transcript or the bar's open state
  // changes. Layout effect: the highlights and the counter are computed from
  // the DOM React has just committed, never from the previous frame's.
  useLayoutEffect(() => {
    const root = containerRef.current;
    if (!open || !root || !query) {
      matchesRef.current = [];
      setTotal(0);
      setIndex(-1);
      clearHighlights();
      return;
    }
    const found = collectMatches(root, query);
    matchesRef.current = found;
    setTotal(found.length);
    // Keep the cursor where it was while the transcript grows under us; a new
    // query starts at the first match.
    setIndex((prev) => (found.length === 0 ? -1 : Math.min(Math.max(prev, 0), found.length - 1)));
  }, [open, query, revision, containerRef]);

  // Paint, and bring the current match into view. Scrolling happens only here
  // — opening or closing the bar never moves the transcript.
  useLayoutEffect(() => {
    const found = matchesRef.current;
    paintHighlights(found, index);
    const cursor = found[index];
    if (cursor) cursor.element.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [index, total, query]);

  const step = useCallback(
    (dir: 1 | -1) => setIndex((prev) => stepIndex(prev, matchesRef.current.length, dir)),
    [],
  );

  return { open, query, setQuery, total, index, step, close, inputRef };
}

/** The bar itself: query box, "n of m" counter, prev/next and a close "x". */
export default function FindBar({ find }: { find: ChatFind }) {
  const { query, total, index } = find;
  const empty = query.length > 0 && total === 0;

  return (
    <div
      data-testid="find-bar"
      role="search"
      className="flex shrink-0 items-center gap-2 border-b border-hairline bg-base px-[22px] py-1.5 max-md:px-3"
    >
      <input
        ref={find.inputRef}
        data-testid="find-input"
        autoFocus
        type="text"
        value={query}
        placeholder="Find in loaded messages"
        aria-label="Find in loaded messages"
        className={`min-w-0 flex-1 rounded-lg border bg-white px-2.5 py-1 text-sm outline-none ${
          empty ? 'border-unread' : 'border-hairline focus:border-hairline2'
        }`}
        onChange={(e) => find.setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            find.close();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            find.step(e.shiftKey ? -1 : 1);
          }
        }}
      />
      <span
        data-testid="find-count"
        aria-live="polite"
        className={`shrink-0 text-xs tabular-nums ${empty ? 'font-semibold text-unread' : 'text-muted'}`}
      >
        {matchLabel(index, total)}
      </span>
      <button
        type="button"
        data-testid="find-prev"
        title="Previous match (shift-enter)"
        aria-label="Previous match"
        disabled={total === 0}
        className="rounded-md px-1.5 py-0.5 text-sm leading-none text-muted hover:bg-daypill hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent"
        onClick={() => find.step(-1)}
      >
        ↑
      </button>
      <button
        type="button"
        data-testid="find-next"
        title="Next match (enter)"
        aria-label="Next match"
        disabled={total === 0}
        className="rounded-md px-1.5 py-0.5 text-sm leading-none text-muted hover:bg-daypill hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent"
        onClick={() => find.step(1)}
      >
        ↓
      </button>
      <button
        type="button"
        data-testid="find-close"
        title="Close find (esc)"
        aria-label="Close find"
        className="rounded-md px-1.5 py-0.5 text-sm leading-none text-muted hover:bg-daypill hover:text-ink"
        onClick={find.close}
      >
        ✕
      </button>
    </div>
  );
}
