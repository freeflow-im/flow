// Gmail's inbox tabs above the list: Primary, then the account's enabled tabs, sharing the row, each its icon and name.
// The open one is blue with a 3px underline. Where the row is too narrow for the names, each tab is its icon and only the
// open one keeps its name. Messages dragged from the list drop on a tab to move them there (lib/dnd.ts).
import { useEffect, useRef, useState, type ComponentType } from 'react';
import { Inbox, Info, MessageSquare, Tag, Users } from 'lucide-react';
import type { Category, TabStatus } from '../api';
import { useDropTarget } from '../lib/dnd';
import { TAB_BADGE_CLASS, TAB_INFO, tabBadge, tabPreview } from '../lib/tabs';
import { cn } from '../lib/utils';

export const TAB_ICONS: Record<Category, ComponentType<{ className?: string }>> = { primary: Inbox, promotions: Tag, social: Users, updates: Info, forums: MessageSquare };
/** Below this width per tab, the tabs are icons (and the open one's name). */
const MIN_TAB_WIDTH = 132;

export function InboxTabs({ tabs, active, status, onChange, onDropMessages }: { tabs: Category[]; active: Category; status?: Partial<Record<Category, TabStatus>> | undefined; onChange(tab: Category): void; onDropMessages?: ((tab: Category, uids: number[]) => void) | undefined }) {
  const row = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = row.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setCompact(el.clientWidth < tabs.length * MIN_TAB_WIDTH));
    ro.observe(el);
    return () => ro.disconnect();
  }, [tabs.length]);

  return (
    <div ref={row} role="tablist" aria-label="Inbox tabs" className="flex shrink-0 overflow-x-auto border-b border-hairline bg-white [scrollbar-width:none]">
      {tabs.map((id) => (
        <InboxTab key={id} id={id} active={id === active} compact={compact} status={status?.[id]} onChange={onChange} onDrop={onDropMessages && ((uids) => onDropMessages(id, uids))} />
      ))}
    </div>
  );
}

function InboxTab({ id, active, compact, status, onChange, onDrop }: { id: Category; active: boolean; compact: boolean; status: TabStatus | undefined; onChange(tab: Category): void; onDrop: ((uids: number[]) => void) | undefined }) {
  const info = TAB_INFO[id];
  const Icon = TAB_ICONS[id];
  const drop = useDropTarget(onDrop);
  const named = !compact || active;
  // What is new in a tab that is not open: "2 new" and the newest message's sender and subject, as Gmail's tabs say.
  const badge = active ? null : tabBadge(status);
  const preview = badge ? tabPreview(status) : null;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      title={named ? undefined : info.label}
      aria-label={named ? undefined : info.label}
      onClick={() => onChange(id)}
      {...drop.props}
      className={cn(
        'relative flex h-14 min-w-0 items-center text-sm outline-none hover:bg-hover focus-visible:bg-hover',
        compact ? (active ? 'shrink-0 gap-2 px-4' : 'min-w-[56px] flex-1 justify-center px-2') : 'flex-1 gap-4 px-4',
        active ? 'font-semibold text-primary' : 'font-medium text-muted',
        drop.over && 'bg-selected-blue text-primary ring-2 ring-primary ring-inset hover:bg-selected-blue',
      )}
    >
      <Icon className="size-5 shrink-0" />
      {named ? (
        <span className="flex min-w-0 flex-1 flex-col items-start">
          <span className="flex min-w-0 max-w-full items-center gap-2">
            <span className="truncate">{info.label}</span>
            {badge && <span className={cn('shrink-0 rounded-full px-2 py-px text-[11px] font-semibold text-white', TAB_BADGE_CLASS[id])}>{badge}</span>}
          </span>
          {preview && <span className="max-w-full truncate text-[12px] font-normal text-muted">{preview}</span>}
        </span>
      ) : (
        badge && <span className={cn('absolute top-2 right-2 size-2 rounded-full', TAB_BADGE_CLASS[id])} aria-label={badge} />
      )}
      {active && <span aria-hidden className="absolute inset-x-2 bottom-0 h-[3px] rounded-t-[3px] bg-primary" />}
    </button>
  );
}
