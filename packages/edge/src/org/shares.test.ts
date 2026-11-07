// The share index in the Org object (platform.md §4.5, §4.6; phase 3.3): a reported grant goes into `shares`, gives the
// `sharing.granted` event, and for a new share the notice: a DM line that notifies the person, or a card in the channel.
import { randomBytes } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDTO, Event, MessageDTO } from '@flow/shared';
import { orgStorage } from '../../test/orgStorage';
import { withPublisher } from './bus';
import { withDb, schema, type DB } from './db/index';
import { directoryLink } from './directoryLink';
import { createChannel } from './services/channels';
import { listNotifications } from './services/notifications';
import { isActiveAccount, recordShare, revokeShare, sharedRefsOf, sharedWith, urlOf } from './services/shares';
import { accountForJoin, createWorkspace, enrollInWorkspace } from './services/workspaces';
import { eq } from 'drizzle-orm';

const ANN = '00000000-0000-7000-8000-00000000000a';
const BOB = '00000000-0000-7000-8000-00000000000b';
const CAT = '00000000-0000-7000-8000-00000000000c';
const WEB = 'https://app.test';

beforeAll(() => { process.env.FLOW_DATA_KEY = randomBytes(32).toString('base64'); });

let db: DB;
let workspaceId: string;
let general: string;
let published: { subject: string; event: Event }[];

const run = <T>(fn: () => Promise<T>) => directoryLink.run({
  ensureAccount: async (organizationId, userId, role, displayName) =>
    ({ id: `acct-${userId.slice(-1)}`, principalId: userId, organizationId, address: `${displayName.toLowerCase()}@acme.freeflow.im`, displayName, role, kind: 'native', state: 'active', createdAt: '' }) satisfies AccountDTO,
}, () => withPublisher((subject: string, event: Event) => void published.push({ subject, event }), () => withDb(db, fn)));

const ref = (id: string, kind = 'sheet') => `${workspaceId}/docs/${kind}/${id}`;
const messagesIn = (channelId: string) => db.select().from(schema.messages).where(eq(schema.messages.channelId, channelId)).all();

beforeEach(async () => {
  ({ db } = orgStorage());
  published = [];
  await run(async () => {
    for (const [id, name] of [[ANN, 'Ann'], [BOB, 'Bob'], [CAT, 'Cat']]) db.insert(schema.users).values({ id, email: `${name}@x.test`, passwordHash: '!', displayName: name }).run();
    workspaceId = (await createWorkspace(ANN, 'Acme', 'acme')).id;
    for (const id of [BOB, CAT]) {
      const account = await accountForJoin(workspaceId, id);
      await db.transaction((tx) => enrollInWorkspace(tx, workspaceId, id, 'member', undefined, account));
    }
    general = db.select().from(schema.channels).get()!.id;
  });
  published = [];
});

describe('the share index', () => {
  it('records a share with a person: the event for that account, and a DM line that notifies them', async () => {
    const event = await run(() => recordShare({ ref: ref('s1'), principal: 'account:acct-b', role: 'viewer', grantedBy: 'acct-a', title: 'Q4 plan', kind: 'sheet' }, WEB));
    expect(event).toMatchObject({
      type: 'sharing.granted', organizationId: workspaceId, actor: 'acct-a', audience: 'account:acct-b',
      ref: { organizationId: workspaceId, app: 'docs', kind: 'sheet', id: 's1' },
      data: { ref: ref('s1'), principal: 'account:acct-b', role: 'viewer', title: 'Q4 plan', kind: 'sheet', url: '/workspace/s/s1' },
    });
    const line = published.find((p) => p.event.type === 'message.created')!.event.data as MessageDTO;
    expect(line).toMatchObject({ userId: ANN, systemKind: 'file_shared', body: `Ann shared Q4 plan with you\n${WEB}/workspace/s/s1` });
    const notified = published.find((p) => p.event.type === 'notification.created')!;
    expect(notified.subject).toContain(BOB);
    const { notifications } = await run(() => listNotifications(BOB, undefined, 10));
    expect(notifications).toMatchObject([{ kind: 1, actorId: ANN, message: { body: expect.stringContaining('shared Q4 plan with you') } }]);

    // A role changed is the event again, with nothing posted.
    published = [];
    const again = await run(() => recordShare({ ref: ref('s1'), principal: 'account:acct-b', role: 'editor', grantedBy: 'acct-a', title: 'Q4 plan', kind: 'sheet' }, WEB));
    expect(again).toMatchObject({ type: 'sharing.granted', data: { role: 'editor' } });
    expect(published.filter((p) => p.event.type === 'message.created')).toEqual([]);

    expect(await run(() => sharedWith({ accountId: 'acct-b', channelIds: [] }))).toMatchObject([{ ref: ref('s1'), kind: 'sheet', title: 'Q4 plan', role: 'editor', grantedBy: 'acct-a', url: '/workspace/s/s1' }]);
    expect(await run(() => sharedRefsOf({ accountId: 'acct-b', channelIds: [] }))).toEqual([ref('s1')]);
    expect(await run(() => sharedRefsOf({ accountId: 'acct-c', channelIds: [] }))).toEqual([]);
  });

  it('records a share with a channel: a card in it, the event for the organization when the channel is public', async () => {
    const folder = 'me:ann:w/Q4';
    const event = await run(() => recordShare({ ref: ref(folder, 'folder'), principal: `channel:${general}`, role: 'viewer', grantedBy: 'acct-a', title: 'Q4', kind: 'folder' }, WEB));
    const url = `/workspace/?withme=1&in=${encodeURIComponent(folder)}&org=${encodeURIComponent(workspaceId)}`;
    expect(event).toMatchObject({ audience: 'org', data: { principal: `channel:${general}`, kind: 'folder', url } });
    const card = messagesIn(general).find((m) => m.systemKind === 'file_shared');
    expect(card?.userId).toBe(ANN);
    expect((published.find((p) => p.event.type === 'message.created')!.event.data as MessageDTO).body).toBe(`Ann shared Q4 with this channel\n${WEB}${url}`);
    // Whoever is in the channel has it shared with them.
    expect(await run(() => sharedRefsOf({ accountId: 'acct-c', channelIds: [general] }))).toEqual([ref(folder, 'folder')]);

    const secret = await run(() => createChannel(workspaceId, ANN, 'secret', undefined, true));
    const hidden = await run(() => recordShare({ ref: ref('s2'), principal: `channel:${secret.id}`, role: 'viewer', grantedBy: 'acct-a', title: 'Plan', kind: 'doc' }, WEB));
    expect(hidden).toMatchObject({ audience: `channel:${secret.id}`, data: { url: '/workspace/doc/s2' } });
  });

  it('the organization and links post nothing; a link\'s token stays out of its event', async () => {
    const org = await run(() => recordShare({ ref: ref('s3'), principal: 'org', role: 'editor', grantedBy: 'acct-a', title: 'All hands', kind: 'deck' }, WEB));
    expect(org).toMatchObject({ audience: 'org', data: { principal: 'org', url: '/workspace/d/s3' } });
    const link = await run(() => recordShare({ ref: ref('s3'), principal: `link:${'x'.repeat(32)}`, role: 'viewer', grantedBy: 'acct-a', title: 'All hands', kind: 'deck' }, WEB));
    expect(link).toMatchObject({ audience: 'account:acct-a', data: { principal: 'link' } });
    expect(published.filter((p) => p.event.type === 'message.created')).toEqual([]);
    // Neither is "shared with me": the organization's is its root, a link's is a guest's.
    expect(await run(() => sharedWith({ accountId: 'acct-b', channelIds: [] }))).toEqual([]);
  });

  it('the organization\'s shares reach every active member, on the bus and when asked for (phase 4.4)', async () => {
    const cal = `${workspaceId}/calendar/calendar/n.acct-a.0123456789ab`;
    await run(() => recordShare({ ref: cal, principal: 'org', role: 'viewer', grantedBy: 'acct-a', title: 'Team', kind: 'calendar' }, WEB));
    expect(await run(() => sharedWith({ accountId: 'acct-b', channelIds: [] }))).toEqual([]);
    expect(await run(() => sharedWith({ accountId: 'acct-b', channelIds: [] }, { includeOrg: true }))).toMatchObject([{ ref: cal, kind: 'calendar', role: 'viewer', principal: 'org', url: '/calendar/?calendar=n.acct-a.0123456789ab' }]);
    expect(await run(() => sharedRefsOf({ accountId: 'acct-b', channelIds: [] }))).toEqual([cal]);
    // Someone who is not a member here sees none of it.
    expect(await run(() => sharedRefsOf({ accountId: 'acct-x', channelIds: [] }))).toEqual([]);
    expect(await run(() => sharedWith({ accountId: 'acct-x', channelIds: [] }, { includeOrg: true }))).toEqual([]);
    expect(await run(() => Promise.all(['acct-b', 'acct-x'].map(isActiveAccount)))).toEqual([true, false]);
    // A person's own share outranks the organization's, and names its principal.
    await run(() => recordShare({ ref: cal, principal: 'account:acct-b', role: 'editor', grantedBy: 'acct-a', title: 'Team', kind: 'calendar' }, WEB));
    expect(await run(() => sharedWith({ accountId: 'acct-b', channelIds: [] }, { includeOrg: true }))).toMatchObject([{ ref: cal, role: 'editor', principal: 'account:acct-b' }]);
  });

  it('a revoke takes the row away and is only the event', async () => {
    await run(() => recordShare({ ref: ref('s1'), principal: 'account:acct-b', role: 'viewer', grantedBy: 'acct-a', title: 'Q4 plan', kind: 'sheet' }, WEB));
    published = [];
    const event = await run(() => revokeShare({ ref: ref('s1'), principal: 'account:acct-b', revokedBy: 'acct-a' }));
    expect(event).toMatchObject({ type: 'sharing.revoked', actor: 'acct-a', audience: 'account:acct-b', data: { ref: ref('s1'), role: null, title: 'Q4 plan', url: '/workspace/s/s1' } });
    expect(published).toEqual([]);
    expect(await run(() => sharedWith({ accountId: 'acct-b', channelIds: [] }))).toEqual([]);
    expect(await run(() => recordShare({ ref: 'not a reference', principal: 'org', role: 'viewer', grantedBy: 'acct-a' }, WEB))).toBeNull();
  });

  it('names a Docs object\'s address by the kind of file it is', () => {
    const r = (kind: string, id: string) => ({ organizationId: 'o', app: 'docs', kind, id });
    expect(['sheet', 'deck', 'doc', 'markdown'].map((k) => urlOf(r('sheet', 'x'), k))).toEqual(['/workspace/s/x', '/workspace/d/x', '/workspace/doc/x', '/workspace/md/x']);
    expect(urlOf(r('file', 'y'), 'file')).toBe('/workspace/f/y');
    expect(urlOf({ organizationId: 'o', app: 'calendar', kind: 'event', id: 'z' }, '')).toBeNull();
  });
});
