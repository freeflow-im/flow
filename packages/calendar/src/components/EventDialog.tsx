// The edit dialog (docs/specs/calendar.md §5): title, when (all-day, start and end, the time zone), repeat (the presets
// and a custom rule), calendar, location, guests (completed from Mail's contacts), description and reminders. A new event
// is created as it stands; an existing one sends only what changed, and a repeating one asks this / following / all first
// (not "this" when its rule changed).
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { addMinutes, format } from 'date-fns';
import { Loader2, X } from 'lucide-react';
import { calendarApi, type CalendarAccount, type CalendarInfo, type EventInput, type EventOccurrence, type EventPatch, type Scope } from '../api';
import { allZones, browserZone, reminderText, wallIn, zoneLabel } from '../lib/format';
import { parseDate } from '../lib/ranges';
import { WEEKDAYS, defaultRule, describeRule, parseRule, positionOf, presetOf, presetsFor, ruleLine, withRule, type PresetId, type Rule } from '../lib/recurrence';
import { Button } from './ui/button';
import { Dialog, DialogContent } from './ui/dialog';
import { Input } from './ui/input';
import { ScopeDialog } from './ScopeDialog';

export interface Draft {
  summary: string; allDay: boolean; startDate: string; startTime: string; endDate: string; endTime: string; timezone: string;
  recurrence: string[]; calendarId: string; location: string; description: string; attendees: { email: string; name?: string }[]; reminders: number[];
}

const REMINDERS = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080];

/** A draft for a new event over a span (a selection, or the next hour), in the browser's zone. */
export function newDraft(start: Date, end: Date, allDay: boolean, calendarId: string, summary = ''): Draft {
  const lastDay = allDay ? new Date(+end - 86_400_000) : end;
  return { summary, allDay, startDate: format(start, 'yyyy-MM-dd'), startTime: format(start, 'HH:mm'), endDate: format(allDay ? lastDay : end, 'yyyy-MM-dd'), endTime: format(end, 'HH:mm'), timezone: browserZone(), recurrence: [], calendarId, location: '', description: '', attendees: [], reminders: allDay ? [] : [10] };
}

/** An existing occurrence as a draft: its times in its own zone (or the browser's), its fields. */
export function draftOf(o: EventOccurrence): Draft {
  const zone = o.timezone && o.timezone !== 'UTC' ? o.timezone : browserZone();
  const s = o.allDay ? { date: o.start, time: '09:00' } : wallIn(o.start, zone);
  const e = o.allDay ? { date: format(new Date(+parseDate(o.end) - 86_400_000), 'yyyy-MM-dd'), time: '10:00' } : wallIn(o.end, zone);
  return { summary: o.summary, allDay: o.allDay, startDate: s.date, startTime: s.time, endDate: e.date, endTime: e.time, timezone: zone, recurrence: o.recurrence ?? [], calendarId: o.calendarId, location: o.location ?? '', description: o.description ?? '', attendees: o.attendees.filter((a) => !(a.self && o.organizer?.self)).map((a) => ({ email: a.email, ...(a.name ? { name: a.name } : {}) })), reminders: o.reminders };
}

const nextDay = (d: string) => format(new Date(+parseDate(d) + 86_400_000 + 3_600_000), 'yyyy-MM-dd');
/** The draft as the API takes it: wall clock times in the draft's zone, dates (end exclusive) for all-day. */
export function inputOf(d: Draft): EventInput {
  return {
    calendarId: d.calendarId, summary: d.summary.trim(), location: d.location.trim() || null, description: d.description.trim() || null,
    ...(d.allDay ? { start: d.startDate, end: nextDay(d.endDate), allDay: true } : { start: `${d.startDate}T${d.startTime}`, end: `${d.endDate}T${d.endTime}`, allDay: false, timezone: d.timezone }),
    recurrence: d.recurrence.length ? d.recurrence : null, attendees: d.attendees, reminders: d.reminders.map((minutes) => ({ minutes })),
  };
}

/** What changed between two drafts, as a patch (times as a whole when any of them changed). */
export function patchOf(before: Draft, after: Draft): EventPatch {
  const a = inputOf(before), b = inputOf(after);
  const p: EventPatch = {};
  if (a.summary !== b.summary) p.summary = b.summary;
  if (a.location !== b.location) p.location = b.location;
  if (a.description !== b.description) p.description = b.description;
  if (a.start !== b.start || a.end !== b.end || a.allDay !== b.allDay || a.timezone !== b.timezone) Object.assign(p, { start: b.start, end: b.end, allDay: b.allDay, ...(b.allDay ? {} : { timezone: b.timezone }) });
  if (JSON.stringify(a.recurrence) !== JSON.stringify(b.recurrence)) p.recurrence = b.recurrence;
  if (JSON.stringify(a.attendees) !== JSON.stringify(b.attendees)) p.attendees = b.attendees;
  if (JSON.stringify(a.reminders) !== JSON.stringify(b.reminders)) p.reminders = b.reminders;
  if (a.calendarId !== b.calendarId) p.calendarId = b.calendarId;
  return p;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-[96px_1fr] sm:items-start sm:gap-3">
      <span className="pt-2 text-[13px] font-medium text-muted">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
const field = 'h-9 rounded-lg border border-border bg-white px-2 text-sm text-ink outline-none focus:ring-2 focus:ring-primary/30';

function CustomRule({ rule, start, onChange }: { rule: Rule; start: Date; onChange(r: Rule): void }) {
  return (
    <div className="mt-2 flex flex-col gap-3 rounded-lg border border-hairline p-3 text-[14px]">
      <div className="flex flex-wrap items-center gap-2">
        Every
        <input aria-label="Interval" type="number" min={1} max={99} className={`${field} w-16`} value={rule.interval} onChange={(e) => onChange({ ...rule, interval: Math.max(1, Number(e.target.value) || 1) })} />
        <select aria-label="Frequency" className={field} value={rule.freq} onChange={(e) => {
          const freq = e.target.value as Rule['freq'];
          onChange({ ...rule, freq, byday: freq === 'WEEKLY' ? [WEEKDAYS[start.getDay()] ?? 'SU'] : [], bymonthday: freq === 'MONTHLY' ? start.getDate() : undefined });
        }}>
          {(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const).map((f) => <option key={f} value={f}>{({ DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' })[f]}{rule.interval > 1 ? 's' : ''}</option>)}
        </select>
      </div>
      {rule.freq === 'WEEKLY' && (
        <div className="flex gap-1" role="group" aria-label="On">
          {WEEKDAYS.map((d) => {
            const on = rule.byday.includes(d);
            return <button key={d} type="button" aria-pressed={on} onClick={() => { const byday = on ? rule.byday.filter((x) => x !== d) : [...rule.byday, d]; onChange({ ...rule, byday: byday.length ? WEEKDAYS.filter((w) => byday.includes(w)) : rule.byday }); }} className={`size-8 rounded-full text-[12px] font-medium ${on ? 'bg-primary text-white' : 'bg-track text-muted'}`}>{d[0]}</button>;
          })}
        </div>
      )}
      {rule.freq === 'MONTHLY' && (
        <select aria-label="Monthly on" className={field} value={rule.bymonthday ? 'day' : 'position'} onChange={(e) => onChange(e.target.value === 'day' ? { ...rule, byday: [], bymonthday: start.getDate() } : { ...rule, byday: [positionOf(start)], bymonthday: undefined })}>
          <option value="day">On day {start.getDate()}</option>
          <option value="position">{describeRule(`FREQ=MONTHLY;BYDAY=${positionOf(start)}`).replace('Monthly ', 'On ').replace(/^On on/, 'On')}</option>
        </select>
      )}
      <div className="flex flex-wrap items-center gap-2">
        Ends
        <select aria-label="Ends" className={field} value={rule.end.kind} onChange={(e) => {
          const kind = e.target.value as Rule['end']['kind'];
          onChange({ ...rule, end: kind === 'count' ? { kind, count: 10 } : kind === 'until' ? { kind, date: format(addMinutes(start, 60 * 24 * 90), 'yyyy-MM-dd') } : { kind: 'never' } });
        }}>
          <option value="never">Never</option>
          <option value="count">After</option>
          <option value="until">On</option>
        </select>
        {rule.end.kind === 'count' && <><input aria-label="Occurrences" type="number" min={1} max={999} className={`${field} w-20`} value={rule.end.count} onChange={(e) => onChange({ ...rule, end: { kind: 'count', count: Math.max(1, Number(e.target.value) || 1) } })} /> times</>}
        {rule.end.kind === 'until' && <input aria-label="Until" type="date" className={field} value={rule.end.date} onChange={(e) => onChange({ ...rule, end: { kind: 'until', date: e.target.value } })} />}
      </div>
      <span className="text-[13px] text-muted">{describeRule(ruleLine(rule))}</span>
    </div>
  );
}

function Guests({ value, onChange }: { value: Draft['attendees']; onChange(v: Draft['attendees']): void }) {
  const [text, setText] = useState('');
  const [found, setFound] = useState<{ name: string; address: string }[]>([]);
  useEffect(() => {
    const q = text.trim();
    if (q.length < 2) { setFound([]); return; }
    const t = setTimeout(() => void calendarApi.contacts(q).then((c) => setFound(c.filter((x) => !value.some((v) => v.email === x.address.toLowerCase())))), 250);
    return () => clearTimeout(t);
  }, [text, value]);
  const add = (email: string, name?: string) => {
    const e = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || value.some((v) => v.email === e)) return;
    onChange([...value, { email: e, ...(name ? { name } : {}) }]);
    setText('');
    setFound([]);
  };
  return (
    <div>
      {!!value.length && (
        <ul className="mb-2 flex flex-wrap gap-1.5">
          {value.map((a) => (
            <li key={a.email} className="flex items-center gap-1 rounded-full bg-track py-0.5 pl-2.5 pr-1 text-[13px]">
              <span title={a.email}>{a.name || a.email}</span>
              <button type="button" aria-label={`Remove ${a.email}`} className="rounded-full p-0.5 text-muted hover:bg-white" onClick={() => onChange(value.filter((v) => v.email !== a.email))}><X className="size-3" /></button>
            </li>
          ))}
        </ul>
      )}
      <div className="relative">
        <Input aria-label="Add guests" placeholder="Add guests by email" value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') { if (text.trim()) { e.preventDefault(); found[0] && !text.includes('@') ? add(found[0].address, found[0].name) : add(text); } } }}
          onBlur={() => text.includes('@') && add(text)} />
        {!!found.length && (
          <ul role="listbox" className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-lg border border-hairline bg-white shadow-lg">
            {found.map((c) => (
              <li key={c.address}><button type="button" role="option" aria-selected={false} className="flex w-full flex-col px-3 py-1.5 text-left hover:bg-hover" onMouseDown={(e) => { e.preventDefault(); add(c.address, c.name); }}><span className="text-[14px]">{c.name || c.address}</span>{c.name && <span className="text-[12px] text-muted">{c.address}</span>}</button></li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function EventDialog({ initial, existing, calendars, accounts, onSave, onDelete, onClose }: {
  initial: Draft; existing?: EventOccurrence; calendars: CalendarInfo[]; accounts: CalendarAccount[];
  onSave(input: EventInput | EventPatch, scope: Scope | undefined): Promise<unknown>; onDelete?: () => void; onClose(): void;
}) {
  const [d, setD] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<EventPatch | null>(null);
  const start = useMemo(() => parseDate(d.startDate), [d.startDate]);
  const presets = useMemo(() => presetsFor(start), [start]);
  const rrule = d.recurrence.find((l) => /^RRULE/i.test(l)) ?? null;
  const [preset, setPreset] = useState<PresetId>(() => presetOf(initial.recurrence, parseDate(initial.startDate)));
  const [custom, setCustom] = useState<Rule>(() => (rrule && parseRule(rrule)) || defaultRule(start));
  const zones = useMemo(() => [...new Set([browserZone(), initial.timezone, ...allZones()])], [initial.timezone]);
  const writable = calendars.filter((c) => c.role !== 'reader');
  // A calendar shared with the person (phase 4.4) takes new events; an event on one stays there (another owner's object
  // holds it), and one of the person's own does not move to one.
  const onShared = !!existing && !!calendars.find((c) => c.id === existing.calendarId)?.shared;
  const sharedChoices = onShared ? writable.filter((c) => c.id === existing!.calendarId) : existing ? [] : writable.filter((c) => c.shared);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));

  // Moving the start keeps the length; an end before the start follows it.
  const setStart = (date: string, time: string) => {
    const before = +new Date(`${d.startDate}T${d.startTime}`), after = +new Date(`${date}T${time}`);
    const end = new Date(+new Date(`${d.endDate}T${d.endTime}`) + (after - before));
    set({ startDate: date, startTime: time, ...(Number.isNaN(+end) ? {} : { endDate: format(end, 'yyyy-MM-dd'), endTime: format(end, 'HH:mm') }) });
  };
  const choosePreset = (id: PresetId) => {
    setPreset(id);
    const p = presets.find((x) => x.id === id);
    if (id === 'custom') set({ recurrence: withRule(d.recurrence, ruleLine(custom)) });
    else set({ recurrence: withRule(d.recurrence, p?.line ?? null) });
  };
  const save = async (input: EventInput | EventPatch, scope?: Scope) => {
    setBusy(true);
    setError(null);
    try {
      await onSave(input, scope);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!d.allDay && `${d.endDate}T${d.endTime}` < `${d.startDate}T${d.startTime}`) return setError('The end is before the start.');
    if (d.allDay && d.endDate < d.startDate) return setError('The end is before the start.');
    if (!existing) return void save(inputOf(d));
    const patch = patchOf(initial, d);
    if (!Object.keys(patch).length) return onClose();
    // A move to another calendar takes the whole series with it; otherwise a repeating event asks how far the change goes.
    if (existing.recurring && patch.calendarId) void save({ ...patch, etag: existing.etag }, 'all');
    else if (existing.recurring) setAsking(patch);
    else void save({ ...patch, etag: existing.etag });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-xl gap-3" aria-describedby={undefined}>
        <h2 className="sr-only">{existing ? 'Edit event' : 'New event'}</h2>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <input aria-label="Title" autoFocus placeholder="Add title" className="mr-8 border-b border-border pb-1 text-[22px] outline-none focus:border-primary" value={d.summary} onChange={(e) => set({ summary: e.target.value })} />
          <Row label="When">
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <input aria-label="Start date" type="date" className={field} value={d.startDate} onChange={(e) => setStart(e.target.value, d.startTime)} required />
                {!d.allDay && <input aria-label="Start time" type="time" step={300} className={field} value={d.startTime} onChange={(e) => setStart(d.startDate, e.target.value)} required />}
                <span className="text-muted">to</span>
                {!d.allDay && <input aria-label="End time" type="time" step={300} className={field} value={d.endTime} onChange={(e) => set({ endTime: e.target.value })} required />}
                <input aria-label="End date" type="date" className={field} value={d.endDate} onChange={(e) => set({ endDate: e.target.value })} required />
              </div>
              <div className="flex flex-wrap items-center gap-3 text-[14px]">
                <label className="flex items-center gap-2"><input type="checkbox" className="size-4 accent-[var(--color-primary)]" checked={d.allDay} onChange={(e) => set({ allDay: e.target.checked })} /> All day</label>
                {!d.allDay && (
                  <select aria-label="Time zone" className={`${field} max-w-[18rem]`} value={d.timezone} onChange={(e) => set({ timezone: e.target.value })}>
                    {zones.map((z) => <option key={z} value={z}>{zoneLabel(z)}</option>)}
                  </select>
                )}
              </div>
            </div>
          </Row>
          <Row label="Repeat">
            <select aria-label="Repeat" className={`${field} w-full`} value={preset} onChange={(e) => choosePreset(e.target.value as PresetId)}>
              {presets.map((p) => <option key={p.id} value={p.id}>{p.id === 'custom' && preset === 'custom' && rrule ? describeRule(rrule) : p.label}</option>)}
            </select>
            {preset === 'custom' && <CustomRule rule={custom} start={start} onChange={(r) => { setCustom(r); set({ recurrence: withRule(d.recurrence, ruleLine(r)) }); }} />}
          </Row>
          <Row label="Calendar">
            <select aria-label="Calendar" className={`${field} w-full`} value={d.calendarId} disabled={onShared} onChange={(e) => set({ calendarId: e.target.value })}>
              {!onShared && accounts.map((a) => (
                <optgroup key={a.id} label={a.displayName || a.email}>
                  {writable.filter((c) => c.accountId === a.id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </optgroup>
              ))}
              {!!sharedChoices.length && (
                <optgroup label="Shared with me">
                  {sharedChoices.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </optgroup>
              )}
            </select>
          </Row>
          <Row label="Location"><Input aria-label="Location" placeholder="Add a place or a link" value={d.location} onChange={(e) => set({ location: e.target.value })} /></Row>
          <Row label="Guests"><Guests value={d.attendees} onChange={(attendees) => set({ attendees })} /></Row>
          <Row label="Reminders">
            <div className="flex flex-wrap items-center gap-1.5">
              {d.reminders.map((m) => (
                <span key={m} className="flex items-center gap-1 rounded-full bg-track py-0.5 pl-2.5 pr-1 text-[13px]">{reminderText(m)}<button type="button" aria-label={`Remove reminder ${reminderText(m)}`} className="rounded-full p-0.5 text-muted hover:bg-white" onClick={() => set({ reminders: d.reminders.filter((x) => x !== m) })}><X className="size-3" /></button></span>
              ))}
              <select aria-label="Add a reminder" className={field} value="" onChange={(e) => e.target.value && set({ reminders: [...new Set([...d.reminders, Number(e.target.value)])].sort((a, b) => a - b) })}>
                <option value="">Add a reminder…</option>
                {REMINDERS.filter((m) => !d.reminders.includes(m)).map((m) => <option key={m} value={m}>{reminderText(m)}</option>)}
              </select>
            </div>
          </Row>
          <Row label="Description"><textarea aria-label="Description" rows={4} className="w-full rounded-lg border border-border p-2 text-sm outline-none focus:ring-2 focus:ring-primary/30" value={d.description} onChange={(e) => set({ description: e.target.value })} /></Row>
          {error && <p role="alert" className="rounded-lg border border-warn-border bg-warn-bg px-3 py-2 text-[14px]">{error}</p>}
          <div className="flex items-center gap-2 pt-1">
            {onDelete && <Button type="button" variant="ghost" className="text-danger" onClick={onDelete} disabled={busy}>Delete</Button>}
            <Button type="button" variant="outline" className="ml-auto" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy || !writable.length}>{busy && <Loader2 className="animate-spin" />}Save</Button>
          </div>
        </form>
        {asking && existing && (
          <ScopeDialog action="edit" allowThis={asking.recurrence === undefined}
            onCancel={() => setAsking(null)}
            onChoose={(scope) => { const p = asking; setAsking(null); void save({ ...p, etag: existing.etag }, scope); }} />
        )}
      </DialogContent>
    </Dialog>
  );
}
