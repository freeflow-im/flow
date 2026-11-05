// Above the view: Today, ‹ ›, the title, and Day | Week | Month | Agenda (Day | Agenda on a phone, with the calendars
// behind a button).
import { ChevronLeft, ChevronRight, Loader2, PanelLeft } from 'lucide-react';
import { VIEWS, type View } from '../lib/ranges';
import { cn } from '../lib/utils';
import { Button } from './ui/button';

const LABEL: Record<View, string> = { day: 'Day', week: 'Week', month: 'Month', agenda: 'Agenda' };
const KEY: Record<View, string> = { day: 'D', week: 'W', month: 'M', agenda: 'A' };

export function Toolbar({ title, view, narrow, busy, onToday, onStep, onView, onCalendars }: { title: string; view: View; narrow: boolean; busy: boolean; onToday(): void; onStep(dir: 1 | -1): void; onView(v: View): void; onCalendars(): void }) {
  const views = narrow ? (['day', 'agenda'] as View[]) : VIEWS;
  return (
    <div className="flex h-14 shrink-0 items-center gap-2 border-b border-hairline px-3">
      {narrow && (
        <Button variant="ghost" size="icon-sm" aria-label="Calendars" onClick={onCalendars}><PanelLeft /></Button>
      )}
      <Button variant="outline" size="sm" onClick={onToday} title="Today (T)">Today</Button>
      <span className="flex">
        <Button variant="ghost" size="icon-sm" aria-label="Previous" title="Previous (←)" onClick={() => onStep(-1)}><ChevronLeft /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="Next" title="Next (→)" onClick={() => onStep(1)}><ChevronRight /></Button>
      </span>
      <h1 className="min-w-0 truncate text-[18px] font-normal text-ink sm:text-[20px]">{title}</h1>
      {busy && <Loader2 className="size-4 shrink-0 animate-spin text-faint" aria-label="Loading" />}
      <div role="tablist" aria-label="View" className="ml-auto flex shrink-0 rounded-lg bg-track p-0.5">
        {views.map((v) => (
          <button key={v} type="button" role="tab" aria-selected={view === v} title={`${LABEL[v]} (${KEY[v]})`} onClick={() => onView(v)}
            className={cn('rounded-md px-3 py-1 text-[14px] text-muted', view === v ? 'bg-white font-medium text-ink shadow-sm' : 'hover:text-ink')}>
            {LABEL[v]}
          </button>
        ))}
      </div>
    </div>
  );
}
