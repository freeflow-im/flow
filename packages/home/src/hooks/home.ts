// Home's data, one query per card, each in the organization the bar selected. The cards load on their own and in
// parallel, so a slow app holds up only its own card. Each is read again every minute while the page is open, and when
// the window regains focus (main.tsx).
import { useQuery } from '@tanstack/react-query';
import { homeApi } from '../api';
import { agentsOf, inboxOf, todayRange, todaysEvents } from '../lib/home';

const REFRESH_MS = 60_000;
const INBOX_ROWS = 4;
const MENTION_ROWS = 20;

/** The states in which the account's mailbox and calendars are still being made (platform.md §3.4). */
const SETTING_UP = ['requested', 'mailbox_ready', 'calendars_ready'];

export function useAccountSetup(org: string | null) {
  const q = useQuery({ queryKey: ['home', 'accounts'], queryFn: homeApi.accounts, enabled: !!org, refetchInterval: (query) => (query.state.data?.some((a) => a.organizationId === org && SETTING_UP.includes(a.state)) ? 5_000 : REFRESH_MS) });
  const account = q.data?.find((a) => a.organizationId === org) ?? null;
  return { settingUp: !!account && SETTING_UP.includes(account.state), guest: account?.kind === 'guest', ready: q.isSuccess };
}

export function useChat(org: string | null) {
  const channels = useQuery({ queryKey: ['home', 'channels', org], queryFn: () => homeApi.channels(org!), enabled: !!org, refetchInterval: REFRESH_MS });
  const members = useQuery({ queryKey: ['home', 'members', org], queryFn: () => homeApi.members(org!), enabled: !!org, refetchInterval: 5 * REFRESH_MS });
  const mentions = useQuery({ queryKey: ['home', 'mentions', org], queryFn: () => homeApi.mentions(org!, MENTION_ROWS), enabled: !!org, refetchInterval: REFRESH_MS });
  return { channels, members, mentions, agents: agentsOf(members.data ?? []) };
}

/** The first mail account's inbox: its unread count and its newest conversations. Waits while the mailbox is being made. */
export function useInbox(org: string | null, settingUp: boolean) {
  const on = !!org && !settingUp;
  const accounts = useQuery({ queryKey: ['home', 'mail', 'accounts', org], queryFn: () => homeApi.mailAccounts(org!), enabled: on, refetchInterval: 5 * REFRESH_MS });
  const account = accounts.data?.[0] ?? null;
  const folders = useQuery({ queryKey: ['home', 'mail', 'folders', org, account?.id], queryFn: () => homeApi.mailFolders(org!, account!.id), enabled: on && !!account, refetchInterval: REFRESH_MS });
  const inbox = folders.data ? inboxOf(folders.data) : null;
  const threads = useQuery({
    queryKey: ['home', 'mail', 'threads', org, account?.id, inbox?.path],
    queryFn: () => homeApi.inbox(org!, account!.id, inbox!.path, INBOX_ROWS),
    enabled: on && !!account && !!inbox,
    refetchInterval: REFRESH_MS,
  });
  return { accounts, account, folders, inbox, threads, unread: inbox?.unread ?? 0 };
}

export function useToday(org: string | null, settingUp: boolean, now: Date) {
  const { from, to } = todayRange(now);
  const q = useQuery({ queryKey: ['home', 'events', org, from], queryFn: () => homeApi.events(org!, from, to), enabled: !!org && !settingUp, refetchInterval: REFRESH_MS });
  return { ...q, events: q.data ? todaysEvents(q.data) : null };
}

export function useRecentFiles(org: string | null) {
  return useQuery({ queryKey: ['home', 'recents', org], queryFn: () => homeApi.recentFiles(org!), enabled: !!org, refetchInterval: REFRESH_MS });
}
