// Home's cards: Today (Calendar), Inbox (Mail), Recent files (Docs) and Mentions (Chat). Each loads on its own, links to
// its app in the corner, and opens each row where its app shows it. A card with nothing to show says what to do next
// (connect a calendar, make a first doc, invite the team): on a new organization these are the setup steps.
import type { ReactNode } from 'react';
import type { ChannelDTO, NotificationDTO, WorkspaceMemberDTO } from '@flow/shared';
import { HomeApiError, type CalendarEvent, type MailThread, type RecentFile } from '../api';
import { eventAddress, eventTime, fileAddress, messageAddress, messageLine, shortWhen, threadAddress } from '../lib/home';

export function Card(props: { title: string; link?: { label: string; href: string }; children: ReactNode; testId: string }) {
  return (
    <section className="flex min-w-0 flex-col rounded-xl border border-hairline bg-white p-5" data-testid={props.testId}>
      <header className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{props.title}</h2>
        {props.link && (
          <a href={props.link.href} className="truncate text-xs text-muted hover:text-primary">
            {props.link.label} →
          </a>
        )}
      </header>
      {props.children}
    </section>
  );
}

/** A card with nothing to show: what that means, and the one thing to do about it. */
function Empty({ text, action }: { text: string; action?: { label: string; href: string } }) {
  return (
    <div className="flex flex-1 flex-col items-start justify-center gap-2 py-4 text-sm text-muted">
      <p>{text}</p>
      {action && (
        <a href={action.href} className="rounded-md border border-border px-3 py-1 text-xs font-medium text-ink hover:bg-hover">
          {action.label}
        </a>
      )}
    </div>
  );
}

function Loading() {
  return (
    <div className="flex flex-col gap-3 py-1" aria-label="Loading">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-4 animate-pulse rounded bg-track" style={{ width: `${85 - i * 15}%` }} />
      ))}
    </div>
  );
}

/** Why a card has no data: the server's reason when it gave one. */
function Failed({ error, app }: { error: unknown; app: string }) {
  const code = error instanceof HomeApiError ? error.code : null;
  if (code === 'no_account') return <Empty text={`${app} is not set up for you in this organization.`} />;
  if (code === 'guest') return <Empty text={`Guests use Chat only.`} />;
  return <Empty text={`${app} could not be reached. It will try again in a minute.`} />;
}

export function TodayCard(props: { events: CalendarEvent[] | null; error: unknown; settingUp: boolean }) {
  return (
    <Card title="Today" link={{ label: 'Calendar', href: '/calendar/' }} testId="home-card-today">
      {props.settingUp ? (
        <Empty text="Your calendar is being set up. This takes a minute or two." />
      ) : props.error ? (
        <Failed error={props.error} app="Calendar" />
      ) : props.events === null ? (
        <Loading />
      ) : props.events.length === 0 ? (
        <Empty text="Nothing on your calendar today." action={{ label: 'Open Calendar', href: '/calendar/' }} />
      ) : (
        <ol className="flex flex-col gap-3">
          {props.events.slice(0, 5).map((e) => (
            <li key={e.id}>
              <a href={eventAddress(e.id)} className="flex gap-3 rounded-md hover:bg-hover">
                <span className="w-14 shrink-0 pt-0.5 font-mono text-xs text-muted">{eventTime(e)}</span>
                <span className="min-w-0 border-l-2 border-primary pl-3">
                  <span className="block truncate text-sm font-medium">{e.summary || '(No title)'}</span>
                  {e.attendees.length > 0 && <span className="block truncate text-xs text-muted">{e.attendees.map((a) => a.name || a.email).slice(0, 3).join(', ')}</span>}
                </span>
              </a>
            </li>
          ))}
          {props.events.length > 5 && <li className="text-xs text-muted">{props.events.length - 5} more today</li>}
        </ol>
      )}
    </Card>
  );
}

export function InboxCard(props: {
  address: string | null;
  account: string | null;
  inboxPath: string | null;
  threads: MailThread[] | null;
  hasAccount: boolean | null;
  error: unknown;
  settingUp: boolean;
  now: Date;
}) {
  return (
    <Card title="Inbox" link={{ label: props.address ?? 'Mail', href: '/mail/' }} testId="home-card-inbox">
      {props.settingUp ? (
        <Empty text="Your mailbox is being set up. This takes a minute or two." />
      ) : props.error ? (
        <Failed error={props.error} app="Mail" />
      ) : props.hasAccount === false ? (
        <Empty text="No mail account yet." action={{ label: 'Set up Mail', href: '/mail/' }} />
      ) : props.threads === null ? (
        <Loading />
      ) : props.threads.length === 0 ? (
        <Empty text="Your inbox is empty." />
      ) : (
        <ul className="flex flex-col divide-y divide-hairline">
          {props.threads.map((t) => (
            <li key={t.threadId}>
              <a href={threadAddress(props.account!, props.inboxPath!, t.threadId)} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-baseline gap-3 py-2 hover:bg-hover">
                <span className={`truncate text-sm ${t.unread ? 'font-semibold' : ''}`}>{t.latest.from?.name || t.latest.from?.address || 'Unknown'}</span>
                <span className={`truncate text-sm ${t.unread ? 'font-semibold' : 'text-ink-soft'}`}>{t.latest.subject || '(No subject)'}</span>
                <span className="text-xs text-muted">{shortWhen(t.latest.date, props.now)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const FILE_BADGE: Record<RecentFile['kind'], { letter: string; tone: string }> = {
  doc: { letter: 'D', tone: 'bg-primary-tint text-primary-deep' },
  markdown: { letter: 'M', tone: 'bg-primary-tint text-primary-deep' },
  sheet: { letter: 'S', tone: 'bg-[#e6f4ea] text-ok' },
  deck: { letter: 'P', tone: 'bg-warn-bg text-warn' },
  pdf: { letter: 'F', tone: 'bg-track text-muted' },
  file: { letter: 'F', tone: 'bg-track text-muted' },
};

export function FilesCard(props: { files: RecentFile[] | null; error: unknown; now: Date }) {
  const files = props.files?.filter((f) => fileAddress(f)) ?? null;
  return (
    <Card title="Recent files" link={{ label: 'Docs', href: '/docs/' }} testId="home-card-files">
      {props.error ? (
        <Failed error={props.error} app="Docs" />
      ) : files === null ? (
        <Loading />
      ) : files.length === 0 ? (
        <Empty text="Files you open in Docs show here." action={{ label: 'Create a doc', href: '/docs/' }} />
      ) : (
        <ul className="flex flex-col gap-1">
          {files.slice(0, 5).map((f) => (
            <li key={f.id}>
              <a href={fileAddress(f)!} className="flex items-center gap-3 rounded-md py-1.5 hover:bg-hover">
                <span className={`flex size-7 shrink-0 items-center justify-center rounded text-xs font-semibold ${FILE_BADGE[f.kind].tone}`}>{FILE_BADGE[f.kind].letter}</span>
                <span className="min-w-0 flex-1 truncate text-sm">{f.name}</span>
                <span className="text-xs text-muted">{shortWhen(f.lastUsed, props.now)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function MentionsCard(props: {
  mentions: NotificationDTO[] | null;
  channels: ChannelDTO[] | null;
  members: WorkspaceMemberDTO[] | null;
  error: unknown;
  inviteHref: string;
  alone: boolean;
}) {
  const names = new Map((props.members ?? []).map((m) => [m.userId, m.displayName]));
  const channelName = new Map((props.channels ?? []).map((c) => [c.id, c.name]));
  const list = props.mentions?.filter((n) => n.kind === 0).slice(0, 4) ?? null;
  return (
    <Card title="Mentions" link={{ label: 'Chat', href: '/chat/' }} testId="home-card-mentions">
      {props.error ? (
        <Failed error={props.error} app="Chat" />
      ) : list === null ? (
        <Loading />
      ) : list.length === 0 ? (
        props.alone ? <Empty text="You are the only one here so far." action={{ label: 'Invite your team', href: props.inviteHref }} /> : <Empty text="No mentions. When someone @mentions you, it shows here." />
      ) : (
        <ul className="flex flex-col gap-3">
          {list.map((n) => (
            <li key={n.id}>
              <a href={messageAddress(n.messageId)} className="block rounded-md hover:bg-hover">
                <span className="block text-xs text-muted">
                  {channelName.get(n.channelId) ? `# ${channelName.get(n.channelId)}` : 'Direct message'} · {names.get(n.actorId ?? '') ?? 'Someone'}
                </span>
                <span className={`block truncate text-sm ${n.readAt ? 'text-ink-soft' : 'font-medium'}`}>{messageLine(n.message.body, names)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
