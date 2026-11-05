// FreeFlow Calendar (docs/specs/calendar.md §5): the suite bar, the calendars and the small month on the left, the
// toolbar and the view (FullCalendar, behind CalendarGrid) in the main area; the event popover, quick create, the edit
// dialog, the this / following / all question, the account dialogs, search, and the keyboard. Under 760px: agenda and
// day only, the calendars behind a button.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { addHours, startOfHour } from 'date-fns';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { openSuiteSearch } from '@flow/suite-bar';
import { CalendarApiError, calendarApi, connectGoogle, googleErrorText, type EventOccurrence, type Response, type Scope } from './api';
import { AccountSettingsDialog, AddAccountDialog } from './components/AccountForms';
import { CalendarGrid } from './components/CalendarGrid';
import { CalendarSuiteBar } from './components/CalendarSuiteBar';
import { ConnectCalendar, type ConnectKind } from './components/ConnectCalendar';
import { SignedOut } from './components/SignedOut';
import { EventDialog, draftOf, inputOf, newDraft, type Draft } from './components/EventDialog';
import { EventPopover } from './components/EventPopover';
import { QuickCreate } from './components/QuickCreate';
import { ScopeDialog } from './components/ScopeDialog';
import { SearchResults } from './components/SearchResults';
import { Sidebar } from './components/Sidebar';
import { Toolbar } from './components/Toolbar';
import type { Anchor } from './components/ui/popover';
import { useMediaQuery, useResizableWidth } from './hooks/layout';
import { useCalendarAssistant } from './hooks/assistant';
import { useOrganizations } from './hooks/organization';
import { calendarContext, setAssistantOpen, useAssistantOpen } from './lib/assistant';
import { ResizeHandle } from './components/ResizeHandle';
import { useAccounts, useCalendarPrefs, useCalendars, useEventMutations, useEvents, useSearch } from './hooks/calendar';
import { movePatch } from './lib/occurrences';
import { neighbours, parseDate, rangeOf, step, titleOf, type View } from './lib/ranges';
import { parsePlace, pathOf, type Place } from './lib/route';
import { cn } from './lib/utils';

// The assistant's panel (and the Markdown of its replies) loads when it first opens.
const AssistantPanel = lazy(() => import('./components/AssistantPanel').then((m) => ({ default: m.AssistantPanel })));

const BASE = import.meta.env.BASE_URL;
const WEEK_STARTS_ON = 0 as const;
type Dialog = { kind: 'add'; connect: ConnectKind } | { kind: 'settings'; accountId: string | null; focusPassword?: boolean } | null;
type Ask = { action: 'edit' | 'delete'; allowThis: boolean; run(s: Scope): void; cancel(): void } | null;
const errorText = (e: unknown) => (e instanceof CalendarApiError && e.code === 'conflict' ? 'This event changed elsewhere. Showing the latest.' : e instanceof Error ? e.message : String(e));
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

export function App() {
  const narrow = useMediaQuery('(max-width: 759px)');
  const [place, setPlace] = useState<Place>(() => parsePlace(window.location.pathname, window.location.search, BASE));
  const view: View = narrow && (place.view === 'week' || place.view === 'month') ? 'agenda' : place.view;
  const range = useMemo(() => rangeOf(view, place.date, WEEK_STARTS_ON), [view, place.date]);
  const ahead = useMemo(() => neighbours(view, place.date, WEEK_STARTS_ON), [view, place.date]);
  const accounts = useAccounts();
  const calendars = useCalendars();
  const cals = useMemo(() => calendars.data ?? [], [calendars.data]);
  const events = useEvents(range, ahead, calendars.data);
  const [toast, setToast] = useState<string | null>(null);
  const onError = useCallback((e: unknown) => setToast(errorText(e)), []);
  const m = useEventMutations(onError);
  const prefs = useCalendarPrefs(onError);
  const [open, setOpen] = useState<{ event: EventOccurrence; anchor: Anchor } | null>(null);
  const [quick, setQuick] = useState<{ draft: Draft; anchor: Anchor } | null>(null);
  const [editing, setEditing] = useState<{ draft: Draft; existing?: EventOccurrence } | null>(null);
  const [ask, setAsk] = useState<Ask>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const results = useSearch(search);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const defaultCalendar = cals.find((c) => c.isDefault) ?? cals.find((c) => c.role !== 'reader');
  const byId = useMemo(() => new Map(cals.map((c) => [c.id, c])), [cals]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  // Back from Google's consent (routes/calendar.ts): `?connected=<id>` or `?error=<code>`, said once and taken off the address.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const connected = q.get('connected'), error = q.get('error');
    if (!connected && !error) return;
    setToast(connected ? 'Google Calendar connected. Your events are on their way.' : googleErrorText(error ?? ''));
    q.delete('connected');
    q.delete('error');
    history.replaceState(null, '', `${window.location.pathname}${q.size ? `?${q}` : ''}`);
  }, []);
  const startGoogle = (email?: string) => void connectGoogle(email).catch((e: unknown) => setToast(errorText(e)));

  // The address follows the view; back and forward move it.
  const navigate = useCallback((next: Partial<Place>, replace = false) => {
    setPlace((p) => {
      const to = { ...p, ...next };
      const url = pathOf(to, BASE);
      if (url !== window.location.pathname + window.location.search) (replace ? history.replaceState : history.pushState).call(history, null, '', url);
      return to;
    });
  }, []);
  useEffect(() => {
    const onPop = () => setPlace(parsePlace(window.location.pathname, window.location.search, BASE));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  // An event named in the address (a link from Mail or the assistant): opened, and the view moved to it.
  useEffect(() => {
    if (!place.eventId || open?.event.id === place.eventId || !cals.length) return;
    let gone = false;
    calendarApi.event(place.eventId).then(({ event }) => {
      if (gone) return;
      setOpen({ event, anchor: null });
      navigate({ date: event.allDay ? parseDate(event.start) : new Date(event.start) }, true);
    }, () => { if (!gone) { setToast('That event is not on your calendars.'); navigate({ eventId: null }, true); } });
    return () => { gone = true; };
  }, [place.eventId, cals.length, open?.event.id, navigate]);

  // The assistant: beside the calendar, or over it below 1100px, in the organization the suite bar has selected.
  const qc = useQueryClient();
  const { active: org } = useOrganizations();
  const assistantOpen = useAssistantOpen();
  const assistantOverlay = useMediaQuery('(max-width: 1099px)');
  const assistantPane = useResizableWidth('flow.calendar.assistantWidth', 380, 300, 720, 'left');
  const viewNow = useRef({ view, range, cals, event: open?.event ?? null, search });
  viewNow.current = { view, range, cals, event: open?.event ?? null, search };
  /** An event by id (the assistant's open_calendar_event, Open event, a link in its chat): the view moves to it, its card opens. */
  const openById = useCallback(async (id: string, start?: string) => {
    if (start) navigate({ date: /^\d{4}-\d\d-\d\d$/.test(start) ? parseDate(start) : new Date(start) });
    try {
      const { event } = await calendarApi.event(id);
      navigate({ date: event.allDay ? parseDate(event.start) : new Date(event.start), eventId: event.id }, true);
      setQuick(null);
      setOpen({ event, anchor: null });
      return true;
    } catch {
      return false;
    }
  }, [navigate]);
  const chat = useCalendarAssistant({
    org: org?.id ?? null,
    context: () => { const v = viewNow.current; return calendarContext({ view: v.view, range: v.range, calendars: v.cals, event: v.event, search: v.search || undefined }); },
    handlers: {
      open: openById,
      show: (date, v) => navigate({ date, view: v }),
      remove: async (id, sc) => { await calendarApi.deleteEvent(id, sc); setOpen((x) => (x?.event.id === id ? null : x)); },
      summaryOf: (id) => (viewNow.current.event?.id === id ? viewNow.current.event.summary : (events.data ?? []).find((o) => o.id === id || o.eventId === id)?.summary ?? null),
    },
    onCalendarChanged: () => void qc.invalidateQueries({ queryKey: ['calendar'] }),
  });

  const openEvent = (event: EventOccurrence, anchor: Anchor) => { setQuick(null); setOpen({ event, anchor }); navigate({ eventId: event.id }, true); };
  const closeEvent = () => { setOpen(null); navigate({ eventId: null }, true); };
  const createNew = () => {
    if (!defaultCalendar) return setToast('Connect a calendar you can write to first.');
    const at = place.date.toDateString() === new Date().toDateString() ? startOfHour(addHours(new Date(), 1)) : addHours(place.date, 9);
    setOpen(null);
    setEditing({ draft: newDraft(at, addHours(at, 1), false, defaultCalendar.id) });
  };
  const edit = (o: EventOccurrence) => { closeEvent(); setEditing({ draft: draftOf(o), existing: o }); };
  const remove = (o: EventOccurrence) => {
    closeEvent();
    const run = (s: Scope) => void m.remove(o, s).then(() => setToast('Event deleted.'), () => {});
    if (o.recurring) setAsk({ action: 'delete', allowThis: true, run, cancel: () => {} });
    else run('all');
  };
  const respond = (o: EventOccurrence, r: Exclude<Response, 'needs-action'>) => {
    setOpen((x) => (x ? { ...x, event: { ...x.event, myResponse: r, attendees: x.event.attendees.map((g) => (g.self ? { ...g, response: r } : g)) } } : x));
    void m.respond(o, r).catch(() => {});
  };
  const moved = (o: EventOccurrence, start: Date, end: Date | null, allDay: boolean, revert: () => void) => {
    const run = (s: Scope | undefined) => void m.update(o, movePatch(o, start, end, allDay, s), s ?? 'all').catch(revert);
    if (o.recurring) setAsk({ action: 'edit', allowThis: true, run, cancel: revert });
    else run(undefined);
  };
  const today = () => navigate({ date: new Date() });
  const go = (dir: 1 | -1) => navigate({ date: step(view, place.date, dir) });
  const setView = (v: View) => navigate({ view: v });

  // The keyboard (§5): t today, d w m a views, ← → or k j, c create, / search, Enter or e edit, Backspace delete.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      // Enter on one of the card's buttons or links (it takes the focus) presses that, not Edit.
      const onControl = e.target instanceof HTMLElement && !!e.target.closest('button, a, [role="menuitem"]');
      if (open && ((e.key === 'Enter' && !onControl) || e.key === 'e')) { e.preventDefault(); if (byId.get(open.event.calendarId)?.role !== 'reader') edit(open.event); return; }
      if (open && (e.key === 'Backspace' || e.key === 'Delete')) { e.preventDefault(); if (byId.get(open.event.calendarId)?.role !== 'reader') remove(open.event); return; }
      if (document.querySelector('[role="dialog"], [data-radix-popper-content-wrapper]')) return;
      const k = e.key;
      if (k === 't') today();
      else if (k === 'd') setView('day');
      else if (k === 'w' && !narrow) setView('week');
      else if (k === 'm' && !narrow) setView('month');
      else if (k === 'a') setView('agenda');
      else if (k === 'ArrowLeft' || k === 'k') go(-1);
      else if (k === 'ArrowRight' || k === 'j') go(1);
      else if (k === 'c') createNew();
      else if (k === '/') openSuiteSearch();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const broken = (accounts.data ?? []).filter((a) => a.status !== 'ok');
  const none = accounts.isSuccess && accounts.data.length === 0;
  const signedOut = accounts.isError && accounts.error instanceof CalendarApiError && accounts.error.code === 'unauthorized';
  const sidebar = (
    <Sidebar
      accounts={accounts.data ?? []} calendars={cals} date={place.date} range={range} weekStartsOn={WEEK_STARTS_ON}
      onCreate={() => { setSidebarOpen(false); createNew(); }}
      onPick={(d) => { setSidebarOpen(false); navigate({ date: d }); }}
      onPickRange={(d, n) => { setSidebarOpen(false); navigate({ date: d, view: narrow ? 'agenda' : n <= 7 ? 'week' : 'month' }); }}
      onToggle={(c) => prefs.mutate({ id: c.id, patch: { hidden: !c.hidden } })}
      onColor={(c, color) => prefs.mutate({ id: c.id, patch: { color } })}
      onDefault={(c) => prefs.mutate({ id: c.id, patch: { isDefault: true } })}
      onAccount={(id) => setDialog({ kind: 'settings', accountId: id })}
      onAdd={() => setDialog({ kind: 'add', connect: 'icloud' })}
    />
  );

  return (
    <div className="flex h-full flex-col">
      <CalendarSuiteBar
        search={{ value: searchText, placeholder: 'Search events', onChange: (q) => { setSearchText(q); if (!q.trim()) setSearch(''); }, onSubmit: (q) => setSearch(q.trim()) }}
        onHome={() => { setSearch(''); setSearchText(''); today(); }}
        onSettings={() => setDialog({ kind: 'settings', accountId: null })}
        assistant={{ open: assistantOpen, onToggle: () => setAssistantOpen(!assistantOpen) }}
      />
      {accounts.isPending ? (
        <div className="flex flex-1 items-center justify-center text-muted"><Loader2 className="size-5 animate-spin" /></div>
      ) : signedOut ? (
        <SignedOut />
      ) : none ? (
        <ConnectCalendar onAdd={(k) => (k === 'google' ? startGoogle() : setDialog({ kind: 'add', connect: k }))} />
      ) : (
        <div className="relative flex min-h-0 flex-1">
          {!narrow && <aside className="w-64 shrink-0 border-r border-hairline">{sidebar}</aside>}
          <main className="flex min-w-0 flex-1 flex-col">
            {broken.map((a) => (
              <div key={a.id} role="alert" className="flex shrink-0 items-center gap-3 border-b border-warn-border bg-warn-bg px-4 py-2 text-[14px]">
                <AlertTriangle className="size-4 shrink-0 text-[#b06000]" />
                <span className="min-w-0 flex-1">{a.status === 'auth_failed' ? (a.kind === 'google' ? `${a.email}: Google stopped giving FreeFlow access to this calendar.` : `${a.email}: the calendar server stopped accepting the password.`) : `${a.email}: the calendar server could not be reached.`}</span>
                {a.kind === 'google' && a.status === 'auth_failed' ? (
                  <button type="button" className="shrink-0 font-medium text-primary hover:underline" onClick={() => startGoogle(a.email)}>Reconnect</button>
                ) : (
                  <button type="button" className="shrink-0 font-medium text-primary hover:underline" onClick={() => setDialog({ kind: 'settings', accountId: a.id, focusPassword: a.status === 'auth_failed' })}>{a.status === 'auth_failed' ? 'Re-enter password' : 'Check settings'}</button>
                )}
              </div>
            ))}
            {search ? (
              <SearchResults q={search} results={results.data ?? []} loading={results.isFetching} calendars={cals} onOpen={(o, el) => openEvent(o, { el })} onClose={() => { setSearch(''); setSearchText(''); }} />
            ) : (
              <>
                <Toolbar title={titleOf(view, place.date, WEEK_STARTS_ON)} view={view} narrow={narrow} busy={events.isFetching && !events.data} onToday={today} onStep={go} onView={setView} onCalendars={() => setSidebarOpen(true)} />
                <div className="min-h-0 flex-1">
                  <CalendarGrid
                    view={view} date={place.date} occurrences={events.data ?? []} calendars={cals} weekStartsOn={WEEK_STARTS_ON} selecting={!!quick}
                    onSelect={(start, end, allDay, at) => {
                      if (!defaultCalendar) return setToast('Connect a calendar you can write to first.');
                      setOpen(null);
                      setQuick({ draft: newDraft(start, end, allDay, defaultCalendar.id), anchor: at });
                    }}
                    onOpen={(o, el) => openEvent(o, { el })}
                    onDay={(d) => navigate({ date: d, view: 'day' })}
                    onChange={moved}
                  />
                </div>
              </>
            )}
          </main>
          {assistantOpen && !assistantOverlay && <ResizeHandle label="Resize the assistant" {...assistantPane.handleProps} />}
          {assistantOpen && (
            <Suspense fallback={null}>
              <AssistantPanel chat={chat} onEvent={!!open} overlay={assistantOverlay} width={assistantPane.width} onClose={() => setAssistantOpen(false)} onOpenEvent={(id, start) => void openById(id, start)} />
            </Suspense>
          )}
        </div>
      )}
      {narrow && sidebarOpen && (
        <div className="fixed inset-0 z-40 flex" role="presentation" onClick={() => setSidebarOpen(false)}>
          <div className="h-full w-72 max-w-[85vw] bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>{sidebar}</div>
          <div className="flex-1 bg-black/30" />
        </div>
      )}
      {open && (
        <EventPopover event={open.event} calendar={byId.get(open.event.calendarId)} anchor={open.anchor} onClose={closeEvent}
          onEdit={() => edit(open.event)} onDelete={() => remove(open.event)} onRespond={(r) => respond(open.event, r)} />
      )}
      {quick && (
        <QuickCreate draft={quick.draft} anchor={quick.anchor} calendars={cals} accounts={accounts.data ?? []} onClose={() => setQuick(null)}
          onSave={(d) => m.create(inputOf(d))} onMore={(d) => { setQuick(null); setEditing({ draft: d }); }} />
      )}
      {editing && (
        <EventDialog initial={editing.draft} existing={editing.existing} calendars={cals} accounts={accounts.data ?? []} onClose={() => setEditing(null)}
          onSave={(input, scope) => (editing.existing ? m.update(editing.existing, input, scope ?? 'all') : m.create(input as Parameters<typeof m.create>[0]))}
          onDelete={editing.existing ? () => { const o = editing.existing!; setEditing(null); remove(o); } : undefined} />
      )}
      {ask && <ScopeDialog action={ask.action} allowThis={ask.allowThis} onCancel={() => { ask.cancel(); setAsk(null); }} onChoose={(s) => { setAsk(null); ask.run(s); }} />}
      {dialog?.kind === 'add' && <AddAccountDialog kind={dialog.connect} onClose={() => setDialog(null)} onAdded={() => { setDialog(null); setToast('Connected. Your events are on their way.'); }} />}
      {dialog?.kind === 'settings' && <AccountSettingsDialog accounts={accounts.data ?? []} initialId={dialog.accountId} focusPassword={dialog.focusPassword} onClose={() => setDialog(null)} onAdd={() => setDialog({ kind: 'add', connect: 'icloud' })} />}
      {toast && (
        <div role="status" className={cn('fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-[#323232] px-4 py-3 text-[14px] text-white shadow-lg')}>{toast}</div>
      )}
    </div>
  );
}
