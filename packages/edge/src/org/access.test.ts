// One function answers Chat (org/access.ts; platform.md §4.4, phase 3.4): the role `effectiveRole` gives over an
// artifact's or a file's chain agrees with the membership checks Chat made before it, and an explicit grant lets someone
// outside the channel open an artifact by id, with the share index told.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDTO, Event, MessageDTO } from '@flow/shared';
import { GRANTS_DDL } from '@flow/shared/grants';
import { orgStorage } from '../../test/orgStorage';
import { accessOf, readerFor, requireRole } from './access';
import { withPublisher } from './bus';
import { withDb, schema, type DB } from './db/index';
import { ORG_MIGRATIONS } from './db/migrations';
import { directoryLink } from './directoryLink';
import { ApiError } from './lib/errors';
import { createArtifact, deleteArtifact, getArtifact, grantArtifact, listArtifactGrants, mintArtifactAppToken, renameArtifact, revokeArtifactGrant, rotateArtifactAppSecret } from './services/artifacts';
import { createChannel, joinChannel } from './services/channels';
import { requireFileAccess } from './services/files';
import { sendMessage } from './services/messages';
import { shareEvents, sharedWith } from './services/shares';
import { accountForJoin, createWorkspace, enrollInWorkspace } from './services/workspaces';
import type { PublishInput } from '../events/core';

const ANN = '00000000-0000-7000-8000-00000000000a'; // workspace owner
const BOB = '00000000-0000-7000-8000-00000000000b'; // member
const CAT = '00000000-0000-7000-8000-00000000000c'; // workspace admin
const DAN = '00000000-0000-7000-8000-00000000000d'; // member of no channel but #general
const OUT = '00000000-0000-7000-8000-00000000000e'; // not in the workspace
const acct = (u: string) => `acct-${u.slice(-1)}`;

beforeAll(() => { process.env.FLOW_DATA_KEY = randomBytes(32).toString('base64'); });

let db: DB;
let ws: string;
let pub: string;
let secret: string;
let published: { subject: string; event: Event }[];
let shareEventsOut: PublishInput[];

const run = <T>(fn: () => Promise<T>) => directoryLink.run({
  ensureAccount: async (organizationId, userId, role, displayName) =>
    ({ id: acct(userId), principalId: userId, organizationId, address: `${displayName.toLowerCase()}@acme.freeflow.im`, displayName, role, kind: 'native', state: 'active', createdAt: '' }) satisfies AccountDTO,
}, () => shareEvents.run(async (e) => void shareEventsOut.push(e), () => withPublisher((subject: string, event: Event) => void published.push({ subject, event }), () => withDb(db, fn))));

/** An outcome as the routes answer it: `ok`, or the error's status. */
const outcome = (p: Promise<unknown>): Promise<'ok' | number> => p.then(() => 'ok' as const, (e: unknown) => {
  if (e instanceof ApiError) return e.statusCode;
  throw e;
});

// ---- the checks Chat made before phase 3.4, verbatim in effect -------------------------------------------------------

/** `requireChannelAccess` then "is a member" (artifacts.ts' requireChannelMember): ok, 403 or 404. */
async function oldChannelMember(channelId: string, userId: string): Promise<'ok' | number> {
  const chan = db.select().from(schema.channels).where(eq(schema.channels.id, channelId)).get();
  if (!chan) return 404;
  if (!db.select().from(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.workspaceId, chan.workspaceId), eq(schema.workspaceMembers.userId, userId))).get()) return 404;
  const isMember = !!db.select().from(schema.channelMembers).where(and(eq(schema.channelMembers.channelId, channelId), eq(schema.channelMembers.userId, userId))).get();
  if (chan.isPrivate && !isMember) return 404;
  return isMember ? 'ok' : 403;
}

/** requireArtifactMember: the artifact, then a member of its channel. */
async function oldArtifact(artifactId: string, userId: string): Promise<'ok' | number> {
  const a = db.select().from(schema.artifacts).where(eq(schema.artifacts.id, artifactId)).get();
  return a ? oldChannelMember(a.channelId, userId) : 404;
}

/** rotateArtifactAppSecret's gate: a member, and the creator or a workspace owner/admin. */
async function oldRotate(artifactId: string, userId: string): Promise<'ok' | number> {
  const base = await oldArtifact(artifactId, userId);
  if (base !== 'ok') return base;
  const a = db.select().from(schema.artifacts).where(eq(schema.artifacts.id, artifactId)).get()!;
  const m = db.select().from(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.workspaceId, a.workspaceId), eq(schema.workspaceMembers.userId, userId))).get();
  return a.createdBy === userId || m?.role === 'owner' || m?.role === 'admin' ? 'ok' : 403;
}

/** requireFileAccess: the uploader; else a workspace member who can access a channel it is pinned or attached in. */
async function oldFile(fileId: string, userId: string): Promise<'ok' | number> {
  const f = db.select().from(schema.files).where(eq(schema.files.id, fileId)).get();
  if (!f) return 404;
  if (f.userId === userId) return 'ok';
  if (!db.select().from(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.workspaceId, f.workspaceId), eq(schema.workspaceMembers.userId, userId))).get()) return 404;
  const channelsOf = [
    ...db.select({ c: schema.artifacts.channelId }).from(schema.artifacts).where(eq(schema.artifacts.fileId, fileId)).all(),
    ...db.select({ c: schema.messages.channelId }).from(schema.messageFiles).innerJoin(schema.messages, eq(schema.messages.id, schema.messageFiles.messageId)).where(eq(schema.messageFiles.fileId, fileId)).all(),
  ];
  for (const { c } of channelsOf) {
    const r = await oldChannelMember(c, userId);
    if (r === 'ok' || r === 403) return 'ok'; // requireChannelAccess passes a public channel's non-member
  }
  return 404;
}

const fileRow = (id: string, userId: string) => db.insert(schema.files).values({ id, workspaceId: ws, userId, name: `${id}.txt`, mimeType: 'text/plain', sizeBytes: 1, storageKey: `files/${id}` }).run();

let pubApp: string; // Bob's, in the public channel
let secretApp: string; // Ann's, in the private channel
let secretDoc: string; // a file artifact in the private channel
const FILES = { pubAttached: '00000000-0000-7000-8000-0000000000f1', secretPinned: '00000000-0000-7000-8000-0000000000f2', loose: '00000000-0000-7000-8000-0000000000f3' };

beforeEach(async () => {
  ({ db } = orgStorage());
  published = [];
  shareEventsOut = [];
  await run(async () => {
    for (const [id, name] of [[ANN, 'Ann'], [BOB, 'Bob'], [CAT, 'Cat'], [DAN, 'Dan'], [OUT, 'Out']]) db.insert(schema.users).values({ id, email: `${name}@x.test`, passwordHash: '!', displayName: name }).run();
    ws = (await createWorkspace(ANN, 'Acme', 'acme')).id;
    for (const id of [BOB, CAT, DAN]) {
      const account = await accountForJoin(ws, id);
      await db.transaction((tx) => enrollInWorkspace(tx, ws, id, 'member', undefined, account));
    }
    db.update(schema.workspaceMembers).set({ role: 'admin' }).where(eq(schema.workspaceMembers.userId, CAT)).run();
    pub = (await createChannel(ws, ANN, 'pub')).id;
    await joinChannel(pub, BOB);
    secret = (await createChannel(ws, ANN, 'secret', undefined, true)).id;
    db.insert(schema.channelMembers).values({ channelId: secret, userId: CAT }).run();
    pubApp = (await createArtifact(BOB, pub, { url: 'https://pub.example/', app: true })).id;
    secretApp = (await createArtifact(ANN, secret, { url: 'https://secret.example/', app: true })).id;
    fileRow(FILES.pubAttached, ANN);
    fileRow(FILES.secretPinned, ANN);
    fileRow(FILES.loose, ANN);
    const m = await sendMessage(pub, ANN, crypto.randomUUID(), 'see attached');
    db.insert(schema.messageFiles).values({ messageId: m.id, fileId: FILES.pubAttached }).run();
    secretDoc = (await createArtifact(ANN, secret, { fileId: FILES.secretPinned })).id;
  });
  published = [];
  shareEventsOut = [];
});

describe('one access function for Chat', () => {
  const PEOPLE = { owner: ANN, member: BOB, admin: CAT, nonMember: DAN, stranger: OUT };

  it('agrees with the old membership checks: public and private channels, the creator, an admin, a non-member', async () => {
    for (const [who, user] of Object.entries(PEOPLE)) {
      for (const [what, id] of Object.entries({ pubApp: () => pubApp, secretApp: () => secretApp, secretDoc: () => secretDoc }).map(([k, f]) => [k, f()] as const)) {
        const old = await run(() => oldArtifact(id, user));
        const label = `${who} on ${what}`;
        expect([label, await run(() => outcome(requireRole(user, 'artifact', id, 'editor')))]).toEqual([label, old]);
        expect([label, await run(() => outcome(getArtifact(id, user)))]).toEqual([label, old]);
        expect([label, await run(() => outcome(mintArtifactAppToken(id, user)))]).toEqual([label, old === 'ok' && what === 'secretDoc' ? 400 : old]);
        if (what !== 'secretDoc') expect([`rotate: ${label}`, await run(() => outcome(rotateArtifactAppSecret(id, user)))]).toEqual([`rotate: ${label}`, await run(() => oldRotate(id, user))]);
      }
      for (const [what, id] of Object.entries(FILES)) {
        const label = `${who} on file ${what}`;
        expect([label, await run(() => outcome(requireFileAccess(id, user)))]).toEqual([label, await run(() => oldFile(id, user))]);
      }
      for (const [what, id] of Object.entries({ pub: () => pub, secret: () => secret }).map(([k, f]) => [k, f()] as const)) {
        const label = `${who} pins in ${what}`;
        expect([label, await run(() => outcome(requireRole(user, 'channel', id, 'editor')))]).toEqual([label, await run(() => oldChannelMember(id, user))]);
      }
    }
  });

  it('gives each person the role the model says: member editor, creator owner, admin in the channel manager', async () => {
    const role = (user: string, kind: 'artifact' | 'channel' | 'file', id: string) => run(async () => accessOf(await readerFor(user, ws), kind, id));
    expect(await role(BOB, 'artifact', pubApp)).toBe('owner');
    expect(await role(ANN, 'artifact', pubApp)).toBe('manager'); // the workspace's owner, in #pub (she made it)
    expect(await role(CAT, 'artifact', pubApp)).toBeNull(); // an admin not in #pub: nothing, as before
    expect(await role(CAT, 'artifact', secretApp)).toBe('manager');
    expect(await role(ANN, 'artifact', secretApp)).toBe('owner');
    expect(await role(DAN, 'artifact', secretApp)).toBeNull();
    expect(await role(BOB, 'channel', pub)).toBe('editor');
    expect(await role(DAN, 'file', FILES.pubAttached)).toBe('viewer'); // a public channel's attachment
    expect(await role(ANN, 'file', FILES.loose)).toBe('owner');
    expect(await role(BOB, 'file', FILES.loose)).toBeNull();
  });

  it('an explicit grant lets someone outside the channel open the artifact by id, and tells the share index', async () => {
    expect(await run(() => outcome(getArtifact(secretDoc, DAN)))).toBe(404);
    // Sharing is a manager's: a member (editor) may not; the creator may.
    db.insert(schema.channelMembers).values({ channelId: secret, userId: BOB }).run();
    expect(await run(() => outcome(grantArtifact(secretDoc, BOB, `account:${acct(DAN)}`, 'viewer')))).toBe(403);
    db.delete(schema.channelMembers).where(and(eq(schema.channelMembers.channelId, secret), eq(schema.channelMembers.userId, BOB))).run();
    expect(await run(() => outcome(grantArtifact(secretDoc, ANN, `link:${'x'.repeat(32)}`, 'viewer')))).toBe(400);
    expect(await run(() => grantArtifact(secretDoc, ANN, `link:${'x'.repeat(32)}`, 'viewer').catch((e: ApiError) => e.code))).toBe('not_supported');
    expect(await run(() => outcome(grantArtifact(secretDoc, ANN, `account:${acct(DAN)}`, 'owner')))).toBe(400);
    expect(await run(() => outcome(grantArtifact(secretDoc, ANN, 'account:nobody', 'viewer')))).toBe(400);

    const given = await run(() => grantArtifact(secretDoc, ANN, `account:${acct(DAN)}`, 'viewer'));
    expect(given).toMatchObject({ role: 'owner', grants: [{ principal: `account:${acct(DAN)}`, role: 'viewer', grantedBy: acct(ANN) }] });
    expect((await run(() => getArtifact(secretDoc, DAN))).id).toBe(secretDoc);
    expect(await run(() => outcome(requireFileAccess(FILES.secretPinned, DAN)))).toBe('ok'); // the file it backs, through it
    expect(await run(() => listArtifactGrants(secretDoc, DAN))).toMatchObject({ role: 'viewer' });
    expect(await run(() => outcome(deleteArtifact(secretDoc, DAN)))).toBe(403);
    expect(await run(() => outcome(renameArtifact(secretDoc, DAN, 'mine now')))).toBe(403);
    // The share index: a row, the DM line with the artifact's address, and sharing.granted for Dan's account.
    const ref = `${ws}/chat/artifact/${secretDoc}`;
    expect(await run(() => sharedWith({ accountId: acct(DAN), channelIds: [] }))).toMatchObject([{ ref, kind: 'artifact', role: 'viewer', url: `/?open=${encodeURIComponent(`artifact:${secretDoc}`)}` }]);
    const line = published.find((p) => p.event.type === 'message.created')!.event.data as MessageDTO;
    expect(line).toMatchObject({ systemKind: 'file_shared', userId: ANN });
    expect(line.body).toMatch(new RegExp(`^Ann shared ${FILES.secretPinned}\\.txt with you\\n\\S*/\\?open=artifact%3A${secretDoc}$`));
    expect(shareEventsOut).toMatchObject([{ type: 'sharing.granted', audience: `account:${acct(DAN)}`, data: { ref, principal: `account:${acct(DAN)}`, role: 'viewer' } }]);

    // A channel as the principal: everyone in it.
    await run(() => grantArtifact(secretApp, ANN, `channel:${pub}`, 'viewer'));
    expect(await run(() => outcome(getArtifact(secretApp, BOB)))).toBe('ok');
    expect(await run(() => outcome(mintArtifactAppToken(secretApp, BOB)))).toBe(403); // a viewer sees the app; a token says "a member"

    shareEventsOut = [];
    expect(await run(() => revokeArtifactGrant(secretDoc, ANN, `account:${acct(DAN)}`))).toMatchObject({ grants: [] });
    expect(await run(() => outcome(getArtifact(secretDoc, DAN)))).toBe(404);
    expect(shareEventsOut).toMatchObject([{ type: 'sharing.revoked', data: { ref } }]);
    expect(await run(() => sharedWith({ accountId: acct(DAN), channelIds: [] }))).toEqual([]);

    // Deleting an artifact takes its grants with it.
    shareEventsOut = [];
    await run(() => deleteArtifact(secretApp, ANN));
    expect(db.select().from(schema.grants).all()).toEqual([]);
    expect(shareEventsOut).toMatchObject([{ type: 'sharing.revoked', data: { principal: `channel:${pub}` } }]);
  });

  it('the grants table is the grants library\'s, as migration 0004', () => {
    expect(ORG_MIGRATIONS[4]!.split('--> statement-breakpoint').map((s) => s.trim().replace(/;$/, ''))).toEqual([...GRANTS_DDL]);
  });

  // The phase exit (platform.md §11, phase 3): effectiveRole is the only authorization path for artifacts and files.
  // What is left of membership in their services is the listings, which stay per channel.
  it('the artifact and file services authorize only through org/access.ts', () => {
    const LISTINGS = new Set(['listArtifacts', 'listAppArtifacts', 'listChannelFiles']);
    for (const file of ['services/artifacts.ts', 'services/files.ts']) {
      const src = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      const fns = src.split(/\n(?=(?:export )?(?:async )?function )/).slice(1);
      expect(fns.length).toBeGreaterThan(8);
      expect(src).toContain("from '../access.js'");
      for (const fn of fns) {
        const name = /function (\w+)/.exec(fn)![1]!;
        const direct = /requireChannelAccess\(|channelMembers\b|isMember\b|workspaceMembers\.role/.test(fn);
        expect([file, name, direct && !LISTINGS.has(name)]).toEqual([file, name, false]);
      }
    }
  });
});
