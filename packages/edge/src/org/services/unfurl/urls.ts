// Phase 11 §1/§2: pulling candidate URLs out of a message body, and
// normalizing them into the cache key.
//
// Pure functions only — no network, no db. The fetch/extract/cache layers all
// key off `normalize()`, so this file defines what "the same link" means.
import { createHash } from 'node:crypto';

/** §1: at most 3 unfurls per message, first-in-message order. */
export const MAX_UNFURLS_PER_MESSAGE = 3;

/** §1: skip a URL already unfurled in this channel within 6 hours. */
export const CHANNEL_SUPPRESSION_MS = 6 * 60 * 60 * 1000;

/** §2 tracking params, stripped before hashing. `utm_*` is a prefix match. */
const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'mc_eid', 'ref', 'ref_src', 'igshid']);

/**
 * Bare URLs plus the target of a markdown link. Deliberately conservative:
 * trailing punctuation is trimmed by `trimTrailing` below, since a sentence
 * like "see https://x.com/a." must not capture the full stop.
 */
const URL_RE = /\bhttps?:\/\/[^\s<>()[\]"'`]+/gi;

/**
 * §1: the body with inline code, fenced code blocks, and blockquotes blanked
 * out, so URLs inside them are never candidates. Blanking (rather than
 * deleting) keeps offsets stable, which keeps first-in-message ordering honest.
 *
 * The server stores literal markdown, so this is the server-side equivalent of
 * the clients' block classifier — we only need the negative space, not a full
 * AST.
 */
export function stripNonLinkRegions(body: string): string {
  const lines = body.split('\n');
  let inFence = false;
  const kept = lines.map((line) => {
    const blank = ' '.repeat(line.length);
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      return blank; // the fence marker line itself
    }
    if (inFence) return blank;
    if (line.startsWith('>')) return blank; // blockquote
    // inline code spans: `…`
    return line.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
  });
  return kept.join('\n');
}

/** Trailing punctuation that is almost always sentence punctuation, not URL. */
function trimTrailing(url: string): string {
  let out = url;
  for (;;) {
    const last = out[out.length - 1];
    if (last && '.,;:!?'.includes(last)) {
      out = out.slice(0, -1);
      continue;
    }
    // a closing paren/bracket only belongs to the URL if it's balanced
    if (last === ')' && (out.match(/\(/g)?.length ?? 0) < (out.match(/\)/g)?.length ?? 0)) {
      out = out.slice(0, -1);
      continue;
    }
    return out;
  }
}

/**
 * §1: candidate URLs in first-in-message order, deduplicated by normalized
 * form, capped at 3. Returns normalized URLs — the cache key is derived from
 * these, and the fetcher requests them.
 */
export function extractUrls(body: string, limit = MAX_UNFURLS_PER_MESSAGE): string[] {
  const scannable = stripNonLinkRegions(body);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of scannable.matchAll(URL_RE)) {
    const normalized = normalize(trimTrailing(match[0]));
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * §2 normalization. Returns null when the input isn't a usable http(s) URL.
 *
 * Query params keep their original order on purpose — some sites are
 * order-sensitive, so sorting them would break those links.
 */
export function normalize(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const scheme = u.protocol.toLowerCase();
  if (scheme !== 'http:' && scheme !== 'https:') return null;
  // `new URL` already lowercases the host and punycodes IDNs.
  if (!u.hostname) return null;

  // default ports
  if ((scheme === 'http:' && u.port === '80') || (scheme === 'https:' && u.port === '443')) {
    u.port = '';
  }
  u.hash = '';

  // Drop tracking params, preserving the order of what remains.
  const kept: Array<[string, string]> = [];
  for (const [key, value] of u.searchParams) {
    const lower = key.toLowerCase();
    if (lower.startsWith('utm_') || TRACKING_PARAMS.has(lower)) continue;
    kept.push([key, value]);
  }
  // Rebuild rather than mutate while iterating.
  const search = new URLSearchParams();
  for (const [k, v] of kept) search.append(k, v);
  const query = search.toString();
  u.search = query ? `?${query}` : '';

  return u.toString();
}

/** §2 cache key. */
export function urlHash(normalizedUrl: string): string {
  return createHash('sha256').update(normalizedUrl).digest('hex');
}

/**
 * §10 denylist / allowlist matching: does `host` equal `domain` or sit under
 * it? Matching on a label boundary keeps "notevil.com" out of "evil.com".
 */
export function hostMatchesDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const d = domain.toLowerCase().replace(/^\.+|\.$/g, '');
  if (!d) return false;
  return h === d || h.endsWith(`.${d}`);
}
