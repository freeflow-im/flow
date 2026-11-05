// The small month in the left column: ‹ › through the months, the visible range shaded, today in blue; a click goes to
// that day (in the view that is open), a drag over days goes to the week holding them (more than a week: their month).
import { useState } from 'react';
import { addDays, addMonths, format, isSameDay, isSameMonth, startOfMonth, startOfWeek } from 'date-fns';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { Range } from '../lib/ranges';
import { cn } from '../lib/utils';

export function MiniMonth({ date, range, weekStartsOn, onPick, onPickRange }: { date: Date; range: Range; weekStartsOn: 0 | 1; onPick(d: Date): void; onPickRange(start: Date, days: number): void }) {
  const [month, setMonth] = useState(() => startOfMonth(date));
  const [shown, setShown] = useState(+startOfMonth(date));
  // The month follows the view's date when that moves elsewhere.
  if (+startOfMonth(date) !== shown) { setShown(+startOfMonth(date)); setMonth(startOfMonth(date)); }
  const [drag, setDrag] = useState<{ from: Date; to: Date } | null>(null);
  const first = startOfWeek(month, { weekStartsOn });
  const days = Array.from({ length: 42 }, (_, i) => addDays(first, i));
  const heads = Array.from({ length: 7 }, (_, i) => format(addDays(first, i), 'EEEEE'));
  const today = new Date();
  const inDrag = (d: Date) => !!drag && d >= (drag.from < drag.to ? drag.from : drag.to) && d <= (drag.from < drag.to ? drag.to : drag.from);
  const finish = () => {
    if (!drag) return;
    const [a, b] = drag.from <= drag.to ? [drag.from, drag.to] : [drag.to, drag.from];
    const n = Math.round((+b - +a) / 86_400_000) + 1;
    setDrag(null);
    if (n <= 1) onPick(a);
    else onPickRange(a, n);
  };
  return (
    <div className="select-none px-3 pb-2" onPointerLeave={() => drag && finish()}>
      <div className="mb-1 flex items-center justify-between">
        <span className="pl-1 text-[14px] font-medium text-ink">{format(month, 'MMMM yyyy')}</span>
        <span className="flex">
          <button type="button" aria-label="Previous month" className="rounded-full p-1 text-muted hover:bg-hover" onClick={() => setMonth(addMonths(month, -1))}><ChevronLeft className="size-4" /></button>
          <button type="button" aria-label="Next month" className="rounded-full p-1 text-muted hover:bg-hover" onClick={() => setMonth(addMonths(month, 1))}><ChevronRight className="size-4" /></button>
        </span>
      </div>
      <div className="grid grid-cols-7 text-center text-[11px] text-muted">
        {heads.map((h, i) => <span key={i} className="py-1">{h}</span>)}
        {days.map((d) => {
          const visible = d >= range.start && d < range.end;
          return (
            <button
              key={+d}
              type="button"
              aria-label={format(d, 'EEEE, MMMM d')}
              onPointerDown={(e) => { e.preventDefault(); setDrag({ from: d, to: d }); }}
              onPointerEnter={() => drag && setDrag({ ...drag, to: d })}
              onPointerUp={finish}
              className={cn('m-px flex aspect-square items-center justify-center rounded-full text-[12px]', !isSameMonth(d, month) && 'text-faint', visible && 'bg-selected-blue', inDrag(d) && 'bg-primary-tint', isSameDay(d, today) ? 'bg-primary font-semibold text-white' : 'hover:bg-hover', isSameDay(d, date) && !isSameDay(d, today) && 'font-semibold text-primary')}
            >
              {format(d, 'd')}
            </button>
          );
        })}
      </div>
    </div>
  );
}
