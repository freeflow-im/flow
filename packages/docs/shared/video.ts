// Videos placed in a presentation or a document. One is named by its address: a video among the user's
// stored files ("/api/files/<id>") or a YouTube video, kept as its watch address
// ("https://www.youtube.com/watch?v=<id>") whatever form of link was given.

/** The address of a stored file. */
export const STORED_FILE_RE = /^\/api\/files\/([0-9a-z]{12}|[0-9a-f-]{36})$/;

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/** The id of the YouTube video a link is to (a watch, short, embed, shorts or live link), or null. */
export function youtubeId(link: string): string | null {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(link.trim()) ? link.trim() : `https://${link.trim()}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = url.pathname.split('/')[1] ?? null;
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const [, first, second] = url.pathname.split('/');
    if (first === 'watch') id = url.searchParams.get('v');
    else if (first === 'embed' || first === 'shorts' || first === 'live' || first === 'v') id = second ?? null;
  }
  return id && YOUTUBE_ID.test(id) ? id : null;
}

export const youtubeWatchUrl = (id: string): string => `https://www.youtube.com/watch?v=${id}`;
/** The player, for a frame. */
export const youtubeEmbedUrl = (id: string, autoplay = false): string => `https://www.youtube-nocookie.com/embed/${id}${autoplay ? '?autoplay=1' : ''}`;
/** A still of the video. */
export const youtubePoster = (id: string): string => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

/** The address a video is kept under, from what a person gave (a YouTube link in any form, or a stored file's address); null if it is neither. */
export function videoAddress(input: string): string | null {
  const text = input.trim();
  if (STORED_FILE_RE.test(text)) return text;
  const id = youtubeId(text);
  return id ? youtubeWatchUrl(id) : null;
}

/** Returns an error message if `src` cannot be a video's address, or null if it is fine. */
export function checkVideo(src: unknown): string | null {
  if (typeof src === 'string' && (STORED_FILE_RE.test(src) || (youtubeId(src) !== null && src === youtubeWatchUrl(youtubeId(src)!)))) return null;
  return 'Video must be a stored video file (/api/files/<id>) or a YouTube link (https://www.youtube.com/watch?v=<id>)';
}
