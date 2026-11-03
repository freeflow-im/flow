// The mail data, through react-query: accounts, folders and the open folder's messages are polled every 60 s while the
// tab is visible, and all re-read when the window regains focus (the contract's polling; push comes later). An inbox tab's
// page that comes back short while the server sorts older mail (`sorting`) is asked for again every 2 s until it is full.
// Flag changes, moves and deletes show at once, in the lists and in the folders' unread counts (lib/counts.ts), and are
// undone if the server refuses them; the counts are read again once, quietly, a few seconds after the last change.
import { useEffect, useRef } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { mailApi, type Category, type MailFolder, type MessageDetail, type MessagePage, type MessageSummary } from '../api';
import { adjustFolders, debounced } from '../lib/counts';

export const POLL_MS = 60_000;
/** How soon a tab's page is asked for again while the server sorts older mail into tabs. */
export const SORTING_RETRY_MS = 2_000;
/** And how many times at most (a few minutes), in case the sorting never gets there. */
export const SORTING_RETRIES = 90;
/** The quiet refresh after a burst of changes. */
export const REFRESH_DELAY_MS = 4_000;
export const PAGE_SIZE = 25;
const MESSAGE_STALE_MS = 5 * 60_000;

export const keys = {
  accounts: ['mail', 'accounts'] as const,
  folders: (accountId: string) => ['mail', 'folders', accountId] as const,
  messages: (accountId: string, folder: string, q: string, category: Category | null = null) => ['mail', 'messages', accountId, folder, q, category ?? ''] as const,
  allMessages: (accountId: string) => ['mail', 'messages', accountId] as const,
  message: (accountId: string, folder: string, uid: number) => ['mail', 'message', accountId, folder, uid] as const,
};

export function useAccounts() {
  return useQuery({ queryKey: keys.accounts, queryFn: mailApi.accounts, refetchInterval: POLL_MS });
}

export function useFolders(accountId: string | null) {
  return useQuery({
    queryKey: keys.folders(accountId ?? ''),
    queryFn: () => mailApi.folders(accountId!),
    enabled: !!accountId,
    refetchInterval: POLL_MS,
  });
}

type Pages = InfiniteData<MessagePage, number>;

/** The next page's `before`: none while the last page is still being sorted (that page is asked for again instead). */
export function nextPageParam(last: MessagePage): number | undefined {
  return last.sorting ? undefined : (last.next ?? undefined);
}

/** The list with its last page replaced by a newer answer for the same `before`; unchanged if the list has moved on since. */
export function replaceLastPage(data: Pages | undefined, param: number, page: MessagePage): Pages | undefined {
  if (!data || !data.pages.length || data.pageParams[data.pageParams.length - 1] !== param) return data;
  return { ...data, pages: [...data.pages.slice(0, -1), page] };
}

/**
 * A folder's messages, or with `category` one inbox tab's. A tab's last page may come back short (even empty) while the
 * server sorts older mail into tabs (`sorting`): it shows at once, and is asked for again every SORTING_RETRY_MS until it
 * is full or the sorting is done; only then does the list go on to older pages.
 */
export function useMessages(accountId: string | null, folder: string | null, q: string, category: Category | null = null) {
  const qc = useQueryClient();
  const queryKey = keys.messages(accountId ?? '', folder ?? '', q, category);
  const fetchPage = (before: number) =>
    mailApi.messages(accountId!, { folder: folder!, limit: PAGE_SIZE, ...(before ? { before } : {}), ...(q ? { q } : {}), ...(category ? { category } : {}) });
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    initialPageParam: 0,
    getNextPageParam: nextPageParam,
    enabled: !!accountId && !!folder,
    refetchInterval: POLL_MS,
  });
  const pages = query.data?.pages;
  const last = pages?.[pages.length - 1];
  const lastParam = query.data?.pageParams[query.data.pageParams.length - 1] as number | undefined;
  const keyText = JSON.stringify(queryKey);
  const retries = useRef({ key: '', n: 0 });
  useEffect(() => {
    if (!last?.sorting || lastParam === undefined || !accountId || !folder) return;
    const which = `${keyText}:${lastParam}`;
    if (retries.current.key !== which) retries.current = { key: which, n: 0 };
    if (retries.current.n >= SORTING_RETRIES) return;
    const timer = setTimeout(() => {
      retries.current.n++;
      fetchPage(lastParam).then(
        (page) => qc.setQueryData<Pages>(queryKey, (old) => replaceLastPage(old, lastParam, page)),
        () => {}, // the next poll asks again
      );
    }, SORTING_RETRY_MS);
    return () => clearTimeout(timer);
    // (queryKey and fetchPage change with keyText.)
  }, [last, lastParam, keyText, accountId, folder, qc]);
  return query;
}

export function useMessage(accountId: string | null, folder: string | null, uid: number | null) {
  return useQuery({
    queryKey: keys.message(accountId ?? '', folder ?? '', uid ?? 0),
    queryFn: () => mailApi.message(accountId!, folder!, uid!),
    enabled: !!accountId && !!folder && uid !== null,
    staleTime: MESSAGE_STALE_MS,
  });
}

/** Reads a message ahead (the next one j would open), so opening it is instant. */
export function prefetchMessage(qc: QueryClient, accountId: string, folder: string, uid: number) {
  return qc.prefetchQuery({ queryKey: keys.message(accountId, folder, uid), queryFn: () => mailApi.message(accountId, folder, uid), staleTime: MESSAGE_STALE_MS });
}

/** One quiet refresh per account, a few seconds after its last change and once no change is still on its way. */
const refreshers = new WeakMap<QueryClient, Map<string, { schedule(): void; lists: boolean }>>();
function scheduleRefresh(qc: QueryClient, accountId: string, lists: boolean) {
  let byAccount = refreshers.get(qc);
  if (!byAccount) refreshers.set(qc, (byAccount = new Map()));
  let r = byAccount.get(accountId);
  if (!r) {
    const entry = {
      lists: false,
      ...debounced(
        () => {
          void qc.invalidateQueries({ queryKey: keys.folders(accountId) });
          if (entry.lists) void qc.invalidateQueries({ queryKey: keys.allMessages(accountId) });
          entry.lists = false;
        },
        REFRESH_DELAY_MS,
        () => qc.isMutating({ mutationKey: ['mail', accountId] }) > 0,
      ),
    };
    byAccount.set(accountId, (r = entry));
  }
  if (lists) r.lists = true;
  r.schedule();
}

/** What the client last saw of a message an action changes: whether it was read. */
interface Seen { uid: number; seen: boolean }

/** Changes to messages in one folder, applied to the cached lists and unread counts at once and rolled back on failure. */
export function useMessageActions(accountId: string | null, folder: string | null) {
  const qc = useQueryClient();
  const mutationKey = ['mail', accountId ?? ''];

  /** What the client last saw of these messages (the lists, else the open message's own copy). */
  const seenOf = (uids: number[]): Seen[] => {
    const want = new Set(uids);
    const out = new Map<number, Seen>();
    for (const [, data] of qc.getQueriesData<Pages>({ queryKey: ['mail', 'messages', accountId ?? '', folder ?? ''] })) {
      for (const m of data?.pages.flatMap((p) => p.messages) ?? []) if (want.has(m.uid) && !out.has(m.uid)) out.set(m.uid, { uid: m.uid, seen: m.seen });
    }
    for (const uid of uids) {
      if (out.has(uid)) continue;
      const d = qc.getQueryData<MessageDetail>(keys.message(accountId ?? '', folder ?? '', uid));
      if (d) out.set(uid, { uid, seen: d.seen });
    }
    return [...out.values()];
  };

  const patchLists = (fn: (m: MessageSummary, key: readonly unknown[]) => MessageSummary | null) => {
    if (!accountId) return [];
    const snapshots = qc.getQueriesData<Pages>({ queryKey: ['mail', 'messages', accountId, folder ?? ''] });
    for (const [key, data] of snapshots) {
      if (!data) continue;
      qc.setQueryData<Pages>(key, {
        ...data,
        pages: data.pages.map((p) => ({ ...p, messages: p.messages.flatMap((m) => fn(m, key) ?? []) })),
      });
    }
    return snapshots;
  };
  /** The sidebar's numbers, moved at once; returns what they were, for a rollback. */
  const patchCounts = (folderDeltas: { path: string; unread?: number; total?: number }[]) => {
    if (!accountId) return [];
    const snapshots: [readonly unknown[], unknown][] = [];
    const folders = qc.getQueryData<MailFolder[]>(keys.folders(accountId));
    if (folders && folderDeltas.length) {
      snapshots.push([keys.folders(accountId), folders]);
      qc.setQueryData(keys.folders(accountId), adjustFolders(folders, folderDeltas));
    }
    return snapshots;
  };
  const restore = (snapshots: [readonly unknown[], unknown][]) => {
    for (const [key, data] of snapshots) qc.setQueryData(key, data);
  };
  const refresh = (lists: boolean) => accountId && scheduleRefresh(qc, accountId, lists);

  const flags = useMutation({
    mutationKey,
    mutationFn: (v: { uids: number[]; seen?: boolean; flagged?: boolean }) => mailApi.setFlags(accountId!, { folder: folder!, ...v }),
    onMutate: (v) => {
      const before = v.seen !== undefined ? seenOf(v.uids) : [];
      const set = new Set(v.uids);
      const snapshots: [readonly unknown[], unknown][] = patchLists((m) => (set.has(m.uid) ? { ...m, ...(v.seen !== undefined ? { seen: v.seen } : {}), ...(v.flagged !== undefined ? { flagged: v.flagged } : {}) } : m));
      // The open message's own copy, so its header's buttons agree with the list.
      for (const uid of v.uids) {
        qc.setQueryData(keys.message(accountId!, folder!, uid), (old: MessageSummary | undefined) =>
          old ? { ...old, ...(v.seen !== undefined ? { seen: v.seen } : {}), ...(v.flagged !== undefined ? { flagged: v.flagged } : {}) } : old,
        );
      }
      // The folder's unread count follows a read/unread change at once.
      if (v.seen !== undefined) {
        const changed = before.filter((m) => m.seen !== v.seen).length;
        snapshots.push(...patchCounts(changed ? [{ path: folder!, unread: v.seen ? -changed : changed }] : []));
      }
      return { snapshots };
    },
    onError: (_e, _v, ctx) => ctx && restore(ctx.snapshots),
    onSettled: (_d, _e, v) => {
      if (v.seen !== undefined) refresh(false);
    },
  });

  /** Messages leaving this folder (for `to`, if known): out of the lists, and out of the counts. */
  const leave = (uids: number[], to: string | null) => {
    const before = seenOf(uids);
    const unread = before.filter((m) => !m.seen).length;
    const set = new Set(uids);
    const snapshots: [readonly unknown[], unknown][] = patchLists((m) => (set.has(m.uid) ? null : m));
    const deltas = [{ path: folder!, unread: -unread, total: -uids.length }, ...(to ? [{ path: to, unread, total: uids.length }] : [])];
    snapshots.push(...patchCounts(deltas));
    return snapshots;
  };
  const trashOf = () => qc.getQueryData<MailFolder[]>(keys.folders(accountId ?? ''))?.find((f) => f.specialUse === 'trash')?.path ?? null;

  const move = useMutation({
    mutationKey,
    mutationFn: (v: { uids: number[]; to: string }) => mailApi.move(accountId!, { folder: folder!, ...v }),
    onMutate: (v) => ({ snapshots: leave(v.uids, v.to) }),
    onError: (_e, _v, ctx) => ctx && restore(ctx.snapshots),
    onSettled: () => refresh(true),
  });

  const remove = useMutation({
    mutationKey,
    mutationFn: (v: { uids: number[] }) => mailApi.remove(accountId!, { folder: folder!, ...v }),
    onMutate: (v) => {
      const trash = trashOf();
      return { snapshots: leave(v.uids, trash && trash !== folder ? trash : null) };
    },
    onError: (_e, _v, ctx) => ctx && restore(ctx.snapshots),
    onSettled: () => refresh(true),
  });

  /** "Move to tab": leaves the open tab's list at once (the sender's other mail follows when the lists are re-read). */
  const moveToTab = useMutation({
    mutationKey,
    mutationFn: (v: { uids: number[]; category: Category }) => mailApi.moveToTab(accountId!, { folder: folder!, uids: v.uids, category: v.category }),
    onMutate: (v) => {
      const set = new Set(v.uids);
      // A tab's list (the key's last part) loses them unless it is the tab they go to; other lists show their new tab.
      return { snapshots: patchLists((m, key) => (!set.has(m.uid) ? m : key[5] && key[5] !== v.category ? null : { ...m, category: v.category })) };
    },
    onError: (_e, _v, ctx) => ctx && restore(ctx.snapshots),
    onSettled: () => refresh(true),
  });

  return { flags, move, remove, moveToTab };
}
