// Channel member list hung off the header avatar stack (issue #70). Kept as a
// pure presentational component — ChannelView owns the fetch, presence lookup
// and the user-card handoff, so the ordering rule stays unit-testable.
import { useEffect, useRef, useState } from 'react';
import { Avatar } from './Avatar';

export interface MemberRow {
  userId: string;
  displayName: string;
  avatarUrl?: string | null;
  isAgent?: boolean;
  statusEmoji?: string;
  statusText?: string;
  online: boolean;
  isSelf?: boolean;
  /** You may take this member out of the channel: an owner or admin may take anyone, a person their own assistant. */
  removable?: boolean;
}

/** Online first, then alphabetical — the roster is short, so no other grouping. */
export function orderMembers(rows: MemberRow[]): MemberRow[] {
  return [...rows].sort(
    (a, b) =>
      Number(b.online) - Number(a.online) ||
      a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }),
  );
}

export default function ChannelMembersPopover({
  rows,
  loading = false,
  onSelect,
  onAdd,
  onRemove,
  onClose,
}: {
  rows: MemberRow[];
  loading?: boolean;
  onSelect: (userId: string) => void;
  /** "Add people", for a channel people can be added to. */
  onAdd?: () => void;
  /** Takes a removable member out of the channel; rejects with what to show when the server refuses. */
  onRemove?: (userId: string) => Promise<void>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const ordered = orderMembers(rows);
  // Remove asks once more on the row itself ("Remove?"), as Really delete? does elsewhere.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const remove = async (userId: string) => {
    setError(null);
    try {
      await onRemove?.(userId);
      setConfirming(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove them from the channel.');
    }
  };

  // Dismiss like the other header affordances: click anywhere outside, or Esc.
  // The trigger button lives outside this node, so it toggles on its own click
  // (pointerdown here would fire first and leave it reopening immediately) —
  // hence the data attribute check.
  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (ref.current?.contains(target ?? null)) return;
      if (target?.closest('[data-members-trigger]')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      data-testid="channel-members-popover"
      role="dialog"
      aria-label="Channel members"
      className="absolute top-[46px] right-0 z-30 max-h-[60vh] w-64 overflow-y-auto rounded-[14px] bg-white p-2 shadow-[0_12px_40px_rgba(20,8,40,.25)]"
    >
      <p className="px-2 pt-1 pb-1.5 text-[11px] font-bold tracking-[.05em] text-muted uppercase">
        {loading && rows.length === 0 ? 'Members' : `${rows.length} member${rows.length === 1 ? '' : 's'}`}
      </p>
      {onAdd && (
        <button
          data-testid="channel-add-people"
          className="mb-1 flex w-full items-center gap-2.5 rounded-[9px] p-1.5 text-left text-[13.5px] font-semibold text-accent-soft hover:bg-accent/10"
          onClick={onAdd}
        >
          <span className="flex h-[26px] w-[26px] items-center justify-center rounded-[9px] bg-accent/10 text-base leading-none">+</span>
          Add people
        </button>
      )}
      {rows.length === 0 && (
        <p className="px-2 py-2 text-sm text-faint">{loading ? 'Loading…' : 'No members.'}</p>
      )}
      {error && <p data-testid="channel-member-remove-error" className="px-2 py-1 text-[12px] text-red-600">{error}</p>}
      {ordered.map((m) => (
        <div key={m.userId} className="group flex items-center gap-1 rounded-[9px] hover:bg-accent/10">
        <button
          data-testid={`channel-member-${m.displayName}`}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[9px] p-1.5 text-left"
          onClick={() => onSelect(m.userId)}
        >
          <Avatar userId={m.userId} name={m.displayName} avatarUrl={m.avatarUrl} size={26} radius={9} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-[13.5px] font-semibold text-ink">
                {m.displayName}
                {m.isSelf && <span className="font-normal text-faint"> (you)</span>}
              </span>
              {m.isAgent && <span title="AI agent">🤖</span>}
              {m.statusEmoji && <span title={m.statusText || undefined}>{m.statusEmoji}</span>}
            </span>
            {m.statusText && <span className="block truncate text-[11px] text-faint">{m.statusText}</span>}
          </span>
          <span
            title={m.online ? 'Online' : 'Offline'}
            className={`inline-block h-2 w-2 shrink-0 rounded-full ${m.online ? 'bg-online' : 'border-[1.5px] border-hairline'}`}
          />
        </button>
        {m.removable && onRemove && (
          <button
            data-testid={`channel-member-remove-${m.displayName}`}
            aria-label={confirming === m.userId ? `Confirm removing ${m.displayName} from the channel` : `Remove ${m.displayName} from the channel`}
            className={`shrink-0 rounded-[7px] px-1.5 py-1 text-[11.5px] font-semibold ${confirming === m.userId ? 'bg-red-600 text-white hover:bg-red-700' : 'text-faint hover:text-red-600'}`}
            onClick={() => (confirming === m.userId ? void remove(m.userId) : setConfirming(m.userId))}
          >
            {confirming === m.userId ? 'Remove?' : 'Remove'}
          </button>
        )}
        </div>
      ))}
    </div>
  );
}
