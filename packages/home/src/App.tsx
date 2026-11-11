// FreeFlow Home (docs/specs/home.md): the suite bar, a sidebar of the apps, channels and agents, and a page of cards with
// what is new in each app, for the organization the bar has active. Every row opens that app's own page. A guest uses
// Chat only (workspace-admin.md §6.5), so a guest is sent there.
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { WorkspaceMemberDTO } from '@flow/shared';
import { adminAddress, chatPageAddress } from '@flow/shared/addresses';
import { homeApi } from './api';
import { FilesCard, InboxCard, MentionsCard, TodayCard } from './components/Cards';
import { HomeSuiteBar } from './components/HomeSuiteBar';
import { appLinks, Sidebar } from './components/Sidebar';
import { useAccountSetup, useChat, useInbox, useRecentFiles, useToday } from './hooks/home';
import { useOrganizations } from './hooks/organization';
import { channelAddress, chatUnread, dmWith, greeting, sidebarChannels, summaryLine } from './lib/home';
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
    if (existing) return window.location.assign(channelAddress(existing.id));
    setOpening(agent.userId);
    try {
      const dm = await homeApi.openDm(orgId, [agent.userId]);
      window.location.assign(channelAddress(dm.id));
    } catch {
      // Chat, where the agent's profile can start the DM instead.
      window.location.assign('/chat/');
    } finally {
      setOpening(null);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <HomeSuiteBar chatUnread={chatCount} mailUnread={mail.unread} />
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
        <div className="flex min-h-0 flex-1 bg-panel">
          <Sidebar
            apps={appLinks({ mailUnread: mail.unread, chatUnread: chatCount, admin })}
            channels={channels ? sidebarChannels(channels) : null}
            agents={chat.members.data ? chat.agents : null}
            onOpenAgent={(a) => void openAgent(a)}
            addAgentHref={admin ? adminAddress('agents') : null}
          />
          <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8" data-testid="home-main">
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
