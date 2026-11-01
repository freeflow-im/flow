// NATS seam (phase1.md §3). Core NATS only — JetStream deferred per decision log.
// Subjects:
//   ws.{workspaceId}.chan.{channelId}.msg
//   ws.{workspaceId}.chan.{channelId}.typing
//   ws.{workspaceId}.presence
//   ws.{workspaceId}.meta
//
// Optionally under a deployment prefix (`FLOW_BUS_PREFIX`), e.g.
// `staging.ws.{workspaceId}....` — see `busPrefix` below.
import { connect, type NatsConnection, type Subscription } from 'nats';
import type { Event } from '@flow/shared';
import { config } from './config.js';

let nc: NatsConnection | null = null;

/**
 * Namespace every subject for this deployment.
 *
 * Empty by default, which is every subject exactly as it has always been —
 * one deployment on one NATS needs nothing here.
 *
 * It exists for the case the multi-server spec warns about: "Never assume
 * UUIDs are globally unique across independent or cloned databases." Two Flow
 * deployments sharing a NATS cluster route on `ws.{workspaceId}...`, so a
 * *cloned* database — staging restored from production, a QA stack seeded from
 * a dump — publishes onto the subjects the original is listening on, and each
 * one's events surface in the other's clients. Independently generated UUIDs
 * never collide; cloned ones always do. A prefix is the cheap fix, and it is
 * the difference between "give it its own bus" and "get it wrong once".
 */
function prefixed(subject: string): string {
  return config.busPrefix ? `${config.busPrefix}.${subject}` : subject;
}

export async function connectBus(): Promise<NatsConnection> {
  if (!nc) {
    nc = await connect({ servers: config.natsUrl, name: 'flow-server' });
  }
  return nc;
}

export function subjectMsg(workspaceId: string, channelId: string): string {
  return prefixed(`ws.${workspaceId}.chan.${channelId}.msg`);
}
export function subjectTyping(workspaceId: string, channelId: string): string {
  return prefixed(`ws.${workspaceId}.chan.${channelId}.typing`);
}
export function subjectPresence(workspaceId: string): string {
  return prefixed(`ws.${workspaceId}.presence`);
}
export function subjectMeta(workspaceId: string): string {
  return prefixed(`ws.${workspaceId}.meta`);
}
/** Per-channel artifact stream (phase 13). Under the workspace wildcard so the
 * gateway forwards it, but NOT a `.meta` subject (those drive membership
 * bookkeeping). The event envelope carries channelId, so the gateway's
 * visible() filter delivers only to channel members — private-channel privacy
 * comes for free. */
export function subjectArtifact(workspaceId: string, channelId: string): string {
  return prefixed(`ws.${workspaceId}.chan.${channelId}.artifact`);
}
/** Per-channel activity-indicator stream (#137). Same shape and reasoning as
 * subjectArtifact: under the workspace wildcard so the gateway forwards it, not
 * a `.meta` subject, and channel-scoped so visible() handles privacy. */
export function subjectIndicator(workspaceId: string, channelId: string): string {
  return prefixed(`ws.${workspaceId}.chan.${channelId}.indicator`);
}
/** Per-channel emoji stream (#396). Same shape and reasoning as
 * subjectIndicator — the emoji is a channel-scoped property, so routing it
 * per channel lets visible() keep a private channel's decoration private. */
export function subjectChannelEmoji(workspaceId: string, channelId: string): string {
  return prefixed(`ws.${workspaceId}.chan.${channelId}.emoji`);
}
/** Per-channel voice-huddle stream (Phase 1). Same shape and reasoning as
 * subjectIndicator: under the workspace wildcard so the gateway forwards it,
 * not a `.meta` subject, and channel-scoped so visible() handles privacy. */
export function subjectHuddle(workspaceId: string, channelId: string): string {
  return prefixed(`ws.${workspaceId}.chan.${channelId}.huddle`);
}
/** Every huddle event, all workspaces — the replica roster-sync subscription
 * (phase 18 M2): huddle.updated carries the full roster, so replicas keep
 * their caches converged by applying each other's events. */
export function subjectHuddleAll(): string {
  return prefixed(`ws.*.chan.*.huddle`);
}
export function subjectWorkspaceAll(workspaceId: string): string {
  return prefixed(`ws.${workspaceId}.>`);
}
/** Replica presence heartbeat (phase 18 M2) — server-to-server, never
 * forwarded to clients (outside the `ws.*` wildcard the gateway subscribes). */
export function subjectPresenceSync(replicaId: string): string {
  return prefixed(`presence.sync.${replicaId}`);
}
export function subjectPresenceSyncAll(): string {
  return prefixed(`presence.sync.*`);
}
/** Per-user meta subject: tells a user's live sockets about workspace joins. */
export function subjectUserMeta(userId: string): string {
  return prefixed(`user.${userId}.meta`);
}
/**
 * Per-user notification subject (phase2.md §4). User-global rather than
 * workspace-scoped — approved deviation (decision log 2026-07-18): matches the
 * user.{id}.meta pattern, one subscription per socket; the event envelope
 * already carries workspaceId/channelId.
 */
export function subjectUserNotify(userId: string): string {
  return prefixed(`user.${userId}.notify`);
}

export function publishEvent(subject: string, event: Event): void {
  // Fire-and-forget: core NATS, loss-tolerant — clients backfill over REST.
  if (!nc) return; // bus optional in unit tests
  try {
    nc.publish(subject, JSON.stringify(event));
  } catch {
    /* never fail the request path on fan-out */
  }
}

export function subscribeBus(subject: string, opts?: { queue?: string }): Subscription {
  if (!nc) throw new Error('bus not connected');
  return nc.subscribe(subject, opts?.queue ? { queue: opts.queue } : undefined);
}

/**
 * Request/reply (phase 18 M3, Socket Mode routing). Returns the parsed JSON
 * reply, or null when the bus is not connected (unit tests, degraded boot) —
 * the caller treats null like "nobody answered". NATS errors (no responders,
 * timeout) propagate; the caller maps them.
 */
export async function requestBus(subject: string, payload: unknown, timeoutMs: number): Promise<unknown | null> {
  if (!nc) return null;
  const m = await nc.request(subject, JSON.stringify(payload), { timeout: timeoutMs });
  return JSON.parse(new TextDecoder().decode(m.data)) as unknown;
}

export async function closeBus(): Promise<void> {
  if (nc) {
    await nc.drain().catch(() => {});
    nc = null;
  }
}
