// Quick create, by the time chosen in the grid: a title, the time it will be, the calendar; Enter saves, "More options"
// opens the full dialog with what was typed.
import { useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import type { CalendarAccount, CalendarInfo } from '../api';
import { whenText } from '../lib/format';
import { Button } from './ui/button';
import { AnchoredPopover, type Anchor } from './ui/popover';
import { inputOf, type Draft } from './EventDialog';

export function QuickCreate({ draft, anchor, calendars, accounts, onSave, onMore, onClose }: { draft: Draft; anchor: Anchor; calendars: CalendarInfo[]; accounts: CalendarAccount[]; onSave(d: Draft): Promise<unknown>; onMore(d: Draft): void; onClose(): void }) {
  const [d, setD] = useState(draft);
  const [busy, setBusy] = useState(false);
  const input = inputOf(d);
  const shown = { start: d.allDay ? input.start : new Date(`${d.startDate}T${d.startTime}`).toISOString(), end: d.allDay ? input.end : new Date(`${d.endDate}T${d.endTime}`).toISOString(), allDay: d.allDay };
  const writable = calendars.filter((c) => c.role !== 'reader');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onSave(d);
      onClose();
    } catch {
      setBusy(false);
    }
  };
  return (
    <AnchoredPopover anchor={anchor} onClose={onClose} label="New event" className="w-[min(360px,calc(100vw-24px))]">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <input aria-label="Title" autoFocus placeholder="Add title" className="border-b border-border pb-1 text-[20px] outline-none focus:border-primary" value={d.summary} onChange={(e) => setD({ ...d, summary: e.target.value })} />
        <p className="text-[14px] text-muted">{whenText(shown)}</p>
        <select aria-label="Calendar" className="h-9 rounded-lg border border-border bg-white px-2 text-sm" value={d.calendarId} onChange={(e) => setD({ ...d, calendarId: e.target.value })}>
          {accounts.map((a) => (
            <optgroup key={a.id} label={a.displayName || a.email}>
              {writable.filter((c) => c.accountId === a.id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </optgroup>
          ))}
        </select>
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onMore(d)}>More options</Button>
          <Button type="submit" disabled={busy || !writable.length}>{busy && <Loader2 className="animate-spin" />}Save</Button>
        </div>
      </form>
    </AnchoredPopover>
  );
}
