import type { ConnectionRuntime } from '../lib/connectionRuntime';
import { useBoundApi } from '../lib/useBoundApi';
// Initials-on-color avatar chips (design 3a) with real-image fallback, and the
// bearer-auth <img> helper shared by attachments and profile views.
import { useEffect, useState } from 'react';
import { blobUrl, cachedBlobUrl } from '../lib/api';

/* Design 3a avatar palette (bg / text), extended with two matching pairs. */
const PALETTE: [string, string][] = [
  ['#e9c8b0', '#7a4d2b'],
  ['#bcd0e9', '#2b527a'],
  ['#cbe3c9', '#3a6b3a'],
  ['#ffb547', '#5a3a00'],
  ['#e3c9e0', '#6b2b62'],
  ['#f0e0a8', '#6e5a14'],
];

function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '?';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

export function chipColors(userId: string): [string, string] {
  return PALETTE[hash(userId) % PALETTE.length]!;
}

export function Avatar({
  userId,
  name,
  avatarUrl,
  size = 38,
  radius = 11,
  className = '',
}: {
  userId: string;
  name: string;
  avatarUrl?: string | null;
  size?: number;
  radius?: number;
  className?: string;
}) {
  const style = { width: size, height: size, borderRadius: radius };
  if (avatarUrl) {
    return (
      <AuthImg path={avatarUrl} alt={name} className={`shrink-0 object-cover ${className}`} style={style} />
    );
  }
  const [bg, fg] = chipColors(userId);
  return (
    <span
      className={`flex shrink-0 items-center justify-center font-extrabold select-none ${className}`}
      style={{ ...style, background: bg, color: fg, fontSize: Math.round(size * 0.37) }}
    >
      {initials(name)}
    </span>
  );
}

export function AuthImg({
  path,
  alt,
  className,
  style,
  runtime,
}: {
  path: string;
  alt: string;
  className?: string;
  style?: React.CSSProperties;
  /** Load through this connection instead of the one on screen — a workspace
   * avatar in the switcher belongs to its own server. */
  runtime?: ConnectionRuntime;
}) {
  const bound = useBoundApi();
  const blobUrl = runtime ? runtime.blobUrl.bind(runtime) : bound.blobUrl;
  const cachedBlobUrl = runtime ? runtime.cachedBlobUrl.bind(runtime) : bound.cachedBlobUrl;
  const [url, setUrl] = useState<string | null>(() => cachedBlobUrl(path) ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setFailed(false);
    // An absolute URL is another origin's public image: hand
    // it to the element as-is. The authenticated blob path is for our backend
    // only — it must never carry a bearer to a foreign origin.
    if (/^https?:\/\//.test(path)) { setUrl(path); return; }
    const cached = cachedBlobUrl(path);
    if (cached) { setUrl(cached); return; }
    setUrl(null);
    void blobUrl(path)
      .then((u) => { if (alive) setUrl(u); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [path]);
  if (failed) {
    return (
      <span
        role="img"
        aria-label={`${alt || 'Image'} unavailable`}
        title={`${alt || 'Image'} unavailable`}
        className={`inline-flex items-center justify-center rounded-lg bg-daypill text-faint ${className ?? ''}`}
        style={style}
      >
        !
      </span>
    );
  }
  if (!url) {
    return (
      <span
        role="status"
        aria-label={`Loading ${alt || 'image'}`}
        className={`inline-block animate-pulse rounded-lg bg-daypill ${className ?? ''}`}
        style={style}
      />
    );
  }
  return <img src={url} alt={alt} className={className} style={style} onError={() => setFailed(true)} />;
}
