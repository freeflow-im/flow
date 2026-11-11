// Home's left column: the apps, then the person's channels, then the organization's agents. Every row is a link to the
// page its own app shows (a channel or an agent's DM opens in Chat), so a click lands where the app would put you.
import type { ChannelDTO, WorkspaceMemberDTO } from '@flow/shared';
import { adminAddress } from '@flow/shared/addresses';
import { channelAddress, SIDEBAR_CHANNELS } from '../lib/home';

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
}) {
  const shown = props.channels?.slice(0, SIDEBAR_CHANNELS) ?? [];
  const more = (props.channels?.length ?? 0) - shown.length;
  return (
    <nav aria-label="Home" className="hidden w-60 shrink-0 flex-col gap-1 overflow-y-auto border-r border-hairline bg-white px-3 py-4 md:flex" data-testid="home-sidebar">
      {props.apps.map((a) => (
        <a key={a.id} href={a.href} aria-current={a.id === props.active ? 'page' : undefined} data-testid={`home-app-${a.id}`} className={`${row} justify-between ${a.id === props.active ? 'bg-row-selected font-semibold' : ''}`}>
          <span>{a.label}</span>
          {!!a.count && (a.pill ? <span className="min-w-5 rounded-full bg-ink px-1.5 text-center text-xs font-semibold text-white">{a.count}</span> : <span className="text-xs text-muted">{a.count}</span>)}
        </a>
      ))}

      <Heading label="Channels" />
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
