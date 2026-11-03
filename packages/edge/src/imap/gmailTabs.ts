// Gmail's inbox categories for the Mail object's cache (docs/specs/mail-api.md, "Inbox tabs"), asked so that no message is
// put in Primary because an answer left it out. Gmail's X-GM-RAW searches over a large UID range have come back incomplete
// (and a refused search is `false` from imapflow, not an empty list), and reading "not returned" as "no category" once sent
// a whole tab's mail to Primary. So:
//   - a search that fails or is refused is an error, and the batch or pass that asked it changes nothing;
//   - the searches go over explicit UID ranges of at most RANGE_CHUNK cached messages each, never `<floor>:*`;
//   - a cached message the range searches no longer return under its category is asked about once more, by its own UID
//     (CONFIRM_CHUNK to a command), and goes to Primary only when none of the four categories returns it then;
//   - a pass where a category with many cached messages comes back with none of them is not believed (`suspicious`).
// Pure but for the one ImapFlow call, so gmailTabs.test.ts can run it against a fake server.
import { TAB_CATEGORIES, uidSet, type Category, type TabCategory } from './categorize';

/** The one ImapFlow method used here (the tests stand in a fake). imapflow answers `false` when the server refuses. */
export interface GmailSearcher {
  search(query: { uid: string; gmraw: string }, options: { uid: true }): Promise<number[] | false | undefined>;
}

/** Cached messages per range search (`UID <min>:<max>` between real cached UIDs). */
export const RANGE_CHUNK = 250;
/** UIDs per targeted search (`UID 5,9,12:14 ...`), the confirmation before anything goes to Primary. */
export const CONFIRM_CHUNK = 100;
/** A category with at least this many cached messages in a re-check, of which no search returns one, is not believed. */
export const SUSPICIOUS_CACHED = 20;
/** A new batch larger than this where no search returns anything is asked about again, UID by UID, before it is stored. */
export const SUSPICIOUS_BATCH = 50;

export const GMAIL_REASON = (tab: TabCategory) => `Gmail category:${tab}`;
export const GMAIL_NONE = 'Gmail: no category';

/** A search that failed or that the server refused: whatever asked it changes nothing. */
export class GmailSearchError extends Error {}

/** Explicit UID ranges, `<min>:<max>` between real UIDs, each covering at most `size` of `uids`. Oldest first. */
export function rangeChunks(uids: Iterable<number>, size = RANGE_CHUNK): string[] {
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < sorted.length; i += size) {
    const s = sorted.slice(i, i + size);
    out.push(s.length === 1 ? String(s[0]) : `${s[0]}:${s[s.length - 1]}`);
  }
  return out;
}

/** UID sets naming each UID (runs collapsed), at most `size` UIDs each. */
export function setChunks(uids: Iterable<number>, size = CONFIRM_CHUNK): string[] {
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < sorted.length; i += size) out.push(uidSet(sorted.slice(i, i + size)));
  return out;
}

/**
 * Gmail's category of each of `want`, from the four X-GM-RAW searches over each UID set. A message in none of them is not
 * in the answer. Throws GmailSearchError when any search throws or is refused.
 */
export async function categoriesOf(c: GmailSearcher, sets: readonly string[], want: ReadonlySet<number>): Promise<Map<number, TabCategory>> {
  const out = new Map<number, TabCategory>();
  for (const uid of sets) {
    for (const tab of TAB_CATEGORIES) {
      let got: number[] | false | undefined;
      try {
        got = await c.search({ uid, gmraw: `category:${tab}` }, { uid: true });
      } catch (err) {
        throw new GmailSearchError(`category:${tab} search failed: ${(err as Error).message}`);
      }
      if (!Array.isArray(got)) throw new GmailSearchError(`category:${tab} search refused by the server`);
      for (const u of got) if (want.has(u) && !out.has(u)) out.set(u, tab);
    }
  }
  return out;
}

/**
 * The categories of a batch of new messages (at most RANGE_CHUNK, one range): the four searches over its range, and when
 * they return nothing at all for a batch over SUSPICIOUS_BATCH, the targeted searches by UID as well. Throws
 * GmailSearchError, and then nothing of the batch should be stored.
 */
export async function sortBatch(c: GmailSearcher, batch: readonly number[]): Promise<{ tabs: Map<number, TabCategory>; confirmed: boolean }> {
  const want = new Set(batch);
  const tabs = await categoriesOf(c, rangeChunks(want, Number.MAX_SAFE_INTEGER), want);
  if (tabs.size || want.size <= SUSPICIOUS_BATCH) return { tabs, confirmed: false };
  return { tabs: await categoriesOf(c, setChunks(want), want), confirmed: true };
}

export interface CachedTab { uid: number; category: string }
export interface TabChange { uid: number; category: Category; reason: string }
export interface RecheckResult {
  changes: TabChange[];
  checked: number;
  /** Primary rows a search returned under a category. */
  promoted: number;
  /** Rows a search returned under another category. */
  moved: number;
  /** Rows no search returned, even asked about by UID, now Primary. */
  demoted: number;
  /** Rows the range searches left out that the targeted searches found (kept in their category, or moved). */
  confirmed: number;
  /** Set when the pass was not believed (a search failed, or a suspicious answer): then `changes` is empty. */
  error: string | null;
}

/**
 * Which cached rows (of messages still in INBOX) change tab, from Gmail's current answer. A row changes only when a search
 * positively returns it under another category; a non-Primary row the range searches leave out goes to Primary only after
 * the targeted searches by UID leave it out too. With `demote: false` (the repair of older rows) rows only ever leave
 * Primary. Any failed search, or a category with SUSPICIOUS_CACHED or more cached rows of which none came back, makes the
 * whole pass change nothing (`error`).
 */
export async function recheckRows(c: GmailSearcher, rows: readonly CachedTab[], opts: { demote?: boolean } = {}): Promise<RecheckResult> {
  const demote = opts.demote ?? true;
  const result: RecheckResult = { changes: [], checked: rows.length, promoted: 0, moved: 0, demoted: 0, confirmed: 0, error: null };
  if (!rows.length) return result;
  const want = new Set(rows.map((r) => r.uid));
  const fail = (error: string): RecheckResult => ({ ...result, changes: [], promoted: 0, moved: 0, demoted: 0, confirmed: 0, error });
  let found: Map<number, TabCategory>;
  try {
    found = await categoriesOf(c, rangeChunks(want), want);
  } catch (err) {
    return fail((err as Error).message);
  }
  const suspicious = suspiciousTabs(rows, found);
  if (suspicious.length) return fail(`not believed: no ${suspicious.map((s) => `${s.tab} (of ${s.cached} cached)`).join(', ')} came back`);
  const missing = demote ? rows.filter((r) => r.category !== 'primary' && !found.has(r.uid)).map((r) => r.uid) : [];
  let again = new Map<number, TabCategory>();
  if (missing.length) {
    try {
      again = await categoriesOf(c, setChunks(missing), new Set(missing));
    } catch (err) {
      return fail(`confirming: ${(err as Error).message}`);
    }
  }
  result.confirmed = again.size;
  for (const row of rows) {
    const tab = found.get(row.uid) ?? again.get(row.uid);
    if (tab) {
      if (tab === row.category) continue;
      if (row.category === 'primary') result.promoted++;
      else result.moved++;
      result.changes.push({ uid: row.uid, category: tab, reason: GMAIL_REASON(tab) });
    } else if (demote && row.category !== 'primary') {
      result.demoted++;
      result.changes.push({ uid: row.uid, category: 'primary', reason: GMAIL_NONE });
    }
  }
  return result;
}

/** The categories with SUSPICIOUS_CACHED or more cached rows of which the searches returned none under that category. */
export function suspiciousTabs(rows: readonly CachedTab[], found: ReadonlyMap<number, TabCategory>): { tab: TabCategory; cached: number }[] {
  const cached = new Map<string, number>();
  for (const r of rows) cached.set(r.category, (cached.get(r.category) ?? 0) + 1);
  const returned = new Set(found.values());
  return TAB_CATEGORIES.filter((tab) => (cached.get(tab) ?? 0) >= SUSPICIOUS_CACHED && !returned.has(tab)).map((tab) => ({ tab, cached: cached.get(tab)! }));
}
