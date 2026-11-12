// Booking page (docs/specs/guest-scheduler.md §1, §4): the owner's settings for the guest scheduler, opened from the
// sidebar. Turn it on (the first time makes its link), copy the link or make a new one, and set what guests are offered:
// the title, the meeting lengths, the weekly hours, the limits, which calendars count as busy and which one gets the
// meetings, and the location. The coming bookings are listed under it. Everything is saved at once with Save.
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Loader2, Plus, RefreshCw, X } from 'lucide-react';
import { calendarApi, type CalendarInfo, type SchedulerBooking, type SchedulerConfig, type SchedulerPage, type Weekday } from '../api';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';

const LENGTHS = [15, 30, 45, 60, 90];
const DAYS: [Weekday, string][] = [['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']];
const NOTICE: [number, string][] = [[0, 'None'], [30, '30 minutes'], [60, '1 hour'], [120, '2 hours'], [240, '4 hours'], [1440, '1 day'], [2880, '2 days']];
const BUFFERS = [0, 5, 10, 15, 30, 60];
const field = 'h-9 rounded-lg border border-border bg-white px-2 text-sm text-ink outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60';
const hm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const minutes = (v: string) => { const [h, m] = v.split(':').map(Number) as [number, number]; return h * 60 + m; };

function zones(current: string): string[] {
  let all: string[] = [];
  try { all = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone'); } catch { /* an old browser */ }
  return [...new Set([current, ...all])].sort();
}

export function BookingPageDialog({ calendars, onClose }: { calendars: CalendarInfo[]; onClose(): void }) {
  const qc = useQueryClient();
  const [saved, setSaved] = useState<SchedulerPage | null>(null);
  const [draft, setDraft] = useState<SchedulerConfig | null>(null);
  const [bookings, setBookings] = useState<SchedulerBooking[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [rotating, setRotating] = useState(false);

  useEffect(() => {
    let live = true;
    calendarApi.scheduler().then((p) => { if (live) { setSaved(p); setDraft(p.page); } }, (e: Error) => live && setError(e.message));
    calendarApi.schedulerBookings().then((b) => live && setBookings(b), () => live && setBookings([]));
    return () => { live = false; };
  }, []);

  const own = calendars.filter((c) => !c.shared);
  const writable = own.filter((c) => c.role !== 'reader');
  const set = (patch: Partial<SchedulerConfig>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const run = async (fn: () => Promise<SchedulerPage>) => {
    setBusy(true); setError(null);
    try {
      const p = await fn();
      setSaved(p); setDraft(p.page);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally { setBusy(false); }
  };
  const save = async () => {
    if (!draft) return;
    if (await run(() => calendarApi.updateScheduler(draft))) { void qc.invalidateQueries({ queryKey: ['scheduler'] }); onClose(); }
  };
  const toggle = (on: boolean) => draft && void run(() => calendarApi.updateScheduler({ ...draft, enabled: on }));
  const copy = async () => {
    if (!saved?.url) return;
    await navigator.clipboard.writeText(saved.url).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Booking page</DialogTitle>
          <DialogDescription>A page where anyone with the link can book a meeting with you in your free time.</DialogDescription>
        </DialogHeader>
        {!draft && !error && <div className="flex justify-center py-6 text-muted"><Loader2 className="size-5 animate-spin" /></div>}
        {draft && (
          <div className="flex flex-col gap-5 text-[14px]">
            <section className="rounded-lg border border-hairline p-3">
              <label className="flex items-center justify-between gap-3">
                <span>
                  <span className="block font-medium">{saved?.page.enabled ? 'Your booking page is on' : 'Your booking page is off'}</span>
                  <span className="block text-muted">{saved?.page.enabled ? 'Guests with the link can book.' : 'Turn it on to get a link to share.'}</span>
                </span>
                <Switch checked={!!saved?.page.enabled} disabled={busy} onChange={toggle} label="Booking page on" />
              </label>
              {saved?.page.enabled && saved.url && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-md bg-panel px-2 py-1.5 text-[13px]" title={saved.url}>{saved.url}</code>
                  <Button type="button" variant="outline" size="sm" onClick={copy}>{copied ? <Check /> : <Copy />}{copied ? 'Copied' : 'Copy link'}</Button>
                  <a href={saved.url} target="_blank" rel="noreferrer" className="text-[13px] font-medium text-primary hover:underline">Open</a>
                </div>
              )}
              {saved?.page.enabled && saved.url && (rotating ? (
                <div className="mt-3 rounded-md bg-warn-bg p-2 text-[13px]">
                  The current link stops working. Guests who already booked can still cancel or reschedule.
                  <div className="mt-2 flex gap-2">
                    <Button type="button" size="sm" disabled={busy} onClick={() => void run(() => calendarApi.rotateScheduler()).then(() => setRotating(false))}>Make a new link</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setRotating(false)}>Keep this link</Button>
                  </div>
                </div>
              ) : (
                <button type="button" className="mt-2 inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink" onClick={() => setRotating(true)}><RefreshCw className="size-3.5" />Make a new link…</button>
              ))}
            </section>

            <section className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 sm:col-span-2"><span className="font-medium">Title</span><input className={field} value={draft.title} maxLength={120} placeholder={saved?.defaultTitle ?? 'Meeting with you'} onChange={(e) => set({ title: e.target.value })} /></label>
              <label className="flex flex-col gap-1 sm:col-span-2"><span className="font-medium">Description <span className="font-normal text-muted">(optional)</span></span><textarea className={cn(field, 'h-16 py-1.5')} value={draft.description} maxLength={2000} onChange={(e) => set({ description: e.target.value })} /></label>
              <div className="flex flex-col gap-1 sm:col-span-2">
                <span className="font-medium">Meeting lengths</span>
                <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Meeting lengths">
                  {LENGTHS.map((n) => {
                    const on = draft.durations.includes(n);
                    return (
                      <button key={n} type="button" aria-pressed={on} onClick={() => {
                        const next = on ? draft.durations.filter((x) => x !== n) : [...draft.durations, n].sort((a, b) => a - b);
                        if (next.length) set({ durations: next, defaultDuration: next.includes(draft.defaultDuration) ? draft.defaultDuration : next[0]! });
                      }} className={cn('rounded-full border px-3 py-1', on ? 'border-primary bg-primary text-white' : 'border-border hover:border-primary')}>{n} min</button>
                    );
                  })}
                  {draft.durations.length > 1 && (
                    <label className="ml-2 flex items-center gap-1.5 text-muted">Default
                      <select className={field} value={draft.defaultDuration} onChange={(e) => set({ defaultDuration: Number(e.target.value) })}>
                        {draft.durations.map((n) => <option key={n} value={n}>{n} min</option>)}
                      </select>
                    </label>
                  )}
                </div>
              </div>
              <label className="flex flex-col gap-1 sm:col-span-2"><span className="font-medium">Location <span className="font-normal text-muted">(a video call link or an address; a link is shown only after booking)</span></span>
                <input className={field} value={draft.location.value} maxLength={500} placeholder="None" onChange={(e) => set({ location: e.target.value.trim() ? { kind: 'text', value: e.target.value } : { kind: 'none', value: '' } })} />
              </label>
            </section>

            <section>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">Weekly hours</span>
                <label className="flex items-center gap-1.5 text-muted">Time zone
                  <select className={cn(field, 'max-w-56')} value={draft.timezone} onChange={(e) => set({ timezone: e.target.value })}>
                    {zones(draft.timezone).map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
                  </select>
                </label>
              </div>
              <ul className="flex flex-col divide-y divide-hairline rounded-lg border border-hairline">
                {DAYS.map(([d, name]) => {
                  const ranges = draft.weekly[d];
                  const setDay = (r: [number, number][]) => set({ weekly: { ...draft.weekly, [d]: r } });
                  return (
                    <li key={d} className="flex flex-wrap items-start gap-3 px-3 py-2">
                      <label className="flex w-32 items-center gap-2 pt-1.5">
                        <input type="checkbox" checked={ranges.length > 0} onChange={(e) => setDay(e.target.checked ? [[540, 1020]] : [])} />
                        <span className={cn(!ranges.length && 'text-muted')}>{name}</span>
                      </label>
                      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                        {!ranges.length && <span className="pt-1.5 text-muted">Unavailable</span>}
                        {ranges.map(([a, b], i) => (
                          <span key={i} className="flex items-center gap-1.5">
                            <input type="time" step={900} aria-label={`${name} from`} className={field} value={hm(a)} onChange={(e) => setDay(ranges.map((r, j) => (j === i ? [minutes(e.target.value), r[1]] : r)))} />
                            <span className="text-muted">–</span>
                            <input type="time" step={900} aria-label={`${name} until`} className={field} value={hm(b === 1440 ? 0 : b)} onChange={(e) => setDay(ranges.map((r, j) => (j === i ? [r[0], minutes(e.target.value) || 1440] : r)))} />
                            <button type="button" aria-label={`Remove ${name} ${hm(a)}`} className="rounded p-1 text-muted hover:bg-hover" onClick={() => setDay(ranges.filter((_, j) => j !== i))}><X className="size-4" /></button>
                            {i === ranges.length - 1 && ranges.length < 6 && (
                              <button type="button" aria-label={`Add hours on ${name}`} className="rounded p-1 text-muted hover:bg-hover" onClick={() => setDay([...ranges, [Math.min(b + 60, 1380), Math.min(b + 120, 1440)]])}><Plus className="size-4" /></button>
                            )}
                          </span>
                        ))}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>

            <section className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1"><span className="font-medium">Minimum notice</span>
                <select className={field} value={draft.minNoticeMin} onChange={(e) => set({ minNoticeMin: Number(e.target.value) })}>
                  {(NOTICE.some(([v]) => v === draft.minNoticeMin) ? NOTICE : [...NOTICE, [draft.minNoticeMin, `${draft.minNoticeMin} minutes`] as [number, string]].sort((a, b) => a[0] - b[0])).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1"><span className="font-medium">Book up to (days ahead)</span>
                <input type="number" min={1} max={365} className={field} value={draft.horizonDays} onChange={(e) => set({ horizonDays: Math.max(1, Math.min(365, Number(e.target.value) || 1)) })} />
              </label>
              <label className="flex flex-col gap-1"><span className="font-medium">Free time before a meeting</span>
                <select className={field} value={draft.bufferBeforeMin} onChange={(e) => set({ bufferBeforeMin: Number(e.target.value) })}>{BUFFERS.map((n) => <option key={n} value={n}>{n ? `${n} min` : 'None'}</option>)}</select>
              </label>
              <label className="flex flex-col gap-1"><span className="font-medium">Free time after a meeting</span>
                <select className={field} value={draft.bufferAfterMin} onChange={(e) => set({ bufferAfterMin: Number(e.target.value) })}>{BUFFERS.map((n) => <option key={n} value={n}>{n ? `${n} min` : 'None'}</option>)}</select>
              </label>
              <label className="flex flex-col gap-1"><span className="font-medium">Most bookings a day</span>
                <input type="number" min={1} max={50} placeholder="No limit" className={field} value={draft.maxPerDay ?? ''} onChange={(e) => set({ maxPerDay: e.target.value ? Math.max(1, Math.min(50, Number(e.target.value))) : null })} />
              </label>
              <label className="flex flex-col gap-1"><span className="font-medium">Add meetings to</span>
                <select className={field} value={draft.targetCalendarId ?? ''} onChange={(e) => set({ targetCalendarId: e.target.value || null })}>
                  <option value="">Your default calendar</option>
                  {writable.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
            </section>

            <section>
              <span className="font-medium">Check these calendars for conflicts</span>
              <div className="mt-1.5 flex flex-col gap-1">
                <label className="flex items-center gap-2"><input type="checkbox" checked={draft.busyCalendarIds === null} onChange={(e) => set({ busyCalendarIds: e.target.checked ? null : own.filter((c) => !c.hidden).map((c) => c.id) })} />Every calendar you show</label>
                {draft.busyCalendarIds !== null && own.map((c) => (
                  <label key={c.id} className="ml-6 flex items-center gap-2">
                    <input type="checkbox" checked={draft.busyCalendarIds!.includes(c.id)} onChange={(e) => set({ busyCalendarIds: e.target.checked ? [...draft.busyCalendarIds!, c.id] : draft.busyCalendarIds!.filter((x) => x !== c.id) })} />
                    <span className="size-3 rounded-sm" style={{ background: c.color }} aria-hidden />{c.name}
                  </label>
                ))}
              </div>
            </section>

            <section>
              <span className="font-medium">Coming bookings</span>
              {bookings === null ? <p className="mt-1 text-muted">Loading…</p> : !bookings.filter((b) => b.status === 'booked').length ? <p className="mt-1 text-muted">None yet.</p> : (
                <ul className="mt-1.5 flex flex-col gap-1">
                  {bookings.filter((b) => b.status === 'booked').map((b) => (
                    <li key={b.id} className="flex flex-wrap gap-x-2">
                      <span className="font-medium">{new Date(b.start).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                      <span>{b.guestName}</span><span className="text-muted">{b.guestEmail} · {b.duration} min</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
        {error && <p role="alert" className="rounded-lg border border-warn-border bg-warn-bg px-3 py-2 text-[14px]">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="button" onClick={save} disabled={busy || !draft}>{busy && <Loader2 className="animate-spin" />}Save</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Switch({ checked, disabled, onChange, label }: { checked: boolean; disabled?: boolean; onChange(on: boolean): void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={cn('relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-60', checked ? 'bg-primary' : 'bg-border')}>
      <span className={cn('absolute left-0.5 top-0.5 size-5 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-5' : 'translate-x-0')} />
    </button>
  );
}
