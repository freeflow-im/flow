// What Home works out from the apps' answers, apart from React so it tests alone: the greeting, today's range, which
// channels and agents the sidebar lists, the text of a mention, and the address each row opens (the suite's addresses,
// @flow/shared/addresses, so every row lands on the page its own app would open).
import type { ChannelDTO, WorkspaceMemberDTO } from '@flow/shared';
import { addressOf } from '@flow/shared/addresses';
import type { CalendarEvent, MailFolder, RecentFile } from '../api';

/** How many channels the sidebar lists before "All channels". */
export const SIDEBAR_CHANNELS = 8;

export function greeting(name: string, now: Date): string {
  const h = now.getHours();
  const part = h < 5 ? 'evening' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
  const first = name.trim().split(/\s+/)[0];
  return first ? `Good ${part}, ${first}` : `Good ${part}`;
}

/** Today in the browser's time zone, as the instants Calendar's `/v1/calendar/events` takes. */
export function todayRange(now: Date): { from: string; to: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

/** Today's events, all-day ones first, then by start; cancelled ones left out. */
export function todaysEvents(events: CalendarEvent[]): CalendarEvent[] {
  return events
    .filter((e) => e.status !== 'cancelled')
    .sort((a, b) => (a.allDay === b.allDay ? a.start.localeCompare(b.start) : a.allDay ? -1 : 1));
}

/** The inbox among an account's folders: the one marked so, else the one IMAP names INBOX. */
export function inboxOf(folders: MailFolder[]): MailFolder | null {
  return folders.find((f) => f.specialUse === 'inbox') ?? folders.find((f) => f.path.toUpperCase() === 'INBOX') ?? null;
}

/** The channels the sidebar lists: standard ones the person is in, not archived; those with something new first. */
export function sidebarChannels(channels: ChannelDTO[]): ChannelDTO[] {
  return channels
    .filter((c) => c.kind === 'standard' && c.isMember && !c.archivedAt)
    .sort((a, b) => Number(b.unreadNotifications > 0) - Number(a.unreadNotifications > 0) || Number(b.unreadCount > 0) - Number(a.unreadCount > 0) || (a.name ?? '').localeCompare(b.name ?? ''));
}

/** Chat's tab number: the notifications waiting in every channel and DM, as Chat's own badge counts them. */
export const chatUnread = (channels: ChannelDTO[]): number => channels.reduce((n, c) => n + (c.isMember ? c.unreadNotifications : 0), 0);

/** The agents the person can talk to, by name: the shared agents and their own assistant. Another person's assistant answers
 * only them (docs/specs/agents.md §1.1), so it is not listed. */
export function agentsOf(members: WorkspaceMemberDTO[], me: string | null = null): WorkspaceMemberDTO[] {
  return members.filter((m) => m.isAgent && (m.kind !== 'personal_agent' || (!!me && m.sponsorId === me))).sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** The person's DM with one other member, if they have one already. */
export function dmWith(channels: ChannelDTO[], me: string, other: string): ChannelDTO | null {
  return channels.find((c) => c.kind === 'dm' && !!c.memberIds?.includes(other) && c.memberIds.every((id) => id === me || id === other)) ?? null;
}

/** A message's text for one line: `<@id>` as `@Name`, group mentions as `@channel`, whitespace folded. */
export function messageLine(body: string, names: Map<string, string>): string {
  return body
    .replace(/<@([0-9a-f-]{36})>/gi, (_, id: string) => `@${names.get(id) ?? 'someone'}`)
    .replace(/<!(channel|here|everyone)>/g, '@$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- where each row goes ----

export const channelAddress = (id: string): string => addressOf({ app: 'chat', kind: 'channel', id })!;
export const messageAddress = (id: string): string => addressOf({ app: 'chat', kind: 'message', id })!;
export const eventAddress = (id: string): string => addressOf({ app: 'calendar', kind: 'event', id })!;

/** A recent file's page in Docs; null for one without an id (the desktop app's files, which Home never lists). */
export function fileAddress(f: RecentFile): string | null {
  if (!f.id) return null;
  const stored = f.kind === 'file' || f.kind === 'pdf';
  return addressOf({ app: 'docs', kind: stored ? 'file' : 'sheet', id: f.id }, stored ? 'file' : f.kind);
}

/** A conversation in Mail, opened in its folder (Mail's App.tsx reads `account`, `folder` and `thread`). */
export function threadAddress(account: string, folder: string, thread: string): string {
  const q = new URLSearchParams({ account, folder, thread });
  return `/mail/?${q.toString()}`;
}

// ---- how times read ----

/** `09:30` for a time today; `All day` for an all-day event. */
export function eventTime(e: CalendarEvent): string {
  if (e.allDay) return 'All day';
  return new Date(e.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** A mail's or file's time: the hour today, the weekday this week, else the date. */
export function shortWhen(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const days = (now.getTime() - d.getTime()) / 86_400_000;
  if (days < 6 && days > 0) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** The line under the greeting: the date, then what is waiting, each part only when there is something. */
export function summaryLine(now: Date, parts: { meetings: number | null; unread: number | null; mentions: number | null }): string {
  const out = [now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })];
  if (parts.meetings) out.push(`${parts.meetings} ${parts.meetings === 1 ? 'meeting' : 'meetings'}`);
  if (parts.unread) out.push(`${parts.unread} unread`);
  if (parts.mentions) out.push(`${parts.mentions} ${parts.mentions === 1 ? 'mention' : 'mentions'}`);
  return out.join(' · ');
}
