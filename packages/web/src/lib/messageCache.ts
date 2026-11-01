// Local-first message cache surgery (perceived-latency work, macOS parity —
// its SyncEngine has inserted optimistic pending rows since phase 2):
// sends insert a pending row immediately, and message WS events carry full
// DTOs that are applied directly to the query cache instead of triggering a
// refetch of the whole list.
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import type { MessageDTO, MessagePage } from '@flow/shared';

/** Client-only markers on an optimistic row: `pending` while the POST is in
 * flight, `failed` once it errors out (the row stays put with a Retry
 * affordance instead of vanishing). A retry flips it back to pending. */
export type LocalMessage = MessageDTO & { pending?: boolean; failed?: boolean };

/** ['messages', channelId] — infinite query; pages newest-first and messages
 * newest-first within a page (flattenMessages un-reverses both). */
export type MessagesData = InfiniteData<MessagePage, string>;
/** ['thread', rootId] — replies ascending (oldest first). */
export type ThreadData = MessagePage & { root: MessageDTO };

export const pendingId = (clientMsgId: string): string => `pending:${clientMsgId}`;

/** Same row if ids match, or if it reconciles a pending row (same clientMsgId). */
const sameRow = (existing: MessageDTO, incoming: MessageDTO): boolean =>
  existing.id === incoming.id ||
  (incoming.clientMsgId !== '' && existing.clientMsgId === incoming.clientMsgId);

interface Applied<T> {
  data: T;
  inserted: boolean;
}

/** Upsert a top-level message: replace in place by id/clientMsgId, else
 * prepend to the newest page (insert=false replaces only — edits/deletes of
 * rows we never loaded shouldn't materialize them). */
export function applyTopLevel(
  data: MessagesData,
  msg: MessageDTO,
  insert: boolean,
): Applied<MessagesData> {
  let replaced = false;
  const pages = data.pages.map((page) => {
    const idx = page.messages.findIndex((m) => sameRow(m, msg));
    if (idx === -1) return page;
    replaced = true;
    const messages = page.messages.slice();
    messages[idx] = msg;
    return { ...page, messages };
  });
  if (replaced) return { data: { ...data, pages }, inserted: false };
  if (!insert) return { data, inserted: false };
  const [first, ...rest] = pages;
  // Flow ids arrive in order, so a new message goes on top.
  const newFirst: MessagePage = first
    ? { ...first, messages: [msg, ...first.messages] }
    : { messages: [msg], hasMore: false };
  return { data: { ...data, pages: [newFirst, ...rest], pageParams: data.pageParams }, inserted: true };
}

/** Upsert a reply into a thread query (ascending: new replies append). */
export function applyThreadReply(data: ThreadData, msg: MessageDTO, insert: boolean): Applied<ThreadData> {
  const idx = data.messages.findIndex((m) => sameRow(m, msg));
  if (idx !== -1) {
    const messages = data.messages.slice();
    messages[idx] = msg;
    return { data: { ...data, messages }, inserted: false };
  }
  if (!insert) return { data, inserted: false };
  return { data: { ...data, messages: [...data.messages, msg] }, inserted: true };
}

/** Root rollup mirror for an arriving reply (server doesn't re-publish the
 * root): replyCount+1, lastReplyAt, participant stack (≤4 distinct, thread
 * order) — same denormalization the server maintains. */
export function bumpRootRollup(root: MessageDTO, reply: MessageDTO): MessageDTO {
  const participants = root.replyParticipantUserIds.includes(reply.userId)
    ? root.replyParticipantUserIds
    : [...root.replyParticipantUserIds, reply.userId].slice(0, 4);
  return {
    ...root,
    replyCount: root.replyCount + 1,
    lastReplyAt: reply.createdAt,
    replyParticipantUserIds: participants,
  };
}

// A reply reaches us up to three times (optimistic insert, POST response, WS
// echo) but must bump the root rollup exactly once. The pending and real row
// share a clientMsgId, so that's the dedupe key.
const bumpedReplies = new Set<string>();

export function shouldBumpRollup(reply: MessageDTO): boolean {
  const key = reply.clientMsgId !== '' ? reply.clientMsgId : reply.id;
  if (bumpedReplies.has(key)) return false;
  if (bumpedReplies.size > 4096) bumpedReplies.clear(); // session-bounded
  bumpedReplies.add(key);
  return true;
}

/** Route one message DTO (from a WS event, an optimistic insert, or a POST
 * response) into every query it affects. Queries that were never loaded are
 * left untouched — they'll fetch fresh when opened. */
export function applyMessageEvent(qc: QueryClient, msg: MessageDTO, insert: boolean): void {
  if (msg.threadRootId === null) {
    qc.setQueryData<MessagesData>(['messages', msg.channelId], (old) =>
      old ? applyTopLevel(old, msg, insert).data : old,
    );
    // Edits/deletes of a thread root mirror into an open thread panel, but
    // keep the (client-maintained) rollup fields of the newer root copy.
    qc.setQueryData<ThreadData>(['thread', msg.id], (old) =>
      old
        ? {
            ...old,
            root: {
              ...msg,
              replyCount: Math.max(msg.replyCount, old.root.replyCount),
              lastReplyAt: msg.lastReplyAt ?? old.root.lastReplyAt,
              replyParticipantUserIds:
                msg.replyParticipantUserIds.length >= old.root.replyParticipantUserIds.length
                  ? msg.replyParticipantUserIds
                  : old.root.replyParticipantUserIds,
            },
          }
        : old,
    );
    return;
  }
  const rootId = msg.threadRootId;
  qc.setQueryData<ThreadData>(['thread', rootId], (old) =>
    old ? applyThreadReply(old, msg, insert).data : old,
  );
  if (insert && shouldBumpRollup(msg)) {
    qc.setQueryData<MessagesData>(['messages', msg.channelId], (old) => {
      if (!old) return old;
      let changed = false;
      const pages = old.pages.map((page) => {
        const idx = page.messages.findIndex((m) => m.id === rootId);
        if (idx === -1) return page;
        changed = true;
        const messages = page.messages.slice();
        messages[idx] = bumpRootRollup(messages[idx]!, msg);
        return { ...page, messages };
      });
      return changed ? { ...old, pages } : old;
    });
    qc.setQueryData<ThreadData>(['thread', rootId], (old) =>
      old ? { ...old, root: bumpRootRollup(old.root, msg) } : old,
    );
  }
}

/** Hard delete (`message.purged`): splice the message out of every query it
 * lives in — no tombstone. A purged reply also decrements the root rollup it
 * had bumped (mirrors the server's txn); a re-posted reply re-bumps it. */
export function removeMessageFromCache(qc: QueryClient, msg: MessageDTO): void {
  // The local DELETE response and its websocket echo both run this path. Keep
  // a short-lived query-cache marker so a reply rollup is adjusted exactly
  // once even when that thread was never opened locally.
  const purgeKey = ['messagePurge', msg.id] as const;
  if (qc.getQueryData<boolean>(purgeKey)) return;
  qc.setQueryData(purgeKey, true);

  if (msg.threadRootId === null) {
    qc.setQueryData<MessagesData>(['messages', msg.channelId], (old) =>
      old
        ? { ...old, pages: old.pages.map((p) => ({ ...p, messages: p.messages.filter((m) => m.id !== msg.id) })) }
        : old,
    );
    // A permanent root delete removes the whole thread on the server. Drop an
    // open/cached thread too so replies cannot linger after the root vanishes.
    qc.removeQueries({ queryKey: ['thread', msg.id], exact: true });
    return;
  }
  const rootId = msg.threadRootId;
  let exactReplyCount: number | undefined;
  qc.setQueryData<ThreadData>(['thread', rootId], (old) =>
    old
      ? (() => {
          const found = old.messages.some((m) => m.id === msg.id);
          const messages = found ? old.messages.filter((m) => m.id !== msg.id) : old.messages;
          const fullyLoaded = !old.hasMore;
          const replyCount = fullyLoaded ? messages.length : Math.max(0, old.root.replyCount - 1);
          exactReplyCount = replyCount;
          return {
            ...old,
            messages,
            root: {
              ...old.root,
              replyCount,
              lastReplyAt: fullyLoaded && found ? messages.at(-1)?.createdAt ?? null : old.root.lastReplyAt,
              replyParticipantUserIds: fullyLoaded
                ? [...new Set(messages.map((m) => m.userId))].slice(0, 4)
                : old.root.replyParticipantUserIds,
            },
          };
        })()
      : old,
  );
  qc.setQueryData<MessagesData>(['messages', msg.channelId], (old) =>
    old
      ? {
          ...old,
          pages: old.pages.map((p) => ({
            ...p,
            messages: p.messages.map((m) =>
              m.id === rootId
                ? { ...m, replyCount: exactReplyCount ?? Math.max(0, m.replyCount - 1) }
                : m,
            ),
          })),
        }
      : old,
  );
}

/** Failed send: keep the optimistic row in place but flip it from `pending`
 * to `failed`, so the message stays visible with a Retry affordance instead
 * of vanishing. A failed reply un-bumps the root rollup it optimistically
 * incremented and frees its dedupe key, so a retry re-bumps exactly once. */
export function markSendFailed(qc: QueryClient, channelId: string, clientMsgId: string, threadRootId?: string): void {
  const id = pendingId(clientMsgId);
  const fail = (m: MessageDTO): LocalMessage => ({ ...(m as LocalMessage), pending: false, failed: true });
  if (threadRootId) {
    qc.setQueryData<ThreadData>(['thread', threadRootId], (old) =>
      old
        ? {
            ...old,
            messages: old.messages.map((m) => (m.id === id ? fail(m) : m)),
            root: { ...old.root, replyCount: Math.max(0, old.root.replyCount - 1) },
          }
        : old,
    );
    qc.setQueryData<MessagesData>(['messages', channelId], (old) =>
      old
        ? {
            ...old,
            pages: old.pages.map((p) => ({
              ...p,
              messages: p.messages.map((m) =>
                m.id === threadRootId ? { ...m, replyCount: Math.max(0, m.replyCount - 1) } : m,
              ),
            })),
          }
        : old,
    );
    bumpedReplies.delete(clientMsgId);
    return;
  }
  qc.setQueryData<MessagesData>(['messages', channelId], (old) =>
    old
      ? { ...old, pages: old.pages.map((p) => ({ ...p, messages: p.messages.map((m) => (m.id === id ? fail(m) : m)) })) }
      : old,
  );
}

/** Discard a failed row entirely (the "×" next to Retry). A failed reply has
 * already un-bumped its rollup in {@link markSendFailed}, so this only removes
 * the row. */
export function removePendingMessage(qc: QueryClient, channelId: string, clientMsgId: string, threadRootId?: string): void {
  const id = pendingId(clientMsgId);
  if (threadRootId) {
    qc.setQueryData<ThreadData>(['thread', threadRootId], (old) =>
      old ? { ...old, messages: old.messages.filter((m) => m.id !== id) } : old,
    );
    return;
  }
  qc.setQueryData<MessagesData>(['messages', channelId], (old) =>
    old
      ? { ...old, pages: old.pages.map((p) => ({ ...p, messages: p.messages.filter((m) => m.id !== id) })) }
      : old,
  );
}
