// Calendar as a panel in another app's side panel (docs/specs/side-panel.md §5): /calendar/panel, in a frame there. A
// day (Calendar's time grid) or a week (a list of days, WeekAgenda.tsx), with ‹ Today › and the choice remembered; no
// suite bar, sidebar or assistant. An event, or the title, opens in Calendar itself (the host is asked to open it: in
// Home, Home does).
import { useMemo, useState } from 'react';
import { addDays, format, isSameMonth, isSameYear } from 'date-fns';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { setCalendarWorkspace, type EventOccurrence } from './api';
import { CalendarGrid } from './components/CalendarGrid';
import { WeekAgenda } from './components/WeekAgenda';
import { Button } from './components/ui/button';
import { useCalendars, useEvents, useSharedCalendars } from './hooks/calendar';
import { useOrganizations } from './hooks/organization';
import { mergeByUid } from './lib/merge';
import { sharedPrefs } from './lib/prefs';
import { neighbours, rangeOf, step } from './lib/ranges';
import { cn } from './lib/utils';
import { pathOf } from './lib/route';
import { asCalendar } from './lib/sharing';

const BASE = import.meta.env.BASE_URL;

/** Asks the app around the panel to open an address (SidePanel.tsx follows it); a page of its own opens it here. */
function openInHost(href: string): void {
  if (window.parent !== window) window.parent.postMessage({ type: 'flow:open', href }, window.location.origin);
  else window.location.assign(href);
}

type PanelView = 'day' | 'week';
const VIEW_KEY = 'flow.calendar.panelView';
const WEEK_STARTS_ON = 0 as const;

function readView(): PanelView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'week' ? 'week' : 'day';
  } catch {
    return 'day';
  }
}

/** The title, short for a narrow panel: "Fri, Nov 13", "Nov 8 – 14"; the year only when it is not this one. */
export function panelTitle(view: PanelView, date: Date, today = new Date()): string {
  const year = (d: Date) => (isSameYear(d, today) ? '' : `, ${format(d, 'yyyy')}`);
  if (view === 'day') return `${format(date, 'EEE, MMM d')}${year(date)}`;
  const { start } = rangeOf('week', date, WEEK_STARTS_ON);
  const last = addDays(start, 6);
  if (isSameMonth(start, last)) return `${format(start, 'MMM d')} – ${format(last, 'd')}${year(last)}`;
  if (isSameYear(start, last)) return `${format(start, 'MMM d')} – ${format(last, 'MMM d')}${year(last)}`;
  return `${format(start, 'MMM d, yyyy')} – ${format(last, 'MMM d, yyyy')}`;
}

export function PanelApp() {
  const [date, setDate] = useState(() => new Date());
  const [view, setViewState] = useState<PanelView>(readView);
  const setView = (v: PanelView) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // Not remembered, that's all.
    }
  };
  const range = useMemo(() => rangeOf(view, date, WEEK_STARTS_ON), [view, date]);
  const ahead = useMemo(() => neighbours(view, date, WEEK_STARTS_ON), [view, date]);
  const organizations = useOrganizations();
  setCalendarWorkspace(organizations.activeId);
  const calendars = useCalendars();
  const shared = useSharedCalendars();
  const sharedPref = sharedPrefs.use();
  const allCals = useMemo(
    () => (calendars.data ? [...calendars.data, ...(shared.data ?? []).map((x) => asCalendar(x, sharedPref[x.id]))] : undefined),
    [calendars.data, shared.data, sharedPref],
  );
  const events = useEvents(range, ahead, allCals);
  const occurrences = useMemo(() => mergeByUid(events.data ?? [], allCals ?? []), [events.data, allCals]);
  const open = (o: EventOccurrence | null) => openInHost(pathOf({ view, date: o ? new Date(o.allDay ? `${o.start.slice(0, 10)}T00:00` : o.start) : date, eventId: o?.id ?? null }, BASE));
  const now = new Date();
  const showsToday = range.start <= now && now < range.end;
  const unit = view === 'day' ? 'day' : 'week';

  return (
    <div className="flex h-dvh flex-col bg-white">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-hairline px-2">
        <Button variant="outline" size="sm" onClick={() => setDate(new Date())} disabled={showsToday}>Today</Button>
        <Button variant="ghost" size="icon-sm" aria-label={`Previous ${unit}`} onClick={() => setDate((d) => step(view, d, -1))}><ChevronLeft /></Button>
        <Button variant="ghost" size="icon-sm" aria-label={`Next ${unit}`} onClick={() => setDate((d) => step(view, d, 1))}><ChevronRight /></Button>
        <button type="button" className="min-w-0 truncate text-left text-[15px] font-semibold text-ink hover:underline" title="Open in Calendar" onClick={() => open(null)}>
          {panelTitle(view, date)}
        </button>
        {events.isFetching && <Loader2 className="size-4 shrink-0 animate-spin text-faint" aria-label="Loading" />}
        <div role="tablist" aria-label="View" className="ml-auto flex shrink-0 rounded-lg bg-track p-0.5">
          {(['day', 'week'] as const).map((v) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)}
              className={cn('rounded-md px-2.5 py-1 text-[13px] text-muted', view === v ? 'bg-white font-medium text-ink shadow-sm' : 'hover:text-ink')}>
              {v === 'day' ? 'Day' : 'Week'}
            </button>
          ))}
        </div>
      </div>
      {calendars.isPending ? (
        <div className="flex flex-1 items-center justify-center text-muted"><Loader2 className="size-5 animate-spin" /></div>
      ) : !allCals?.length ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted">
          No calendar is connected yet.
          <Button variant="outline" size="sm" onClick={() => openInHost(BASE)}>Open Calendar</Button>
        </div>
      ) : view === 'week' ? (
        <WeekAgenda start={range.start} occurrences={occurrences} calendars={allCals} onOpen={(o) => open(o)} />
      ) : (
        <div className="min-h-0 flex-1">
          <CalendarGrid
            view="day"
            date={date}
            occurrences={occurrences}
            calendars={allCals}
            weekStartsOn={0}
            selecting={false}
            onSelect={() => {}}
            onOpen={(o) => open(o)}
            onDay={(d) => setDate(d)}
            // Moving an event is Calendar's own (with its this / following / all question): here it goes back.
            onChange={(_o, _s, _e, _a, revert) => revert()}
          />
        </div>
      )}
    </div>
  );
}
