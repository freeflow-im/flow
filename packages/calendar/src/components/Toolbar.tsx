// Above the view: Today, ‹ ›, the title, and Day | Week | Month | Agenda (Day | Agenda on a phone, with the calendars
// behind a button). Off today's day or week, Today turns solid with an arrow pointing back to it, a chip beside the
// title says how far away the view is, and a blue rule runs under the bar, all without changing its height.
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, Loader2, PanelLeft } from 'lucide-react';
import { VIEWS, type View } from '../lib/ranges';
import { cn } from '../lib/utils';
import { Button } from './ui/button';

const LABEL: Record<View, string> = { day: 'Day', week: 'Week', month: 'Month', agenda: 'Agenda' };
const KEY: Record<View, string> = { day: 'D', week: 'W', month: 'M', agenda: 'A' };

export function Toolbar({ title, offset, view, narrow, busy, onToday, onStep, onView, onCalendars }: { title: string; offset?: { dir: 1 | -1; label: string } | null; view: View; narrow: boolean; busy: boolean; onToday(): void; onStep(dir: 1 | -1): void; onView(v: View): void; onCalendars(): void }) {
  const views = narrow ? (['day', 'agenda'] as View[]) : VIEWS;
  return (
    <div data-offset={offset ? offset.dir : undefined}
      className={cn('flex h-14 shrink-0 items-center gap-2 border-b px-3', offset ? 'border-primary shadow-[0_1px_0_var(--color-primary)]' : 'border-hairline')}>
      {narrow && (
        <Button variant="ghost" size="icon-sm" aria-label="Calendars" onClick={onCalendars}><PanelLeft /></Button>
      )}
      {offset ? (
        <Button variant="default" size="sm" className="gap-1.5 shadow-sm" onClick={onToday} title="Back to today (T)">
          {offset.dir > 0 ? <ArrowLeft aria-hidden /> : <ArrowRight aria-hidden />}Today
        </Button>
      ) : (
        <Button variant="outline" size="sm" onClick={onToday} title="Today (T)">Today</Button>
      )}
      <span className="flex">
        <Button variant="ghost" size="icon-sm" aria-label="Previous" title="Previous (←)" onClick={() => onStep(-1)}><ChevronLeft /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="Next" title="Next (→)" onClick={() => onStep(1)}><ChevronRight /></Button>
      </span>
      <h1 className="min-w-0 truncate text-[18px] font-normal text-ink sm:text-[20px]">{title}</h1>
      {offset && (
        <span className="shrink-0 whitespace-nowrap rounded-full border border-primary/25 bg-primary-tint/60 px-2.5 py-0.5 text-[12px] font-medium text-primary-deep">
          {offset.label}
        </span>
      )}
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
