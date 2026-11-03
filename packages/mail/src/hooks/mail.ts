// The mail data, through react-query: accounts, folders and the open folder's messages are polled every 60 s while the
// tab is visible and re-read when the window regains focus (the contract's polling; push comes later). Flag changes,
// moves and deletes show at once and are undone if the server refuses them.
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { mailApi, type MessagePage, type MessageSummary } from '../api';

export const POLL_MS = 60_000;
export const PAGE_SIZE = 25;

export const keys = {
  accounts: ['mail', 'accounts'] as const,
  folders: (accountId: string) => ['mail', 'folders', accountId] as const,
  messages: (accountId: string, folder: string, q: string) => ['mail', 'messages', accountId, folder, q] as const,
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

export function useMessages(accountId: string | null, folder: string | null, q: string) {
  return useInfiniteQuery({
    queryKey: keys.messages(accountId ?? '', folder ?? '', q),
    queryFn: ({ pageParam }) => mailApi.messages(accountId!, { folder: folder!, limit: PAGE_SIZE, ...(pageParam ? { before: pageParam } : {}), ...(q ? { q } : {}) }),
    initialPageParam: 0,
    getNextPageParam: (last: MessagePage) => last.next ?? undefined,
    enabled: !!accountId && !!folder,
    refetchInterval: POLL_MS,
  });
}

export function useMessage(accountId: string | null, folder: string | null, uid: number | null) {
  return useQuery({
    queryKey: keys.message(accountId ?? '', folder ?? '', uid ?? 0),
    queryFn: () => mailApi.message(accountId!, folder!, uid!),
    enabled: !!accountId && !!folder && uid !== null,
    staleTime: 5 * 60_000,
  });
}

type Pages = InfiniteData<MessagePage, number>;

/** Changes to messages in one folder, applied to the cached lists at once and rolled back on failure. */
export function useMessageActions(accountId: string | null, folder: string | null) {
  const qc = useQueryClient();

  const patchLists = (fn: (m: MessageSummary) => MessageSummary | null) => {
    if (!accountId) return [];
    const snapshots = qc.getQueriesData<Pages>({ queryKey: ['mail', 'messages', accountId, folder ?? ''] });
    for (const [key, data] of snapshots) {
      if (!data) continue;
      qc.setQueryData<Pages>(key, {
        ...data,
        pages: data.pages.map((p) => ({ ...p, messages: p.messages.flatMap((m) => fn(m) ?? []) })),
      });
    }
    return snapshots;
  };
  const restore = (snapshots: ReturnType<typeof patchLists>) => {
    for (const [key, data] of snapshots) qc.setQueryData(key, data);
  };
  const settle = () => {
    if (!accountId) return;
    void qc.invalidateQueries({ queryKey: keys.folders(accountId) });
    void qc.invalidateQueries({ queryKey: keys.allMessages(accountId) });
  };

  const flags = useMutation({
    mutationFn: (v: { uids: number[]; seen?: boolean; flagged?: boolean }) => mailApi.setFlags(accountId!, { folder: folder!, ...v }),
    onMutate: (v) => {
      const set = new Set(v.uids);
      const snapshots = patchLists((m) => (set.has(m.uid) ? { ...m, ...(v.seen !== undefined ? { seen: v.seen } : {}), ...(v.flagged !== undefined ? { flagged: v.flagged } : {}) } : m));
      // The open message's own copy, so its header's buttons agree with the list.
      for (const uid of v.uids) {
        qc.setQueryData(keys.message(accountId!, folder!, uid), (old: MessageSummary | undefined) =>
          old ? { ...old, ...(v.seen !== undefined ? { seen: v.seen } : {}), ...(v.flagged !== undefined ? { flagged: v.flagged } : {}) } : old,
        );
      }
      // The folder's unread count follows a read/unread change at once.
      return { snapshots };
    },
    onError: (_e, _v, ctx) => ctx && restore(ctx.snapshots),
    onSettled: () => accountId && void qc.invalidateQueries({ queryKey: keys.folders(accountId) }),
  });

  const removeFromList = (uids: number[]) => {
    const set = new Set(uids);
    return patchLists((m) => (set.has(m.uid) ? null : m));
  };

  const move = useMutation({
    mutationFn: (v: { uids: number[]; to: string }) => mailApi.move(accountId!, { folder: folder!, ...v }),
    onMutate: (v) => ({ snapshots: removeFromList(v.uids) }),
    onError: (_e, _v, ctx) => ctx && restore(ctx.snapshots),
    onSettled: settle,
  });

  const remove = useMutation({
    mutationFn: (v: { uids: number[] }) => mailApi.remove(accountId!, { folder: folder!, ...v }),
    onMutate: (v) => ({ snapshots: removeFromList(v.uids) }),
    onError: (_e, _v, ctx) => ctx && restore(ctx.snapshots),
    onSettled: settle,
  });

  return { flags, move, remove };
}
