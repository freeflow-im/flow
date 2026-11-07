// Calendars shared between accounts in the client (platform phase 4.4): a shared calendar as the views take one, what a
// person may do on a calendar by its role, who a grant names, and what a refusal says. Pure.
import type { CalendarGrant, CalendarInfo, EventOccurrence, GrantRole, SharedCalendar } from '../api';
import type { SharedPref } from './prefs';
import type { SuiteChannel, SuiteMember } from '../suite';
import { CalendarApiError } from '../api';

export const ROLES: { role: GrantRole; label: string }[] = [
  { role: 'viewer', label: 'Can view' },
  { role: 'editor', label: 'Can edit' },
  { role: 'manager', label: 'Can share' },
];
export const roleLabel = (r: GrantRole | 'owner' | null | undefined) => ROLES.find((x) => x.role === r)?.label ?? (r === 'owner' ? 'Owner' : '');

/** A native calendar's id is `n.<ownerAccountId>.<random>` (the server's rules.ts). */
export const isNativeId = (id: string) => /^n\.[^.]+\.[^.]+$/.test(id);
export const ownerOfNative = (id: string): string | null => (isNativeId(id) ? id.split('.')[1]! : null);

/** A shared calendar as the sidebar, the grid and the dialogs take a calendar: a viewer's is read-only (`reader`). Its tick
 * and colour are this browser's (prefs.ts); it is never the default for new events. */
export function asCalendar(s: SharedCalendar, pref: SharedPref | undefined): CalendarInfo {
  return {
    id: s.id, accountId: `shared:${s.ownerAccountId}`, name: s.name, color: pref?.color ?? s.color, timezone: null,
    role: s.role === 'viewer' ? 'reader' : 'writer', hidden: !pref?.shown, isDefault: false, syncedAt: new Date(0).toISOString(),
    shared: { ownerAccountId: s.ownerAccountId, role: s.role, principal: s.principal },
  };
}

/** Whether the person may change events on the calendar (drag, resize, edit, delete, create there). */
export const canChange = (c: CalendarInfo | undefined) => !!c && c.role !== 'reader';
/** Whether the person may share it: their own native calendar, or one shared with them to manage. */
export const canShare = (c: CalendarInfo | undefined) => !!c && isNativeId(c.id) && (c.shared ? c.shared.role === 'manager' : c.role === 'owner');
/** What an event's card says on a calendar the person can only read because it was shared with them. */
export const readOnlyNote = (c: CalendarInfo | undefined) => (c?.shared && c.role === 'reader' ? 'You can view this calendar' : null);

/** Whether a guest on a native event is a member of the organization (the server resolved their address to an account),
 * or someone outside; nothing for an event on a connected calendar. */
export function guestMark(o: Pick<EventOccurrence, 'calendarId'>, g: { accountId?: string }): 'member' | 'outside' | null {
  return isNativeId(o.calendarId) ? (g.accountId ? 'member' : 'outside') : null;
}

/** Who a grant names, in words. */
export function grantLabel(g: Pick<CalendarGrant, 'principal'>, members: SuiteMember[], channels: SuiteChannel[], orgName: string | undefined): string {
  if (g.principal === 'org') return `Everyone in ${orgName ?? 'the organization'}`;
  if (g.principal.startsWith('channel:')) {
    const c = channels.find((x) => `channel:${x.id}` === g.principal);
    return c?.name ? `#${c.name}` : 'A channel';
  }
  const m = members.find((x) => x.accountId && `account:${x.accountId}` === g.principal);
  return m ? `${m.displayName}${m.isAgent ? ' (agent)' : ''}` : 'A member';
}

/** Whom the dialog offers to add: members with an account (people and agents) other than the owner, and named live
 * channels, less those it is already shared with. */
export function addable(grants: Pick<CalendarGrant, 'principal'>[], members: SuiteMember[], channels: SuiteChannel[], ownerAccountId: string | null) {
  const taken = new Set(grants.map((g) => g.principal));
  return {
    people: members.filter((m) => m.accountId && m.accountId !== ownerAccountId && !taken.has(`account:${m.accountId}`)),
    rooms: channels.filter((c) => c.name && !c.archivedAt && !taken.has(`channel:${c.id}`)),
    org: !taken.has('org'),
  };
}

/** A refusal as the toast says it: the server's message, or plain words for a conflict and the organizer's rule. */
export function errorText(e: unknown): string {
  if (e instanceof CalendarApiError && e.code === 'conflict') return 'This event changed elsewhere. Showing the latest.';
  if (e instanceof CalendarApiError && e.code === 'not_organizer') return e.message || 'Only the organizer can change this event.';
  return e instanceof Error ? e.message : String(e);
}
