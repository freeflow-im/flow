// Calendar's data on react-query (docs/specs/calendar.md §5, Data): the accounts and calendars, the occurrences of the
// visible range (refetched every 60 s while the page is visible and on focus, the neighbouring ranges read ahead), and
// the changes, each made in every cached range at once and rolled back if the server says no. A `conflict` (the event
// changed elsewhere) refetches and says so.
import { useEffect, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { calendarApi, type CalendarAccount, type CalendarInfo, type EventInput, type EventOccurrence, type EventPatch, type NewAccount, type Response, type Scope } from '../api';
import { applyDelete, applyPatch } from '../lib/occurrences';
import { overlaps, rangeKey, type Range } from '../lib/ranges';

const REFRESH_MS = 60_000;
/** While a calendar has not had its first sync (just connected), the lists are read again this often. */
const SYNCING_MS = 2_000;

export const keys = {
  accounts: ['calendar', 'accounts'] as const,
  calendars: ['calendar', 'calendars'] as const,
  events: ['calendar', 'events'] as const,
  range: (r: Range) => ['calendar', 'events', rangeKey(r).from, rangeKey(r).to] as const,
  search: (q: string) => ['calendar', 'search', q] as const,
};

export function useAccounts() {
  return useQuery({ queryKey: keys.accounts, queryFn: calendarApi.accounts, refetchInterval: REFRESH_MS });
}

export function useCalendars() {
  const q = useQuery({
    queryKey: keys.calendars,
    queryFn: calendarApi.calendars,
    refetchInterval: (query) => (query.state.data?.some((c) => !c.syncedAt) ? SYNCING_MS : REFRESH_MS),
  });
  return q;
}

/** Every calendar's occurrences in a range: hidden ones too, so a checkbox shows or hides them with no round trip. */
function fetchRange(r: Range, calendars: CalendarInfo[]) {
  const { from, to } = rangeKey(r);
  return calendarApi.events(from, to, calendars.map((c) => c.id));
}

export function useEvents(range: Range, ahead: Range[], calendars: CalendarInfo[] | undefined) {
  const qc = useQueryClient();
  const syncing = !!calendars?.some((c) => !c.syncedAt);
  const ids = calendars?.map((c) => c.id).join(',') ?? '';
  const q = useQuery({
    queryKey: [...keys.range(range), ids],
    queryFn: () => fetchRange(range, calendars ?? []),
    enabled: !!calendars?.length,
    refetchInterval: syncing ? SYNCING_MS : REFRESH_MS,
    placeholderData: (prev) => prev,
  });
  const aheadKey = ahead.map((r) => rangeKey(r).from).join();
  useEffect(() => {
    if (!calendars?.length) return;
    for (const r of ahead) void qc.prefetchQuery({ queryKey: [...keys.range(r), ids], queryFn: () => fetchRange(r, calendars), staleTime: 30_000 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aheadKey, ids, qc]);
  return q;
}

export function useSearch(q: string) {
  return useQuery({ queryKey: keys.search(q), queryFn: () => calendarApi.search(q), enabled: q.trim().length > 0 });
}

type Snapshot = [readonly unknown[], EventOccurrence[] | undefined][];
/** Every cached range, changed by `fn` at once; the snapshot puts them back. */
function changeRanges(qc: QueryClient, fn: (list: EventOccurrence[], key: readonly unknown[]) => EventOccurrence[]): Snapshot {
  const snap = qc.getQueriesData<EventOccurrence[]>({ queryKey: keys.events });
  for (const [key, list] of snap) if (list) qc.setQueryData<EventOccurrence[]>(key, fn(list, key));
  return snap;
}
const restore = (qc: QueryClient, snap: Snapshot | undefined) => { for (const [key, list] of snap ?? []) qc.setQueryData(key, list); };
const rangeOfKey = (key: readonly unknown[]): Range => ({ start: new Date(String(key[2])), end: new Date(String(key[3])) });

export interface Mutations {
  create(input: EventInput): Promise<EventOccurrence>;
  update(target: EventOccurrence, patch: EventPatch, scope: Scope): Promise<EventOccurrence>;
  remove(target: EventOccurrence, scope: Scope): Promise<void>;
  respond(target: EventOccurrence, response: Exclude<Response, 'needs-action'>): Promise<EventOccurrence>;
}

/** The event changes, optimistic; `onError` hears what went wrong (a conflict first refetches). */
export function useEventMutations(onError: (e: unknown) => void): Mutations & { pending: boolean } {
  const qc = useQueryClient();
  const settle = () => { void qc.invalidateQueries({ queryKey: keys.events }); void qc.invalidateQueries({ queryKey: ['calendar', 'search'] }); };
  const create = useMutation({
    mutationFn: (input: EventInput) => calendarApi.createEvent(input),
    onSuccess: (event) => {
      // Shown in the ranges it falls in until the refetch brings its other occurrences.
      changeRanges(qc, (list, key) => (overlaps(rangeOfKey(key), event.start, event.end, event.allDay) ? [...list.filter((o) => o.id !== event.id), event] : list));
    },
    onError,
    onSettled: settle,
  });
  const update = useMutation({
    mutationFn: ({ target, patch }: { target: EventOccurrence; patch: EventPatch; scope: Scope }) => calendarApi.updateEvent(target.id, patch),
    onMutate: async ({ target, patch, scope }) => {
      await qc.cancelQueries({ queryKey: keys.events });
      return { snap: changeRanges(qc, (list) => applyPatch(list, target, patch, scope)) };
    },
    onError: (e, _v, ctx) => { restore(qc, ctx?.snap); onError(e); },
    onSettled: settle,
  });
  const remove = useMutation({
    mutationFn: ({ target, scope }: { target: EventOccurrence; scope: Scope }) => calendarApi.deleteEvent(target.id, target.recurring ? scope : undefined).then(() => undefined),
    onMutate: async ({ target, scope }) => {
      await qc.cancelQueries({ queryKey: keys.events });
      return { snap: changeRanges(qc, (list) => applyDelete(list, target, target.recurring ? scope : 'all')) };
    },
    onError: (e, _v, ctx) => { restore(qc, ctx?.snap); onError(e); },
    onSettled: settle,
  });
  const respond = useMutation({
    mutationFn: ({ target, response }: { target: EventOccurrence; response: Exclude<Response, 'needs-action'> }) => calendarApi.respond(target.recurring ? target.eventId : target.id, response),
    onMutate: async ({ target, response }) => {
      await qc.cancelQueries({ queryKey: keys.events });
      const mark = (o: EventOccurrence): EventOccurrence => ({ ...o, myResponse: response, attendees: o.attendees.map((a) => (a.self ? { ...a, response } : a)) });
      return { snap: changeRanges(qc, (list) => list.map((o) => (o.eventId === target.eventId ? mark(o) : o))) };
    },
    onError: (e, _v, ctx) => { restore(qc, ctx?.snap); onError(e); },
    onSettled: settle,
  });
  return useMemo(() => ({
    create: (input) => create.mutateAsync(input),
    update: (target, patch, scope) => update.mutateAsync({ target, patch, scope }),
    remove: (target, scope) => remove.mutateAsync({ target, scope }),
    respond: (target, response) => respond.mutateAsync({ target, response }),
    pending: create.isPending || update.isPending || remove.isPending,
  }), [create, update, remove, respond]);
}

/** A calendar's local preferences (shown, colour, default), at once. */
export function useCalendarPrefs(onError: (e: unknown) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { hidden?: boolean; color?: string | null; isDefault?: true } }) => calendarApi.updateCalendar(id, patch),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: keys.calendars });
      const prev = qc.getQueryData<CalendarInfo[]>(keys.calendars);
      qc.setQueryData<CalendarInfo[]>(keys.calendars, (list) => list?.map((c) => {
        const next = c.id === id ? { ...c, ...(patch.hidden !== undefined ? { hidden: patch.hidden } : {}), ...(patch.color ? { color: patch.color } : {}) } : c;
        return patch.isDefault ? { ...next, isDefault: c.id === id } : next;
      }));
      return { prev };
    },
    onError: (e, _v, ctx) => { qc.setQueryData(keys.calendars, ctx?.prev); onError(e); },
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.calendars }),
  });
}

export function useAddAccount(onAdded: (a: CalendarAccount) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewAccount) => calendarApi.addAccount(body),
    onSuccess: ({ account, calendars }) => {
      qc.setQueryData<CalendarAccount[]>(keys.accounts, (old) => [...(old ?? []).filter((a) => a.id !== account.id), account]);
      qc.setQueryData<CalendarInfo[]>(keys.calendars, (old) => [...(old ?? []).filter((c) => c.accountId !== account.id), ...calendars]);
      void qc.invalidateQueries({ queryKey: ['calendar'] });
      onAdded(account);
    },
  });
}
