// Conversations in the list and the reading pane, the pure parts: search results grouped into threads (the server
// groups a folder's own pages), the row's "Ann, Bob, me" label, which messages of an open thread start expanded, and
// where long runs of read messages fold.
import type { Address, MessageSummary, ThreadMessage, ThreadSummary } from '../api';
import { displayName } from './addresses';

/** The thread id of a message the server does not place in one: a thread of its own (`m:<uid>`, in the folder it is in). */
export const soloThreadId = (uid: number) => `m:${uid}`;

/** A subject less the "Re:" and "Fwd:" a reply adds: what a conversation's row and reading show (a lone message keeps its own). */
export const conversationSubject = (subject: string, count: number): string => (count > 1 ? subject.replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, '') : subject);
/** A thread id made by `soloThreadId`: the message's uid, or null for a server's thread. */
export function soloUid(threadId: string): number | null {
  const m = /^m:(\d+)$/.exec(threadId);
  return m ? Number(m[1]) : null;
}

/** The thread one message stands for: the row a list shows when it only has the messages. */
export function threadOfMessage(m: MessageSummary): ThreadSummary {
  return {
    threadId: m.threadId ?? soloThreadId(m.uid), folder: m.folder, uid: m.uid, uids: [m.uid], latest: m, count: 1, unread: m.seen ? 0 : 1, flagged: m.flagged,
    participants: m.from ? [m.from] : [], date: m.date, folders: [m.folder], ...(m.category ? { category: m.category } : {}), ...(m.categoryReason ? { categoryReason: m.categoryReason } : {}),
  };
}

/**
 * Messages (newest first, as a search lists them) as threads, newest first: the rows with the same `threadId` become
 * one, standing where its newest message was; a message without one is a thread of its own. The counts are of what
 * is listed (a search shows only what matched).
 */
export function groupByThread(messages: readonly MessageSummary[]): ThreadSummary[] {
  const rows = new Map<string, ThreadSummary>();
  for (const m of messages) {
    const id = m.threadId ?? soloThreadId(m.uid);
    const have = rows.get(id);
    if (!have) {
      rows.set(id, threadOfMessage(m));
      continue;
    }
    have.uids.push(m.uid);
    have.count++;
    if (!m.seen) have.unread++;
    have.flagged ||= m.flagged;
    if (m.from && !have.participants.some((a) => a.address.toLowerCase() === m.from!.address.toLowerCase())) have.participants.unshift(m.from);
    if (m.date > have.date) have.date = m.date;
    if (!have.folders.includes(m.folder)) have.folders.push(m.folder);
  }
  return [...rows.values()];
}

/** The row's names, as Gmail writes them: first names in order, "me" for the account's own address, each once. */
export function participantsLabel(participants: readonly Address[], me: string, max = 3): string {
  const mine = me.toLowerCase();
  const names: string[] = [];
  const seen = new Set<string>();
  for (const a of participants) {
    const address = a.address.toLowerCase();
    if (seen.has(address)) continue;
    seen.add(address);
    const name = address === mine ? 'me' : displayName(a).split(/\s+/)[0] || a.address;
    if (!names.includes(name)) names.push(name);
  }
  if (!names.length) return '(no sender)';
  if (names.length <= max) return names.join(', ');
  // The first and the last ones, as Gmail keeps the newest writers in view.
  return [names[0], '…', ...names.slice(-(max - 1))].join(', ');
}

/** Which messages of an open thread start expanded: the unread ones, and the last one. */
export function expandedByDefault(messages: readonly { seen: boolean }[]): Set<number> {
  const out = new Set<number>();
  messages.forEach((m, i) => {
    if (!m.seen || i === messages.length - 1) out.add(i);
  });
  return out;
}

export type ThreadSegment = { kind: 'message'; index: number } | { kind: 'fold'; indexes: number[] };

/** The thread's messages in order, with runs of `minRun` or more collapsed read messages folded into one "N older messages" line. */
export function foldRuns(messages: readonly { seen: boolean }[], expanded: ReadonlySet<number>, minRun = 3): ThreadSegment[] {
  const out: ThreadSegment[] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length >= minRun) out.push({ kind: 'fold', indexes: run });
    else for (const index of run) out.push({ kind: 'message', index });
    run = [];
  };
  messages.forEach((m, i) => {
    if (!expanded.has(i) && m.seen && i !== messages.length - 1) run.push(i);
    else {
      flush();
      out.push({ kind: 'message', index: i });
    }
  });
  flush();
  return out;
}

/** The UIDs a dragged row carries: its thread's messages in the folder, or every checked thread's when it is checked. */
export function dragThreadUids(threadId: string, checked: ReadonlySet<string>, rows: readonly ThreadSummary[]): number[] {
  const ids = checked.has(threadId) ? rows.filter((r) => checked.has(r.threadId)).map((r) => r.threadId) : [threadId];
  return rows.filter((r) => ids.includes(r.threadId)).flatMap((r) => r.uids);
}

/** The message a reply or forward answers: the last one in the thread (the one in `folder` when there is one). */
export function replyTarget(messages: readonly ThreadMessage[], folder: string | null): ThreadMessage | undefined {
  const ready = messages.filter((m) => !m.bodyPending);
  return [...ready].reverse().find((m) => m.folder === folder) ?? ready[ready.length - 1] ?? messages[messages.length - 1];
}
