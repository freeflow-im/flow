// The guest scheduler's public page (docs/specs/guest-scheduler.md §1, §4): no session, no suite bar. At
// /calendar/book/<token> a guest picks a length, a day with open time and a start, gives a name and an address, and books;
// at /calendar/book/m/<manage token> (the link in their confirmation) they see the booking and cancel or move it. Times
// show in the zone the guest picks, which starts at the browser's.
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { CalendarCheck, ChevronLeft, ChevronRight, Clock, Globe, MapPin, Video } from 'lucide-react';
import { BookError, book, cancel, getDays, getManaged, getPage, getSlots, reschedule, routeOf, type Base, type Booking, type PageInfo } from './api';
import { addMonths, allZones, browserZone, dateIn, dayTitle, fullWhen, googleLink, icsOf, monthCells, monthTitle, timeIn, zoneLabel } from './time';
import { cn } from '../lib/utils';

const params = () => new URLSearchParams(window.location.search);
function setParam(key: string, value: string | null) {
  const u = new URL(window.location.href);
  if (value === null) u.searchParams.delete(key); else u.searchParams.set(key, value);
  window.history.replaceState(null, '', u);
}
const errorText = (e: unknown) => (e instanceof BookError ? e.message : 'Something went wrong; try again');

export function BookApp() {
  const route = useMemo(() => routeOf(window.location.pathname), []);
  if (!route) return <Message title="This link does not work" text="Check the address, or ask for a new link." />;
  return route.kind === 'page' ? <PageFlow base={route.base} /> : <ManageFlow base={route.base} />;
}

// ---- booking -------------------------------------------------------------------------------------------------------

function PageFlow({ base }: { base: Base }) {
  const [page, setPage] = useState<PageInfo | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [tz, setTz] = useState(browserZone);
  const [duration, setDuration] = useState<number | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [done, setDone] = useState<{ booking: Booking; manageUrl: string } | null>(null);
  const [taken, setTaken] = useState<string | null>(null);

  useEffect(() => {
    getPage(base).then((r) => {
      setPage(r.page);
      const asked = Number(params().get('duration'));
      setDuration(r.page.durations.includes(asked) ? asked : r.page.defaultDuration);
      document.title = `${r.page.title} · ${r.page.ownerName}`;
    }, (e) => setFailed(e instanceof BookError && e.status === 404 ? 'not_found' : errorText(e)));
  }, [base]);

  if (failed === 'not_found') return <Message title="This booking page is not available" text="The link may be old, or the page turned off. Ask for a new link." />;
  if (failed) return <Message title="The page could not load" text={failed} />;
  if (!page || duration === null) return <Loading />;
  const chooseLength = (n: number) => { setDuration(n); setParam('duration', String(n)); setPicked(null); };

  if (done) {
    return (
      <Shell page={page} duration={done.booking.duration} tz={tz} when={done.booking}>
        <Confirmed booking={done.booking} manageUrl={done.manageUrl} heading="You are scheduled" />
      </Shell>
    );
  }
  if (picked) {
    return (
      <Shell page={page} duration={duration} tz={tz} when={{ start: picked, end: new Date(Date.parse(picked) + duration * 60_000).toISOString() }} onBack={() => setPicked(null)}>
        <DetailsForm
          onSubmit={async (f) => {
            try {
              setDone(await book(base, { start: picked, duration, tz, ...f }));
            } catch (e) {
              if (e instanceof BookError && e.code === 'slot_taken') { setTaken('That time was just taken. Pick another.'); setPicked(null); return; }
              throw e;
            }
          }}
        />
      </Shell>
    );
  }
  return (
    <Shell page={page} duration={duration} tz={tz} lengths={page.durations.length > 1 ? { value: duration, onChange: chooseLength } : undefined}>
      {taken ? <p role="alert" className="mb-3 rounded-md border border-warn-border bg-warn-bg px-3 py-2 text-sm">{taken}</p> : null}
      <Picker base={base} page={page} duration={duration} tz={tz} setTz={setTz} onPick={(s) => { setTaken(null); setPicked(s); }} />
    </Shell>
  );
}

// ---- a booking's own link --------------------------------------------------------------------------------------------

function ManageFlow({ base }: { base: Base }) {
  const [data, setData] = useState<{ booking: Booking; page: PageInfo } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [tz, setTz] = useState(browserZone);
  const [mode, setMode] = useState<'view' | 'move' | 'cancel'>('view');
  const [duration, setDuration] = useState(30);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    getManaged(base).then((r) => { setData(r); setDuration(r.booking.duration); document.title = `${r.booking.title} · ${r.booking.ownerName}`; }, (e) => setFailed(e instanceof BookError && e.status === 404 ? 'not_found' : errorText(e)));
  }, [base]);

  if (failed === 'not_found') return <Message title="This booking link is not available" text="Check the link in your confirmation email." />;
  if (failed) return <Message title="The page could not load" text={failed} />;
  if (!data) return <Loading />;
  const { booking, page } = data;
  const act = async (fn: () => Promise<{ booking: Booking }>, after: string) => {
    setBusy(true); setNote(null);
    try {
      const r = await fn();
      setData({ booking: r.booking, page }); setMode('view'); setPicked(null); setNote(after);
    } catch (e) {
      if (e instanceof BookError && e.code === 'slot_taken') { setPicked(null); setNote('That time was just taken. Pick another.'); }
      else setNote(errorText(e));
    } finally { setBusy(false); }
  };

  if (mode === 'move' && !picked) {
    return (
      <Shell page={page} duration={duration} tz={tz} lengths={page.durations.length > 1 ? { value: duration, onChange: setDuration } : undefined} onBack={() => setMode('view')}>
        {note ? <p role="alert" className="mb-3 rounded-md border border-warn-border bg-warn-bg px-3 py-2 text-sm">{note}</p> : null}
        <p className="mb-2 text-sm text-muted">Now: {fullWhen(booking.start, booking.end, tz)}</p>
        <Picker base={base} page={page} duration={duration} tz={tz} setTz={setTz} heading="Pick a new time" onPick={setPicked} />
      </Shell>
    );
  }
  if (mode === 'move' && picked) {
    const end = new Date(Date.parse(picked) + duration * 60_000).toISOString();
    return (
      <Shell page={page} duration={duration} tz={tz} when={{ start: picked, end }} onBack={() => setPicked(null)}>
        <h2 className="text-xl font-semibold">Move your meeting</h2>
        <p className="mt-3 text-sm text-muted line-through">{fullWhen(booking.start, booking.end, tz)}</p>
        <p className="mt-1 text-sm font-medium">{fullWhen(picked, end, tz)}</p>
        <div className="mt-6 flex gap-2">
          <Primary disabled={busy} onClick={() => act(() => reschedule(base, { start: picked, duration, tz }), 'Your meeting has moved. We sent you an email.')}>Confirm the new time</Primary>
          <Secondary onClick={() => setPicked(null)}>Back</Secondary>
        </div>
      </Shell>
    );
  }
  return (
    <Shell page={page} duration={booking.duration} tz={tz} when={booking.status === 'booked' ? booking : undefined}>
      {note ? <p role="status" className="mb-4 rounded-md bg-selected-blue px-3 py-2 text-sm">{note}</p> : null}
      {booking.status === 'cancelled' ? (
        <div>
          <h2 className="text-xl font-semibold">This meeting is cancelled</h2>
          <p className="mt-2 text-sm text-muted">{booking.title} with {booking.ownerName}, which was {fullWhen(booking.start, booking.end, tz)}.</p>
        </div>
      ) : (
        <div>
          <Confirmed booking={booking} heading="Your meeting" />
          {mode === 'cancel' ? (
            <div className="mt-6 rounded-lg border border-border p-4">
              <p className="text-sm font-medium">Cancel this meeting?</p>
              <p className="mt-1 text-sm text-muted">{booking.ownerName} will be told.</p>
              <div className="mt-3 flex gap-2">
                <Danger disabled={busy} onClick={() => act(() => cancel(base), 'Your meeting is cancelled. We sent you an email.')}>Yes, cancel it</Danger>
                <Secondary onClick={() => setMode('view')}>Keep it</Secondary>
              </div>
            </div>
          ) : (
            <div className="mt-6 flex flex-wrap gap-2">
              {booking.canReschedule ? <Secondary onClick={() => { setNote(null); setMode('move'); }}>Reschedule</Secondary> : null}
              {booking.canCancel ? <Secondary onClick={() => { setNote(null); setMode('cancel'); }}>Cancel</Secondary> : null}
            </div>
          )}
          <TimeZone tz={tz} setTz={setTz} />
        </div>
      )}
    </Shell>
  );
}

// ---- the picker: month, days, starts ---------------------------------------------------------------------------------

function Picker({ base, page, duration, tz, setTz, onPick, heading = 'Select a Date & Time' }: { base: Base; page: PageInfo; duration: number; tz: string; setTz(z: string): void; onPick(start: string): void; heading?: string }) {
  const thisMonth = dateIn(Date.now(), tz).slice(0, 7);
  const lastMonth = dateIn(Date.parse(page.horizonEnd) - 1, tz).slice(0, 7);
  const [month, setMonth] = useState(() => { const m = params().get('month'); return m && /^\d{4}-\d\d$/.test(m) && m >= thisMonth && m <= lastMonth ? m : thisMonth; });
  const [days, setDays] = useState<string[] | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [slots, setSlots] = useState<string[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState(false);

  useEffect(() => {
    let live = true, retry: ReturnType<typeof setTimeout> | undefined;
    setDays(null); setError(null);
    const load = (again: boolean) => getDays(base, month, duration, tz).then((r) => {
      if (!live) return;
      setDays(r.days);
      // Nothing open this month (its last days): the next month, once.
      if (!r.days.length && !skipped && month === thisMonth && month < lastMonth) { setSkipped(true); setMonth(addMonths(month, 1)); }
      // A sync the visit started was still running: look once more when it is likely done.
      if (r.syncing && again) retry = setTimeout(() => load(false), 3000);
    }, (e) => live && setError(errorText(e)));
    load(true);
    return () => { live = false; clearTimeout(retry); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, month, duration, tz]);

  useEffect(() => {
    if (!date) { setSlots(null); return; }
    let live = true;
    setSlots(null); setChosen(null);
    getSlots(base, date, duration, tz).then((r) => live && setSlots(r.slots), (e) => live && setError(errorText(e)));
    return () => { live = false; };
  }, [base, date, duration, tz]);

  // A day picked in another month, or no longer open, is let go.
  useEffect(() => { if (date && days && !days.includes(date)) setDate(null); }, [days, date]);
  const go = (n: number) => { const m = addMonths(month, n); setMonth(m); setParam('month', m); setDate(null); };
  const open = new Set(days ?? []);
  const today = dateIn(Date.now(), tz);

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <div className="min-w-0 flex-1">
        <h2 className="mb-5 text-xl font-semibold">{heading}</h2>
        <div className="mb-4 flex items-center justify-center gap-6">
          <button type="button" aria-label="Previous month" disabled={month <= thisMonth} onClick={() => go(-1)} className="rounded-full p-2 text-primary hover:bg-selected-blue disabled:text-faint disabled:hover:bg-transparent"><ChevronLeft className="size-5" /></button>
          <span className="min-w-40 text-center font-medium" aria-live="polite">{monthTitle(month)}</span>
          <button type="button" aria-label="Next month" disabled={month >= lastMonth} onClick={() => go(1)} className="rounded-full p-2 text-primary hover:bg-selected-blue disabled:text-faint disabled:hover:bg-transparent"><ChevronRight className="size-5" /></button>
        </div>
        <div className="grid grid-cols-7 gap-y-1 text-center" role="grid" aria-label={monthTitle(month)} aria-busy={days === null}>
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <span key={d} className="pb-2 text-xs font-medium uppercase text-muted">{d}</span>)}
          {monthCells(month).map((d, i) => {
            if (!d) return <span key={`x${i}`} />;
            const avail = open.has(d);
            return (
              <span key={d} className="flex justify-center">
                <button
                  type="button"
                  disabled={!avail}
                  aria-pressed={date === d}
                  aria-label={`${dayTitle(d)}${avail ? ', times available' : ''}`}
                  onClick={() => setDate(d)}
                  className={cn('relative flex size-11 items-center justify-center rounded-full text-[15px]',
                    avail ? 'bg-selected-blue font-semibold text-primary hover:bg-primary-tint' : 'text-muted',
                    date === d && 'bg-primary text-[var(--book-on-primary)] hover:bg-primary-deep')}
                >
                  {Number(d.slice(8))}
                  {d === today ? <span className={cn('absolute bottom-1.5 size-1 rounded-full', date === d ? 'bg-[var(--book-on-primary)]' : 'bg-current')} /> : null}
                </button>
              </span>
            );
          })}
        </div>
        {days !== null && !days.length ? <p className="mt-4 text-center text-sm text-muted">No open times in {monthTitle(month)}.{month < lastMonth ? ' Try the next month.' : ''}</p> : null}
        {error ? <p role="alert" className="mt-4 text-center text-sm text-danger">{error}</p> : null}
        <TimeZone tz={tz} setTz={(z) => { setTz(z); setDate(null); }} />
      </div>
      {date ? (
        <div className="lg:w-56">
          <h3 className="mb-4 font-medium lg:mt-[4.25rem]">{dayTitle(date)}</h3>
          {slots === null ? <p className="text-sm text-muted">Loading times…</p> : !slots.length ? <p className="text-sm text-muted">No times left on this day.</p> : (
            <ul className="flex max-h-[26rem] flex-col gap-2 overflow-y-auto pr-1">
              {slots.map((s) => (
                <li key={s} className="flex gap-2">
                  <button type="button" onClick={() => setChosen(s)} className={cn('h-12 flex-1 rounded-md border text-[15px] font-semibold', chosen === s ? 'border-muted bg-muted text-[var(--book-on-primary)]' : 'border-primary/50 text-primary hover:border-primary hover:border-2')}>
                    {timeIn(s, tz)}
                  </button>
                  {chosen === s ? <button type="button" onClick={() => onPick(s)} className="h-12 flex-1 rounded-md bg-primary text-[15px] font-semibold text-[var(--book-on-primary)] hover:bg-primary-deep">Next</button> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function TimeZone({ tz, setTz }: { tz: string; setTz(z: string): void }) {
  const zones = useMemo(() => allZones(tz), [tz]);
  return (
    <div className="mt-8">
      <label htmlFor="book-tz" className="mb-1 block text-sm font-semibold">Time zone</label>
      <div className="flex items-center gap-2 text-sm">
        <Globe className="size-4 shrink-0 text-muted" aria-hidden />
        <select id="book-tz" value={tz} onChange={(e) => setTz(e.target.value)} className="min-w-0 max-w-full flex-1 truncate rounded-md border border-transparent bg-transparent py-1 hover:border-border focus:border-primary focus:outline-none">
          {zones.map((z) => <option key={z} value={z}>{zoneLabel(z)}</option>)}
        </select>
      </div>
    </div>
  );
}

// ---- the form and the confirmation -----------------------------------------------------------------------------------

function DetailsForm({ onSubmit }: { onSubmit(f: { name: string; email: string; note?: string; website?: string }): Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setError(null);
    try {
      await onSubmit({ name: String(f.get('name') ?? '').trim(), email: String(f.get('email') ?? '').trim(), note: String(f.get('note') ?? '').trim() || undefined, website: String(f.get('website') ?? '') || undefined });
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };
  const field = 'mt-1 block w-full rounded-md border border-border bg-transparent px-3 py-2 text-[15px] focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';
  return (
    <form onSubmit={submit} className="max-w-md">
      <h2 className="mb-5 text-xl font-semibold">Enter Details</h2>
      <label className="mb-4 block text-sm font-semibold">Name<input name="name" required maxLength={120} autoComplete="name" className={field} /></label>
      <label className="mb-4 block text-sm font-semibold">Email<input name="email" type="email" required maxLength={320} autoComplete="email" className={field} /></label>
      <label className="mb-4 block text-sm font-semibold">Anything to share before the meeting? <span className="font-normal text-muted">(optional)</span><textarea name="note" rows={4} maxLength={2000} className={field} /></label>
      {/* For bots only: a person never sees or fills it. */}
      <input name="website" tabIndex={-1} autoComplete="off" aria-hidden className="absolute -left-[9999px] size-px opacity-0" />
      {error ? <p role="alert" className="mb-3 text-sm text-danger">{error}</p> : null}
      <Primary type="submit" disabled={busy}>{busy ? 'Scheduling…' : 'Schedule Event'}</Primary>
    </form>
  );
}

function Confirmed({ booking, manageUrl, heading }: { booking: Booking; manageUrl?: string; heading: string }) {
  const ics = useMemo(() => URL.createObjectURL(new Blob([icsOf(booking)], { type: 'text/calendar' })), [booking]);
  useEffect(() => () => URL.revokeObjectURL(ics), [ics]);
  return (
    <div>
      <h2 className="flex items-center gap-2 text-xl font-semibold"><CalendarCheck className="size-6 text-primary" aria-hidden />{heading}</h2>
      {manageUrl ? <p className="mt-2 text-sm text-muted">A calendar invitation has been sent to your email address.</p> : null}
      <div className="mt-5 flex flex-wrap gap-2 text-sm">
        <a href={ics} download="meeting.ics" className="rounded-md border border-border px-3 py-1.5 font-medium hover:bg-hover">Add to calendar (.ics)</a>
        <a href={googleLink(booking)} target="_blank" rel="noreferrer" className="rounded-md border border-border px-3 py-1.5 font-medium hover:bg-hover">Add to Google Calendar</a>
      </div>
      {manageUrl ? (
        <p className="mt-6 text-sm text-muted">
          Need to change it? <a href={manageUrl} className="font-medium text-primary hover:underline">Cancel or reschedule</a>. The link is in your email too.
        </p>
      ) : null}
    </div>
  );
}

// ---- the frame -------------------------------------------------------------------------------------------------------

/** The two panels: who and what on the left (and, once picked, when), the steps on the right. */
function Shell({ page, duration, tz, when, lengths, onBack, children }: {
  page: PageInfo; duration: number; tz: string; when?: { start: string; end: string; location?: string | null }; lengths?: { value: number; onChange(n: number): void }; onBack?(): void; children: ReactNode;
}) {
  const where = when && 'location' in when ? when.location : null;
  return (
    <main className="flex min-h-full items-start justify-center bg-panel px-4 py-6 sm:py-12">
      <div className="w-full max-w-5xl overflow-hidden rounded-xl border border-hairline bg-[var(--book-card)] shadow-sm md:flex">
        <section className="border-b border-hairline p-6 md:w-80 md:shrink-0 md:border-b-0 md:border-r md:p-8">
          {onBack ? <button type="button" onClick={onBack} aria-label="Back" className="mb-4 flex size-10 items-center justify-center rounded-full border border-border text-primary hover:bg-selected-blue"><ChevronLeft className="size-5" /></button> : null}
          <p className="font-medium text-muted">{page.ownerName}</p>
          <h1 className="mt-1 text-2xl font-bold leading-tight sm:text-[28px]">{page.title}</h1>
          <ul className="mt-5 flex flex-col gap-3 text-[15px] font-medium text-muted">
            <li className="flex items-start gap-2.5">
              <Clock className="mt-0.5 size-5 shrink-0" aria-hidden />
              {lengths ? (
                <span className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Meeting length">
                  {page.durations.map((n) => (
                    <button key={n} type="button" role="radio" aria-checked={lengths.value === n} onClick={() => lengths.onChange(n)}
                      className={cn('rounded-full border px-3 py-0.5 text-sm', lengths.value === n ? 'border-primary bg-primary text-[var(--book-on-primary)]' : 'border-border hover:border-primary hover:text-primary')}>
                      {n} min
                    </button>
                  ))}
                </span>
              ) : <span>{duration} min</span>}
            </li>
            {when ? <li className="flex items-start gap-2.5"><CalendarCheck className="mt-0.5 size-5 shrink-0" aria-hidden /><span>{fullWhen(when.start, when.end, tz)}</span></li> : null}
            {where ? <li className="flex items-start gap-2.5"><MapPin className="mt-0.5 size-5 shrink-0" aria-hidden /><span className="break-all">{where}</span></li>
              : page.location.kind === 'link' ? <li className="flex items-start gap-2.5"><Video className="mt-0.5 size-5 shrink-0" aria-hidden /><span>Web conferencing details provided upon confirmation.</span></li>
              : page.location.kind === 'text' ? <li className="flex items-start gap-2.5"><MapPin className="mt-0.5 size-5 shrink-0" aria-hidden /><span>{page.location.label}</span></li> : null}
            {when ? <li className="flex items-start gap-2.5"><Globe className="mt-0.5 size-5 shrink-0" aria-hidden /><span>{tz.replace(/_/g, ' ')}</span></li> : null}
          </ul>
          {page.description ? <p className="mt-5 whitespace-pre-line text-sm text-ink">{page.description}</p> : null}
        </section>
        <section className="min-w-0 flex-1 p-6 md:p-8">{children}</section>
      </div>
    </main>
  );
}

function Message({ title, text }: { title: string; text: string }) {
  return (
    <main className="flex min-h-full items-center justify-center bg-panel px-4">
      <div className="max-w-md rounded-xl border border-hairline bg-[var(--book-card)] p-8 text-center">
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-muted">{text}</p>
      </div>
    </main>
  );
}
const Loading = () => <main className="flex min-h-full items-center justify-center bg-panel text-sm text-muted" aria-busy>Loading…</main>;

const Primary = ({ className, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" {...p} className={cn('rounded-full bg-primary px-5 py-2.5 text-[15px] font-semibold text-[var(--book-on-primary)] hover:bg-primary-deep disabled:opacity-60', className)} />;
const Secondary = ({ className, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" {...p} className={cn('rounded-full border border-border px-5 py-2.5 text-[15px] font-semibold hover:bg-hover', className)} />;
const Danger = ({ className, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" {...p} className={cn('rounded-full bg-danger px-5 py-2.5 text-[15px] font-semibold text-[var(--book-on-primary)] hover:opacity-90 disabled:opacity-60', className)} />;
