// An app's menu under its row in Home's sidebar (docs/specs/home.md §2.1): the items the app sent, with the one it shows
// marked. A click goes back to the app (App.tsx); an item with children opens them in place.
import { useState, type ComponentType } from 'react';
import {
  Archive,
  CalendarDays,
  CalendarCheck,
  ChevronDown,
  ChevronRight,
  Clock,
  File,
  Folder,
  Inbox,
  Lock,
  Mail,
  OctagonAlert,
  Pencil,
  Plus,
  Send,
  Settings,
  Share2,
  Star,
  Trash2,
  User,
  Users,
  type LucideProps,
} from 'lucide-react';
import type { SuiteMenuIcon, SuiteMenuItem } from '@flow/suite-bar';

const ICONS: Record<Exclude<SuiteMenuIcon, 'dot'>, ComponentType<LucideProps>> = {
  inbox: Inbox,
  star: Star,
  draft: File,
  send: Send,
  archive: Archive,
  mail: Mail,
  spam: OctagonAlert,
  trash: Trash2,
  folder: Folder,
  plus: Plus,
  pen: Pencil,
  clock: Clock,
  share: Share2,
  people: Users,
  lock: Lock,
  calendar: CalendarDays,
  today: CalendarCheck,
  settings: Settings,
  user: User,
};

function Icon({ item }: { item: SuiteMenuItem }) {
  if (item.icon === 'dot') {
    const on = item.on !== false;
    return <span className="size-3 shrink-0 rounded-sm border-2" style={{ borderColor: item.color ?? 'currentColor', background: on ? (item.color ?? 'currentColor') : 'transparent' }} aria-hidden />;
  }
  const I = item.icon ? ICONS[item.icon] : null;
  return I ? <I className="size-4 shrink-0 text-muted" strokeWidth={1.75} aria-hidden /> : <span className="size-4 shrink-0" aria-hidden />;
}

const row = 'flex w-full items-center gap-2.5 rounded-md py-1 pr-3 text-left text-[13px] text-ink hover:bg-hover';

export function AppMenu(props: { app: string; items: SuiteMenuItem[]; selected: string | null; onItem: (item: SuiteMenuItem) => void }) {
  return (
    <ul className="mb-1 flex flex-col" data-testid={`home-menu-${props.app}`}>
      {props.items.map((item) => (
        <MenuRow key={item.id} item={item} depth={0} selected={props.selected} onItem={props.onItem} />
      ))}
    </ul>
  );
}

function MenuRow({ item, depth, selected, onItem }: { item: SuiteMenuItem; depth: number; selected: string | null; onItem: (item: SuiteMenuItem) => void }) {
  const holdsSelected = !!item.children?.some((c) => c.id === selected);
  const [open, setOpen] = useState(holdsSelected);
  const current = item.id === selected;
  const pad = { paddingLeft: 24 + depth * 14 };
  if (item.children) {
    return (
      <li>
        <button type="button" className={`${row} text-muted`} style={pad} aria-expanded={open || holdsSelected} onClick={() => setOpen(!open)}>
          {open || holdsSelected ? <ChevronDown className="size-4 shrink-0" aria-hidden /> : <ChevronRight className="size-4 shrink-0" aria-hidden />}
          <span className="truncate">{item.label}</span>
        </button>
        {(open || holdsSelected) && (
          <ul>
            {item.children.map((c) => (
              <MenuRow key={c.id} item={c} depth={depth + 1} selected={selected} onItem={onItem} />
            ))}
          </ul>
        )}
      </li>
    );
  }
  return (
    <li>
      <button
        type="button"
        className={`${row} ${current ? 'bg-row-selected font-semibold' : ''} ${item.on === false ? 'text-muted' : ''}`}
        style={pad}
        aria-current={current ? 'page' : undefined}
        aria-pressed={item.on === undefined ? undefined : item.on}
        data-testid={`home-menu-item-${item.id}`}
        onClick={() => onItem(item)}
      >
        <Icon item={item} />
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {!!item.count && <span className="text-xs text-muted tabular-nums">{item.count > 9999 ? '9999+' : item.count}</span>}
      </button>
    </li>
  );
}
