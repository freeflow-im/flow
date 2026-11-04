// Conversations (docs/specs/mail-api.md, Conversations): which thread a cached message belongs to, decided when it is
// cached. A server that threads mail itself (Gmail's X-GM-THRID, OBJECTID's THREADID) is believed; elsewhere the message
// joins the thread of what it answers or references (In-Reply-To, References, in either direction), and only a reply
// whose references lead nowhere falls back to a thread with the same subject and someone in common, lately. Pure: the
// cache is read through `ThreadStore`, so threads.test.ts can feed it anything.

/** A message as it arrives, the parts threading reads. Ids are bare (no angle brackets); addresses lower-cased. */
export interface Incoming {
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  subject: string;
  /** ms */
  date: number;
  serverThreadId: string | null;
  /** A mailing list's message (List-Id): never threaded by subject. */
  list: boolean;
  draft: boolean;
  participants: string[];
}

/** What is known of a message id: its thread, and when that message was sent. */
export interface Known { threadId: string; date: number }

export interface ThreadStore {
  /** The threads of these message ids, among cached messages and those remembered after leaving the cache. */
  threadsOf(messageIds: readonly string[]): Map<string, Known>;
  /** The threads of cached messages that reference this message id. */
  referencing(messageId: string): string[];
  /** Threads with a message of this normalized subject since `since`, newest first, each with that message's date and participants. */
  bySubject(norm: string, since: number): { threadId: string; date: number; participants: string[] }[];
  newId(): string;
}

export interface Assignment { threadId: string; by: 'server' | 'references' | 'subject' | 'new'; merge: string[] }

/** How far back a reply looks for a thread by its subject. */
export const SUBJECT_WINDOW_MS = 30 * 24 * 60 * 60_000;

export const bareId = (id: string | null | undefined): string => (id ? id.trim().replace(/^<|>$/g, '') : '');

/** The ids in an In-Reply-To or References value, bare and in order. */
export const idsIn = (value: string | null | undefined): string[] => (value ?? '').split(/\s+/).map(bareId).filter(Boolean);

const PREFIX = /^\s*(?:(?:re|fwd?|aw|wg|sv|vs|tr|rv|antw|r)\s*(?:\[\d+\]|\(\d+\))?\s*:\s*)+/i;

/** The subject without its reply and forward prefixes and [list] tags, lower-cased, one space between words. */
export function normalizeSubject(subject: string): string {
  let s = subject;
  for (let i = 0; i < 10; i++) {
    const next = s.replace(PREFIX, '').replace(/^\s*\[[^\]]{1,80}\]\s*/, '');
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Whether the subject carries a reply or forward prefix. */
export const isReplySubject = (subject: string): boolean => PREFIX.test(subject);

/**
 * The thread a message belongs to. 1. the server's own thread id; 2. the thread of what it answers or references, or of
 * what references it (several: the thread of the oldest such message, the others to be merged into it); 3. for a reply
 * whose references lead nowhere (or none at all), a thread with the same subject in the last 30 days sharing a
 * participant (the newest such message not later than the reply, else the newest), unless it is a mailing list's or a
 * draft; 4. a new thread.
 */
export function assignThread(m: Incoming, store: ThreadStore): Assignment {
  if (m.serverThreadId) return { threadId: `s:${m.serverThreadId}`, by: 'server', merge: [] };
  const ids = [...new Set([m.inReplyTo ?? '', ...m.references, m.messageId].filter(Boolean))];
  const known = store.threadsOf(ids);
  const found = new Map<string, number>();
  for (const [, k] of known) found.set(k.threadId, Math.min(found.get(k.threadId) ?? Infinity, k.date));
  if (m.messageId) for (const t of store.referencing(m.messageId)) if (!found.has(t)) found.set(t, Infinity);
  if (found.size) {
    const [winner, ...losers] = [...found].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([t]) => t);
    return { threadId: winner, by: 'references', merge: losers };
  }
  const reply = isReplySubject(m.subject) || !!m.inReplyTo || m.references.length > 0;
  if (reply && !m.list && !m.draft) {
    const norm = normalizeSubject(m.subject);
    if (norm) {
      const mine = new Set(m.participants);
      const candidates = store.bySubject(norm, m.date - SUBJECT_WINDOW_MS).filter((c) => c.participants.some((p) => mine.has(p)));
      const match = candidates.find((c) => c.date <= m.date) ?? candidates[0];
      if (match) return { threadId: match.threadId, by: 'subject', merge: [] };
    }
  }
  return { threadId: store.newId(), by: 'new', merge: [] };
}

/** One message, seen once however many folders hold a copy: the server's id, else the Message-ID, else the row itself. */
export const dedupeKey = (r: { emailId: string | null; messageId: string; folder: string; uid: number }): string => r.emailId ?? (r.messageId || `${r.folder}:${r.uid}`);

/**
 * The people in a thread as Gmail lists them: each sender once, oldest first; `me` for the account's own address. Returns
 * the names (the address when there is none) and how many.
 */
export function participants(rows: { from: { name: string; address: string } | null; date: string }[], me: string): { name: string; address: string }[] {
  const seen = new Set<string>();
  const out: { name: string; address: string }[] = [];
  for (const r of [...rows].sort((a, b) => Date.parse(a.date) - Date.parse(b.date))) {
    const address = (r.from?.address ?? '').toLowerCase();
    if (!address || seen.has(address)) continue;
    seen.add(address);
    out.push({ name: address === me.toLowerCase() ? 'me' : r.from?.name || address, address });
  }
  return out;
}
