// The assistant in Calendar, its pure parts: what each turn says the user is looking at (the `calendar` context), the
// browser tools Calendar runs (open_calendar_event, show_calendar_range, and delete_event after the user confirms; the
// server offers no other app's), and what the chat links to (an event the assistant made or changed). The panel is
// components/AssistantPanel.tsx, the turns hooks/assistant.ts.
import type { CalendarAccount, CalendarInfo, EventOccurrence, Scope } from '../api';
import { MAX_CALENDARS_SHOWN, type CalendarContext, type ChatItem, type ClientToolCall, type ClientToolResult } from './docsAgent';
import { browserPref } from './prefs';
import type { Range, View } from './ranges';

/** Whether the panel is open, remembered in this browser. */
const pref = browserPref<'closed' | 'open'>('calendar.assistant', ['closed', 'open']);
export const useAssistantOpen = () => pref.use() === 'open';
export const setAssistantOpen = (open: boolean) => pref.set(open ? 'open' : 'closed');

export interface CalendarView {
  view: View;
  range: Range;
  calendars: CalendarInfo[];
  /** The event whose card is open. */
  event: EventOccurrence | null;
  search?: string;
  /** The accounts, to say whether the open event's calendar is the FreeFlow (native) one. */
  accounts?: CalendarAccount[];
}

/** The user's role on a calendar, in the grants' words: a calendar a server shares into the account read-only is viewed only. */
const roleOf = (c: CalendarInfo): 'owner' | 'editor' | 'viewer' => (c.role === 'reader' ? 'viewer' : c.role === 'writer' ? 'editor' : 'owner');

/** What a turn sent from Calendar says the user is looking at (rendered for the model by the server's renderCalendarContext). */
export function calendarContext(v: CalendarView, zone = Intl.DateTimeFormat().resolvedOptions().timeZone): CalendarContext {
  const shown = v.calendars.filter((c) => !c.hidden);
  const e = v.event;
  const cal = e ? v.calendars.find((c) => c.id === e.calendarId) : undefined;
  const kind = cal && v.accounts?.find((a) => a.id === cal.accountId)?.kind;
  return {
    page: 'calendar',
    view: v.view,
    from: v.range.start.toISOString(),
    to: v.range.end.toISOString(),
    timezone: zone || 'UTC',
    calendars: shown.slice(0, MAX_CALENDARS_SHOWN).map((c) => ({ id: c.id, name: c.name })),
    ...(e ? { event: { id: e.id, summary: e.summary, start: e.start, end: e.end, allDay: e.allDay, calendar: cal?.name ?? '', ...(kind ? { native: kind === 'native' } : {}), ...(cal ? { role: roleOf(cal) } : {}) } } : {}),
    ...(v.search ? { search: v.search } : {}),
  };
}

/** The event a link in the chat opens (`/calendar/…?event=<id>`, the Calendar tools' links), or null. */
export function eventOfLink(href: string, origin: string = window.location.origin): string | null {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || !url.pathname.startsWith('/calendar')) return null;
  return url.searchParams.get('event');
}

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

/** The event a create_event or update_event call made or changed, to open it from the chat. */
export function madeEventOf(item: ToolItem): { id: string; start: string } | null {
  if (item.status !== 'ok' || !item.result || (item.name !== 'create_event' && item.name !== 'update_event')) return null;
  try {
    const r = JSON.parse(item.result) as { created?: { id?: unknown; start?: unknown }; updated?: { id?: unknown; start?: unknown } };
    const e = r.created ?? r.updated;
    return typeof e?.id === 'string' && typeof e.start === 'string' ? { id: e.id, start: e.start } : null;
  } catch {
    return null;
  }
}

/** Calendar tools after which the views may have changed: the ranges are read again. */
export const CHANGES_CALENDAR = new Set(['create_event', 'update_event', 'respond_to_event', 'delete_event']);

/** The question delete_event asks before it runs (as Docs' confirmationFor asks it). */
export function deleteQuestion(input: Record<string, unknown>, summary?: string | null): string {
  const what = summary ? `“${summary}”` : 'this event';
  return input.scope === 'following' ? `Delete ${what} and the events after it in the series?` : input.scope === 'all' ? `Delete ${what}, every occurrence of it?` : `Delete ${what} from your calendar?`;
}

/** The view and day show_calendar_range asks for: its view, else the one that fits from..to. */
export function rangeRequest(input: Record<string, unknown>): { date: Date; view: View } | null {
  const parse = (v: unknown) => {
    if (typeof v !== 'string') return null;
    const d = /^\d{4}-\d\d-\d\d$/.test(v) ? new Date(`${v}T00:00:00`) : new Date(v);
    return Number.isNaN(+d) ? null : d;
  };
  const from = parse(input.from);
  if (!from) return null;
  const to = parse(input.to);
  const asked = input.view === 'day' || input.view === 'week' || input.view === 'month' || input.view === 'agenda' ? input.view : null;
  const days = to ? (+to - +from) / 86_400_000 : 1;
  return { date: from, view: asked ?? (days <= 1 ? 'day' : days <= 7 ? 'week' : 'month') };
}

export interface CalendarClientHandlers {
  /** Opens an event's card (and moves the view to it); false when it is not on the user's calendars. */
  open(id: string): Promise<boolean>;
  show(date: Date, view: View): void;
  /** Asks the user; true to go ahead. */
  confirm(question: string): Promise<boolean>;
  remove(id: string, scope: Scope | undefined): Promise<void>;
  /** The title of an event, for the delete question, when it is known. */
  summaryOf(id: string): string | null;
}

/** Runs the browser tools the assistant asked for, in Calendar: the server offers a turn from Calendar only Calendar's (the tool registry, platform.md §5.4). */
export async function runCalendarClientCalls(calls: ClientToolCall[], h: CalendarClientHandlers): Promise<ClientToolResult[]> {
  const results: ClientToolResult[] = [];
  for (const call of calls) {
    const i = call.input;
    try {
      if (call.name === 'open_calendar_event') {
        const id = typeof i.id === 'string' ? i.id : '';
        results.push(await h.open(id) ? { id: call.id, content: JSON.stringify({ opened: id }) } : { id: call.id, content: 'That event is not on the user\'s calendars. Use an id from list_events or the <app_context>.', isError: true });
      } else if (call.name === 'show_calendar_range') {
        const r = rangeRequest(i);
        if (!r) results.push({ id: call.id, content: 'from: give a date (2026-11-05) or an ISO time.', isError: true });
        else {
          h.show(r.date, r.view);
          results.push({ id: call.id, content: JSON.stringify({ shown: r.view, from: String(i.from) }) });
        }
      } else if (call.name === 'delete_event') {
        const id = typeof i.id === 'string' ? i.id : '';
        const scope = i.scope === 'this' || i.scope === 'following' || i.scope === 'all' ? i.scope : undefined;
        if (!(await h.confirm(deleteQuestion(i, h.summaryOf(id))))) results.push({ id: call.id, content: 'The user chose not to delete it. Do not try again another way.', isError: true });
        else {
          await h.remove(id, scope);
          results.push({ id: call.id, content: JSON.stringify({ deleted: id, ...(scope ? { scope } : {}) }) });
        }
      } else {
        results.push({ id: call.id, content: `Unknown tool ${call.name}.`, isError: true });
      }
    } catch (e) {
      results.push({ id: call.id, content: e instanceof Error ? e.message : String(e), isError: true });
    }
  }
  return results;
}
