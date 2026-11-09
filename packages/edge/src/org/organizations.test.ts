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
  accountForJoin, createJoinLink, createWorkspace, enrollInWorkspace, listMembers, myWorkspaces, setMemberRole, transferWorkspaceOwnership, updateWorkspace,
} from './services/workspaces';

const ANN = '00000000-0000-7000-8000-00000000000a';
const BOB = '00000000-0000-7000-8000-00000000000b';
const BOT = '00000000-0000-7000-8000-00000000000c';

beforeAll(() => { process.env.FLOW_DATA_KEY = randomBytes(32).toString('base64'); });

let db: DB;
let workspaceId: string;
let asked: [string, string][];
/** The state the directory reports for every account, for the sponsor rule (§3.3). */
let accountState: AccountDTO['state'];
/** The kind the directory reports for every account (§3.3). */
let accountKind: AccountDTO['kind'];

/** The directory's half, as the object provides it: an address per joiner. */
const run = <T>(fn: () => Promise<T>) => directoryLink.run({
  ensureAccount: async (organizationId, userId, role, displayName) => {
    asked.push([userId, role]);
    return { id: `acct-${userId}`, principalId: userId, organizationId, address: `${displayName.toLowerCase()}@acme.freeflow.im`, displayName, role, kind: 'native', state: 'active', createdAt: '' } satisfies AccountDTO;
  },
  accountFor: async (organizationId, userId) =>
    ({ id: `acct-${userId}`, principalId: userId, organizationId, address: accountKind === 'guest' ? null : 'x@acme.freeflow.im', displayName: 'x', role: 'member', kind: accountKind, state: accountState, createdAt: '' }),
}, () => withDb(db, fn));

beforeEach(async () => {
  db = orgStorage().db;
  asked = [];
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
    expect(mine).toMatchObject({ role: 'member', address: 'bob@acme.freeflow.im', policies: { inviteBy: 'admins', agentsBy: 'members', linkSharing: true, defaultAccountKind: 'native' } });
  });

  it('lets only admins invite by default, members add agents, and refuses them with policy_forbids when the policy says admins', async () => {
    await expect(run(() => createJoinLink(workspaceId, BOB))).rejects.toMatchObject({ statusCode: 403, code: 'policy_forbids' });
    await run(() => createAgentInvite(workspaceId, BOB));
    await run(() => updateWorkspace(workspaceId, ANN, { policies: { inviteBy: 'members' } }));
    await run(() => createJoinLink(workspaceId, BOB));
    await expect(run(() => createJoinLink(workspaceId, BOT))).rejects.toMatchObject({ statusCode: 403, code: 'forbidden' });
    await expect(run(() => updateWorkspace(workspaceId, BOB, { policies: { inviteBy: 'admins' } }))).rejects.toMatchObject({ statusCode: 403 });
    const ws = await run(() => updateWorkspace(workspaceId, ANN, { policies: { inviteBy: 'admins', agentsBy: 'admins' } }));
    expect(ws.policies).toEqual({ inviteBy: 'admins', agentsBy: 'admins', linkSharing: true, defaultAccountKind: 'native' });
    await expect(run(() => createJoinLink(workspaceId, BOB))).rejects.toMatchObject({ statusCode: 403, code: 'policy_forbids' });
    await expect(run(() => createAgentInvite(workspaceId, BOB))).rejects.toMatchObject({ statusCode: 403, code: 'policy_forbids' });
    await run(() => createJoinLink(workspaceId, ANN));
    const kept = await run(() => updateWorkspace(workspaceId, ANN, { policies: { linkSharing: false } }));
    expect(kept.policies).toEqual({ inviteBy: 'admins', agentsBy: 'admins', linkSharing: false, defaultAccountKind: 'native' });
    const guests = await run(() => updateWorkspace(workspaceId, ANN, { policies: { defaultAccountKind: 'guest' } }));
    expect(guests.policies).toEqual({ inviteBy: 'admins', agentsBy: 'admins', linkSharing: false, defaultAccountKind: 'guest' });
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
