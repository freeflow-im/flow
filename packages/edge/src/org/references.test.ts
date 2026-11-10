// References in the Org object (services/references.ts, platform phase 6.4): Chat's kinds by the one access function, any
// other app's from the share index when it is shared with the reader, and `ask` for what the index does not hold.
import { randomBytes } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDTO } from '@flow/shared';
import { orgStorage } from '../../test/orgStorage';
import { withPublisher } from './bus';
import { withDb, schema, type DB } from './db/index';
import { directoryLink } from './directoryLink';
import { createArtifact } from './services/artifacts';
import { createChannel } from './services/channels';
import { sendMessage } from './services/messages';
import { resolveInOrg } from './services/references';
import { shareEvents } from './services/shares';
import { accountForJoin, createWorkspace, enrollInWorkspace } from './services/workspaces';

const ANN = '00000000-0000-7000-8000-00000000000a';
const BOB = '00000000-0000-7000-8000-00000000000b';
const acct = (u: string) => `acct-${u.slice(-1)}`;

beforeAll(() => { process.env.FLOW_DATA_KEY = randomBytes(32).toString('base64'); });

let db: DB;
let ws: string;
const run = <T>(fn: () => Promise<T>) => directoryLink.run({
  ensureAccount: async (organizationId, userId, role, displayName) =>
    ({ id: acct(userId), principalId: userId, organizationId, address: `${displayName.toLowerCase()}@acme.freeflow.im`, displayName, role, kind: 'native', state: 'active', createdAt: '' }) satisfies AccountDTO,
}, () => shareEvents.run(async () => {}, () => withPublisher(() => {}, () => withDb(db, fn))));

let pub: string, secret: string, app: string, msg: string, secretMsg: string;
beforeEach(async () => {
  ({ db } = orgStorage());
  await run(async () => {
    for (const [id, name] of [[ANN, 'Ann'], [BOB, 'Bob']]) db.insert(schema.users).values({ id, email: `${name}@x.test`, passwordHash: '!', displayName: name }).run();
    ws = (await createWorkspace(ANN, 'Acme', 'acme')).id;
    const account = await accountForJoin(ws, BOB);
    await db.transaction((tx) => enrollInWorkspace(tx, ws, BOB, 'member', undefined, account));
    pub = (await createChannel(ws, ANN, 'pub')).id;
    secret = (await createChannel(ws, ANN, 'secret', undefined, true)).id;
    app = (await createArtifact(ANN, secret, { url: 'https://secret.example/', name: 'Secret plan', app: true })).id;
    msg = (await sendMessage(pub, ANN, crypto.randomUUID(), `hello <@${BOB}>, see the plan`)).id;
    secretMsg = (await sendMessage(secret, ANN, crypto.randomUUID(), 'between us')).id;
  });
});

const ref = (app: string, kind: string, id: string) => `${ws}/${app}/${kind}/${id}`;

describe('resolveInOrg', () => {
  it('resolves Chat’s kinds for whoever may see them, and denies the rest without a title', async () => {
    const asks = () => [ref('chat', 'channel', pub), ref('chat', 'channel', secret), ref('chat', 'artifact', app), ref('chat', 'message', msg), ref('chat', 'message', secretMsg)];
    const ann = await run(() => resolveInOrg(ANN, ws, asks()));
    expect(ann).toMatchObject([
      { app: 'chat', kind: 'channel', title: '#pub', url: `/?open=channel%3A${pub}`, role: 'manager' },
      { title: '#secret', role: 'manager' },
      { kind: 'artifact', title: 'Secret plan', summary: 'in #secret', role: 'owner', url: `/?open=artifact%3A${app}` },
      { kind: 'message', title: 'Message from Ann in #pub', summary: 'hello @Bob, see the plan', url: `/?open=message%3A${msg}` },
      { title: 'Message from Ann in #secret', summary: 'between us' },
    ]);
    const bob = await run(() => resolveInOrg(BOB, ws, asks()));
    // A public channel and its messages are every member's to read; the private channel and what is in it are not Bob's.
    expect(bob).toEqual([
      expect.objectContaining({ title: '#pub', role: 'viewer' }),
      { ref: ref('chat', 'channel', secret), denied: true },
      { ref: ref('chat', 'artifact', app), denied: true },
      expect.objectContaining({ title: 'Message from Ann in #pub', role: 'viewer' }),
      { ref: ref('chat', 'message', secretMsg), denied: true },
    ]);
  });

  it('answers another app’s object from the share index when shared with the reader, else hands it back to ask', async () => {
    const shared = ref('docs', 'sheet', 'S1'), other = ref('docs', 'sheet', 'S2');
    db.insert(schema.shares).values({ ref: shared, principal: `account:${acct(BOB)}`, role: 'viewer', grantedBy: acct(ANN), title: 'Q4 plan', kind: 'deck', at: Date.now() }).run();
    db.insert(schema.shares).values({ ref: other, principal: `account:${acct(ANN)}`, role: 'editor', grantedBy: acct(ANN), title: 'Hers', kind: 'doc', at: Date.now() }).run();
    const out = await run(() => resolveInOrg(BOB, ws, [shared, other, `elsewhere/docs/sheet/S1`, 'garbage']));
    expect(out).toEqual([
      { ref: shared, app: 'docs', kind: 'sheet', title: 'Q4 plan', role: 'viewer', icon: '📽️', url: '/docs/d/S1', fileKind: 'deck' },
      { ref: other, ask: true },
      { ref: 'elsewhere/docs/sheet/S1', denied: true },
      { ref: 'garbage', denied: true },
    ]);
  });
});
