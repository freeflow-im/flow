// Gmail's inbox tabs above the list: Primary, then the account's enabled tabs, sharing the row. The open one is blue
// with a 3px underline; another with mail new since it was last opened shows a coloured "N new" pill and, under its
// name, who sent the latest message and its subject. Where the row is too narrow for that, each tab is its icon and a
// count, and the row scrolls sideways.
import { useEffect, useRef, useState, type ComponentType } from 'react';
import { Inbox, Info, MessageSquare, Tag, Users } from 'lucide-react';
import type { Category, TabCount } from '../api';
import { badgeFor, latestLine, TAB_INFO } from '../lib/tabs';
import { cn } from '../lib/utils';

export const TAB_ICONS: Record<Category, ComponentType<{ className?: string }>> = { primary: Inbox, promotions: Tag, social: Users, updates: Info, forums: MessageSquare };
/** Below this width per tab, the tabs are icons and counts. */
const MIN_TAB_WIDTH = 168;

export function InboxTabs({ tabs, active, counts, onChange }: { tabs: Category[]; active: Category; counts: TabCount[] | undefined; onChange(tab: Category): void }) {
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
      {tabs.map((id) => {
        const info = TAB_INFO[id];
        const Icon = TAB_ICONS[id];
        const count = counts?.find((c) => c.id === id);
        const isActive = id === active;
        const badge = badgeFor(count, isActive);
        const line = badge?.kind === 'new' ? latestLine(count) : null;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={isActive}
            title={compact ? `${info.label}${badge ? ` (${badge.text})` : ''}` : undefined}
            onClick={() => onChange(id)}
            className={cn(
              'relative flex h-14 min-w-0 flex-1 items-center text-left text-sm outline-none hover:bg-hover focus-visible:bg-hover',
              compact ? 'min-w-[64px] justify-center gap-1.5 px-2' : 'gap-4 px-4',
              isActive ? 'text-primary' : 'text-muted',
            )}
          >
            <Icon className="size-5 shrink-0" />
            {compact ? (
              badge && <CompactCount id={id} text={badge.kind === 'new' ? badge.text.replace(' new', '') : badge.text} />
            ) : (
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-2">
                  <span className={cn('truncate', isActive || badge?.kind === 'new' ? 'font-semibold' : 'font-medium', !isActive && badge?.kind === 'new' && 'text-ink')}>{info.label}</span>
                  {badge?.kind === 'new' && <span className={cn('shrink-0 rounded px-1.5 py-px text-[11px] leading-4 font-semibold', info.pill)}>{badge.text}</span>}
                  {badge?.kind === 'count' && <span className={cn('shrink-0 text-xs font-semibold', isActive ? 'text-primary' : 'text-ink')}>{badge.text}</span>}
                </span>
                {line && <span className="truncate text-xs text-muted">{line}</span>}
              </span>
            )}
            {isActive && <span aria-hidden className="absolute inset-x-2 bottom-0 h-[3px] rounded-t-[3px] bg-primary" />}
          </button>
        );
      })}
    </div>
  );
}

function CompactCount({ id, text }: { id: Category; text: string }) {
  return <span className={cn('rounded-full px-1.5 text-[11px] leading-[18px] font-semibold', id === 'primary' ? 'text-ink' : TAB_INFO[id].pill)}>{text}</span>;
}
