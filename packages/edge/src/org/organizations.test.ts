// Organizations in an Org object (platform.md §3.1, §3.2): the address on every member row, the policies and their
// gates, and handing the organization to another person.
import { randomBytes } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDTO } from '@flow/shared';
import { orgStorage } from '../../test/orgStorage';
import { withDb, schema, type DB } from './db/index';
import { directoryLink } from './directoryLink';
import { createAgentInvite, inviteAgentToWorkspace } from './services/agents';
import {
  acceptInvite, accountForJoin, createInvites, createJoinLink, createWorkspace, enrollInWorkspace, listMembers, listPendingInvites, myWorkspaces, revokeInvite, setMemberRole, transferWorkspaceOwnership, updateWorkspace,
} from './services/workspaces';

const ANN = '00000000-0000-7000-8000-00000000000a';
const BOB = '00000000-0000-7000-8000-00000000000b';
const BOT = '00000000-0000-7000-8000-00000000000c';

beforeAll(() => { process.env.FLOW_DATA_KEY = randomBytes(32).toString('base64'); });

let db: DB;
let workspaceId: string;
let asked: [string, string][];
let askedKinds: [string, string][];
/** The state the directory reports for every account, for the sponsor rule (§3.3). */
let accountState: AccountDTO['state'];
/** The kind the directory reports for every account (§3.3). */
let accountKind: AccountDTO['kind'];

/** The directory's half, as the object provides it: an address per joiner. */
const run = <T>(fn: () => Promise<T>) => directoryLink.run({
  ensureAccount: async (organizationId, userId, role, displayName, kind = 'native') => {
    asked.push([userId, role]);
    askedKinds.push([userId, kind]);
    return { id: `acct-${userId}`, principalId: userId, organizationId, address: kind === 'guest' ? null : `${displayName.toLowerCase()}@acme.freeflow.im`, displayName, role, kind, state: 'active', createdAt: '' } satisfies AccountDTO;
  },
  accountFor: async (organizationId, userId) =>
    ({ id: `acct-${userId}`, principalId: userId, organizationId, address: accountKind === 'guest' ? null : 'x@acme.freeflow.im', displayName: 'x', role: 'member', kind: accountKind, state: accountState, createdAt: '' }),
}, () => withDb(db, fn));

beforeEach(async () => {
  db = orgStorage().db;
  asked = [];
  askedKinds = [];
  accountState = 'active';
  accountKind = 'native';
  await run(async () => {
    for (const [id, name, isAgent] of [[ANN, 'Ann', false], [BOB, 'Bob', false], [BOT, 'Bot', true]] as const) {
      db.insert(schema.users).values({ id, email: `${name}@x.test`, passwordHash: '!', displayName: name, isAgent }).run();
    }
    workspaceId = (await createWorkspace(ANN, 'Acme', 'acme')).id;
    for (const id of [BOB, BOT]) {
      const account = await accountForJoin(workspaceId, id);
      await db.transaction((tx) => enrollInWorkspace(tx, workspaceId, id, 'member', undefined, account));
    }
  });
});

describe('organizations', () => {
  it('asks the directory before each join, and keeps the address on the member row', async () => {
    expect(asked).toEqual([[ANN, 'owner'], [BOB, 'member'], [BOT, 'member']]);
    const members = await run(() => listMembers(workspaceId, BOB));
    expect(Object.fromEntries(members.map((m) => [m.userId, m.address]))).toEqual({ [ANN]: 'ann@acme.freeflow.im', [BOB]: 'bob@acme.freeflow.im', [BOT]: 'bot@acme.freeflow.im' });
    expect(await run(() => accountForJoin(workspaceId, BOB))).toBeNull();
    expect(asked).toHaveLength(3);
    const [mine] = await run(() => myWorkspaces(BOB));
    expect(mine).toMatchObject({ role: 'member', address: 'bob@acme.freeflow.im', policies: { inviteBy: 'admins', agentsBy: 'members', linkSharing: true } });
  });

  it('lets only admins invite by default, members add agents, and refuses them with policy_forbids when the policy says admins', async () => {
    await expect(run(() => createJoinLink(workspaceId, BOB))).rejects.toMatchObject({ statusCode: 403, code: 'policy_forbids' });
    await run(() => createAgentInvite(workspaceId, BOB));
    await run(() => updateWorkspace(workspaceId, ANN, { policies: { inviteBy: 'members' } }));
    await run(() => createJoinLink(workspaceId, BOB));
    await expect(run(() => createJoinLink(workspaceId, BOT))).rejects.toMatchObject({ statusCode: 403, code: 'forbidden' });
    await expect(run(() => updateWorkspace(workspaceId, BOB, { policies: { inviteBy: 'admins' } }))).rejects.toMatchObject({ statusCode: 403 });
    const ws = await run(() => updateWorkspace(workspaceId, ANN, { policies: { inviteBy: 'admins', agentsBy: 'admins' } }));
    expect(ws.policies).toEqual({ inviteBy: 'admins', agentsBy: 'admins', linkSharing: true });
    await expect(run(() => createJoinLink(workspaceId, BOB))).rejects.toMatchObject({ statusCode: 403, code: 'policy_forbids' });
    await expect(run(() => createAgentInvite(workspaceId, BOB))).rejects.toMatchObject({ statusCode: 403, code: 'policy_forbids' });
    await run(() => createJoinLink(workspaceId, ANN));
    const kept = await run(() => updateWorkspace(workspaceId, ANN, { policies: { linkSharing: false } }));
    expect(kept.policies).toEqual({ inviteBy: 'admins', agentsBy: 'admins', linkSharing: false });
  });

  it('renames the organization for an owner or admin, within 1 to 80 characters; the slug stays', async () => {
    const before = (await run(() => myWorkspaces(ANN)))[0]!;
    const renamed = await run(() => updateWorkspace(workspaceId, ANN, { name: '  Acme Rockets  ' }));
    expect(renamed.name).toBe('Acme Rockets');
    expect(renamed.slug).toBe(before.slug);
    await expect(run(() => updateWorkspace(workspaceId, ANN, { name: '   ' }))).rejects.toMatchObject({ statusCode: 400, code: 'bad_name' });
    await expect(run(() => updateWorkspace(workspaceId, BOB, { name: 'Bob Co' }))).rejects.toMatchObject({ statusCode: 403 });
  });

  it('invites people as members or as chat guests; the pending list shows them, a revoke ends one, an accepted guest joins as a guest', async () => {
    const results = await run(() => createInvites(workspaceId, ANN, ['eve@example.com', 'fay@example.com'], 'guest'));
    expect(results.map((r) => [r.email, r.kind, r.status !== 'invalid_email' && r.status !== 'already_member'])).toEqual([['eve@example.com', 'guest', true], ['fay@example.com', 'guest', true]]);
    await run(() => createInvites(workspaceId, ANN, ['gil@example.com']));
    const pending = await run(() => listPendingInvites(workspaceId, ANN));
    expect(pending.map((i) => [i.email, i.kind, i.invitedBy.id]).sort()).toEqual([['eve@example.com', 'guest', ANN], ['fay@example.com', 'guest', ANN], ['gil@example.com', 'native', ANN]]);
    await expect(run(() => listPendingInvites(workspaceId, BOB))).rejects.toMatchObject({ statusCode: 403 });
    await run(() => revokeInvite(workspaceId, ANN, pending.find((i) => i.email === 'fay@example.com')!.id));
    expect((await run(() => listPendingInvites(workspaceId, ANN))).map((i) => i.email).sort()).toEqual(['eve@example.com', 'gil@example.com']);
    // Eve signs up and accepts: the directory is asked for a guest account.
    const EVE = '00000000-0000-7000-8000-00000000000e';
    db.insert(schema.users).values({ id: EVE, email: 'eve@example.com', passwordHash: '!', displayName: 'Eve' }).run();
    const eveInvite = results[0]!.inviteUrl!.split('/').pop()!;
    await run(() => acceptInvite(EVE, { token: eveInvite }));
    expect(askedKinds).toContainEqual([EVE, 'guest']);
    // A guest's member row carries no address (the DTO leaves the field out).
    const eve = (await run(() => listMembers(workspaceId, ANN))).find((m) => m.userId === EVE);
    expect(eve).toBeTruthy();
    expect(eve!.address ?? null).toBeNull();
    expect((await run(() => listPendingInvites(workspaceId, ANN))).map((i) => i.email)).toEqual(['gil@example.com']);
  });

  it('hands the organization to a person: one owner throughout, and only the owner may hand it on', async () => {
    accountKind = 'guest';
    await expect(run(() => transferWorkspaceOwnership(workspaceId, ANN, BOB))).rejects.toMatchObject({ statusCode: 409, code: 'owner_not_guest' });
    accountKind = 'native';
    await expect(run(() => transferWorkspaceOwnership(workspaceId, ANN, BOT))).rejects.toMatchObject({ statusCode: 403, code: 'agent_forbidden' });
    await expect(run(() => transferWorkspaceOwnership(workspaceId, BOB, ANN))).rejects.toMatchObject({ statusCode: 403 });
    const ws = await run(() => transferWorkspaceOwnership(workspaceId, ANN, BOB));
    expect(ws.role).toBe('admin');
    const roles = Object.fromEntries((await run(() => listMembers(workspaceId, ANN))).map((m) => [m.userId, m.role]));
    expect(roles).toEqual({ [ANN]: 'admin', [BOB]: 'owner', [BOT]: 'member' });
    await expect(run(() => transferWorkspaceOwnership(workspaceId, ANN, BOB))).rejects.toMatchObject({ statusCode: 403 });
  });

  it('keeps an agent from sponsoring, being an admin, or joining where its sponsor has no active account', async () => {
    await expect(run(() => createAgentInvite(workspaceId, BOT))).rejects.toMatchObject({ statusCode: 403, code: 'agent_forbidden' });
    await expect(run(() => setMemberRole(workspaceId, ANN, BOT, 'admin'))).rejects.toMatchObject({ statusCode: 403, code: 'agent_forbidden' });
    await run(() => setMemberRole(workspaceId, ANN, BOB, 'admin'));
    const other = (await run(() => createWorkspace(ANN, 'Beta', 'beta'))).id;
    accountState = 'suspended';
    await expect(run(() => inviteAgentToWorkspace(BOT, other, ANN))).rejects.toMatchObject({ statusCode: 403, code: 'agent_forbidden' });
    accountState = 'active';
    expect((await run(() => inviteAgentToWorkspace(BOT, other, ANN))).workspace.id).toBe(other);
  });
});
