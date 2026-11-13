// Home's left column: the apps, then the person's channels, then the organization's agents. Every row is a link to the
// page its own app shows (a channel or an agent's DM opens in Chat), so a click lands where the app would put you.
import { Fragment, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { ChannelDTO, WorkspaceMemberDTO } from '@flow/shared';
import type { SuiteMenuItem, SuiteMenuPicker } from '@flow/suite-bar';
import { adminAddress } from '@flow/shared/addresses';
import { channelAddress, SIDEBAR_CHANNELS } from '../lib/home';
import { AppMenu, Collapse } from './AppMenu';

export interface AppLink {
  id: string;
  label: string;
  href: string;
  count?: number;
  /** Chat's number is a pill (it needs you); Mail's is a plain count. */
  pill?: boolean;
}

export function appLinks(opts: { mailUnread: number; chatUnread: number; admin: boolean }): AppLink[] {
  return [
    { id: 'home', label: 'Home', href: '/home/' },
    { id: 'mail', label: 'Mail', href: '/mail/', count: opts.mailUnread },
    { id: 'calendar', label: 'Calendar', href: '/calendar/' },
    { id: 'docs', label: 'Docs', href: '/docs/' },
    { id: 'chat', label: 'Chat', href: '/chat/', count: opts.chatUnread, pill: true },
    ...(opts.admin ? [{ id: 'admin', label: 'Admin', href: adminAddress() }] : []),
  ];
}

const row = 'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm text-ink hover:bg-hover';

export function Sidebar(props: {
  apps: AppLink[];
  /** What the main area shows: Home's cards or an app, and the chat channel open in Chat. */
  active: string;
  activeChannel: string | null;
  channels: ChannelDTO[] | null;
  agents: WorkspaceMemberDTO[] | null;
  onOpenAgent: (agent: WorkspaceMemberDTO) => void;
  /** Where "+ Add" goes for someone who may add agents (an owner or admin); none otherwise. */
  addAgentHref: string | null;
  /**
   * The apps' menus (docs/specs/home.md §2.1). The open app's shows under its row; the others stay drawn, closed, so a
   * switch slides one shut and the other open.
   */
  menus: Partial<Record<string, { items: SuiteMenuItem[]; selected: string | null; picker?: SuiteMenuPicker }>>;
  onMenuItem: (item: SuiteMenuItem) => void;
  /** A choice in an app row's picker (Mail's accounts), from any view. */
  onPickerItem: (app: string, item: SuiteMenuItem) => void;
}) {
  const shown = props.channels?.slice(0, SIDEBAR_CHANNELS) ?? [];
  const more = (props.channels?.length ?? 0) - shown.length;
  return (
    <nav aria-label="Home" className="hidden w-60 shrink-0 flex-col gap-1 overflow-y-auto border-r border-hairline bg-white px-3 py-4 md:flex" data-testid="home-sidebar">
      {props.apps.map((a) => (
        <Fragment key={a.id}>
          <AppRow app={a} active={a.id === props.active} picker={props.menus[a.id]?.picker} onPick={(item) => props.onPickerItem(a.id, item)} />
          {props.menus[a.id] && (
            <Collapse open={a.id === props.active} testId={`home-menu-wrap-${a.id}`}>
              <AppMenu app={a.id} items={props.menus[a.id]!.items} selected={props.menus[a.id]!.selected} onItem={props.onMenuItem} />
            </Collapse>
          )}
        </Fragment>
      ))}

      <Heading label="Agents" action={props.addAgentHref ? { label: '+ Add', href: props.addAgentHref } : undefined} />
      {props.agents === null ? (
        <Placeholder />
      ) : props.agents.length === 0 ? (
        <p className="px-3 py-1.5 text-xs text-muted">{props.addAgentHref ? 'No agents yet. Add one to work beside you.' : 'No agents in this organization yet.'}</p>
      ) : (
        props.agents.map((a) => (
          <button key={a.userId} type="button" onClick={() => props.onOpenAgent(a)} data-testid={`home-agent-${a.userId}`} className={`${row} w-full text-left`} title={`Message ${a.displayName}`}>
            <Avatar name={a.displayName} url={a.avatarUrl} />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{a.displayName}</span>
              <span className="block truncate text-xs text-muted">{a.statusText || a.title || 'Agent'}</span>
            </span>
          </button>
        ))
      )}

      <Heading label="Channels" action={{ label: 'Open Chat', href: '/chat/' }} />
      {props.channels === null ? (
        <Placeholder />
      ) : shown.length === 0 ? (
        <a href="/chat/" className={`${row} text-muted`}>Find a channel in Chat</a>
      ) : (
        <>
          {shown.map((c) => (
            <a key={c.id} href={channelAddress(c.id)} data-testid={`home-channel-${c.id}`} aria-current={props.active === 'chat' && props.activeChannel === c.id ? 'page' : undefined} className={`${row} justify-between ${props.active === 'chat' && props.activeChannel === c.id ? 'bg-row-selected' : ''} ${c.unreadCount > 0 || c.unreadNotifications > 0 ? 'font-semibold' : ''}`}>
              <span className="truncate"># {c.name}</span>
              {c.unreadNotifications > 0 && <span className="min-w-5 rounded-full bg-ink px-1.5 text-center text-xs font-semibold text-white">{c.unreadNotifications}</span>}
            </a>
          ))}
          {more > 0 && <a href="/chat/" className={`${row} text-xs text-muted`}>{more} more in Chat</a>}
        </>
      )}
    </nav>
  );
}

function Heading({ label, action }: { label: string; action?: { label: string; href: string } }) {
  return (
    <div className="mt-5 mb-1 flex items-center justify-between px-3">
      <span className="text-xs font-semibold tracking-wide text-muted uppercase">{label}</span>
      {action && (
        <a href={action.href} className="text-xs font-medium text-primary hover:underline">
          {action.label}
        </a>
      )}
    </div>
  );
}

const Placeholder = () => <div className="mx-3 my-1 h-4 animate-pulse rounded bg-track" />;

export function Avatar({ name, url }: { name: string; url: string | null }) {
  if (url) return <img src={url} alt="" className="size-7 shrink-0 rounded-full object-cover" />;
  return <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-tint text-xs font-semibold text-primary-deep">{name.trim().charAt(0).toUpperCase() || '?'}</span>;
}

function Count({ app }: { app: AppLink }) {
  if (!app.count) return null;
  return app.pill ? <span className="min-w-5 rounded-full bg-ink px-1.5 text-center text-xs font-semibold text-white">{app.count}</span> : <span className="text-xs text-muted">{app.count}</span>;
}

/**
 * An app's row. With a picker (Mail's accounts, docs/specs/home.md §2.1) it reads `Mail gmail.com ▾`: the name still opens
 * the app, the short name and ▾ open the list below the row, and a choice goes to the app as a menu item's click does.
 */
function AppRow(props: { app: AppLink; active: boolean; picker?: SuiteMenuPicker; onPick: (item: SuiteMenuItem) => void }) {
  const { app, active, picker } = props;
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const cls = `${row} justify-between ${active ? 'bg-row-selected font-semibold' : ''}`;
  if (!picker || picker.items.length < 2) {
    return (
      <a href={app.href} aria-current={active ? 'page' : undefined} data-testid={`home-app-${app.id}`} className={cls}>
        <span>{app.label}</span>
        <Count app={app} />
      </a>
    );
  }
  const current = picker.items.find((i) => i.id === picker.selected);
  return (
    <div ref={box} className="relative">
      <div className={cls}>
        <span className="flex min-w-0 items-center">
          <a href={app.href} aria-current={active ? 'page' : undefined} data-testid={`home-app-${app.id}`} className="shrink-0">{app.label}</a>
          <button
            type="button"
            className="ml-1 flex h-5 min-w-0 items-center gap-0.5 rounded px-1 text-xs font-normal text-muted hover:bg-row-selected"
            aria-label={`Choose ${app.label} account${current ? `, now ${current.label}` : ''}`}
            aria-haspopup="menu"
            aria-expanded={open}
            data-testid={`home-picker-${app.id}`}
            onClick={() => setOpen(!open)}
          >
            {picker.label && <span className="truncate" data-testid={`home-picker-label-${app.id}`}>{picker.label}</span>}
            <ChevronDown className="size-4 shrink-0" aria-hidden />
          </button>
        </span>
        <Count app={app} />
      </div>
      {open && (
        <ul role="menu" className="absolute left-2 right-0 z-20 mt-1 rounded-md border border-hairline bg-white py-1 shadow-lg" data-testid={`home-picker-list-${app.id}`}>
          {picker.items.map((item) => (
            <li key={item.id} role="none">
              <a
                role="menuitemradio"
                aria-checked={item.id === picker.selected}
                href={item.href ?? app.href}
                title={item.label}
                className="flex items-center gap-2 px-2 py-1.5 text-[13px] text-ink hover:bg-hover"
                onClick={(e) => {
                  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                  e.preventDefault();
                  setOpen(false);
                  props.onPick(item);
                }}
              >
                {item.id === picker.selected ? <Check className="size-4 shrink-0" aria-hidden /> : <span className="size-4 shrink-0" aria-hidden />}
                <span className="truncate">{item.label}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
