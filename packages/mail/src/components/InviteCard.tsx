// An invitation above a message's body (docs/specs/calendar.md §14), after Gmail's: the event's title, when, where, who
// organized it, how many guests, how it repeats; for an invitation, Going? Yes · No · Maybe (the answer filled when it is
// on a calendar already, "On your calendar · Going"), with a calendar to put it on when there is more than one and it is
// not on one yet; for a cancellation, "This event was cancelled" with Remove from calendar (or "Not on your calendar");
// for a reply, "Ann Lee accepted". The card asks Calendar (`inviteApi`) what the part is and where it stands; a message
// whose part Calendar cannot read as an invitation shows no card. An answer shows on the card at once, a toast says
// "Replying…" while it goes (it may be emailed to the organizer, which takes a few seconds), then what happened; a failure
// puts the card back and says why. `InviteCardView` is the card itself, for the tests.
import { CalendarDays, Check, Loader2, MapPin, Repeat, Users, Video } from 'lucide-react';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MailApiError, inviteApi, type InviteAnswer, type InviteRef, type InviteResponse, type Replied } from '../api';
import { cardWhen, describeRecurrence } from '../lib/calendarShared';
import { answeredText, guestCount, nameOf, replyLine, responseWord } from '../lib/invites';
import type { Notice } from '../lib/notice';
import { cn } from '../lib/utils';

type Answer = Exclude<InviteResponse, 'needs-action'>;
const CHOICES: { value: Answer; label: string }[] = [
  { value: 'accepted', label: 'Yes' },
  { value: 'declined', label: 'No' },
  { value: 'tentative', label: 'Maybe' },
];

export interface InviteCardViewProps {
  answer: InviteAnswer;
  /** The answer being sent (its button shows a spinner, the others wait). */
  pending?: Answer | 'remove' | null;
  onRespond(response: Answer, calendarId: string | undefined): void;
  onRemove(): void;
}

/** The card, from Calendar's answer. */
export function InviteCardView({ answer: a, pending, onRespond, onRemove }: InviteCardViewProps) {
  const e = a.event;
  const defaultCalendar = a.calendars.find((c) => c.isDefault) ?? a.calendars[0];
  const [calendarId, setCalendarId] = useState(defaultCalendar?.id);
  const repeats = e.recurrenceId ? null : describeRecurrence(e.recurrence);
  const guests = guestCount(e);
  const mine = a.onCalendar?.myResponse ?? null;
  const busy = !!pending;
  return (
    <section aria-label="Invitation" className="mb-3 overflow-hidden rounded-lg border border-border bg-white">
      <div className="flex gap-3 px-4 py-3">
        <CalendarDays className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1 text-[14px] text-ink">
          <h3 className={cn('text-[16px] font-medium leading-snug', a.action === 'cancel' && 'line-through decoration-muted')}>{e.summary || '(no title)'}</h3>
          <div>{cardWhen(e)}{e.recurrenceId && <span className="text-muted"> · one occurrence</span>}</div>
          {repeats && <div className="flex items-center gap-1.5 text-muted"><Repeat className="size-3.5" aria-hidden />{repeats}</div>}
          {e.location && <div className="flex items-center gap-1.5 text-muted"><MapPin className="size-3.5 shrink-0" aria-hidden /><span className="min-w-0 break-words">{e.location}</span></div>}
          {e.conference && (
            <div className="flex items-center gap-1.5">
              <Video className="size-3.5 text-muted" aria-hidden />
              <a href={e.conference.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Join {e.conference.label}</a>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-1.5 text-muted">
            <Users className="size-3.5" aria-hidden />
            {e.organizer && <span>Organizer: {a.organizerIsMe ? 'you' : nameOf(e.organizer)}</span>}
            {e.organizer && guests > 0 && <span aria-hidden>·</span>}
            {guests > 0 && <span>{guests} guest{guests === 1 ? '' : 's'}</span>}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-hairline bg-panel px-4 py-2.5 text-[14px]">
        {a.action === 'reply' && a.reply && <span className="font-medium text-ink">{replyLine(a.reply)}</span>}
        {a.action === 'cancel' && (
          <>
            <span className="font-medium text-ink">This event was cancelled</span>
            {a.onCalendar && !a.onCalendar.cancelled ? (
              <button type="button" disabled={busy} onClick={onRemove} className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-white px-4 font-medium text-ink hover:bg-hover disabled:opacity-60">
                {pending === 'remove' && <Loader2 className="size-3.5 animate-spin" />} Remove from calendar
              </button>
            ) : (
              <span className="ml-auto text-muted">Not on your calendar</span>
            )}
          </>
        )}
        {a.action === 'request' && (a.onCalendar || a.calendars.length ? (
          <>
            <span className="mr-1 text-ink">{a.onCalendar ? <>On your calendar · <span className="font-medium">{responseWord(mine)}</span></> : 'Going?'}</span>
            <div role="group" aria-label="Going?" className="flex gap-1.5">
              {CHOICES.map((c) => {
                const chosen = mine === c.value;
                return (
                  <button
                    key={c.value}
                    type="button"
                    aria-pressed={chosen}
                    disabled={busy}
                    onClick={() => onRespond(c.value, a.onCalendar ? undefined : calendarId)}
                    className={cn('inline-flex h-8 items-center gap-1 rounded-full border px-4 font-medium disabled:opacity-60', chosen ? 'border-primary bg-primary-tint text-primary-deep' : 'border-border bg-white text-ink hover:bg-hover')}
                  >
                    {chosen ? <Check className="size-3.5" /> : pending === c.value ? <Loader2 className="size-3.5 animate-spin" /> : null}
                    {c.label}
                  </button>
                );
              })}
            </div>
            {!a.onCalendar && a.calendars.length > 1 && (
              <label className="ml-auto flex items-center gap-1.5 text-muted">
                <span className="sr-only">Calendar</span>
                <select value={calendarId} onChange={(ev) => setCalendarId(ev.target.value)} disabled={busy} className="h-8 rounded-md border border-border bg-white px-2 text-[14px] text-ink" aria-label="Calendar">
                  {a.calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
            )}
          </>
        ) : (
          <span className="text-muted">
            <a href="/calendar/" className="font-medium text-primary hover:underline">Connect a calendar</a> to answer this invitation.
          </span>
        ))}
      </div>
    </section>
  );
}

const inviteKey = (r: InviteRef) => ['mail', 'invite', r.account, r.folder, r.uid, r.part] as const;

/** The answer as the card shows it before Calendar has it: on the calendar chosen (or the one it is on), with this response. */
export function answeredAt(a: InviteAnswer, response: Answer, calendarId: string | undefined): InviteAnswer {
  const on = a.onCalendar ?? { calendarId: calendarId ?? a.calendars.find((c) => c.isDefault)?.id ?? a.calendars[0]?.id ?? '', id: '', eventId: '', cancelled: false, myResponse: null };
  return { ...a, onCalendar: { ...on, myResponse: response } };
}

/** The card for one message's invitation part: Calendar asked, the answer shown and sent, the toast said. Nothing while it loads or when Calendar cannot read it. */
export function InviteCard({ invite, onNotice }: { invite: InviteRef; onNotice(notice: Notice): void }) {
  const qc = useQueryClient();
  const key = inviteKey(invite);
  const q = useQuery({ queryKey: key, queryFn: () => inviteApi.read(invite), staleTime: 30_000, retry: (n, err) => n < 1 && !(err instanceof MailApiError && err.status < 500) });
  const respond = useMutation({
    mutationFn: ({ response, calendarId }: { response: Answer; calendarId: string | undefined }) => inviteApi.respond(invite, response, calendarId),
    onMutate: async ({ response, calendarId }) => {
      await qc.cancelQueries({ queryKey: key });
      const before = qc.getQueryData<InviteAnswer>(key);
      if (before) qc.setQueryData(key, answeredAt(before, response, calendarId));
      onNotice({ text: 'Replying…', progress: true });
      return { before };
    },
    onSuccess: (answer: InviteAnswer & Replied, { response }) => {
      qc.setQueryData(key, answer);
      onNotice(answeredText(response, answer, nameOf(answer.event.organizer)));
    },
    onError: (err, _v, ctx) => {
      if (ctx?.before) qc.setQueryData(key, ctx.before);
      onNotice(`Could not reply: ${err instanceof Error ? err.message : String(err)}`);
    },
  });
  const remove = useMutation({
    mutationFn: () => inviteApi.cancel(invite),
    onSuccess: (answer) => {
      qc.setQueryData(key, answer);
      onNotice(answer.removed ? 'Removed from your calendar.' : 'It was not on your calendar.');
    },
    onError: (err) => onNotice(`Could not remove it: ${err instanceof Error ? err.message : String(err)}`),
  });
  if (!q.data) return null;
  const pending = respond.isPending ? respond.variables?.response ?? null : remove.isPending ? 'remove' : null;
  return <InviteCardView answer={q.data} pending={pending} onRespond={(response, calendarId) => respond.mutate({ response, calendarId })} onRemove={() => remove.mutate()} />;
}
