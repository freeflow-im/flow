// The mail data, through react-query: accounts, folders and the open folder's conversations (or, for a search, its
// messages) are polled every 60 s while the tab is visible, and all re-read when the window regains focus (the
// contract's polling; push comes later). An inbox tab's page that comes back short while the server sorts older mail
// (`sorting`) is asked for again every 2 s until it is full; an open thread with a body the server has not fetched yet
// (`bodyPending`) likewise. Flag changes, moves and deletes show at once, in the lists and in the folders' unread counts
// (lib/counts.ts), and are undone if the server refuses them; the counts are read again once, quietly, a few seconds
// after the last change.
import { useEffect, useRef } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { mailApi, type Category, type MailFolder, type MessageDetail, type MessagePage, type MessageSummary, type ThreadDetail, type ThreadMessage, type ThreadPage, type ThreadSummary } from '../api';
import { adjustFolders, debounced } from '../lib/counts';
import { expandedByDefault, soloUid } from '../lib/threads';

export const POLL_MS = 60_000;
/** How soon a tab's page is asked for again while the server sorts older mail into tabs. */
export const SORTING_RETRY_MS = 2_000;
/** And how many times at most (a few minutes), in case the sorting never gets there. */
export const SORTING_RETRIES = 90;
/** How many times an open thread is asked for again while a body of it is still to come. */
export const BODY_RETRIES = 5;
/** The quiet refresh after a burst of changes. */
export const REFRESH_DELAY_MS = 4_000;
export const PAGE_SIZE = 25;
const MESSAGE_STALE_MS = 5 * 60_000;

export const keys = {
  accounts: ['mail', 'accounts'] as const,
  folders: (accountId: string) => ['mail', 'folders', accountId] as const,
  messages: (accountId: string, folder: string, q: string, category: Category | null = null) => ['mail', 'messages', accountId, folder, q, category ?? ''] as const,
  allMessages: (accountId: string) => ['mail', 'messages', accountId] as const,
  threads: (accountId: string, folder: string, category: Category | null = null) => ['mail', 'threads', accountId, folder, category ?? ''] as const,
  allThreads: (accountId: string) => ['mail', 'threads', accountId] as const,
  message: (accountId: string, folder: string, uid: number) => ['mail', 'message', accountId, folder, uid] as const,
  thread: (accountId: string, threadId: string) => ['mail', 'thread', accountId, threadId] as const,
  /** Every open conversation of the account: what a sent message joins. */
  threadDetails: (accountId: string) => ['mail', 'thread', accountId] as const,
};

/** As the server's TAB_HEARTBEAT_MS (packages/edge/src/imap/cache.ts). */
export const HEARTBEAT_MS = 5 * 60_000;

/**
 * Tells the server a Mail tab is open, at once and every HEARTBEAT_MS, also while the tab is hidden (the lists' polls stop
 * then), to the Mail object of the organization shown: the server checks for new mail every 5 minutes while a tab is open, 15 after a day without use.
 */
export function useTabHeartbeat(organizationId: string | null | undefined) {
  useEffect(() => {
    if (!organizationId) return;
    const beat = () => { mailApi.heartbeat().catch(() => {}); };
    beat();
    const timer = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [organizationId]);
}

export function useAccounts() {
  return useQuery({ queryKey: keys.accounts, queryFn: mailApi.accounts, refetchInterval: POLL_MS });
}

/** The inbox tabs' badges, polled with the lists; `after` is what the person has seen in each tab (lib/tabs.ts). */
export function useTabStatus(accountId: string | null, enabled: boolean, after: Partial<Record<Category, number>>) {
  const afterKey = Object.entries(after).map(([t, u]) => `${t}:${u}`).sort().join(',');
  return useQuery({
    queryKey: ['mail', 'tabs', accountId ?? '', afterKey] as const,
    queryFn: () => mailApi.tabStatus(accountId!, after),
    enabled: !!accountId && enabled,
    refetchInterval: POLL_MS,
    placeholderData: (prev) => prev,
  });
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
type ThreadPages = InfiniteData<ThreadPage, number>;

/** The next page's `before`: none while the last page is still being sorted (that page is asked for again instead). */
export function nextPageParam(last: { next: number | null; sorting?: true }): number | undefined {
  return last.sorting ? undefined : (last.next ?? undefined);
}

/** The list with its last page replaced by a newer answer for the same `before`; unchanged if the list has moved on since. */
export function replaceLastPage<P>(data: InfiniteData<P, number> | undefined, param: number, page: P): InfiniteData<P, number> | undefined {
  if (!data || !data.pages.length || data.pageParams[data.pageParams.length - 1] !== param) return data;
  return { ...data, pages: [...data.pages.slice(0, -1), page] };
}

/**
 * Asks for a list's last page again every SORTING_RETRY_MS while it says `sorting` (an inbox tab's page that came back
 * short while the server sorts older mail), until it is full or the sorting is done; only then does the list go on.
 */
function useSortingRetry<P extends { sorting?: true }>(queryKey: readonly unknown[], data: InfiniteData<P, number> | undefined, enabled: boolean, fetchPage: (before: number) => Promise<P>) {
  const qc = useQueryClient();
  const pages = data?.pages;
  const last = pages?.[pages.length - 1];
  const lastParam = data?.pageParams[data.pageParams.length - 1] as number | undefined;
  const keyText = JSON.stringify(queryKey);
  const retries = useRef({ key: '', n: 0 });
  useEffect(() => {
    if (!last?.sorting || lastParam === undefined || !enabled) return;
    const which = `${keyText}:${lastParam}`;
    if (retries.current.key !== which) retries.current = { key: which, n: 0 };
    if (retries.current.n >= SORTING_RETRIES) return;
    const timer = setTimeout(() => {
      retries.current.n++;
      fetchPage(lastParam).then(
        (page) => qc.setQueryData<InfiniteData<P, number>>(queryKey, (old) => replaceLastPage(old, lastParam, page)),
        () => {}, // the next poll asks again
      );
    }, SORTING_RETRY_MS);
    return () => clearTimeout(timer);
    // (queryKey and fetchPage change with keyText.)
  }, [last, lastParam, keyText, enabled, qc]);
}

/** A folder's messages, flat: a search of it (`q`), as the server answers one. */
export function useMessages(accountId: string | null, folder: string | null, q: string, category: Category | null = null, enabled = true) {
  const queryKey = keys.messages(accountId ?? '', folder ?? '', q, category);
  const fetchPage = (before: number) =>
    mailApi.messages(accountId!, { folder: folder!, limit: PAGE_SIZE, ...(before ? { before } : {}), ...(q ? { q } : {}), ...(category ? { category } : {}) });
  const on = enabled && !!accountId && !!folder;
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    initialPageParam: 0,
    getNextPageParam: nextPageParam,
    enabled: on,
    refetchInterval: POLL_MS,
  });
  useSortingRetry(queryKey, query.data as InfiniteData<MessagePage, number> | undefined, on, fetchPage);
  return query;
}

/** A folder's conversations, or with `category` one inbox tab's, newest first; paged with `before` = the last row's `uid`. */
export function useThreads(accountId: string | null, folder: string | null, category: Category | null = null, enabled = true) {
  const queryKey = keys.threads(accountId ?? '', folder ?? '', category);
  const fetchPage = (before: number) => mailApi.threads(accountId!, { folder: folder!, limit: PAGE_SIZE, ...(before ? { before } : {}), ...(category ? { category } : {}) });
  const on = enabled && !!accountId && !!folder;
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    initialPageParam: 0,
    getNextPageParam: nextPageParam,
    enabled: on,
    refetchInterval: POLL_MS,
  });
  useSortingRetry(queryKey, query.data as InfiniteData<ThreadPage, number> | undefined, on, fetchPage);
  return query;
}

/** A conversation, as the server tells it; a thread id of `soloThreadId` is that one message of `folder`, read as a thread of one. */
function fetchThread(accountId: string, threadId: string, folder: string): Promise<ThreadDetail> {
  const uid = soloUid(threadId);
  if (uid !== null) return mailApi.message(accountId, folder, uid).then((m) => ({ threadId, messages: [m] }));
  return mailApi.thread(accountId, threadId, folder);
}

const bodiesPending = (t: ThreadDetail | undefined) => !!t?.messages.some((m) => m.bodyPending);

/** The reads of pending bodies on their way (`<account>:<thread>:<folder>:<uid>`), so one message is read once at a time. */
const bodyReads = new Map<string, Promise<void>>();

/**
 * Reads one message of an open thread whose body the server has not fetched yet (a live read, which the server keeps),
 * and puts its body and attachments into the cached thread. A read that fails marks the message `bodyFailed` (the pane
 * offers Retry); the next read clears it.
 */
export function fetchBody(qc: QueryClient, accountId: string, threadId: string, m: { folder: string; uid: number }): Promise<void> {
  const key = `${accountId}:${threadId}:${m.folder}:${m.uid}`;
  const going = bodyReads.get(key);
  if (going) return going;
  const patch = (fn: (old: ThreadMessage) => ThreadMessage) => {
    qc.setQueryData<ThreadDetail>(keys.thread(accountId, threadId), (old) => (old ? { ...old, messages: old.messages.map((x) => (x.folder === m.folder && x.uid === m.uid ? fn(x) : x)) } : old));
  };
  const read = mailApi.message(accountId, m.folder, m.uid).then(
    (detail) => patch((old) => {
      const { bodyPending: _pending, bodyFailed: _failed, ...rest } = old;
      return { ...rest, ...detail, ...(old.threadId ? { threadId: old.threadId } : {}) };
    }),
    () => patch((old) => ({ ...old, bodyFailed: true as const })),
  ).finally(() => bodyReads.delete(key));
  bodyReads.set(key, read);
  return read;
}

/**
 * The open conversation. While the server has not fetched a body of it yet (`bodyPending`), it is asked for again
 * every SORTING_RETRY_MS, BODY_RETRIES times at most (the next poll of the lists does not touch it); the messages that
 * show open (the unread ones and the last) do not wait for that: each is read at once (`fetchBody`).
 */
export function useThread(accountId: string | null, threadId: string | null, folder: string | null) {
  const qc = useQueryClient();
  const queryKey = keys.thread(accountId ?? '', threadId ?? '');
  const query = useQuery({
    queryKey,
    // A body read here (`fetchBody`) outlives the server's answers that still say the body is pending.
    queryFn: async () => {
      const fresh = await fetchThread(accountId!, threadId!, folder!);
      const old = qc.getQueryData<ThreadDetail>(queryKey);
      if (!old) return fresh;
      const have = new Map(old.messages.filter((x) => !x.bodyPending && (x.html !== null || x.text !== null)).map((x) => [`${x.folder}/${x.uid}`, x]));
      return { ...fresh, messages: fresh.messages.map((x) => (x.bodyPending && have.has(`${x.folder}/${x.uid}`) ? { ...have.get(`${x.folder}/${x.uid}`)!, seen: x.seen, flagged: x.flagged, answered: x.answered } : x)) };
    },
    enabled: !!accountId && !!threadId && !!folder,
    staleTime: (q) => (bodiesPending(q.state.data) ? 0 : MESSAGE_STALE_MS),
    refetchInterval: (q) => (bodiesPending(q.state.data) && q.state.dataUpdateCount <= BODY_RETRIES ? SORTING_RETRY_MS : false),
  });
  const data = query.data;
  useEffect(() => {
    if (!data || !accountId || !threadId || data.threadId !== threadId) return;
    const shown = expandedByDefault(data.messages);
    data.messages.forEach((m, i) => {
      if (shown.has(i) && m.bodyPending && !m.bodyFailed) void fetchBody(qc, accountId, threadId, m);
    });
  }, [data, accountId, threadId, qc]);
  return query;
}

/** Reads a conversation ahead (the next one j would open), so opening it is instant. */
export function prefetchThread(qc: QueryClient, accountId: string, threadId: string, folder: string) {
  return qc.prefetchQuery({ queryKey: keys.thread(accountId, threadId), queryFn: () => fetchThread(accountId, threadId, folder), staleTime: MESSAGE_STALE_MS });
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
          if (entry.lists) {
            void qc.invalidateQueries({ queryKey: keys.allMessages(accountId) });
            void qc.invalidateQueries({ queryKey: keys.allThreads(accountId) });
          }
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

/** Changes to messages in one folder, applied to the cached lists, threads and unread counts at once and rolled back on failure. */
export function useMessageActions(accountId: string | null, folder: string | null) {
  const qc = useQueryClient();
  const mutationKey = ['mail', accountId ?? ''];
  const threadLists = () => qc.getQueriesData<ThreadPages>({ queryKey: ['mail', 'threads', accountId ?? '', folder ?? ''] });
  const threadDetails = () => qc.getQueriesData<ThreadDetail>({ queryKey: ['mail', 'thread', accountId ?? ''] });

  /** What the client last saw of these messages (the lists, the open threads, else the open message's own copy). */
  const seenOf = (uids: number[]): Seen[] => {
    const want = new Set(uids);
    const out = new Map<number, Seen>();
    for (const [, data] of qc.getQueriesData<Pages>({ queryKey: ['mail', 'messages', accountId ?? '', folder ?? ''] })) {
      for (const m of data?.pages.flatMap((p) => p.messages) ?? []) if (want.has(m.uid) && !out.has(m.uid)) out.set(m.uid, { uid: m.uid, seen: m.seen });
    }
    for (const [, t] of threadDetails()) {
      for (const m of t?.messages ?? []) if (m.folder === folder && want.has(m.uid) && !out.has(m.uid)) out.set(m.uid, { uid: m.uid, seen: m.seen });
    }
    for (const [, data] of threadLists()) {
      for (const t of data?.pages.flatMap((p) => p.threads) ?? []) {
        if (!t.uids.some((u) => want.has(u))) continue;
        // A thread row knows its newest message, and how many of the rest are unread: when the whole thread is acted on,
        // that many of them count as unread (which ones does not matter to the counts).
        if (want.has(t.latest.uid) && !out.has(t.latest.uid)) out.set(t.latest.uid, { uid: t.latest.uid, seen: t.latest.seen });
        if (!t.uids.every((u) => want.has(u))) continue;
        let unseen = t.unread - (t.latest.seen ? 0 : 1);
        for (const u of t.uids) {
          if (u === t.latest.uid || out.has(u)) continue;
          out.set(u, { uid: u, seen: unseen <= 0 });
          unseen--;
        }
      }
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
  /** The thread rows of this folder's lists, each given to `fn` (null drops it). */
  const patchThreads = (fn: (t: ThreadSummary, key: readonly unknown[]) => ThreadSummary | null) => {
    if (!accountId) return [];
    const snapshots: [readonly unknown[], unknown][] = threadLists();
    for (const [key, data] of snapshots as [readonly unknown[], ThreadPages | undefined][]) {
      if (!data) continue;
      qc.setQueryData<ThreadPages>(key, { ...data, pages: data.pages.map((p) => ({ ...p, threads: p.threads.flatMap((t) => fn(t, key) ?? []) })) });
    }
    return snapshots;
  };
  /** The open threads' messages of this folder, each given to `fn` (null drops it). */
  const patchThreadDetails = (fn: (m: MessageDetail) => MessageDetail | null) => {
    const snapshots: [readonly unknown[], unknown][] = threadDetails();
    for (const [key, t] of snapshots as [readonly unknown[], ThreadDetail | undefined][]) {
      if (!t) continue;
      qc.setQueryData<ThreadDetail>(key, { ...t, messages: t.messages.flatMap((m) => (m.folder === folder ? (fn(m) ?? []) : m)) });
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
      const apply = <M extends { seen: boolean; flagged: boolean }>(m: M): M => ({ ...m, ...(v.seen !== undefined ? { seen: v.seen } : {}), ...(v.flagged !== undefined ? { flagged: v.flagged } : {}) });
      const snapshots: [readonly unknown[], unknown][] = patchLists((m) => (set.has(m.uid) ? apply(m) : m));
      // A thread row: its newest message's flags, its unread count by what was known of its messages, and its star.
      const unreadBefore = new Map(before.map((m) => [m.uid, m.seen]));
      snapshots.push(
        ...patchThreads((t) => {
          const hit = t.uids.filter((u) => set.has(u));
          if (!hit.length) return t;
          let unread = t.unread;
          if (v.seen !== undefined) {
            const known = hit.filter((u) => unreadBefore.has(u));
            const wereUnread = known.filter((u) => unreadBefore.get(u) === false).length;
            // Exact when every message acted on was known; else the most the change could mean (the lists are re-read soon).
            if (known.length === hit.length) unread = v.seen ? Math.max(0, unread - wereUnread) : unread + (known.length - wereUnread);
            else unread = v.seen ? Math.max(0, unread - hit.length) : Math.max(unread, hit.length);
          }
          const flagged = v.flagged === undefined ? t.flagged : v.flagged ? true : hit.length >= t.uids.length ? false : t.flagged;
          return { ...t, unread, flagged, latest: set.has(t.latest.uid) ? apply(t.latest) : t.latest };
        }),
        ...patchThreadDetails((m) => (set.has(m.uid) ? apply(m) : m)),
      );
      // The open message's own copy, so its header's buttons agree with the list.
      for (const uid of v.uids) {
        qc.setQueryData(keys.message(accountId!, folder!, uid), (old: MessageSummary | undefined) => (old ? apply(old) : old));
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

  /**
   * A conversation read: its unread messages marked read in whatever folders they are in. A thread's row counts its unread
   * messages account-wide (an archived reply, a copy under another label), so marking only this folder's copies left the
   * row unread for good. Applied to the open thread, this folder's rows and lists, and each folder's count at once.
   */
  const threadSeen = useMutation({
    mutationKey,
    mutationFn: async (v: { threadId: string; messages: { folder: string; uid: number }[] }) => {
      const byFolder = new Map<string, number[]>();
      for (const m of v.messages) byFolder.set(m.folder, [...(byFolder.get(m.folder) ?? []), m.uid]);
      await Promise.all([...byFolder].map(([f, uids]) => mailApi.setFlags(accountId!, { folder: f, uids, seen: true })));
    },
    onMutate: (v) => {
      const marked = new Set(v.messages.map((m) => `${m.folder}\u0000${m.uid}`));
      const isMarked = (m: { folder: string; uid: number }) => marked.has(`${m.folder}\u0000${m.uid}`);
      const snapshots: [readonly unknown[], unknown][] = threadDetails();
      // What the open thread knew was unread, per folder: what the counts move by.
      const unreadIn = new Map<string, number>();
      for (const [key, t] of snapshots as [readonly unknown[], ThreadDetail | undefined][]) {
        if (!t) continue;
        if (t.threadId === v.threadId) for (const m of t.messages) if (isMarked(m) && !m.seen) unreadIn.set(m.folder, (unreadIn.get(m.folder) ?? 0) + 1);
        qc.setQueryData<ThreadDetail>(key, { ...t, messages: t.messages.map((m) => (isMarked(m) && !m.seen ? { ...m, seen: true } : m)) });
      }
      const here = new Set(v.messages.filter((m) => m.folder === folder).map((m) => m.uid));
      snapshots.push(
        ...patchLists((m) => (here.has(m.uid) && !m.seen ? { ...m, seen: true } : m)),
        ...patchThreads((t) => (t.threadId === v.threadId ? { ...t, unread: 0, latest: here.has(t.latest.uid) ? { ...t.latest, seen: true } : t.latest } : t)),
        ...patchCounts([...unreadIn].map(([path, n]) => ({ path, unread: -n }))),
      );
      for (const m of v.messages) qc.setQueryData(keys.message(accountId!, m.folder, m.uid), (old: MessageSummary | undefined) => (old ? { ...old, seen: true } : old));
      return { snapshots };
    },
    onError: (_e, _v, ctx) => ctx && restore(ctx.snapshots),
    onSettled: () => refresh(true),
  });

  /** Messages leaving this folder (for `to`, if known): out of the lists and the threads, and out of the counts. */
  const leave = (uids: number[], to: string | null) => {
    const before = seenOf(uids);
    const unread = before.filter((m) => !m.seen).length;
    const set = new Set(uids);
    const snapshots: [readonly unknown[], unknown][] = patchLists((m) => (set.has(m.uid) ? null : m));
    // A thread row stays while it has a message left in the folder (its newest one stands for it until the lists are re-read).
    snapshots.push(
      ...patchThreads((t) => {
        const left = t.uids.filter((u) => !set.has(u));
        if (left.length === t.uids.length) return t;
        if (!left.length) return null;
        // (The thread's count stays: a message moved or trashed is still in the account.)
        return { ...t, uids: left, uid: left[0]!, unread: Math.min(t.unread, Math.max(0, t.unread - before.filter((m) => !m.seen && t.uids.includes(m.uid)).length)) };
      }),
      ...patchThreadDetails((m) => (set.has(m.uid) ? null : m)),
    );
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
      const snapshots: [readonly unknown[], unknown][] = patchLists((m, key) => (!set.has(m.uid) ? m : key[5] && key[5] !== v.category ? null : { ...m, category: v.category }));
      snapshots.push(...patchThreads((t, key) => (!t.uids.some((u) => set.has(u)) ? t : key[4] && key[4] !== v.category ? null : { ...t, category: v.category })));
      return { snapshots };
    },
    onError: (_e, _v, ctx) => ctx && restore(ctx.snapshots),
    onSettled: () => refresh(true),
  });

  return { flags, threadSeen, move, remove, moveToTab };
}
