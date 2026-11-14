// Calendar as a panel in another app's side panel (docs/specs/side-panel.md §5): /calendar/panel, in a frame there. One
// day at a time, with ‹ Today ›; no suite bar, sidebar or assistant. An event, or the title, opens in Calendar itself
// (the host is asked to open it: in Home, Home does).
import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { setCalendarWorkspace, type EventOccurrence } from './api';
import { CalendarGrid } from './components/CalendarGrid';
import { Button } from './components/ui/button';
import { useCalendars, useEvents, useSharedCalendars } from './hooks/calendar';
import { useOrganizations } from './hooks/organization';
import { mergeByUid } from './lib/merge';
import { sharedPrefs } from './lib/prefs';
import { neighbours, rangeOf, step, titleOf } from './lib/ranges';
import { pathOf } from './lib/route';
import { asCalendar } from './lib/sharing';

const BASE = import.meta.env.BASE_URL;

/** Asks the app around the panel to open an address (SidePanel.tsx follows it); a page of its own opens it here. */
function openInHost(href: string): void {
  if (window.parent !== window) window.parent.postMessage({ type: 'flow:open', href }, window.location.origin);
  else window.location.assign(href);
}

export function PanelApp() {
  const [date, setDate] = useState(() => new Date());
  const range = useMemo(() => rangeOf('day', date), [date]);
  const ahead = useMemo(() => neighbours('day', date), [date]);
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
  const open = (o: EventOccurrence | null) => openInHost(pathOf({ view: 'day', date, eventId: o?.id ?? null }, BASE));
  const isToday = date.toDateString() === new Date().toDateString();

  return (
    <div className="flex h-dvh flex-col bg-white">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-hairline px-2">
        <Button variant="outline" size="sm" onClick={() => setDate(new Date())} disabled={isToday}>Today</Button>
        <Button variant="ghost" size="icon-sm" aria-label="Previous day" onClick={() => setDate((d) => step('day', d, -1))}><ChevronLeft /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="Next day" onClick={() => setDate((d) => step('day', d, 1))}><ChevronRight /></Button>
        <button type="button" className="min-w-0 truncate text-left text-[15px] text-ink hover:underline" title="Open in Calendar" onClick={() => open(null)}>
          {titleOf('day', date)}
        </button>
        {events.isFetching && <Loader2 className="ml-auto size-4 shrink-0 animate-spin text-faint" aria-label="Loading" />}
      </div>
      {calendars.isPending ? (
        <div className="flex flex-1 items-center justify-center text-muted"><Loader2 className="size-5 animate-spin" /></div>
      ) : !allCals?.length ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted">
          No calendar is connected yet.
          <Button variant="outline" size="sm" onClick={() => openInHost(BASE)}>Open Calendar</Button>
        </div>
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
