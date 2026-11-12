// FreeFlow Home (docs/specs/home.md): the suite bar, a sidebar of the apps, channels and agents, and beside it either
// Home's cards (what is new in each app) or the app opened from them, in a frame Home keeps (hooks/frames.ts). Home stays
// on screen: a row in the sidebar or a card opens its app beside it. A guest uses Chat only (workspace-admin.md §6.5),
// so a guest is sent there.
import { useEffect, useState, type MouseEvent } from 'react';
import type { SuiteMenuItem } from '@flow/suite-bar';
import { useQuery } from '@tanstack/react-query';
import type { WorkspaceMemberDTO } from '@flow/shared';
import { adminAddress, chatPageAddress } from '@flow/shared/addresses';
import { homeApi } from './api';
import { FilesCard, InboxCard, MentionsCard, TodayCard } from './components/Cards';
import { HomeSuiteBar } from './components/HomeSuiteBar';
import { appLinks, Sidebar } from './components/Sidebar';
import { useFrames } from './hooks/frames';
import { useAppMenus } from './hooks/menus';
import { useAccountSetup, useChat, useInbox, useRecentFiles, useToday } from './hooks/home';
import { useOrganizations } from './hooks/organization';
import { channelAddress, chatUnread, dmWith, greeting, sidebarChannels, summaryLine } from './lib/home';
import { FRAMED_APPS, channelOf, type FramedApp } from './lib/views';
import { readActiveOrganization, suite, writeActiveOrganization } from './suite';

/** The clock the page reads, moved on every minute so the greeting and "today" follow the day. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

export function App() {
  const organizations = useOrganizations();
  const org = organizations.active ?? null;
  const orgId = org?.id ?? null;
  const admin = org?.role === 'owner' || org?.role === 'admin';
  const now = useNow();
  const me = useQuery({ queryKey: ['suite', 'me'], queryFn: suite.me, refetchInterval: 60_000 });
  const setup = useAccountSetup(orgId);
  const chat = useChat(orgId);
  const mail = useInbox(orgId, setup.settingUp);
  const today = useToday(orgId, setup.settingUp, now);
  const files = useRecentFiles(orgId);
  const frames = useFrames();
  const menus = useAppMenus(orgId, frames.refs.current, frames.follow);

  useEffect(() => {
    if (setup.guest) window.location.replace('/chat/');
  }, [setup.guest]);
  // The organization shown is kept where Chat keeps its selection, so a channel or an agent opened from here opens in it
  // (Chat follows an `open=` link only in the organization it has selected; with none it asks which one first).
  useEffect(() => {
    if (orgId && readActiveOrganization() !== orgId) writeActiveOrganization(orgId);
  }, [orgId]);

  const channels = chat.channels.data ?? null;
  const chatCount = channels ? chatUnread(channels) : 0;
  const unreadMentions = chat.mentions.data?.filter((n) => n.kind === 0 && !n.readAt).length ?? null;
  const [opening, setOpening] = useState<string | null>(null);
  const openAgent = async (agent: WorkspaceMemberDTO) => {
    if (!orgId || !me.data || opening) return;
    const existing = channels && dmWith(channels, me.data.id, agent.userId);
    if (existing) return void frames.open(channelAddress(existing.id));
    setOpening(agent.userId);
    try {
      const dm = await homeApi.openDm(orgId, [agent.userId]);
      frames.open(channelAddress(dm.id));
      void chat.channels.refetch();
    } catch {
      // Chat, where the agent's profile can start the DM instead.
      frames.open('/chat/');
    } finally {
      setOpening(null);
    }
  };

  // A link in the sidebar or a card opens in Home (an app's page in its frame) instead of leaving it. A click with a
  // modifier (a new tab or window) is the browser's.
  const onLinkClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element).closest('a[href]') as HTMLAnchorElement | null;
    if (!a || (a.target && a.target !== '_self')) return;
    if (frames.open(a.getAttribute('href')!)) e.preventDefault();
  };
  // An item of the open app's menu: the app switches to it in place; an app not loaded yet opens at the item's address.
  const onMenuItem = (item: SuiteMenuItem) => {
    if (frames.view === 'home') return;
    const app = frames.view as FramedApp;
    if (menus.select(app, item.id)) frames.show(app);
    else if (item.href) frames.open(item.href);
  };
  const openMenu = frames.view !== 'home' ? menus.menus[frames.view as FramedApp] : undefined;

  const chatHref = frames.last.chat;
  const activeChannel = chatHref ? channelOf(chatHref, window.location.origin) : null;

  return (
    <div className="flex h-full flex-col">
      <HomeSuiteBar chatUnread={chatCount} mailUnread={mail.unread} onHome={() => frames.open('/home/')} />
      {!organizations.ready ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted">Loading…</div>
      ) : !org ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center" data-testid="home-no-organization">
          <h1 className="text-xl font-semibold">Welcome to FreeFlow</h1>
          <p className="max-w-sm text-sm text-muted">Create an organization for your team, or join one you were invited to.</p>
          <a href={chatPageAddress('chooser')} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-deep">
            Get started
          </a>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 bg-panel" onClick={onLinkClick}>
          <Sidebar
            active={frames.view}
            activeChannel={activeChannel}
            apps={appLinks({ mailUnread: mail.unread, chatUnread: chatCount, admin })}
            channels={channels ? sidebarChannels(channels) : null}
            agents={chat.members.data ? chat.agents : null}
            onOpenAgent={(a) => void openAgent(a)}
            addAgentHref={admin ? adminAddress('agents') : null}
            menu={openMenu ? { items: openMenu.items, selected: openMenu.selected } : null}
            onMenuItem={onMenuItem}
          />
          {/* The apps opened so far, each in its own frame, kept loaded while hidden. */}
          {FRAMED_APPS.map((app) => {
            const f = frames.frames[app];
            return f ? (
              <iframe
                key={`${app}:${f.load}`}
                ref={(el) => void (frames.refs.current[app] = el)}
                src={f.src}
                title={app}
                data-testid={`home-frame-${app}`}
                className={`min-w-0 flex-1 border-0 bg-white ${frames.view === app ? '' : 'hidden'}`}
              />
            ) : null;
          })}
          <main className={`min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8 ${frames.view === 'home' ? '' : 'hidden'}`} data-testid="home-main">
            <div className="mx-auto flex max-w-5xl flex-col gap-5">
              <header>
                <h1 className="text-2xl font-semibold" data-testid="home-greeting">
                  {greeting(me.data?.displayName ?? '', now)}
                </h1>
                <p className="mt-1 text-sm text-muted">{summaryLine(now, { meetings: today.events?.filter((e) => !e.allDay).length ?? null, unread: mail.unread, mentions: unreadMentions })}</p>
              </header>
              {/* Below the sidebar's width, the apps as a row: the sidebar is hidden there. */}
              <nav aria-label="Apps" className="flex gap-2 overflow-x-auto md:hidden">
                {appLinks({ mailUnread: mail.unread, chatUnread: chatCount, admin })
                  .filter((a) => a.id !== 'home')
                  .map((a) => (
                    <a key={a.id} href={a.href} className="rounded-full border border-border bg-white px-3 py-1 text-sm whitespace-nowrap">
                      {a.label}
                      {a.count ? ` ${a.count}` : ''}
                    </a>
                  ))}
              </nav>
              <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                <TodayCard events={today.events} error={today.error} settingUp={setup.settingUp} />
                <InboxCard
                  address={mail.account?.email ?? null}
                  account={mail.account?.id ?? null}
                  inboxPath={mail.inbox?.path ?? null}
                  threads={mail.threads.data ?? null}
                  hasAccount={mail.accounts.data ? mail.accounts.data.length > 0 : null}
                  error={mail.accounts.error ?? mail.folders.error ?? mail.threads.error}
                  settingUp={setup.settingUp}
                  now={now}
                />
                <FilesCard files={files.data ?? null} error={files.error} now={now} />
                <MentionsCard
                  mentions={chat.mentions.data ?? null}
                  channels={channels}
                  members={chat.members.data ?? null}
                  error={chat.mentions.error}
                  inviteHref={chatPageAddress('invite')}
                  alone={(chat.members.data ?? []).filter((m) => !m.isAgent && !m.isBot).length <= 1}
                />
              </div>
            </div>
          </main>
        </div>
      )}
    </div>
  );
}
