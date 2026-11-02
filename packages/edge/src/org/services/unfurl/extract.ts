// Phase 11 §5: content-type dispatch and the metadata precedence chain.
//
// Resolved field-by-field: a lower tier only fills what higher tiers left
// empty, so a page with og:title but no og:description still picks the
// description up from <meta name="description">.
//
// Deliberately regex-based over a DOM parser: we only ever read <head>, the
// fetcher stops the stream at </head>, and adding an HTML parser dependency to
// process untrusted remote markup is its own attack surface.
import type { UnfurlDTO } from '@flow/shared';
import { parseDurationSec } from './video.js';

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 400;

/** Meta tags, keyed by their name/property (lowercased). */
export function parseMetaTags(html: string): Map<string, string> {
  const out = new Map<string, string>();
  const head = cutHead(html);
  const tagRe = /<meta\b[^>]*>/gi;
  for (const match of head.matchAll(tagRe)) {
    const tag = match[0];
    const key =
      attr(tag, 'property') ?? attr(tag, 'name') ?? attr(tag, 'itemprop') ?? undefined;
    const value = attr(tag, 'content');
    if (!key || value === undefined) continue;
    const k = key.toLowerCase();
    // First occurrence wins — duplicated og tags are common and the first is
    // conventionally the canonical one.
    if (!out.has(k)) out.set(k, decodeEntities(value));
  }
  return out;
}

/** <link rel="…" href="…"> pairs from <head>, rel lowercased. */
export function parseLinkRels(html: string): Array<{ rel: string; href: string; type?: string }> {
  const out: Array<{ rel: string; href: string; type?: string }> = [];
  const head = cutHead(html);
  for (const match of head.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = attr(tag, 'rel');
    const href = attr(tag, 'href');
    if (!rel || !href) continue;
    const type = attr(tag, 'type');
    out.push({ rel: rel.toLowerCase(), href: decodeEntities(href), ...(type ? { type: type.toLowerCase() } : {}) });
  }
  return out;
}

export function parseTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(cutHead(html));
  if (!m) return undefined;
  const text = stripTags(decodeEntities(m[1]!)).trim();
  return text || undefined;
}

function cutHead(html: string): string {
  const end = html.toLowerCase().indexOf('</head>');
  return end === -1 ? html : html.slice(0, end);
}

function attr(tag: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const m = re.exec(tag);
  if (!m) return undefined;
  return m[2] ?? m[3] ?? m[4];
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'",
  ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z0-9]+);/gi, (whole, body: string) => {
    const lower = body.toLowerCase();
    if (lower.startsWith('#x')) {
      const code = parseInt(lower.slice(2), 16);
      return Number.isFinite(code) ? safeFromCodePoint(code, whole) : whole;
    }
    if (lower.startsWith('#')) {
      const code = parseInt(lower.slice(1), 10);
      return Number.isFinite(code) ? safeFromCodePoint(code, whole) : whole;
    }
    return NAMED_ENTITIES[lower] ?? whole;
  });
}

function safeFromCodePoint(code: number, fallback: string): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

export function stripTags(input: string): string {
  return input.replace(/<[^>]*>/g, '');
}

/** §5: truncate on a word boundary with an ellipsis. */
export function truncate(input: string, max: number): string {
  const text = input.trim();
  if (text.length <= max) return text;
  const slice = text.slice(0, max - 1);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

function clean(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  const text = truncate(stripTags(decodeEntities(value)).replace(/\s+/g, ' '), max);
  return text || undefined;
}

/**
 * Resolve a URL-valued field against the final response URL, and REFUSE
 * anything that isn't http(s).
 *
 * Remote pages control these strings. `<link rel="icon" href="data:,">` is
 * common in the wild (example.com ships it), and a hostile page can just as
 * easily declare `javascript:…` as its canonical/og:url/og:image — which a
 * client rendering an <a href> or <img src> would happily execute. Filtering
 * here means no client has to remember to.
 */
function absolute(href: string | undefined, base: string): string | undefined {
  if (!href) return undefined;
  try {
    const resolved = new URL(href, base);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return undefined;
    return resolved.toString();
  } catch {
    return undefined;
  }
}

export interface HtmlMetadata {
  title?: string | undefined;
  description?: string | undefined;
  siteName?: string | undefined;
  author?: string | undefined;
  publishedAt?: string | undefined;
  canonicalUrl?: string | undefined;
  imageUrl?: string | undefined;
  imageWidth?: number | undefined;
  imageHeight?: number | undefined;
  imageAlt?: string | undefined;
  faviconUrl?: string | undefined;
  layout: 'thumbnail' | 'large_image';
  /** oEmbed discovery endpoint, if the page advertised one. */
  oembedHref?: string | undefined;
  ogType?: string | undefined;
  /** Runtime in seconds, for media cards. */
  durationSec?: number | undefined;
}

/**
 * §5 tiers 2-4 (Open Graph → Twitter Cards → bare HTML). oEmbed (tier 1) needs
 * a second network round-trip, so the worker applies it over the top of this.
 */
export function extractHtmlMetadata(html: string, finalUrl: string): HtmlMetadata {
  const meta = parseMetaTags(html);
  const links = parseLinkRels(html);
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = meta.get(key);
      if (value && value.trim()) return value;
    }
    return undefined;
  };

  const canonical = links.find((l) => l.rel.split(/\s+/).includes('canonical'))?.href;
  const iconLink = links.find((l) => {
    const rels = l.rel.split(/\s+/);
    return rels.includes('icon') || rels.includes('shortcut');
  })?.href;
  const oembed = links.find(
    (l) => l.rel.split(/\s+/).includes('alternate') && l.type === 'application/json+oembed',
  )?.href;

  const twitterCard = pick('twitter:card')?.toLowerCase();
  const ogImageWidth = Number(pick('og:image:width'));
  const aspect =
    Number.isFinite(ogImageWidth) && Number(pick('og:image:height')) > 0
      ? ogImageWidth / Number(pick('og:image:height'))
      : NaN;
  // §6 layout hint
  const largeImage =
    twitterCard === 'summary_large_image' ||
    (Number.isFinite(ogImageWidth) && ogImageWidth >= 600 && aspect >= 1.4 && aspect <= 2.2);

  const ogType = pick('og:type');
  const published = ogType === 'article' ? pick('article:published_time') : undefined;

  return {
    title: clean(pick('og:title', 'twitter:title') ?? parseTitle(html), TITLE_MAX),
    description: clean(pick('og:description', 'twitter:description', 'description'), DESCRIPTION_MAX),
    siteName: clean(pick('og:site_name', 'twitter:site'), 100),
    author: clean(pick('article:author', 'author'), 100),
    publishedAt: published,
    canonicalUrl: absolute(pick('og:url') ?? canonical, finalUrl),
    imageUrl: absolute(pick('og:image', 'og:image:url', 'twitter:image'), finalUrl),
    imageWidth: Number.isFinite(ogImageWidth) ? ogImageWidth : undefined,
    imageHeight: Number.isFinite(Number(pick('og:image:height'))) ? Number(pick('og:image:height')) : undefined,
    imageAlt: clean(pick('og:image:alt', 'twitter:image:alt'), 200),
    // A declared icon we can't use (data:, javascript:) falls back to the
    // conventional /favicon.ico rather than leaving the field unusable.
    faviconUrl: absolute(iconLink, finalUrl) ?? absolute('/favicon.ico', finalUrl),
    layout: largeImage ? 'large_image' : 'thumbnail',
    oembedHref: absolute(oembed, finalUrl),
    ogType,
    // Bare seconds (og:video:duration) or ISO-8601 (`itemprop="duration"`,
    // which is the form YouTube uses) — parseDurationSec takes either.
    durationSec: parseDurationSec(pick('og:video:duration', 'video:duration', 'duration', 'music:duration')),
  };
}

/**
 * Providers whose oEmbed endpoint we know, because their pages won't tell us.
 *
 * §5 tier 1 discovers oEmbed from `<link rel="alternate"
 * type="application/json+oembed">`. Sites that serve a JS shell to non-browser
 * agents (TikTok returns the same 98 KB "TikTok - Make Your Day" document for
 * every path, with no og:image and no oembed link) can never be discovered
 * that way, so their cards come out bare.
 *
 * This is NOT a per-site scraper (out of scope per §11) — it calls the site's
 * own public, documented oEmbed API, which the spec already ranks as the
 * highest-precedence source. The only per-site part is the endpoint URL.
 */
const KNOWN_OEMBED: Array<{ host: RegExp; endpoint: (pageUrl: string) => string }> = [
  {
    host: /(^|\.)tiktok\.com$/,
    endpoint: (pageUrl) => `https://www.tiktok.com/oembed?url=${encodeURIComponent(pageUrl)}`,
  },
  {
    // YouTube advertises its endpoint, but ~690 KB into a ~700 KB <head> — past
    // any sane body cap, so discovery only finds it on a full read. Knowing the
    // endpoint means a truncated fetch still yields a titled card.
    host: /(^|\.)(youtube\.com|youtu\.be)$/,
    endpoint: (pageUrl) =>
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(pageUrl)}`,
  },
];

/** A known oEmbed endpoint for this page, or undefined. */
export function knownOembedEndpoint(pageUrl: string): string | undefined {
  try {
    const host = new URL(pageUrl).hostname.toLowerCase();
    return KNOWN_OEMBED.find((p) => p.host.test(host))?.endpoint(pageUrl);
  } catch {
    return undefined;
  }
}

export interface OembedPayload {
  title?: string | undefined;
  author_name?: string | undefined;
  provider_name?: string | undefined;
  thumbnail_url?: string | undefined;
  type?: string | undefined;
  duration?: number | undefined;
}

/**
 * §5 tier 1 overlay. oEmbed outranks OG, so its fields overwrite — but only
 * where oEmbed actually has a value. `html` is deliberately ignored: rendering
 * third-party markup is out of scope for v1.
 */
export function applyOembed(base: HtmlMetadata, payload: OembedPayload, finalUrl: string): HtmlMetadata {
  const author = clean(payload.author_name, 100);
  const provider = clean(payload.provider_name, 100);
  // Video oEmbed often carries an empty `title` (the caption lives elsewhere).
  // Falling back to the page's <title> then yields the site's generic shell
  // title — "TikTok - Make Your Day" for every video. "<author> on <provider>"
  // is both truthful and useful, and matches how X titles its own pages.
  const authorTitle = !clean(payload.title, TITLE_MAX) && author && provider
    ? `${author} on ${provider}`
    : undefined;
  return {
    ...base,
    title: clean(payload.title, TITLE_MAX) ?? authorTitle ?? base.title,
    author: author ?? base.author,
    siteName: provider ?? base.siteName,
    imageUrl: absolute(payload.thumbnail_url, finalUrl) ?? base.imageUrl,
    // Vimeo and friends state it here; YouTube's oEmbed doesn't, which is why
    // the page's own `itemprop="duration"` is still read.
    durationSec: parseDurationSec(payload.duration?.toString()) ?? base.durationSec,
  };
}

/** §5: content-type → card type. Null means "no unfurl". */
export function cardTypeForContentType(contentType: string): UnfurlDTO['type'] | null {
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type === 'application/pdf') return 'file';
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'link';
  return null;
}

/**
 * §5: reject cards that would render empty. Without this a page with no
 * metadata produces a card containing nothing but its own URL.
 */
export function hasRenderableContent(meta: {
  title?: string | undefined;
  description?: string | undefined;
  imageUrl?: string | undefined;
}): boolean {
  return Boolean(meta.title || meta.description || meta.imageUrl);
}
