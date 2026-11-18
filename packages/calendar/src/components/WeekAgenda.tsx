// The side panel's Week view (PanelApp.tsx): the seven days of a week as a list, each day's events as cards tinted with
// their calendar's colour (an all-day event in the colour itself), "Nothing scheduled" on an empty day. Made to be
// narrow, where the time grid of Calendar's own week view does not fit. A card opens the event in Calendar. Today's row
// has a "now" line between the events before and after the current time, and the week that has today opens at today.
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { addDays, format, isSameDay, isToday } from 'date-fns';
import type { CalendarInfo, EventOccurrence } from '../api';
import { time, timeRange } from '../lib/format';
import { textOn } from '../lib/occurrences';
import { parseDate } from '../lib/ranges';
import { cn } from '../lib/utils';

/** The part of an occurrence on one day: all-day ones by their dates, timed ones by their instants. */
function onDay(o: EventOccurrence, day: Date): boolean {
  const next = addDays(day, 1);
  if (o.allDay) return parseDate(o.start) <= day && day < parseDate(o.end);
  const s = new Date(o.start), e = new Date(o.end);
  return s < next && (e > day || (+e === +s && s >= day));
}

/** A timed event's time on one day: its range, or where it comes from or goes on to across midnight. */
function timeOnDay(o: EventOccurrence, day: Date): string {
  const s = new Date(o.start), e = new Date(o.end);
  const startsHere = isSameDay(s, day), endsHere = isSameDay(e, day) || +e === +addDays(day, 1);
  if (startsHere && endsHere) return timeRange(s, e);
  if (startsHere) return `From ${time(s)}`;
  if (isSameDay(e, day)) return `Until ${time(e)}`;
  return 'All day';
}

/** The day's events: all-day first, then by start, then by end. */
export function eventsOfDay(occurrences: readonly EventOccurrence[], day: Date): EventOccurrence[] {
  return occurrences
    .filter((o) => o.status !== 'cancelled' && onDay(o, day))
    .sort((a, b) => Number(b.allDay) - Number(a.allDay) || +new Date(a.start) - +new Date(b.start) || +new Date(a.end) - +new Date(b.end));
}

/** Where the now line goes among a day's events: before the first timed event that has not started yet. */
export function nowIndex(events: readonly EventOccurrence[], now: Date): number {
  const i = events.findIndex((o) => !o.allDay && new Date(o.start) > now);
  return i < 0 ? events.length : i;
}

/** The current time, again each minute. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function NowLine() {
  return (
    <div role="separator" aria-label="Now" className="relative my-0.5 flex h-0 items-center">
      <span className="absolute -left-1.5 size-2.5 rounded-full bg-[#ea4335]" />
      <span className="h-0.5 w-full bg-[#ea4335]" />
    </div>
  );
}

export function WeekAgenda({ start, occurrences, calendars, onOpen }: { start: Date; occurrences: readonly EventOccurrence[]; calendars: readonly CalendarInfo[]; onOpen(o: EventOccurrence, el: Element): void }) {
  const byId = new Map(calendars.map((c) => [c.id, c]));
  const shown = occurrences.filter((o) => !byId.get(o.calendarId)?.hidden);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const now = useNow();
  // The week that has today opens at today, and stays there as the events come in and make the days above it taller,
  // until the person scrolls. The list is scrolled itself: scrollIntoView would scroll the page around the panel too.
  const list = useRef<HTMLOListElement>(null);
  const todayRow = useRef<HTMLLIElement>(null);
  const moved = useRef(false);
  const startKey = +start;
  useEffect(() => {
    moved.current = false;
  }, [startKey]);
  useLayoutEffect(() => {
    const ol = list.current, row = todayRow.current;
    if (!ol || !row || moved.current) return;
    ol.scrollTop = row.offsetTop - ol.offsetTop;
  }, [startKey, shown.length]);
  const byPerson = () => {
    moved.current = true;
  };

  return (
    <ol ref={list} onWheel={byPerson} onTouchMove={byPerson} onKeyDown={byPerson} onPointerDown={byPerson}
      className="relative min-h-0 flex-1 overflow-y-auto" aria-label="Week">
      {days.map((day) => {
        const events = eventsOfDay(shown, day);
        const today = isToday(day);
        const at = today ? nowIndex(events, now) : -1;
        return (
          <li key={+day} ref={today ? todayRow : undefined} className="flex gap-3 border-b border-hairline px-3 py-3">
            <div className="w-10 shrink-0 text-center">
              <div className={cn('text-[11px] font-semibold tracking-wide', today ? 'text-primary' : 'text-muted')}>{format(day, 'EEE').toUpperCase()}</div>
              <div className={cn('mx-auto mt-0.5 flex size-8 items-center justify-center rounded-full text-[20px] leading-none', today ? 'bg-primary text-white' : 'text-ink')}>{format(day, 'd')}</div>
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              {!events.length && <div className="pt-1.5 text-sm text-muted">Nothing scheduled</div>}
              {events.map((o, i) => {
                const color = byId.get(o.calendarId)?.color ?? '#1a73e8';
                const title = o.summary || '(No title)';
                const declined = o.myResponse === 'declined';
                const card = o.allDay ? (
                  <button
                    key={o.id}
                    type="button"
                    onClick={(e) => onOpen(o, e.currentTarget)}
                    className={cn('truncate rounded-md px-3 py-1.5 text-left text-[13px] font-semibold', declined && 'line-through opacity-60')}
                    style={{ background: color, color: textOn(color) }}
                    title={`${title} · all day`}
                  >
                    {title} <span className="font-normal opacity-90">· all day</span>
                  </button>
                ) : (
                  <button
                    key={o.id}
                    type="button"
                    onClick={(e) => onOpen(o, e.currentTarget)}
                    className={cn('rounded-md px-3 py-1.5 text-left', declined && 'opacity-60')}
                    style={{ background: `color-mix(in srgb, ${color} 14%, white)`, color: `color-mix(in srgb, ${color} 72%, black)` }}
                    title={title}
                  >
                    <div className={cn('truncate text-[13px] font-semibold', declined && 'line-through')}>{title}</div>
                    <div className="truncate text-[12px] opacity-90">{timeOnDay(o, day)}</div>
                  </button>
                );
                return i === at ? <Fragment key={o.id}><NowLine />{card}</Fragment> : card;
              })}
              {at === events.length && <NowLine />}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
