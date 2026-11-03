// Huddles on Workers: a join mints a LiveKit token the room accepts, the roster lives in the organization's SQLite (an
// object is evicted between requests), and LiveKit's webhook is verified by signature before it changes anything.
import { randomBytes } from 'node:crypto';
import { jwtVerify } from 'jose';
import { AccessToken } from 'livekit-server-sdk';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { orgStorage } from '../../test/orgStorage';
import { orgRoutes } from '../routes/org';
import { withDb, schema, type DB } from './db/index';
import { handleLiveKitWebhook, joinHuddle, leaveHuddle } from './services/huddles';
import { huddleParticipants } from './huddles';
import { createWorkspace } from './services/workspaces';
import type { DatabaseSync } from 'node:sqlite';

const ANN = '00000000-0000-7000-8000-00000000000a';
const KEY = 'APIkey123';
const SECRET = 'a-livekit-secret-of-reasonable-length';

beforeAll(() => {
  process.env.FLOW_DATA_KEY = randomBytes(32).toString('base64');
  Object.assign(process.env, { LIVEKIT_API_KEY: KEY, LIVEKIT_API_SECRET: SECRET, LIVEKIT_URL: 'wss://test.livekit.cloud' });
});

/** A webhook as LiveKit signs it: a JWT from the project's key whose `sha256` claim is the body's digest. */
async function signed(event: object, secret = SECRET): Promise<{ body: string; auth: string }> {
  const body = JSON.stringify(event);
  const digest = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))).toString('base64');
  const at = new AccessToken(KEY, secret);
  at.sha256 = digest;
  return { body, auth: await at.toJwt() };
}

let db: DB;
let sqlite: DatabaseSync;
let channelId: string;
beforeEach(async () => {
  ({ db, sqlite } = orgStorage());
  await withDb(db, async () => {
    db.insert(schema.users).values({ id: ANN, email: 'ann@x.test', passwordHash: '!', displayName: 'Ann' }).run();
    await createWorkspace(ANN, 'Locked In', 'locked-in');
    channelId = db.select().from(schema.channels).get()!.id;
  });
});

describe('a huddle in an Org object', () => {
  it('join mints a token for the channel room, signed with the project secret, and keeps the roster in SQLite', async () => {
    const answer = await withDb(db, () => joinHuddle(channelId, ANN));
    expect(answer.url).toBe('wss://test.livekit.cloud');
    const { payload } = await jwtVerify(answer.token, new TextEncoder().encode(SECRET));
    expect(payload).toMatchObject({ iss: KEY, sub: ANN, video: { room: channelId, roomJoin: true, canPublish: true, canSubscribe: true } });
    expect(sqlite.prepare('SELECT user_id FROM _huddle_participants WHERE channel_id = ?').all(channelId)).toEqual([{ user_id: ANN }]);

    await withDb(db, () => leaveHuddle(channelId, ANN));
    expect(withDb(db, () => huddleParticipants(channelId))).toEqual([]);
  });

  it('a signed participant_left webhook removes the participant; a forged one changes nothing', async () => {
    await withDb(db, () => joinHuddle(channelId, ANN));
    const event = { event: 'participant_left', room: { name: channelId }, participant: { identity: ANN } };
    const forged = await signed(event, 'some-other-secret-of-reasonable-length');
    await expect(withDb(db, () => handleLiveKitWebhook(forged.body, forged.auth))).rejects.toThrow();
    expect(withDb(db, () => huddleParticipants(channelId))).toHaveLength(1);
    const real = await signed(event);
    await withDb(db, () => handleLiveKitWebhook(real.body, real.auth));
    expect(withDb(db, () => huddleParticipants(channelId))).toEqual([]);
  });
});

describe('the Worker side', () => {
  const env = (handle = vi.fn(async () => Response.json({ ok: true })), org: string | null = 'org-1', extra: Record<string, string> = {}) => ({
    handle,
    env: {
      LIVEKIT_API_KEY: KEY, LIVEKIT_API_SECRET: SECRET, LIVEKIT_URL: 'wss://test.livekit.cloud', ...extra,
      DIRECTORY: { idFromName: () => 'd', get: () => ({ call: async () => ({ ok: true, value: org }) }) },
      ORG: { idFromName: (id: string) => id, get: () => ({ handle }) },
    },
  });
  const post = (e: ReturnType<typeof env>['env'], body: string, auth: string) =>
    orgRoutes.request('https://app.example/v1/livekit/webhook', { method: 'POST', headers: { authorization: auth, 'content-type': 'application/webhook+json' }, body }, e as never);

  it('/v1/config reports huddles once the three LiveKit settings are set', async () => {
    expect(await (await orgRoutes.request('https://app.example/v1/config', {}, env().env as never)).json()).toMatchObject({ huddles: true });
    expect(await (await orgRoutes.request('https://app.example/v1/config', {}, { ...env().env, LIVEKIT_URL: undefined } as never)).json()).toMatchObject({ huddles: false });
  });

  it('client-info offers push only with the APNs driver and its credentials', async () => {
    const caps = async (extra: Record<string, string>) => ((await (await orgRoutes.request('https://app.example/v1/client-info', {}, env(undefined, null, extra).env as never)).json()) as { capabilities: Record<string, boolean> }).capabilities;
    expect((await caps({})).push).toBe(false);
    expect((await caps({ FLOW_PUSH_DRIVER: 'apns', FLOW_APNS_KEY: 'k', FLOW_APNS_KEY_ID: 'i' })).push).toBe(false);
    expect(await caps({ FLOW_PUSH_DRIVER: 'apns', FLOW_APNS_KEY: 'k', FLOW_APNS_KEY_ID: 'i', FLOW_APNS_TEAM_ID: 't' })).toMatchObject({ push: true, pushRouting: true });
  });

  it('forwards a signed webhook, body untouched, to the organization that owns the room', async () => {
    const { handle, env: e } = env();
    const { body, auth } = await signed({ event: 'room_finished', room: { name: '00000000-0000-7000-8000-0000000000c1' } });
    const res = await post(e, body, auth);
    expect(res.status).toBe(200);
    expect(handle).toHaveBeenCalledTimes(1);
    const [req] = handle.mock.calls[0]! as unknown as [Request];
    expect(await req.text()).toBe(body);
    expect(req.headers.get('authorization')).toBe(auth);
  });

  it('refuses an unsigned or forged webhook without waking an object', async () => {
    const { handle, env: e } = env();
    const event = { event: 'room_finished', room: { name: '00000000-0000-7000-8000-0000000000c1' } };
    const forged = await signed(event, 'some-other-secret-of-reasonable-length');
    expect((await post(e, forged.body, forged.auth)).status).toBe(400);
    expect((await post(e, forged.body, '')).status).toBe(400);
    const real = await signed(event);
    expect((await post(e, real.body.replace('finished', 'started'), real.auth)).status).toBe(400);
    expect(handle).not.toHaveBeenCalled();
  });

  it('acknowledges a room that is no channel of ours', async () => {
    const { handle, env: e } = env(undefined, null);
    const { body, auth } = await signed({ event: 'room_finished', room: { name: '00000000-0000-7000-8000-0000000000c1' } });
    expect((await post(e, body, auth)).status).toBe(200);
    expect(handle).not.toHaveBeenCalled();
  });
});
