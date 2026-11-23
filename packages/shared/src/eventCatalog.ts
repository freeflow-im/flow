// The event types an automation can listen to (Admin → Automations), grouped by the app that publishes them: the
// built-in apps' manifests (`events`), the organization's installed apps (`app.<name>.<event>`, user-apps.md §4) and
// the suite's own sharing events, which no one app owns. Each has a short name for people; the type is what is saved.
import { APP_MANIFESTS } from './manifests.js';
import { appEventType } from './userApps.js';

export interface CatalogEvent {
  /** The full type a subscription's filter names: `chat.message.created`, `app.taskboard.task.created`. */
  type: string;
  /** What it means, for people: "Message posted". */
  label: string;
}

export interface EventGroup {
  /** The publishing app's name (`chat`, `taskboard`), or `sharing`. */
  app: string;
  /** Its name for people: "Chat", "Taskboard". */
  label: string;
  /** An app the organization installed, rather than one of the suite's. */
  installed: boolean;
  events: CatalogEvent[];
}

/** The suite's events by name (a new built-in event gets one here: eventCatalog.test.ts checks). */
export const EVENT_LABELS: Record<string, string> = {
  'chat.message.created': 'Message posted',
  'chat.message.updated': 'Message edited',
  'chat.message.deleted': 'Message deleted',
  'chat.message.purged': 'Message removed for good',
  'chat.thread.reply': 'Reply in a thread',
  'chat.channel.created': 'Channel created',
  'chat.channel.updated': 'Channel changed',
  'chat.channel.archived': 'Channel archived',
  'chat.member.joined': 'Member joined',
  'chat.member.left': 'Member left',
  'chat.member.updated': 'Member changed',
  'chat.reaction.added': 'Reaction added',
  'chat.reaction.removed': 'Reaction removed',
  'chat.artifact.created': 'Artifact created',
  'chat.artifact.updated': 'Artifact changed',
  'chat.artifact.deleted': 'Artifact deleted',
  'chat.notification.created': 'Notification (mention or reply)',
  'chat.notification.read': 'Notification read',
  'docs.file.changed': 'File changed',
  'mail.received': 'Email received',
  'mail.sent': 'Email sent',
  'calendar.event.added': 'Event added',
  'calendar.event.updated': 'Event changed',
  'calendar.event.cancelled': 'Event cancelled',
  'calendar.invited': 'Invitation received',
  'calendar.booked': 'Booking made',
  'contacts.changed': 'Contacts changed',
  'meet.agent.joined': 'Agent joined a meeting',
  'meet.ended': 'Meeting ended (an agent was in it)',
  'agent.job.finished': 'Agent job finished',
  'alert.created': 'Alert shown',
  'alert.closed': 'Alert closed',
  'sharing.granted': 'Something shared',
  'sharing.revoked': 'Sharing removed',
};

/** Events of the suite itself, in no app's manifest: shares of any app's objects (org/services/shares.ts), agents' jobs (events/core.ts) and the suite bar's alerts (shared/alerts.ts). */
const SUITE_GROUPS: EventGroup[] = [
  { app: 'sharing', label: 'Sharing', types: ['sharing.granted', 'sharing.revoked'] },
  { app: 'agents', label: 'Agents', types: ['agent.job.finished'] },
  { app: 'alerts', label: 'Alerts', types: ['alert.created', 'alert.closed'] },
].map(({ types, ...g }) => ({ ...g, installed: false, events: types.map((type) => ({ type, label: EVENT_LABELS[type]! })) }));

/** A name for an event no table names: its short name as words ("task.created" → "Task created"). */
export function eventLabel(type: string, short = type): string {
  const known = EVENT_LABELS[type];
  if (known) return known;
  const words = short.replace(/[._]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : type;
}

const capitalized = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/** Every event type, by publishing app: the suite's apps first, then the installed ones by name. */
export function eventCatalog(installed: readonly { name: string; label: string; events: readonly string[] }[] = []): EventGroup[] {
  const suite: EventGroup[] = APP_MANIFESTS.filter((m) => m.events.length).map((m) => ({
    app: m.name,
    label: m.tab?.label ?? m.panel?.label ?? capitalized(m.name),
    installed: false,
    events: m.events.map((type) => ({ type, label: eventLabel(type) })),
  }));
  const apps: EventGroup[] = installed
    .filter((a) => a.events.length)
    .map((a) => ({ app: a.name, label: a.label, installed: true, events: a.events.map((short) => ({ type: appEventType(a.name, short), label: eventLabel(appEventType(a.name, short), short) })) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return [...suite, ...SUITE_GROUPS, ...apps];
}

/** The group and event a type is in, or null for a type no app declares (one typed by hand). */
export function findEvent(groups: readonly EventGroup[], type: string): { group: EventGroup; event: CatalogEvent } | null {
  for (const group of groups) {
    const event = group.events.find((e) => e.type === type);
    if (event) return { group, event };
  }
  return null;
}
