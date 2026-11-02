// Phase 11 §7: the unfurl cache — positive entries, negative entries, and
// stale-while-revalidate.
import { and, eq, lt, sql } from 'drizzle-orm';
import type { UnfurlDTO } from '@flow/shared';
import { db } from '../../db/index.js';
import { unfurlCache } from '../../db/schema.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** §7 positive TTL clamp. */
export const TTL_MIN_MS = 1 * HOUR;
export const TTL_MAX_MS = 7 * DAY;
export const TTL_DEFAULT_MS = 24 * HOUR;

/** §7: serve an expired entry for up to 24h past TTL while a refresh runs. */
export const STALE_WINDOW_MS = 24 * HOUR;

/** §7 negative TTLs, by failure reason. */
export const NEGATIVE_TTL_MS: Record<string, number> = {
  http_404: 7 * DAY,
  http_410: 7 * DAY,
  http_401: DAY,
  http_403: DAY,
  robots: DAY,
  ssrf: 7 * DAY,
  denylisted: 7 * DAY,
  unsupported_type: 7 * DAY,
  empty: 7 * DAY,
  // transient
  http_5xx: 15 * 60 * 1000,
  timeout: 15 * 60 * 1000,
  network: 15 * 60 * 1000,
};

export function negativeTtlMs(reason: string): number {
  return NEGATIVE_TTL_MS[reason] ?? 15 * 60 * 1000;
}

/**
 * §7: TTL from `Cache-Control: max-age`, clamped to [1h, 7d]; 24h when the
 * header is absent or unparseable. `no-store`/`no-cache` still get the floor —
 * we must cache something or a popular link refetches on every mention.
 */
export function positiveTtlMs(cacheControl: string | undefined): number {
  if (!cacheControl) return TTL_DEFAULT_MS;
  const directives = cacheControl.toLowerCase();
  if (/\bno-store\b|\bno-cache\b/.test(directives)) return TTL_MIN_MS;
  const m = /\bmax-age\s*=\s*(\d+)/.exec(directives);
  if (!m) return TTL_DEFAULT_MS;
  const seconds = Number(m[1]);
  if (!Number.isFinite(seconds)) return TTL_DEFAULT_MS;
  return Math.min(TTL_MAX_MS, Math.max(TTL_MIN_MS, seconds * 1000));
}

export interface CacheHit {
  ok: boolean;
  failureReason: string | null;
  data: UnfurlDTO | null;
  expiresAt: Date;
  /** Past TTL but inside the stale window — usable, but kick off a refresh. */
  stale: boolean;
}

export async function readCache(urlHash: string): Promise<CacheHit | null> {
  const rows = await db.select().from(unfurlCache).where(eq(unfurlCache.urlHash, urlHash)).limit(1);
  const row = rows[0];
  if (!row) return null;
  const now = Date.now();
  const expiresAt = row.expiresAt;
  const age = now - expiresAt.getTime();
  if (age > STALE_WINDOW_MS) return null; // too old to serve at all
  return {
    ok: row.ok,
    failureReason: row.failureReason,
    data: (row.data as UnfurlDTO | null) ?? null,
    expiresAt,
    stale: age > 0,
  };
}

export async function writePositive(
  urlHash: string,
  normalizedUrl: string,
  data: UnfurlDTO,
  ttlMs: number,
): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlMs);
  await db
    .insert(unfurlCache)
    .values({ urlHash, normalizedUrl, ok: true, failureReason: null, data, expiresAt })
    .onConflictDoUpdate({
      target: unfurlCache.urlHash,
      set: { ok: true, failureReason: null, data, expiresAt, fetchedAt: sql`(unixepoch('subsec') * 1000)` },
    });
}

export async function writeNegative(
  urlHash: string,
  normalizedUrl: string,
  reason: string,
): Promise<void> {
  const expiresAt = new Date(Date.now() + negativeTtlMs(reason));
  await db
    .insert(unfurlCache)
    .values({ urlHash, normalizedUrl, ok: false, failureReason: reason, data: null, expiresAt })
    .onConflictDoUpdate({
      target: unfurlCache.urlHash,
      set: { ok: false, failureReason: reason, data: null, expiresAt, fetchedAt: sql`(unixepoch('subsec') * 1000)` },
    });
}

/** Housekeeping: drop entries past the stale window. */
export async function evictExpired(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_WINDOW_MS);
  const deleted = await db
    .delete(unfurlCache)
    .where(and(lt(unfurlCache.expiresAt, cutoff)))
    .returning({ urlHash: unfurlCache.urlHash });
  return deleted.length;
}
