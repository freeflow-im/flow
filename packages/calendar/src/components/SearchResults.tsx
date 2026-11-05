// What the bar's search found: the matching occurrences a year each way, by day; a click opens one.
import { format } from 'date-fns';
import { Loader2, X } from 'lucide-react';
import type { CalendarInfo, EventOccurrence } from '../api';
import { shortTime } from '../lib/format';
import { parseDate } from '../lib/ranges';
import { Button } from './ui/button';

export function SearchResults({ q, results, loading, calendars, onOpen, onClose }: { q: string; results: EventOccurrence[]; loading: boolean; calendars: CalendarInfo[]; onOpen(o: EventOccurrence, el: Element): void; onClose(): void }) {
  const byId = new Map(calendars.map((c) => [c.id, c]));
  const day = (o: EventOccurrence) => format(o.allDay ? parseDate(o.start) : new Date(o.start), 'yyyy-MM-dd');
  const groups = new Map<string, EventOccurrence[]>();
  for (const o of results) groups.set(day(o), [...(groups.get(day(o)) ?? []), o]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-hairline px-4">
        <h1 className="min-w-0 truncate text-[18px]">Search results for “{q}”</h1>
        {loading && <Loader2 className="size-4 animate-spin text-faint" />}
        <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Close search" onClick={onClose}><X /></Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
        {!loading && !results.length && <p className="py-10 text-center text-muted">Nothing found a year either side of today.</p>}
        {[...groups].map(([d, list]) => (
          <section key={d} className="flex gap-4 border-b border-hairline py-2">
            <h2 className="w-28 shrink-0 pt-1.5 text-[14px] text-muted">{format(parseDate(d), 'EEE, MMM d, yyyy')}</h2>
            <ul className="min-w-0 flex-1">
              {list.map((o) => (
                <li key={o.id}>
                  <button type="button" className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-hover" onClick={(e) => onOpen(o, e.currentTarget)}>
                    <span className="size-2.5 shrink-0 rounded-full" style={{ background: byId.get(o.calendarId)?.color }} />
                    <span className="w-20 shrink-0 text-[13px] text-muted">{shortTime(o)}</span>
                    <span className="min-w-0 truncate">{o.summary || '(No title)'}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
