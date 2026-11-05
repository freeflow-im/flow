// The left column: Create, the small month, and the calendars grouped by account, each a checkbox in its colour with a
// menu (colour, default for new events, the account's settings); Add account at the bottom. On a phone it opens over the
// page from the toolbar's Calendars button.
import { Check, MoreVertical, Plus, Star } from 'lucide-react';
import type { CalendarAccount, CalendarInfo } from '../api';
import type { Range } from '../lib/ranges';
import { cn } from '../lib/utils';
import { MiniMonth } from './MiniMonth';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';

export const COLORS = ['#d50000', '#e67c73', '#f4511e', '#f6bf26', '#33b679', '#0b8043', '#039be5', '#3f51b5', '#7986cb', '#8e24aa', '#616161', '#795548'];

export interface SidebarProps {
  accounts: CalendarAccount[];
  calendars: CalendarInfo[];
  date: Date;
  range: Range;
  weekStartsOn: 0 | 1;
  onCreate(): void;
  onPick(d: Date): void;
  onPickRange(start: Date, days: number): void;
  onToggle(c: CalendarInfo): void;
  onColor(c: CalendarInfo, color: string | null): void;
  onDefault(c: CalendarInfo): void;
  onAccount(accountId: string): void;
  onAdd(): void;
}

export function Sidebar(p: SidebarProps) {
  return (
    <nav aria-label="Calendars" className="flex h-full w-full flex-col overflow-y-auto bg-white pb-4">
      <div className="p-3">
        <Button onClick={p.onCreate} className="h-12 rounded-2xl bg-white px-5 text-ink shadow-md ring-1 ring-hairline hover:bg-hover">
          <Plus className="size-5 text-primary" /> Create
        </Button>
      </div>
      <MiniMonth date={p.date} range={p.range} weekStartsOn={p.weekStartsOn} onPick={p.onPick} onPickRange={p.onPickRange} />
      {p.accounts.map((a) => {
        const cals = p.calendars.filter((c) => c.accountId === a.id);
        return (
          <section key={a.id} className="mt-3 px-2">
            <h2 className="flex items-center justify-between px-2 py-1 text-[12px] font-medium uppercase tracking-[.06em] text-muted">
              <button type="button" className="min-w-0 truncate text-left hover:text-ink" title={a.email} onClick={() => p.onAccount(a.id)}>{a.displayName || a.email}</button>
              {a.status !== 'ok' && <span className="ml-2 shrink-0 rounded bg-warn-bg px-1.5 text-[11px] normal-case tracking-normal text-ink">{a.status === 'auth_failed' ? 'Password needed' : 'Not reachable'}</span>}
            </h2>
            <ul>
              {cals.map((c) => (
                <li key={c.id} className="group flex items-center rounded-lg pr-1 hover:bg-hover">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 px-2 py-1.5 text-[14px]">
                    <input type="checkbox" className="peer sr-only" checked={!c.hidden} onChange={() => p.onToggle(c)} />
                    <span aria-hidden className={cn('flex size-[18px] shrink-0 items-center justify-center rounded-[4px] border-2 peer-focus-visible:ring-2 peer-focus-visible:ring-primary/40')} style={{ borderColor: c.color, background: c.hidden ? 'transparent' : c.color }}>
                      {!c.hidden && <Check className="size-3.5 text-white" strokeWidth={3} />}
                    </span>
                    <span className="min-w-0 truncate">{c.name}</span>
                    {c.isDefault && <Star className="size-3 shrink-0 fill-current text-faint" aria-label="Default calendar" />}
                    {!c.syncedAt && <span className="shrink-0 text-[12px] text-faint">Syncing…</span>}
                  </label>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button type="button" aria-label={`Options for ${c.name}`} className="rounded p-1 text-muted opacity-0 hover:bg-white group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100">
                        <MoreVertical className="size-4" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-56">
                      <div className="grid grid-cols-6 gap-1.5 p-2">
                        {COLORS.map((color) => (
                          <button key={color} type="button" aria-label={`Colour ${color}`} className="flex size-6 items-center justify-center rounded-full" style={{ background: color }} onClick={() => p.onColor(c, color)}>
                            {c.color === color && <Check className="size-3.5 text-white" />}
                          </button>
                        ))}
                      </div>
                      <DropdownMenuItem onSelect={() => p.onColor(c, null)}>The server's colour</DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem disabled={c.role === 'reader' || c.isDefault} onSelect={() => p.onDefault(c)}>{c.role === 'reader' ? 'Read-only calendar' : c.isDefault ? 'New events go here' : 'Put new events here'}</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => p.onAccount(a.id)}>Account settings…</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              ))}
              {!cals.length && <li className="px-2 py-1 text-[14px] text-faint">No calendars</li>}
            </ul>
          </section>
        );
      })}
      <div className="mt-3 px-3">
        <Button variant="ghost" size="sm" onClick={p.onAdd} className="text-muted"><Plus /> Add account</Button>
      </div>
    </nav>
  );
}
