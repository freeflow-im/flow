// References resolved for a reader, in the Org object (docs/specs/platform.md §5.3, phase 6.4): Chat's own kinds from its
// tables and the one access function (org/access.ts), and any other app's object from the share index when it is shared
// with the reader. What the index does not hold is handed back as `ask`, for the route to ask the owning app
// (routes/references.ts). What the reader may not see is `denied`, never a title.
import { eq } from 'drizzle-orm';
import { parseReference } from '@flow/shared';
import { addressOf, iconOf, type ResolvedReference } from '@flow/shared/addresses';
import { maxRole, type Role } from '@flow/shared/grants';
import { accessOf, readerFor, type ChatReader } from '../access.js';
import { db, schema } from '../db/index.js';
import { getMessageById } from './messages.js';
import { sharesOf } from './shares.js';
import { inList } from '../sqlList.js';

const { artifacts, channels, files, users } = schema;

/** The Org object's answer for one reference: resolved, denied, or another app's to answer. */
export type OrgReferenceAnswer = ResolvedReference | { ref: string; ask: true };

/** At most this many references in one call. */
export const MAX_REFERENCES = 50;

/** How much of a message a chip shows. */
const SUMMARY_CHARS = 140;

const denied = (ref: string): ResolvedReference => ({ ref, denied: true });

/** A channel's role for the reader: its chain's, or viewer of a public channel, which every member may read. */
async function channelRole(reader: ChatReader, chan: { id: string; isPrivate: boolean }): Promise<Role | null> {
  return maxRole(await accessOf(reader, 'channel', chan.id), chan.isPrivate ? null : 'viewer');
}

/** What a channel is called on a chip: `#name`, or a DM's. */
const channelTitle = (chan: { name: string | null }) => (chan.name ? `#${chan.name}` : 'Direct message');

async function chatReference(reader: ChatReader, ref: string, kind: string, id: string): Promise<ResolvedReference> {
  const base = { ref, app: 'chat', kind, icon: iconOf('chat', kind), url: addressOf({ app: 'chat', kind, id }) ?? '' };
  if (kind === 'channel') {
    const chan = (await db.select().from(channels).where(eq(channels.id, id)).limit(1))[0];
    const role = chan && chan.workspaceId === reader.workspaceId ? await channelRole(reader, chan) : null;
    return chan && role ? { ...base, title: channelTitle(chan), role } : denied(ref);
  }
  if (kind === 'artifact') {
    const row = (await db.select({ name: artifacts.name, channel: channels.name }).from(artifacts).innerJoin(channels, eq(channels.id, artifacts.channelId)).where(eq(artifacts.id, id)).limit(1))[0];
    const role = row ? await accessOf(reader, 'artifact', id) : null;
    return row && role ? { ...base, title: row.name, role, ...(row.channel ? { summary: `in #${row.channel}` } : {}) } : denied(ref);
  }
  if (kind === 'file') {
    const row = (await db.select({ name: files.name }).from(files).where(eq(files.id, id)).limit(1))[0];
    const role = row ? await accessOf(reader, 'file', id) : null;
    return row && role ? { ...base, title: row.name, role } : denied(ref);
  }
  if (kind === 'message') {
    const msg = await getMessageById(id);
    const chan = msg && !msg.deletedAt ? (await db.select().from(channels).where(eq(channels.id, msg.channelId)).limit(1))[0] : undefined;
    const role = chan && chan.workspaceId === reader.workspaceId ? await channelRole(reader, chan) : null;
    if (!msg || !chan || !role) return denied(ref);
    // Mentions are stored as <@userId>: shown by name, as the clients draw them.
    const mentioned = [...msg.body.matchAll(/<@([^>]+)>/g)].map((m) => m[1]!);
    const names = new Map((mentioned.length ? await db.select({ id: users.id, name: users.displayName }).from(users).where(inList(users.id, mentioned)) : []).map((u) => [u.id, u.name]));
    const author = (await db.select({ name: users.displayName }).from(users).where(eq(users.id, msg.userId)).limit(1))[0]?.name ?? 'someone';
    const text = msg.body.replace(/<@([^>]+)>/g, (_, u: string) => `@${names.get(u) ?? 'someone'}`).replace(/<!(channel|here|everyone)>/g, '@$1').replace(/\s+/g, ' ').trim();
    return { ...base, title: `Message from ${author} in ${channelTitle(chan)}`, role, ...(text ? { summary: text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS - 1)}…` : text } : {}) };
  }
  return denied(ref);
}

/**
 * The references, in the order asked, for `userId` in this organization: Chat's resolved here; another app's from the
 * share index when shared with the reader (the organization's grants included), else `ask`. A reference of another
 * organization, or one that does not parse, is denied. Throws (404) when the user is not a member.
 */
export async function resolveInOrg(userId: string, workspaceId: string, refs: string[]): Promise<OrgReferenceAnswer[]> {
  const reader = await readerFor(userId, workspaceId);
  const parsed = refs.map((ref) => ({ ref, r: parseReference(ref) }));
  const others = parsed.filter(({ r }) => r && r.organizationId === workspaceId && r.app !== 'chat').map(({ ref }) => ref);
  const shared = await sharesOf(reader, others);
  return Promise.all(parsed.map(async ({ ref, r }): Promise<OrgReferenceAnswer> => {
    if (!r || r.organizationId !== workspaceId) return denied(ref);
    if (r.app === 'chat') return chatReference(reader, ref, r.kind, r.id);
    const s = shared.get(ref);
    if (!s) return { ref, ask: true };
    const fileKind = r.app === 'docs' && r.kind !== 'folder' ? s.kind || undefined : undefined;
    return {
      ref, app: r.app, kind: r.kind, title: s.title || 'Untitled', role: s.role, icon: iconOf(r.app, r.kind, fileKind),
      url: addressOf(r, s.kind) ?? '', ...(fileKind ? { fileKind } : {}),
    };
  }));
}
