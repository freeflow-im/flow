// The one component that knows FullCalendar (docs/specs/calendar.md §2.6): the view and date in, the occurrences in as its
// events, and out the clicks and drags (a selection on empty time, a click on an event or a day, a move or a resize).
// Everything around it (the data on react-query, the popover, the dialogs, the sidebar) never touches FullCalendar, so
// another grid could stand in. Styled through its CSS variables and a few rules in index.css.
import { useEffect, useMemo, useRef } from 'react';
import FullCalendar from '@fullcalendar/react';
import type { EventClickArg, EventDropArg, DateSelectArg } from '@fullcalendar/core';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import listPlugin from '@fullcalendar/list';
import interactionPlugin, { type EventResizeDoneArg } from '@fullcalendar/interaction';
import type { CalendarInfo, EventOccurrence } from '../api';
import { toFcEvent } from '../lib/occurrences';
import { fcView, type View } from '../lib/ranges';

export interface GridProps {
  view: View;
  date: Date;
  occurrences: EventOccurrence[];
  calendars: CalendarInfo[];
  weekStartsOn: 0 | 1;
  /** Whether quick create is open over the selection; when it closes, the selection goes. */
  selecting: boolean;
  /** Empty time chosen (a click or a drag): the pointer, to anchor quick create. */
  onSelect(start: Date, end: Date, allDay: boolean, at: { x: number; y: number } | null): void;
  onOpen(o: EventOccurrence, el: Element): void;
  /** A day's number clicked (month view, a list's date): that day. */
  onDay(date: Date): void;
  /** A drag or a resize; `revert` puts it back (a cancelled scope question, a refusal). */
  onChange(o: EventOccurrence, start: Date, end: Date | null, allDay: boolean, revert: () => void): void;
}

export function CalendarGrid({ view, date, occurrences, calendars, weekStartsOn, selecting, onSelect, onOpen, onDay, onChange }: GridProps) {
  const ref = useRef<FullCalendar>(null);
  const byId = useMemo(() => new Map(calendars.map((c) => [c.id, c])), [calendars]);
  const events = useMemo(() => occurrences.filter((o) => !byId.get(o.calendarId)?.hidden).map((o) => toFcEvent(o, byId.get(o.calendarId))), [occurrences, byId]);

  useEffect(() => {
    const api = ref.current?.getApi();
    if (!api) return;
    if (api.view.type !== fcView(view)) api.changeView(fcView(view), date);
    else api.gotoDate(date);
  }, [view, date]);

  useEffect(() => {
    if (!selecting) ref.current?.getApi().unselect();
  }, [selecting]);

  const changed = (info: EventDropArg | EventResizeDoneArg) => {
    const o = info.event.extendedProps.occurrence as EventOccurrence;
    if (!info.event.start) return info.revert();
    onChange(o, info.event.start, info.event.end, info.event.allDay, info.revert);
  };

  return (
    <div className="cal-grid h-full min-h-0">
      <FullCalendar
        ref={ref}
        plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]}
        initialView={fcView(view)}
        initialDate={date}
        headerToolbar={false}
        height="100%"
        firstDay={weekStartsOn}
        events={events}
        eventClassNames={(a) => {
          const start = a.event.start ?? new Date();
          const end = a.event.end ?? start;
          const names: string[] = [];
          if (end < new Date()) names.push('cal-past');
          // A quarter-hour event is as tall as one line of small text, so its title is set smaller (index.css).
          if (!a.event.allDay && +end - +start <= 15 * 60_000) names.push('cal-quarter');
          return names;
        }}
        nowIndicator
        navLinks
        navLinkDayClick={(d) => onDay(d)}
        dayMaxEvents
        selectable
        selectMirror
        unselectAuto={false}
        editable
        eventResizableFromStart={false}
        snapDuration="00:15:00"
        slotDuration="00:30:00"
        scrollTime="07:30:00"
        scrollTimeReset={false}
        allDayText="All day"
        noEventsText="Nothing on the calendar this week"
        eventTimeFormat={{ hour: 'numeric', minute: '2-digit', meridiem: 'short' }}
        // In the time grid the title comes first and the time under it, so a short event (one line of room) shows what it
        // is rather than when, as Google Calendar does; the month grid and the list keep FullCalendar's own content. `true` is
        // how FullCalendar 6 is asked for that: under React an `undefined` renders an empty chip (the month grid's events were
        // bare lines from 2026-11-09 to 11-12).
        eventContent={(arg) =>
          arg.view.type.startsWith('timeGrid') && !arg.event.allDay ? (
            <div className="fc-event-main-frame cal-title-first">
              <div className="fc-event-title-container">
                <div className="fc-event-title fc-sticky">{arg.event.title || '(No title)'}</div>
              </div>
              {arg.timeText && <div className="fc-event-time">{arg.timeText}</div>}
            </div>
          ) : true
        }
        slotLabelFormat={{ hour: 'numeric', meridiem: 'short' }}
        dayHeaderFormat={view === 'month' ? { weekday: 'short' } : { weekday: 'short', day: 'numeric' }}
        select={(info: DateSelectArg) => {
          let end = info.end;
          // A click on a half-hour slot makes an hour, as most calendars do.
          if (!info.allDay && +info.end - +info.start <= 30 * 60_000) end = new Date(+info.start + 60 * 60_000);
          const e = info.jsEvent as MouseEvent | null;
          onSelect(info.start, end, info.allDay, e ? { x: e.clientX, y: e.clientY } : null);
        }}
        eventClick={(info: EventClickArg) => {
          info.jsEvent.preventDefault();
          ref.current?.getApi().unselect();
          onOpen(info.event.extendedProps.occurrence as EventOccurrence, info.el);
        }}
        eventDrop={changed}
        eventResize={changed}
      />
    </div>
  );
}
