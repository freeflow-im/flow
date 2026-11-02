// Phase 11 §5 extension: providers whose links we can play inside Flow.
//
// The card's player is built HERE, from the video id we parsed out of the URL —
// never from the provider's oEmbed `html`. That keeps the sanitization boundary
// on the server: a client receives an id and a URL we constructed, so no
// third-party markup ever has to be trusted or stripped by four separate
// clients.

/** Providers we can play. One for now; the shape is the extension point. */
export type VideoProvider = 'youtube';

export interface VideoEmbed {
  provider: VideoProvider;
  /** The provider's own id for the video — clients may use it for artwork. */
  videoId: string;
  /** Player URL built by us. Carries no query, so clients append their own
   * (`?autoplay=1`) without having to merge parameters. */
  playerUrl: string;
  width?: number;
  height?: number;
}

/** YouTube ids are 11 chars today; bounded rather than exact so a format
 * change degrades to "no embed" instead of to an unbounded string in a URL. */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;

const YOUTUBE_HOST_RE = /(^|\.)(youtube\.com|youtube-nocookie\.com)$/;
const YOUTU_BE_RE = /(^|\.)youtu\.be$/;

/** Path forms that carry the id as the last segment: /shorts/ID, /embed/ID,
 * /live/ID, /v/ID. `watch` carries it in `?v=` instead. */
const YOUTUBE_PATH_PREFIXES = ['shorts', 'embed', 'live', 'v'];

function youtubeId(url: URL): string | undefined {
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);

  if (YOUTU_BE_RE.test(host)) return segments[0];
  if (!YOUTUBE_HOST_RE.test(host)) return undefined;
  if (segments[0] === 'watch') return url.searchParams.get('v') ?? undefined;
  if (segments.length >= 2 && YOUTUBE_PATH_PREFIXES.includes(segments[0]!.toLowerCase())) {
    return segments[1];
  }
  return undefined;
}

/**
 * The playable embed for a URL, or undefined when it isn't one we can play.
 *
 * `youtube-nocookie.com` on purpose: the player is only ever loaded after the
 * viewer asks for it, and even then we would rather not hand YouTube a
 * tracking cookie for someone who clicked play in a chat app.
 */
export function parseVideoEmbed(rawUrl: string | undefined): VideoEmbed | undefined {
  if (!rawUrl) return undefined;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;

  const id = youtubeId(url);
  if (!id || !VIDEO_ID_RE.test(id)) return undefined;
  return {
    provider: 'youtube',
    videoId: id,
    playerUrl: `https://www.youtube-nocookie.com/embed/${id}`,
    width: 1280,
    height: 720,
  };
}

/** Is this URL one we would build an embed for? Decided before the fetch, so
 * the page-size budget can be raised for it (see LIMITS.maxVideoPageBytes). */
export function isVideoPage(rawUrl: string): boolean {
  return parseVideoEmbed(rawUrl) !== undefined;
}

const ISO_DURATION_RE = /^P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i;

/**
 * Seconds from either shape a page might declare: bare seconds
 * (`og:video:duration`) or ISO-8601 (`<meta itemprop="duration"
 * content="PT3M34S">`, which is how YouTube states it).
 */
export function parseDurationSec(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const text = value.trim();
  if (!text) return undefined;

  if (/^\d+(\.\d+)?$/.test(text)) {
    const seconds = Math.round(Number(text));
    return seconds > 0 ? seconds : undefined;
  }

  const m = ISO_DURATION_RE.exec(text);
  if (!m) return undefined;
  const days = /^P(\d+)D/i.exec(text);
  const seconds =
    Number(days?.[1] ?? 0) * 86_400 +
    Number(m[1] ?? 0) * 3_600 +
    Number(m[2] ?? 0) * 60 +
    Math.round(Number(m[3] ?? 0));
  return seconds > 0 ? seconds : undefined;
}
