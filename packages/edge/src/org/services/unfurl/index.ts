// Phase 11: orchestration — message in, cards out.
//
// The send path calls `scheduleForMessage` and returns immediately (§1: send
// never blocks). The queue does the work and, when a message gains cards,
// republishes it as `message.updated` so connected clients patch in place.
import { and, eq, gt, isNull, inArray } from 'drizzle-orm';
import type { MessageDTO, UnfurlDTO } from '@flow/shared';
import { config } from '../../config.js';
import { db } from '../../db/index.js';
import {
  channels,
  messages as messagesTable,
  messageUnfurls,
  unfurlDomainDenylist,
  users,
  workspaces,
} from '../../db/schema.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { publishEvent, subjectMsg } from '../../bus.js';
import { blobStore } from '../../storage/index.js';
import { readCache, positiveTtlMs, writeNegative, writePositive } from './cache.js';
import {
  applyOembed,
  cardTypeForContentType,
  extractHtmlMetadata,
  hasRenderableContent,
  knownOembedEndpoint,
} from './extract.js';
import { FetchError, guardedFetch, LIMITS } from './fetcher.js';
import { layoutFor, proxyImage, UNFURL_IMAGE_KEY_RE } from './images.js';
import { isAllowed as robotsAllows } from './robots.js';
import { SsrfError } from './ssrf.js';
import { isAllowedByAllowlist, isDenied, UnfurlQueue } from './queue.js';
import { CHANNEL_SUPPRESSION_MS, extractUrls, urlHash } from './urls.js';
import { parseVideoEmbed } from './video.js';

const queue = new UnfurlQueue();

/** Test seam + graceful shutdown. */
export function stopUnfurlQueue(): void {
  queue.stop();
}

function log(message: string): void {
  console.log(`[unfurl] ${message}`);
}

/** Map a thrown error to the §7 negative-cache reason. */
function reasonFor(err: unknown): string {
  if (err instanceof SsrfError) return 'ssrf';
  if (err instanceof FetchError) return err.reason === 'network' ? 'network' : err.reason;
  return 'network';
}

function isRetryable(err: unknown): boolean {
  // §9: retry transient failures only — never 4xx, robots, or SSRF.
  if (err instanceof SsrfError) return false;
  if (err instanceof FetchError) return err.reason === 'timeout' || err.reason === 'network' || err.reason === 'http_5xx';
  return false;
}

/**
 * Fetch + extract one URL into a card. Throws on failure; the caller decides
 * whether to retry and what to negative-cache.
 */
export async function buildUnfurl(normalizedUrl: string): Promise<UnfurlDTO> {
  const deadline = Date.now() + LIMITS.totalTimeoutMs;
  const hash = urlHash(normalizedUrl);

  // §3 robots, off by default — operator ruling 2026-07-22 (decision_log.md):
  // a link a user pasted is not crawling, and every big social site
  // blanket-disallows unknown agents. Re-enable with
  // FLOW_UNFURL_RESPECT_ROBOTS=1 if our egress starts getting blocked.
  if (config.unfurlRespectRobots && !(await robotsAllows(normalizedUrl, deadline))) {
    throw new FetchError('robots.txt disallows', 'robots');
  }

  // Recognized from the URL alone, before the fetch — a playable page gets the
  // larger head budget (see LIMITS.maxVideoPageBytes).
  let embed = parseVideoEmbed(normalizedUrl);

  const res = await guardedFetch(normalizedUrl, {
    stopAt: '</head>',
    deadline,
    ...(embed ? { maxBytes: LIMITS.maxVideoPageBytes } : {}),
  });
  if (res.status === 404 || res.status === 410) throw new FetchError('gone', `http_${res.status}`, res.status);
  if (res.status === 401 || res.status === 403) throw new FetchError('denied', `http_${res.status}`, res.status);
  if (res.status >= 500) throw new FetchError(`upstream ${res.status}`, 'http_5xx', res.status);
  if (res.status >= 400) throw new FetchError(`upstream ${res.status}`, `http_${res.status}`, res.status);

  const type = cardTypeForContentType(res.contentType);
  if (!type) throw new FetchError(`unsupported type ${res.contentType}`, 'unsupported_type');

  const now = new Date().toISOString();
  const base: UnfurlDTO = {
    url: normalizedUrl,
    urlHash: hash,
    type,
    fetchedAt: now,
    expiresAt: new Date(Date.now() + positiveTtlMs(res.headers['cache-control'])).toISOString(),
  };

  // §5: non-HTML types are media/file cards with no page to parse.
  if (type !== 'link') {
    const name = decodeURIComponent(new URL(res.finalUrl).pathname.split('/').pop() || '') || undefined;
    return {
      ...base,
      layout: type === 'image' ? 'large_image' : 'media',
      ...(name ? { title: name } : {}),
      canonicalUrl: res.finalUrl,
    };
  }

  let meta = extractHtmlMetadata(res.body, res.finalUrl);
  // A shortener, or a host we don't match, is only recognizable once the
  // redirects have played out.
  embed ??= parseVideoEmbed(res.finalUrl) ?? parseVideoEmbed(meta.canonicalUrl);
  const ogImageUrl = meta.imageUrl;

  // §5 tier 1: oEmbed outranks everything, but costs another round trip.
  // Fall back to a known endpoint for providers whose pages don't advertise
  // one (TikTok serves a JS shell to non-browsers) — see knownOembedEndpoint.
  const oembedHref = meta.oembedHref ?? knownOembedEndpoint(res.finalUrl);
  if (oembedHref) {
    try {
      const oe = await guardedFetch(oembedHref, {
        accept: 'application/json',
        maxBytes: LIMITS.maxJsonBytes,
        deadline,
      });
      if (oe.status >= 200 && oe.status < 300) {
        meta = applyOembed(meta, JSON.parse(oe.body) as Record<string, never>, res.finalUrl);
      }
    } catch {
      /* oEmbed is an enhancement — never fail the card over it */
    }
  }

  // Video oEmbed thumbnails are the small square-ish artwork (YouTube's is a
  // 4:3 `hqdefault`, pillarboxed); og:image is the 16:9 master. A play card is
  // mostly picture, so prefer the master where the page offered one — and fall
  // back to oEmbed for providers that publish no og:image at all.
  if (embed && ogImageUrl) meta = { ...meta, imageUrl: ogImageUrl };

  if (!hasRenderableContent(meta)) throw new FetchError('no renderable metadata', 'empty');

  // §6: never hotlink — fetch, validate, re-encode and store the image behind
  // our own URL. Returns null on any problem, leaving a text-only card.
  //
  // The favicon goes through the same pipeline (§8 shows favicon_url as an
  // internal URL): pointing clients at a third-party favicon would leak every
  // viewer's IP to that origin on every render. Note this drops .ico favicons —
  // sharp can't decode ICO — so those cards show the site name without a mark.
  const [image, favicon] = await Promise.all([
    meta.imageUrl ? proxyImage(meta.imageUrl, deadline) : null,
    meta.faviconUrl ? proxyImage(meta.faviconUrl, deadline) : null,
  ]);
  // Recompute the layout hint from the real decoded dimensions: og:image:width
  // is frequently absent (X gives none at all), so the metadata-only guess
  // under-reports large images.
  const layout = image
    ? layoutFor(image.width, image.height, meta.layout === 'large_image')
    : meta.layout;

  return {
    ...base,
    canonicalUrl: meta.canonicalUrl ?? res.finalUrl,
    // A playable page is a video card whatever its content type said, and it
    // always renders large — a play badge on an 80px chip is unhittable.
    ...(embed ? { type: 'video' as const, embed, layout: 'large_image' as const } : { layout }),
    ...(meta.durationSec || embed
      ? {
          media: {
            ...(embed ? { provider: embed.provider } : {}),
            ...(meta.durationSec ? { durationSec: meta.durationSec } : {}),
          },
        }
      : {}),
    ...(image
      ? {
          image: {
            url: image.url,
            thumbUrl: image.thumbUrl,
            width: image.width,
            height: image.height,
            ...(meta.imageAlt ? { alt: meta.imageAlt } : {}),
          },
        }
      : {}),
    ...(meta.siteName ? { siteName: meta.siteName } : {}),
    // the proxied favicon, never the remote one
    ...(favicon ? { faviconUrl: favicon.thumbUrl } : {}),
    ...(meta.title ? { title: meta.title } : {}),
    ...(meta.description ? { description: meta.description } : {}),
    ...(meta.author ? { author: meta.author } : {}),
    ...(meta.publishedAt ? { publishedAt: meta.publishedAt } : {}),
  };
}

interface Gate {
  workspaceId: string;
  denylist: string[];
  allowlist: string[] | null;
}

/** §10: workspace switch, allowlist mode, denylist, per-user opt-out. */
async function gateFor(channelId: string, userId: string): Promise<Gate | null> {
  const rows = await db
    .select({
      workspaceId: channels.workspaceId,
      enabled: workspaces.unfurlEnabled,
      allowlist: workspaces.unfurlDomainAllowlist,
      userOptIn: users.unfurlOwnLinks,
    })
    .from(channels)
    .innerJoin(workspaces, eq(workspaces.id, channels.workspaceId))
    .innerJoin(users, eq(users.id, userId))
    .where(eq(channels.id, channelId))
    .limit(1);
  const row = rows[0];
  if (!row || !row.enabled || !row.userOptIn) return null;
  const denyRows = await db.select({ domain: unfurlDomainDenylist.domain }).from(unfurlDomainDenylist);
  return {
    workspaceId: row.workspaceId,
    denylist: denyRows.map((d) => d.domain),
    allowlist: row.allowlist ?? null,
  };
}

/** §1: was this URL already unfurled in this channel in the last 6h? */
async function recentlyUnfurledInChannel(channelId: string, hash: string): Promise<boolean> {
  const since = new Date(Date.now() - CHANNEL_SUPPRESSION_MS);
  const rows = await db
    .select({ messageId: messageUnfurls.messageId })
    .from(messageUnfurls)
    .where(
      and(
        eq(messageUnfurls.channelId, channelId),
        eq(messageUnfurls.urlHash, hash),
        gt(messageUnfurls.createdAt, since),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Re-read the message and republish it so clients patch in the new cards. */
async function republish(messageId: string): Promise<void> {
  const { getMessageById } = await import('../messages.js');
  const dto = await getMessageById(messageId);
  if (!dto) return;
  const chan = await db.select().from(channels).where(eq(channels.id, dto.channelId)).limit(1);
  const workspaceId = chan[0]?.workspaceId;
  if (!workspaceId) return;
  publishEvent(subjectMsg(workspaceId, dto.channelId), {
    type: 'message.updated',
    workspaceId,
    channelId: dto.channelId,
    ts: new Date().toISOString(),
    data: dto,
  });
}

/**
 * §1: extract candidate links and queue them. Never throws — a failure here
 * must not affect the message that triggered it.
 */
export async function scheduleForMessage(msg: MessageDTO): Promise<void> {
  try {
    const urls = extractUrls(msg.body);
    if (urls.length === 0) return;
    const gate = await gateFor(msg.channelId, msg.userId);
    if (!gate) return;

    let position = 0;
    for (const url of urls) {
      const hash = urlHash(url);
      const host = new URL(url).hostname;
      if (isDenied(host, gate.denylist)) continue;
      if (!isAllowedByAllowlist(host, gate.allowlist)) continue;
      // §10 tombstone: the sender already removed this card from this message.
      const tomb = await db
        .select({ deletedAt: messageUnfurls.deletedAt })
        .from(messageUnfurls)
        .where(and(eq(messageUnfurls.messageId, msg.id), eq(messageUnfurls.urlHash, hash)))
        .limit(1);
      if (tomb[0]?.deletedAt) continue;
      if (tomb.length > 0) continue; // already attached
      if (await recentlyUnfurledInChannel(msg.channelId, hash)) continue;

      const slot = position++;
      queue.enqueue({
        key: `${msg.id}:${hash}`,
        host,
        retryable: isRetryable,
        run: async () => {
          const cached = await readCache(hash);
          if (cached && !cached.stale) {
            if (!cached.ok) return; // negative cache — silent, per §9
            await attach(msg, hash, slot);
            return;
          }
          try {
            const card = await buildUnfurl(url);
            await writePositive(hash, url, card, new Date(card.expiresAt).getTime() - Date.now());
            await attach(msg, hash, slot);
          } catch (err) {
            await writeNegative(hash, url, reasonFor(err));
            throw err; // let the queue decide about retrying
          }
        },
        onError: (err) => log(`${url}: ${(err as Error).message}`),
      });
    }
  } catch (err) {
    log(`scheduling failed for ${msg.id}: ${(err as Error).message}`);
  }
}

async function attach(msg: MessageDTO, hash: string, position: number): Promise<void> {
  await db
    .insert(messageUnfurls)
    .values({ messageId: msg.id, urlHash: hash, channelId: msg.channelId, position })
    .onConflictDoNothing();
  await republish(msg.id);
}

/** Cards for a page of messages, honouring tombstones and cache expiry. */
export async function unfurlsForMessages(messageIds: string[]): Promise<Map<string, UnfurlDTO[]>> {
  const out = new Map<string, UnfurlDTO[]>();
  if (messageIds.length === 0) return out;
  const rows = await db
    .select({
      messageId: messageUnfurls.messageId,
      urlHash: messageUnfurls.urlHash,
      position: messageUnfurls.position,
    })
    .from(messageUnfurls)
    .where(and(inArray(messageUnfurls.messageId, messageIds), isNull(messageUnfurls.deletedAt)))
    .orderBy(messageUnfurls.position);
  if (rows.length === 0) return out;

  const hashes = [...new Set(rows.map((r) => r.urlHash))];
  const cached = await Promise.all(hashes.map(async (h) => [h, await readCache(h)] as const));
  const byHash = new Map(cached);
  for (const row of rows) {
    const hit = byHash.get(row.urlHash);
    if (!hit?.ok || !hit.data) continue;
    const list = out.get(row.messageId) ?? [];
    list.push(hit.data);
    out.set(row.messageId, list);
  }
  return out;
}

/** §10: sender removes one card. Writes a tombstone so it can't come back. */
export async function deleteUnfurl(messageId: string, hash: string): Promise<void> {
  await db
    .update(messageUnfurls)
    .set({ deletedAt: new Date() })
    .where(and(eq(messageUnfurls.messageId, messageId), eq(messageUnfurls.urlHash, hash)));
  await republish(messageId);
}

/**
 * §10 with authorization: only the message's author may remove its cards
 * ("per-message: sender can delete an individual unfurl").
 */
export async function deleteUnfurlAsUser(messageId: string, hash: string, userId: string): Promise<void> {
  const rows = await db
    .select({ userId: messagesTable.userId })
    .from(messagesTable)
    .where(eq(messagesTable.id, messageId))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound('message not found');
  if (row.userId !== userId) throw forbidden('only the author can remove a link preview');
  await deleteUnfurl(messageId, hash);
}

/** §6: serve a stored preview image. The key is a content hash + size, so the
 * regex is the whole validation — nothing user-supplied reaches the store. */
export async function getUnfurlImage(key: string): Promise<Buffer> {
  if (!UNFURL_IMAGE_KEY_RE.test(key)) throw notFound('image not found');
  try {
    return await blobStore().get(`unfurl-images/${key}`);
  } catch {
    throw notFound('image not found');
  }
}

export { queue as unfurlQueue };
