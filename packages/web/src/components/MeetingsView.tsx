// Chat's "Meetings" (docs/specs/meetings.md §9 3b): the meeting chats the person is in, which the channel list leaves
// out. Live meetings first, with Join; then the newest. Opening one shows its channel in the ordinary channel view. The
// same "sentinel channel id" shape as the Activity feed and the Directory.
import type { MeetingChatDTO, WorkspaceMemberDTO } from '@flow/shared';
import { useAuth, useRuntime, useSelection } from '../state';
import { useMeetingChats, useMembers } from '../hooks';
import { meetRoomUrl } from '../huddle';
import { Avatar } from './Avatar';
import { MobileMenuButton } from './MobileMenuButton';

/** "Mon 16 Nov": the day a meeting chat last met (its last session, else its newest message, else when it was made). */
export function meetingDay(chat: Pick<MeetingChatDTO, 'lastSessionAt' | 'lastMessageAt' | 'meeting'>, now: Date = new Date()): string {
  const iso = chat.lastSessionAt ?? chat.lastMessageAt ?? chat.meeting.createdAt;
  const d = new Date(iso);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(d, now)) return 'Today';
  if (sameDay(d, new Date(now.getTime() - 86_400_000))) return 'Yesterday';
  const opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}

/** Who was in a meeting, as a line: "Ann, Bob and 3 others" (you last, as "you"). */
export function peopleLine(ids: string[], names: Record<string, string>, me: string): string {
  const others = ids.filter((id) => id !== me).map((id) => names[id] ?? 'Someone');
  const all = ids.includes(me) ? [...others, 'you'] : others;
  if (all.length === 0) return '';
  if (all.length <= 3) return all.length === 1 ? all[0]! : `${all.slice(0, -1).join(', ')} and ${all[all.length - 1]}`;
  return `${all.slice(0, 2).join(', ')} and ${all.length - 2} others`;
}

export default function MeetingsView() {
  const sel = useSelection();
  const auth = useAuth();
  const runtime = useRuntime();
  const chats = useMeetingChats(sel.workspaceId);
  const members = useMembers(sel.workspaceId);
  return (
    <MeetingsList
      chats={chats.data ?? []}
      loading={chats.isLoading}
      members={members.data ?? []}
      me={auth.user.id}
      roomUrl={(code) => meetRoomUrl(runtime.origin, code)}
      onOpen={(channelId) => sel.selectChannel(channelId)}
    />
  );
}

/** The presentational half, prop-driven so it renders in a test without a query client. */
export function MeetingsList({
  chats,
  loading,
  members,
  me,
  roomUrl,
  onOpen,
}: {
  chats: MeetingChatDTO[];
  loading: boolean;
  members: WorkspaceMemberDTO[];
  me: string;
  roomUrl: (code: string) => string;
  onOpen: (channelId: string) => void;
}) {
  const byId = new Map(members.map((m) => [m.userId, m]));
  const names = Object.fromEntries(members.map((m) => [m.userId, m.displayName]));
  return (
    <section data-testid="meetings-view" className="flex min-w-0 flex-1 flex-col bg-base">
      <header className="flex h-[60px] shrink-0 items-center gap-3 border-b border-hairline px-[22px] max-md:px-3">
        <MobileMenuButton />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-bold">Meetings</h2>
          <p className="truncate text-xs text-muted">The chats of the meetings you joined. Only mentions of you count as unread here.</p>
        </div>
      </header>
      <div className="mc-scroll min-h-0 flex-1 overflow-y-auto px-[22px] py-4 max-md:px-3">
        {loading ? (
          <p className="py-6 text-center text-sm text-muted">Loading…</p>
        ) : chats.length === 0 ? (
          <p data-testid="meetings-empty" className="py-6 text-center text-sm text-muted">
            No meetings yet. A meeting’s chat shows here once you join it in Meet.
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {chats.map((c) => {
              const shown = c.peopleIds.slice(0, 4);
              const mentions = c.channel.unreadNotifications ?? 0;
              return (
                <li key={c.channel.id} data-testid={`meeting-row-${c.meeting.code}`} data-live={c.live ? 'true' : 'false'} className="flex items-center gap-3 rounded-xl border border-hairline bg-white px-3 py-2.5 hover:border-hairline2">
                  <button type="button" className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left" onClick={() => onOpen(c.channel.id)}>
                    <span className={`flex size-10 shrink-0 items-center justify-center rounded-xl text-lg ${c.live ? 'bg-accent/15' : 'bg-daypill'}`} aria-hidden="true">🎥</span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-bold text-ink">{c.meeting.title || 'Meeting'}</span>
                        {c.live && <span data-testid="meeting-live" className="shrink-0 rounded-full bg-red-600 px-1.5 text-[10px] font-bold uppercase text-white">Live</span>}
                        {mentions > 0 && (
                          <span data-testid="meeting-mentions" className="shrink-0 rounded-[9px] bg-unread px-[5px] py-px text-[10px] font-bold text-white">{Math.min(mentions, 99)}</span>
                        )}
                      </span>
                      <span className="block truncate text-xs text-muted">
                        {meetingDay(c)}
                        {c.peopleIds.length > 0 && ` · ${peopleLine(c.peopleIds, names, me)}`}
                        {c.live && c.livePeople.length > 0 && ` · ${c.livePeople.length} in it now`}
                      </span>
                    </span>
                    <span className="flex shrink-0 max-md:hidden">
                      {shown.map((id, i) => {
                        const m = byId.get(id);
                        return (
                          <span key={id} className={i > 0 ? '-ml-2' : ''}>
                            <Avatar userId={id} name={m?.displayName ?? '?'} avatarUrl={m?.avatarUrl} size={24} radius={12} className="ring-2 ring-white" />
                          </span>
                        );
                      })}
                    </span>
                  </button>
                  {c.live && (
                    <a
                      data-testid={`meeting-join-${c.meeting.code}`}
                      href={roomUrl(c.meeting.code)}
                      target="_blank"
                      rel="noopener"
                      className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white no-underline hover:bg-accent-deep"
                    >
                      Join
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
