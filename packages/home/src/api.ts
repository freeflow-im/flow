// The other apps' APIs, as Home reads them: each card asks the app it shows, in the organization the bar selected. Only
// the fields Home draws are typed here; each app's own client has the rest (packages/mail, calendar, docs, web).
import type { ChannelDTO, NotificationDTO, WorkspaceMemberDTO } from '@flow/shared';

/** A request the server refused, with its error code (`no_account`, `guest`, …): a card says why it is empty. */
export class HomeApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin' });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    throw new HomeApiError(res.status, err?.error?.code ?? `http_${res.status}`, err?.error?.message ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

const enc = encodeURIComponent;
/** `path` naming the organization, as Mail, Calendar and Docs take it (`?workspace=`). */
const inOrg = (path: string, org: string) => `${path}${path.includes('?') ? '&' : '?'}workspace=${enc(org)}`;

export interface MailAccount {
  id: string;
  email: string;
  status: string;
}
export interface MailFolder {
  path: string;
  specialUse: string | null;
  unread: number;
}
export interface MailThread {
  threadId: string;
  unread: number;
  latest: { subject: string; date: string; from: { name: string; address: string } | null };
}
export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  status: 'confirmed' | 'tentative' | 'cancelled';
  attendees: { name?: string | null; email: string }[];
}
export interface RecentFile {
  id?: string;
  name: string;
  kind: 'doc' | 'deck' | 'sheet' | 'markdown' | 'pdf' | 'file';
  lastUsed: string;
}

/** One of the person's accounts (GET /v1/me/accounts): a new one's mailbox and calendars are made after it joins. */
export interface SuiteAccount {
  organizationId: string;
  kind: 'native' | 'guest';
  state: 'requested' | 'mailbox_ready' | 'calendars_ready' | 'active' | 'suspended' | 'removed';
}

export const homeApi = {
  accounts: async () => (await get<{ accounts: SuiteAccount[] }>('/v1/me/accounts')).accounts,
  mailAccounts: async (org: string) => (await get<{ accounts: MailAccount[] }>(inOrg('/v1/mail/accounts', org))).accounts,
  mailFolders: async (org: string, account: string) => (await get<{ folders: MailFolder[] }>(inOrg(`/v1/mail/accounts/${enc(account)}/folders`, org))).folders,
  inbox: async (org: string, account: string, inboxPath: string, limit: number) =>
    (await get<{ threads: MailThread[] }>(inOrg(`/v1/mail/accounts/${enc(account)}/threads?folder=${enc(inboxPath)}&limit=${limit}`, org))).threads,
  events: async (org: string, from: string, to: string) => (await get<{ events: CalendarEvent[] }>(inOrg(`/v1/calendar/events?from=${enc(from)}&to=${enc(to)}`, org))).events,
  recentFiles: async (org: string) => (await get<{ files: RecentFile[] }>(inOrg('/api/recents', org))).files,
  channels: async (org: string) => (await get<{ channels: ChannelDTO[] }>(`/v1/workspaces/${enc(org)}/channels`)).channels,
  members: async (org: string) => (await get<{ members: WorkspaceMemberDTO[] }>(`/v1/workspaces/${enc(org)}/members`)).members,
  mentions: async (org: string, limit: number) => (await get<{ notifications: NotificationDTO[] }>(`/v1/me/notifications?workspaceId=${enc(org)}&limit=${limit}`)).notifications,
  /** The person's DM with these members: the existing one, or a new one (`POST /v1/workspaces/:id/dms`, an upsert). */
  openDm: async (org: string, userIds: string[]) => {
    const res = await fetch(`/v1/workspaces/${enc(org)}/dms`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userIds }) });
    if (!res.ok) throw new HomeApiError(res.status, `http_${res.status}`, `${res.status} ${res.statusText}`);
    return (await res.json()) as ChannelDTO;
  },
};
