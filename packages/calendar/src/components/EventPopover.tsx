// An event's card, by the event clicked (or centred, for one opened from a link or a search), after Google Calendar's:
// edit, delete, a menu and close at the top; the colour, title, when and how it repeats; the video call with its dial-in;
// the guests, summed up and folded; reminders, the organizer, the place and the description; and, for an invitation,
// Going? Yes · No · Maybe in a band at the bottom. Edit and delete only on a calendar the person may change.
import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlignLeft, Bell, Calendar as CalendarIcon, Check, ChevronDown, ChevronUp, Copy, MapPin, MoreVertical, Pencil, Phone, Trash2, Users, Video, X } from 'lucide-react';
import { calendarApi, type CalendarInfo, type EventOccurrence, type Response } from '../api';
import { conferenceOf, linkify, shownDescription } from '../lib/conference';
import { RESPONSE_LABEL, cardWhen, guestName, guestSummary, orderedGuests, reminderText } from '../lib/format';
import { canChange, guestMark, readOnlyNote } from '../lib/sharing';
import type { SuiteMember } from '../suite';
import { parseDate } from '../lib/ranges';
import { describeRecurrence } from '../lib/recurrence';
import { pathOf } from '../lib/route';
import { cn } from '../lib/utils';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { AnchoredPopover, type Anchor } from './ui/popover';

/** Google's order. */
const ANSWERS: [Exclude<Response, 'needs-action'>, string][] = [['accepted', 'Yes'], ['declined', 'No'], ['tentative', 'Maybe']];
const DOT: Record<Response, string> = { accepted: 'bg-[#1e8e3e]', declined: 'bg-[#d93025]', tentative: 'bg-[#f9ab00]', 'needs-action': 'bg-[#9aa0a6]' };
const ANSWER_TEXT: Record<Response, string> = { ...RESPONSE_LABEL, 'needs-action': 'Awaiting' };
const isUrl = (s: string) => /^https?:\/\/\S+$/.test(s.trim());

function IconButton({ label, onClick, children }: { label: string; onClick?: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="flex size-9 items-center justify-center rounded-full text-muted outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-primary/40 [&_svg]:size-[18px]">
      {children}
    </button>
  );
}

/** A row: a 24px icon column (in line with the title's dot), then its content. */
function Row({ icon, children, className }: { icon: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('grid grid-cols-[24px_1fr] gap-x-4 py-2', className)}>
      <span className="flex h-6 items-center justify-center text-muted [&_svg]:size-[18px]">{icon}</span>
      <div className="min-w-0 text-[15px] leading-6">{children}</div>
    </div>
  );
}

function Linked({ text }: { text: string }) {
  return (
    <>
      {linkify(text).map((p, i) => ('url' in p
        ? <a key={i} href={p.url} target="_blank" rel="noopener noreferrer" className="break-all text-primary hover:underline">{p.url}</a>
        : <span key={i}>{p.text}</span>))}
    </>
  );
}

function useCopy(): [string | null, (what: string, text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  return [copied, (what, text) => {
    void navigator.clipboard?.writeText(text).then(() => { setCopied(what); setTimeout(() => setCopied((c) => (c === what ? null : c)), 1500); }, () => {});
  }];
}

export function EventPopover({ event, calendar, members = [], alsoOn, anchor, onClose, onEdit, onDelete, onRespond }: { event: EventOccurrence; calendar: CalendarInfo | undefined; members?: SuiteMember[]; alsoOn?: string | null; anchor: Anchor; onClose(): void; onEdit(): void; onDelete(): void; onRespond(r: Exclude<Response, 'needs-action'>): void }) {
  const writable = canChange(calendar);
  const viewOnly = readOnlyNote(calendar);
  const color = calendar?.color ?? '#1a73e8';
  // An occurrence moved on its own (an exception) carries no rule: the series has it.
  const series = useQuery({ queryKey: ['calendar', 'event', event.eventId], queryFn: () => calendarApi.event(event.eventId), enabled: event.recurring && !event.recurrence?.length, staleTime: 5 * 60_000 });
  const rule = event.recurrence?.length ? event.recurrence : series.data?.event.recurrence;
  const repeat = event.recurring ? describeRecurrence(rule) : null;
  const call = conferenceOf(event);
  const description = shownDescription(event.description);
  const guests = orderedGuests(event);
  const [guestsOpen, setGuestsOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [copied, copy] = useCopy();
  const invited = event.myResponse !== undefined && !event.organizer?.self;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const host = event.organizer ? guestName(event.organizer) ?? event.organizer.email : calendar?.name ?? null;
  const location = event.location && !(call && event.location.trim() === call.url) ? event.location.trim() : null;
  const link = () => `${window.location.origin}${pathOf({ view: 'week', date: event.allDay ? parseDate(event.start) : new Date(event.start), eventId: event.id }, import.meta.env.BASE_URL)}`;

  return (
    <AnchoredPopover anchor={anchor} onClose={onClose} label={event.summary || 'Event'} autoFocus
      className="flex max-h-[min(720px,calc(100dvh-24px),var(--radix-popover-content-available-height))] w-[min(440px,calc(100vw-24px))] flex-col overflow-hidden rounded-2xl border-0 p-0 shadow-[0_4px_8px_3px_rgba(60,64,67,.15),0_1px_3px_rgba(60,64,67,.3)]">
      <div className="flex shrink-0 justify-end gap-0.5 px-2 pt-2">
        {writable && <IconButton label="Edit event" onClick={onEdit}><Pencil /></IconButton>}
        {writable && <IconButton label="Delete event" onClick={onDelete}><Trash2 /></IconButton>}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="More options" title="More options" className="flex size-9 items-center justify-center rounded-full text-muted outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-primary/40"><MoreVertical className="size-[18px]" /></button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => copy('event', link())}>{copied === 'event' ? 'Link copied' : 'Copy link to event'}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <IconButton label="Close" onClick={onClose}><X /></IconButton>
      </div>

      <div className="min-h-0 overflow-y-auto px-4 pb-3">
        <div className="grid grid-cols-[24px_1fr] gap-x-4 pb-2">
          <span className="flex h-8 items-center justify-center"><span className="size-3.5 rounded" style={{ background: color }} /></span>
          <div className="min-w-0">
            <h2 className={cn('break-words text-[22px] leading-8 text-ink', event.myResponse === 'declined' && 'line-through decoration-1')}>{event.summary || '(No title)'}</h2>
            <p className="text-[15px] leading-6 text-ink">{cardWhen(event)}</p>
            {event.timezone && event.timezone !== zone && !event.allDay && <p className="text-[13px] leading-5 text-muted">{event.timezone.replace(/_/g, ' ')}</p>}
            {repeat && <p className="text-[15px] leading-6 text-muted">{repeat}</p>}
            {viewOnly && <p className="mt-1 text-[13px] leading-5 text-muted">{viewOnly}</p>}
            {alsoOn && <p className="mt-1 text-[13px] leading-5 text-muted">{alsoOn}</p>}
          </div>
        </div>

        {call && (
          <>
            <Row icon={<Video />} className="items-start">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <a href={call.url} target="_blank" rel="noopener noreferrer" className="inline-flex h-9 items-center rounded-full bg-primary px-5 text-[14px] font-medium text-white hover:bg-primary-deep">{call.label}</a>
                  <p className="mt-1 truncate text-[13px] leading-5 text-muted">{call.shown}</p>
                  {(call.meetingId || call.passcode) && <p className="text-[13px] leading-5 text-muted">{[call.meetingId && `Meeting ID: ${call.meetingId}`, call.passcode && `Passcode: ${call.passcode}`].filter(Boolean).join(' · ')}</p>}
                </div>
                <IconButton label={copied === 'call' ? 'Copied' : 'Copy the meeting link'} onClick={() => copy('call', call.url)}>{copied === 'call' ? <Check /> : <Copy />}</IconButton>
              </div>
            </Row>
            {call.dialIn && (
              <Row icon={<Phone />}>
                <a href={call.dialIn.tel} className="text-primary hover:underline">Join by phone</a>
                <p className="text-[13px] leading-5 text-muted">{call.dialIn.text}</p>
              </Row>
            )}
            {call.morePhones && (
              <Row icon={<span className="size-[18px]" />} className="pt-0">
                <a href={call.morePhones} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">More phone numbers</a>
              </Row>
            )}
          </>
        )}

        {location && (
          <Row icon={<MapPin />}>
            {isUrl(location)
              ? <a className="break-all text-primary hover:underline" href={location} target="_blank" rel="noopener noreferrer">{location}</a>
              : <a className="break-words hover:underline" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`} target="_blank" rel="noopener noreferrer">{location}</a>}
          </Row>
        )}

        {!!guests.length && (
          <Row icon={<Users />}>
            <button type="button" aria-expanded={guestsOpen} onClick={() => setGuestsOpen(!guestsOpen)} className="-mx-2 flex w-[calc(100%+16px)] items-center gap-2 rounded-lg px-2 text-left hover:bg-hover">
              <span className="min-w-0 flex-1">
                <span className="block">{guests.length} {guests.length === 1 ? 'guest' : 'guests'}</span>
                <span className="block text-[13px] leading-5 text-muted">{guestSummary(guests)}</span>
              </span>
              {guestsOpen ? <ChevronUp className="size-5 shrink-0 text-muted" /> : <ChevronDown className="size-5 shrink-0 text-muted" />}
            </button>
            {guestsOpen && (
              <ul className="mt-2 max-h-64 overflow-y-auto">
                {guests.map((g) => {
                  const name = guestName(g);
                  const mark = guestMark(event, g, members);
                  return (
                    <li key={g.email} className="flex items-center gap-3 py-1" title={g.email}>
                      <span className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-track text-[13px] font-medium uppercase text-muted">
                        {(name ?? g.email)[0]}
                        <span aria-hidden className={cn('absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-white', DOT[g.response])} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-1.5 text-[14px] leading-5">
                          <span className="truncate">{name ?? g.email}{g.self && <span className="text-muted"> (you)</span>}</span>
                          {mark && <span className={cn('shrink-0 rounded px-1 text-[11px] leading-4', mark === 'outside' ? 'bg-warn-bg text-ink' : 'bg-track text-muted')} title={mark === 'member' ? 'A member of your organization' : mark === 'agent' ? 'An agent in your organization' : 'Outside your organization: invited by email'}>{mark}</span>}
                        </span>
                        <span className="block truncate text-[12px] leading-4 text-muted">
                          {[g.organizer ? 'Organizer' : null, g.role === 'optional' ? 'Optional' : null, name ? g.email : null].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      <span className="shrink-0 text-[12px] text-muted">{ANSWER_TEXT[g.response]}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Row>
        )}

        {!!event.reminders.length && <Row icon={<Bell />}>{event.reminders.map(reminderText).join(', ')}</Row>}

        {host && (
          <Row icon={<CalendarIcon />}>
            <span className="block truncate">{host}</span>
            {event.organizer && calendar && <span className="block truncate text-[13px] leading-5 text-muted">{calendar.name}</span>}
          </Row>
        )}

        {description && (
          <Row icon={<AlignLeft />}>
            <p className={cn('whitespace-pre-wrap break-words text-[14px] leading-6', !more && 'line-clamp-6')}><Linked text={description} /></p>
            {(description.split('\n').length > 6 || description.length > 360) && (
              <button type="button" className="mt-1 text-[14px] font-medium text-primary hover:underline" onClick={() => setMore(!more)}>{more ? 'Show less' : 'Show more'}</button>
            )}
          </Row>
        )}
      </div>

      {invited && (
        <div className="flex shrink-0 items-center gap-2 bg-panel px-4 py-3">
          <span className="mr-auto text-[14px] text-ink">Going?</span>
          {ANSWERS.map(([r, label]) => {
            const on = event.myResponse === r;
            return (
              <button key={r} type="button" aria-pressed={on} onClick={() => onRespond(r)}
                className={cn('h-9 rounded-full border px-4 text-[14px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-primary/40', on ? 'border-transparent text-white' : 'border-border bg-white text-ink hover:bg-hover')}
                style={on ? { background: color } : undefined}>
                {on && <Check className="-ml-1 mr-1 inline size-4" />}{label}
              </button>
            );
          })}
        </div>
      )}
    </AnchoredPopover>
  );
}
