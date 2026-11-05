// An event's details, by the event clicked (or centred, for one opened from a link or a search): when, how it repeats,
// where (and Join for a video call), the calendar, the people and their answers, the description; RSVP for an invitation,
// Edit and Delete for a calendar the person may change.
import { Calendar as CalendarIcon, MapPin, Pencil, Repeat, Trash2, Users, Video, X, AlignLeft } from 'lucide-react';
import type { CalendarInfo, EventOccurrence, Response } from '../api';
import { RESPONSE_LABEL, whenText } from '../lib/format';
import { describeRecurrence } from '../lib/recurrence';
import { cn } from '../lib/utils';
import { AnchoredPopover, type Anchor } from './ui/popover';
import { Button } from './ui/button';

const isUrl = (s: string) => /^https?:\/\/\S+$/.test(s.trim());
const ANSWERS: [Exclude<Response, 'needs-action'>, string][] = [['accepted', 'Yes'], ['tentative', 'Maybe'], ['declined', 'No']];

export function EventPopover({ event, calendar, anchor, onClose, onEdit, onDelete, onRespond }: { event: EventOccurrence; calendar: CalendarInfo | undefined; anchor: Anchor; onClose(): void; onEdit(): void; onDelete(): void; onRespond(r: Exclude<Response, 'needs-action'>): void }) {
  const writable = !!calendar && calendar.role !== 'reader';
  const repeat = event.recurring ? describeRecurrence(event.recurrence) ?? 'Repeats' : null;
  const invited = event.attendees.find((a) => a.self) && !event.organizer?.self;
  const people = [...(event.organizer && !event.attendees.some((a) => a.email === event.organizer!.email) ? [event.organizer] : []), ...event.attendees];
  return (
    <AnchoredPopover anchor={anchor} onClose={onClose} label={event.summary || 'Event'}>
      <div className="-mr-1 -mt-1 mb-2 flex justify-end gap-0.5">
        {writable && <Button variant="ghost" size="icon-sm" aria-label="Edit" title="Edit (E)" onClick={onEdit}><Pencil /></Button>}
        {writable && <Button variant="ghost" size="icon-sm" aria-label="Delete" title="Delete (Backspace)" onClick={onDelete}><Trash2 /></Button>}
        <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}><X /></Button>
      </div>
      <div className="flex gap-3">
        <span className="mt-1.5 size-3.5 shrink-0 rounded" style={{ background: calendar?.color ?? '#1a73e8' }} />
        <div className="min-w-0">
          <h2 className={cn('break-words text-[20px] leading-tight', event.myResponse === 'declined' && 'line-through')}>{event.summary || '(No title)'}</h2>
          <p className="mt-1 text-[14px] text-muted">{whenText(event)}</p>
          {event.timezone && event.timezone !== Intl.DateTimeFormat().resolvedOptions().timeZone && !event.allDay && <p className="text-[13px] text-faint">{event.timezone.replace(/_/g, ' ')}</p>}
          {repeat && <p className="mt-0.5 flex items-center gap-1 text-[14px] text-muted"><Repeat className="size-3.5" /> {repeat}</p>}
        </div>
      </div>
      <div className="mt-3 flex flex-col gap-2.5 text-[14px]">
        {event.conference && (
          <div className="flex items-center gap-3">
            <Video className="size-4 shrink-0 text-muted" />
            <Button asChild size="sm"><a href={event.conference.url} target="_blank" rel="noopener noreferrer">Join with {event.conference.label}</a></Button>
          </div>
        )}
        {event.location && (
          <div className="flex gap-3">
            <MapPin className="mt-0.5 size-4 shrink-0 text-muted" />
            {isUrl(event.location) ? <a className="min-w-0 break-all text-primary hover:underline" href={event.location} target="_blank" rel="noopener noreferrer">{event.location}</a> : <span className="min-w-0 break-words">{event.location}</span>}
          </div>
        )}
        {!!people.length && (
          <div className="flex gap-3">
            <Users className="mt-0.5 size-4 shrink-0 text-muted" />
            <ul className="min-w-0 flex-1">
              <li className="text-muted">{people.length} {people.length === 1 ? 'guest' : 'guests'}</li>
              {people.slice(0, 12).map((a) => (
                <li key={a.email} className="flex min-w-0 items-baseline gap-2">
                  <span className="min-w-0 truncate" title={a.email}>{a.name || a.email}{a.self ? ' (you)' : ''}</span>
                  <span className="shrink-0 text-[12px] text-faint">{event.organizer?.email === a.email ? 'Organizer' : RESPONSE_LABEL[a.response]}{a.role === 'optional' ? ' · optional' : ''}</span>
                </li>
              ))}
              {people.length > 12 && <li className="text-faint">and {people.length - 12} more</li>}
            </ul>
          </div>
        )}
        {event.description && (
          <div className="flex gap-3">
            <AlignLeft className="mt-0.5 size-4 shrink-0 text-muted" />
            <p className="max-h-40 min-w-0 overflow-y-auto whitespace-pre-wrap break-words text-ink">{event.description}</p>
          </div>
        )}
        <div className="flex items-center gap-3 text-muted">
          <CalendarIcon className="size-4 shrink-0" />
          <span className="truncate">{calendar?.name ?? 'Calendar'}</span>
        </div>
      </div>
      {invited && (
        <div className="mt-4 flex items-center gap-2 border-t border-hairline pt-3 text-[14px]">
          <span className="mr-auto text-muted">Going?</span>
          {ANSWERS.map(([r, label]) => (
            <Button key={r} size="sm" variant={event.myResponse === r ? 'secondary' : 'outline'} aria-pressed={event.myResponse === r} onClick={() => onRespond(r)}>{label}</Button>
          ))}
        </div>
      )}
    </AnchoredPopover>
  );
}
