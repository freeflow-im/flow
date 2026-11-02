// "Set a status…" from the account menu: the canned statuses (status.ts) and Clear, in a small dialog. Both apps
// show it; each saves the choice with its own `PATCH /v1/me`.
import { useEffect, useRef } from 'react';
import { STATUS_OPTIONS, type StatusOption } from './status';
import './suite-bar.css';

export interface StatusDialogProps {
  current?: { emoji: string; text: string } | null;
  /** Saving: the options are disabled. */
  busy?: boolean;
  error?: string | null;
  onPick(option: StatusOption): void;
  onClear(): void;
  onClose(): void;
}

export function StatusDialog({ current, busy, error, onPick, onClear, onClose }: StatusDialogProps) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="sb-dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sb-dialog" role="dialog" aria-modal="true" aria-labelledby="sb-status-title" data-testid="suite-status-dialog">
        <h2 id="sb-status-title" className="sb-dialog-title">Set a status</h2>
        <div className="sb-status-list">
          {STATUS_OPTIONS.map((o, i) => (
            <button
              key={o.text}
              ref={i === 0 ? first : undefined}
              type="button"
              className={`sb-status-option${current?.text === o.text && current.emoji === o.emoji ? ' active' : ''}`}
              data-testid={`suite-status-option-${i + 1}`}
              disabled={busy}
              onClick={() => onPick(o)}
            >
              <span className="sb-status-emoji">{o.emoji}</span>
              <span className="sb-status-text">{o.text}</span>
              {o.suppresses && <span className="sb-menu-hint">pauses notifications</span>}
            </button>
          ))}
        </div>
        {error && <p className="sb-dialog-error" role="alert">{error}</p>}
        <div className="sb-dialog-actions">
          <button type="button" className="sb-link-btn" data-testid="suite-status-clear" disabled={busy || !current?.text} onClick={onClear}>
            Clear status
          </button>
          <button type="button" className="sb-link-btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
