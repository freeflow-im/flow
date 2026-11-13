// The suite's one query language (docs/specs/search.md §3): what a search box and the agents' `search` tools take. The
// parser turns the text into words and filters as data; each source turns the words into an FTS5 MATCH expression
// (`toFtsMatch`), quoting every word, so text from the box is never read as FTS5 syntax.

/** What a hit can be. */
export const SEARCH_KINDS = ['doc', 'sheet', 'deck', 'markdown', 'file', 'message', 'email'] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];
export const isSearchKind = (k: unknown): k is SearchKind => typeof k === 'string' && (SEARCH_KINDS as readonly string[]).includes(k);

/** One word or phrase of a query. */
export interface SearchTerm {
  text: string;
  /** A quoted phrase: its words in this order. */
  phrase?: boolean;
  /** `word*`: any word starting with this. */
  prefix?: boolean;
}

export interface SearchFilters {
  types?: SearchKind[];
  /** Authors: `me`, user ids, names or addresses; each source resolves what it can. */
  from?: string[];
  /** ISO times: on or after `after`, before `before`. */
  after?: string;
  before?: string;
  /** A folder, a channel or a mail folder. */
  in?: string;
  /** `attachment`, `link`. */
  has?: string[];
  /** `unread`, `starred`, `shared`. */
  is?: string[];
}

export interface SearchQuery {
  /** Every group must match; a group matches when any of its terms does (`a OR b` is one group of two). */
  groups: SearchTerm[][];
  /** None of these may match (`-word`). */
  not: SearchTerm[];
  filters: SearchFilters;
}

/** One hit, the same shape from every source (§4). */
export interface SearchHit {
  source: 'docs' | 'chat' | 'mail';
  kind: SearchKind;
  id: string;
  title: string;
  /** The matching text with the words between SNIPPET_OPEN and SNIPPET_CLOSE. */
  snippet: string;
  author?: string;
  /** ISO time of the last change (a document) or of sending (a message, an email). */
  at: string;
  container?: string;
  url: string;
  /** The source's own rank: lower is better, not comparable across sources. */
  rank: number;
}

/** What marks the matched words in a snippet: control characters, which no text the user typed holds. */
export const SNIPPET_OPEN = '\u0002';
export const SNIPPET_CLOSE = '\u0003';

const FILTER_KEYS = new Set(['type', 'kind', 'from', 'after', 'before', 'in', 'has', 'is']);
/** Aliases a person may type for a kind. */
const KIND_ALIASES: Record<string, SearchKind> = {
  doc: 'doc', docs: 'doc', document: 'doc', documents: 'doc',
  sheet: 'sheet', sheets: 'sheet', spreadsheet: 'sheet', spreadsheets: 'sheet',
  deck: 'deck', decks: 'deck', presentation: 'deck', presentations: 'deck', slides: 'deck',
  markdown: 'markdown', md: 'markdown',
  file: 'file', files: 'file', pdf: 'file',
  message: 'message', messages: 'message', chat: 'message',
  email: 'email', emails: 'email', mail: 'email',
};

interface Token { text: string; quoted: boolean; negate: boolean; key?: string }

/** Split the text into words, quoted phrases and `key:value` filters (a value may be quoted: `in:"Q4 reports"`). */
function tokenize(input: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const s = input;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (i >= s.length) break;
    let negate = false;
    if (s[i] === '-' && i + 1 < s.length && !/\s/.test(s[i + 1]!)) { negate = true; i++; }
    if (s[i] === '"') {
      const end = s.indexOf('"', i + 1);
      const text = s.slice(i + 1, end < 0 ? s.length : end);
      i = end < 0 ? s.length : end + 1;
      out.push({ text, quoted: true, negate });
      continue;
    }
    let j = i;
    while (j < s.length && !/\s/.test(s[j]!) && s[j] !== '"') j++;
    const word = s.slice(i, j);
    const colon = word.indexOf(':');
    const key = colon > 0 ? word.slice(0, colon).toLowerCase() : '';
    if (key && FILTER_KEYS.has(key)) {
      let value = word.slice(colon + 1);
      i = j;
      if (!value && s[i] === '"') {
        const end = s.indexOf('"', i + 1);
        value = s.slice(i + 1, end < 0 ? s.length : end);
        i = end < 0 ? s.length : end + 1;
      }
      out.push({ text: value, quoted: false, negate, key });
      continue;
    }
    i = j;
    out.push({ text: word, quoted: false, negate });
  }
  return out;
}

const DAY_MS = 86_400_000;

/** A date as an ISO time: `2026-10-01` (the start of that day, UTC) or a relative `7d`, `2w`, `3m`, `1y` before now. */
export function parseSearchDate(value: string, now: Date = new Date()): string | undefined {
  const v = value.trim().toLowerCase();
  const rel = /^(\d{1,4})([dwmy])$/.exec(v);
  if (rel) {
    const n = Number(rel[1]);
    const d = new Date(now.getTime());
    if (rel[2] === 'd') d.setTime(d.getTime() - n * DAY_MS);
    else if (rel[2] === 'w') d.setTime(d.getTime() - n * 7 * DAY_MS);
    else if (rel[2] === 'm') d.setUTCMonth(d.getUTCMonth() - n);
    else d.setUTCFullYear(d.getUTCFullYear() - n);
    return d.toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const t = Date.parse(`${v}T00:00:00Z`);
    // Date.parse rolls 2026-02-30 over to March; a date that does not come back as typed is no date.
    return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== v ? undefined : new Date(t).toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}t/.test(v)) {
    const t = Date.parse(value);
    return Number.isNaN(t) ? undefined : new Date(t).toISOString();
  }
  return undefined;
}

const list = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);
/** Whether a term has anything a tokenizer would index (a letter or a digit). */
const hasWord = (t: string) => /[\p{L}\p{N}]/u.test(t);

/** Parse the text of a search box (§3). Unknown `key:` words are plain words; filters that do not parse are dropped. */
export function parseSearch(input: string, now: Date = new Date()): SearchQuery {
  const groups: SearchTerm[][] = [];
  const not: SearchTerm[] = [];
  const filters: SearchFilters = {};
  const tokens = tokenize(input.slice(0, 1000));
  let joinNext = false;
  for (const t of tokens) {
    if (t.key) {
      const values = list(t.text);
      if (!values.length || t.negate) continue;
      if (t.key === 'type' || t.key === 'kind') {
        const kinds = values.map((v) => KIND_ALIASES[v.toLowerCase()]).filter((k): k is SearchKind => !!k);
        if (kinds.length) filters.types = [...new Set([...(filters.types ?? []), ...kinds])];
      } else if (t.key === 'from') filters.from = [...(filters.from ?? []), ...values];
      else if (t.key === 'after' || t.key === 'before') {
        const at = parseSearchDate(t.text, now);
        if (at) filters[t.key] = at;
      } else if (t.key === 'in') filters.in = t.text.trim();
      else if (t.key === 'has') filters.has = [...new Set([...(filters.has ?? []), ...values.map((v) => v.toLowerCase())])];
      else if (t.key === 'is') filters.is = [...new Set([...(filters.is ?? []), ...values.map((v) => v.toLowerCase())])];
      continue;
    }
    if (!t.quoted && !t.negate && t.text === 'OR') {
      joinNext = groups.length > 0;
      continue;
    }
    const prefix = !t.quoted && t.text.endsWith('*');
    const text = (prefix ? t.text.replace(/\*+$/, '') : t.text).trim();
    if (!hasWord(text)) continue;
    const term: SearchTerm = { text, ...(t.quoted && /\s/.test(text) ? { phrase: true } : {}), ...(prefix ? { prefix: true } : {}) };
    if (t.negate) { not.push(term); joinNext = false; continue; }
    if (joinNext) groups[groups.length - 1]!.push(term);
    else groups.push([term]);
    joinNext = false;
  }
  return { groups, not, filters };
}

/** Whether the query has words to match (a query of filters alone lists by them). */
export const hasSearchWords = (q: SearchQuery): boolean => q.groups.length > 0;

const quote = (t: SearchTerm) => `"${t.text.replace(/"/g, '""')}"${t.prefix ? '*' : ''}`;

/**
 * The FTS5 MATCH expression for the query's words, or null when it has none. Every term is quoted. `prefixLast` makes the
 * last word a prefix too, for search as you type.
 */
export function toFtsMatch(q: SearchQuery, opts: { prefixLast?: boolean } = {}): string | null {
  if (!q.groups.length) return null;
  const groups = q.groups.map((g, gi) =>
    g.map((t, ti) => (opts.prefixLast && gi === q.groups.length - 1 && ti === g.length - 1 && !t.phrase ? { ...t, prefix: true } : t)),
  );
  const pos = groups.map((g) => (g.length === 1 ? quote(g[0]!) : `(${g.map(quote).join(' OR ')})`)).join(' AND ');
  if (!q.not.length) return pos;
  return `(${pos}) NOT (${q.not.map(quote).join(' OR ')})`;
}
