// The find bar every editor shows (the spreadsheet's FindBar puts its own options in it): the query, how many
// matches and which is shown, previous and next (Shift+Enter, Enter), and close (Esc).
import { useEffect, useRef, type ReactNode } from 'react';
import { MOD } from '../commands.ts';

export function FindToggle(props: { on: boolean; title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      className={`find-toggle${props.on ? ' on' : ''}`}
      title={props.title}
      aria-label={props.title}
      aria-pressed={props.on}
      onMouseDown={(e) => e.preventDefault()}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

export function FindBox(props: {
  query: string;
  onQuery(query: string): void;
  /** How many matches there are, and which is shown (-1: none yet). */
  count: number;
  current: number;
  onStep(dir: 1 | -1): void;
  onClose(): void;
  /** Bumped to focus the input again (⌘F while it is open). */
  focusSeq: number;
  placeholder: string;
  label: string;
  /** Options after the arrows (Match case, ...). */
  children?: ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [props.focusSeq]);
  const { query, count, current } = props;
  const status = !query ? '' : count === 0 ? 'No results' : current >= 0 && current < count ? `${current + 1} of ${count}` : `${count} found`;

  return (
    <div className="find-bar" role="search" aria-label={props.label}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="find-icon">
        <circle cx="6.5" cy="6.5" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M10 10l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <input
        ref={inputRef}
        className="find-input"
        placeholder={props.placeholder}
        aria-label="Find"
        value={query}
        spellCheck={false}
        onChange={(e) => props.onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            props.onStep(e.shiftKey ? -1 : 1);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            props.onClose();
          }
        }}
      />
      <span className={`find-status${query && !count ? ' none' : ''}`} aria-live="polite">
        {status}
      </span>
      <button className="find-nav" title="Previous match (Shift+Enter)" aria-label="Previous match" disabled={!count} onMouseDown={(e) => e.preventDefault()} onClick={() => props.onStep(-1)}>
        ↑
      </button>
      <button className="find-nav" title="Next match (Enter)" aria-label="Next match" disabled={!count} onMouseDown={(e) => e.preventDefault()} onClick={() => props.onStep(1)}>
        ↓
      </button>
      {props.children && <span className="find-sep" />}
      {props.children}
      <button className="find-close" title={`Close (Esc) · open with ${MOD}F`} aria-label="Close find" onClick={props.onClose}>
        ✕
      </button>
    </div>
  );
}
