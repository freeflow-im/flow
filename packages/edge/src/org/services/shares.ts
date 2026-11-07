// The share index (docs/specs/platform.md §4.5, §4.6; phase 3.3): every grant an app object reports, kept in the Org
// object's `shares` table, so "shared with me" and the bus's visibility (events/core.ts' `ref:` audience) are answered
// here, and the sharing events, the notification and the channel card that follow a share.
//
// An app object (Docs, docs/object.ts) reports each grant change by binding (Org.recordShare / Org.revokeShare). The
// functions here run inside the Org object's scope (its database and its socket publisher): they write the index, post
// the card or the notice, and hand back the `sharing.*` event, which the object publishes into the event log.
import { AsyncLocalStorage } from 'node:async_hooks';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { parseReference, type Reference } from '@flow/shared';
import { ORG_PRINCIPAL, parsePrincipal, principalsOf, ROLE_RANK, type Role } from '@flow/shared/grants';
import type { Audience, PublishInput } from '../../events/core';
import { docsAddress } from '../../docs/addresses';
import { db, schema } from '../db/index.js';
import { createDm } from './channels.js';
import { postHuddleSystemMessage } from './messages.js';

const { shares, workspaceMembers, users, channels } = schema;

export interface RecordShareInput {
  /** The object's formatted reference, `<org>/<app>/<kind>/<id>`. */
  ref: string;
  principal: string;
  role: string;
  /** The granter's account. */
  grantedBy: string;
  title?: string;
  /** The kind of file: a document's kind (`sheet`, `deck`, `doc`, `markdown`), `file` or `folder`; Chat's `artifact`. */
  kind?: string;
  /** A grant that only moved (its object's reference changed, as a moved folder's does): indexed, with no notice again. */
  silent?: boolean;
}

export interface RevokeShareInput { ref: string; principal: string; revokedBy: string }

/** One row of "shared with me" (GET /v1/workspaces/:id/shared-with-me). */
export interface SharedItem { ref: string; kind: string; title: string; role: string; grantedBy: string; at: number; url: string }

/** Who reads the index: an account and the channels it is in. */
export interface ShareReader { accountId: string; channelIds: string[] }

/** Where a Chat object opens in the web client: an artifact by id. */
export function chatAddress(ref: Reference | null): string | null {
  return ref?.app === 'chat' && ref.kind === 'artifact' ? `/?open=${encodeURIComponent(`artifact:${ref.id}`)}` : null;
}

/** The address of a shared object (a Docs one, a Chat artifact; another app's has none yet). */
export const urlOf = (ref: Reference | null, fileKind: string): string | null => docsAddress(ref, fileKind) ?? chatAddress(ref);

/** Where a request in the Org object sends a sharing event (the object binds it to the Events object; tests, nowhere). */
export const shareEvents = new AsyncLocalStorage<(event: PublishInput) => Promise<void>>();

/** A grant Chat made in this object (services/artifacts.ts): indexed, announced, and its event published. */
export async function reportShare(input: RecordShareInput, webBase: string): Promise<void> {
  const event = await recordShare(input, webBase);
  if (event) await shareEvents.getStore()?.(event);
}

/** A grant Chat took away in this object: out of the index, and its event published. */
export async function reportRevoke(input: RevokeShareInput): Promise<void> {
  const event = await revokeShare(input);
  if (event) await shareEvents.getStore()?.(event);
}

/**
 * The audience of a sharing event: the principal itself when it is an account or a private channel; a public channel's
 * is the organization's, as its messages' are (eventLog.ts); the organization's is the organization's. A link's event goes
 * to its granter alone: its token is the credential, and the organization is not to learn it.
 */
async function audienceOf(principal: string, actor: string): Promise<Audience> {
  const p = parsePrincipal(principal);
  if (p.kind === 'account') return `account:${p.id!}`;
  if (p.kind === 'link') return `account:${actor}`;
  if (p.kind === 'channel') {
    const chan = (await db.select({ isPrivate: channels.isPrivate }).from(channels).where(eq(channels.id, p.id!)).limit(1))[0];
    return chan?.isPrivate ? `channel:${p.id!}` : 'org';
  }
  return 'org';
}

/** What a sharing event says of its principal: a link's token is left out. */
const shownPrincipal = (principal: string) => (principal.startsWith('link:') ? 'link' : principal);

async function userOfAccount(accountId: string): Promise<{ id: string; displayName: string } | null> {
  const row = await db
    .select({ id: users.id, displayName: users.displayName })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.accountId, accountId))
    .limit(1);
  return row[0] ?? null;
}

/**
 * A grant given or changed: the row upserted, then for a new share the notice: a DM line from the granter to an account
 * ("Ann shared Q4 plan with you", which notifies as a DM does), or the card in a channel ("Ann shared Q4 plan with this
 * channel"), each with the file's address on its own line. A role changed on an existing share posts nothing again.
 * Returns the `sharing.granted` event to publish, or null for a reference that does not parse.
 */
export async function recordShare(input: RecordShareInput, webBase: string): Promise<PublishInput | null> {
  const ref = parseReference(input.ref);
  if (!ref || !(input.role in ROLE_RANK)) return null;
  const title = input.title ?? '';
  const kind = input.kind ?? '';
  const at = Date.now();
  const before = await db.select({ role: shares.role }).from(shares).where(and(eq(shares.ref, input.ref), eq(shares.principal, input.principal))).limit(1);
  await db
    .insert(shares)
    .values({ ref: input.ref, principal: input.principal, role: input.role, grantedBy: input.grantedBy, title, kind, at })
    .onConflictDoUpdate({ target: [shares.ref, shares.principal], set: { role: input.role, grantedBy: input.grantedBy, title, kind, at } })
    .run();
  const url = urlOf(ref, kind) ?? '';
  if (!before[0] && !input.silent) await announce(ref.organizationId, input.principal, input.grantedBy, title || 'a file', `${webBase.replace(/\/+$/, '')}${url}`);
  return {
    type: 'sharing.granted',
    organizationId: ref.organizationId,
    actor: input.grantedBy,
    ref,
    audience: await audienceOf(input.principal, input.grantedBy),
    ts: new Date(at).toISOString(),
    data: { ref: input.ref, principal: shownPrincipal(input.principal), role: input.role, title, kind, url },
  };
}

/** The DM line or the channel card for a new share; best-effort, as the system lines are. */
async function announce(workspaceId: string, principal: string, grantedBy: string, title: string, link: string): Promise<void> {
  const p = parsePrincipal(principal);
  if (p.kind !== 'account' && p.kind !== 'channel') return;
  const actor = await userOfAccount(grantedBy);
  if (!actor) return;
  try {
    if (p.kind === 'account') {
      const target = await userOfAccount(p.id!);
      if (!target || target.id === actor.id) return;
      const dm = await createDm(workspaceId, actor.id, [target.id]);
      await postHuddleSystemMessage(dm, actor.id, 'file_shared', `${actor.displayName} shared ${title} with you\n${link}`);
    } else {
      const chan = (await db.select({ id: channels.id, workspaceId: channels.workspaceId }).from(channels).where(eq(channels.id, p.id!)).limit(1))[0];
      if (!chan) return;
      await postHuddleSystemMessage(chan, actor.id, 'file_shared', `${actor.displayName} shared ${title} with this channel\n${link}`);
    }
  } catch (err) {
    console.error(`[shares] notice for ${principal}: ${(err as Error).message}`);
  }
}

/** A grant taken away: the row removed, and the `sharing.revoked` event to publish (null for a reference that does not
 * parse). Nothing is posted. */
export async function revokeShare(input: RevokeShareInput): Promise<PublishInput | null> {
  const ref = parseReference(input.ref);
  if (!ref) return null;
  const gone = await db.delete(shares).where(and(eq(shares.ref, input.ref), eq(shares.principal, input.principal))).returning();
  const row = gone[0];
  const kind = row?.kind ?? '';
  return {
    type: 'sharing.revoked',
    organizationId: ref.organizationId,
    actor: input.revokedBy,
    ref,
    audience: await audienceOf(input.principal, input.revokedBy),
    ts: new Date().toISOString(),
    data: { ref: input.ref, principal: shownPrincipal(input.principal), role: null, title: row?.title ?? '', kind, url: urlOf(ref, kind) ?? '' },
  };
}

/** The principals a reader's shares are under: its account and its channels (not `org`, which is the organization's
 * root rather than something shared with this reader, as the grants library's "shared with me" has it). */
const principalsFor = (reader: ShareReader) => principalsOf(reader).filter((p) => p !== ORG_PRINCIPAL);

/** What is shared with the reader, newest first, one row per object with the highest role it is given. */
export async function sharedWith(reader: ShareReader): Promise<SharedItem[]> {
  const rows = await db.select().from(shares).where(inArray(shares.principal, principalsFor(reader))).orderBy(desc(shares.at));
  const best = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const had = best.get(r.ref);
    if (!had || ROLE_RANK[r.role as Role] > ROLE_RANK[had.role as Role]) best.set(r.ref, had ? { ...r, at: had.at } : r);
  }
  return [...best.values()].map((r) => ({ ref: r.ref, kind: r.kind, title: r.title, role: r.role, grantedBy: r.grantedBy, at: r.at, url: urlOf(parseReference(r.ref), r.kind) ?? '' }));
}

/** The references shared with the reader: what the bus lets through for a `ref:` audience. */
export async function sharedRefsOf(reader: ShareReader): Promise<string[]> {
  const rows = await db.selectDistinct({ ref: shares.ref }).from(shares).where(inArray(shares.principal, principalsFor(reader)));
  return rows.map((r) => r.ref);
}
