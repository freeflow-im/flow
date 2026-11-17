// Hosted apps' screen hosts and sessions (docs/specs/user-apps.md §6.1, §6.2).
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { appHostLabel, appOrigin, parseAppHost } from './hosted';
import { mintUserAppToken, signAppSession, verifyAppSession, verifyUserAppToken } from '../org/lib/appSigning';

const ORG = '01a1ebd3-be55-7b8d-9021-9e61067a68a6';

describe('the screen host', () => {
  it('names an app in an organization within one label, and reads it back', () => {
    const label = appHostLabel('taskboard', ORG);
    expect(label).toBe('taskboard--01a1ebd3be557b8d90219e61067a68a6');
    expect(label.length).toBeLessThanOrEqual(63);
    expect(appOrigin('taskboard', ORG, 'flowtoo.org')).toBe(`https://${label}.flowtoo.org`);
    expect(parseAppHost(`${label}.flowtoo.org`, 'flowtoo.org')).toEqual({ app: 'taskboard', org: ORG });
    expect(parseAppHost(`${label}.flowtoo.localhost:8787`, 'flowtoo.localhost:8787')).toEqual({ app: 'taskboard', org: ORG });
  });

  it('reads nothing from another domain or a malformed label', () => {
    expect(parseAppHost('app.freeflow.im', 'flowtoo.org')).toBeNull();
    expect(parseAppHost(`x.${appHostLabel('taskboard', ORG)}.flowtoo.org`, 'flowtoo.org')).toBeNull();
    expect(parseAppHost('taskboard--abc.flowtoo.org', 'flowtoo.org')).toBeNull();
    expect(parseAppHost(`${appHostLabel('taskboard', ORG)}.flowtoo.org.evil.com`, 'flowtoo.org')).toBeNull();
  });
});

describe('door keys and sessions', () => {
  const secret = randomBytes(32);
  const who = { app: 'taskboard', workspaceId: ORG, userId: 'u1', accountId: 'a1', displayName: 'Ann', isAgent: false };

  it('checks a door key with its secret only', () => {
    const { token } = mintUserAppToken(secret, who);
    expect(verifyUserAppToken(secret, token)).toMatchObject({ v: 2, app: 'taskboard', accountId: 'a1' });
    expect(verifyUserAppToken(randomBytes(32), token)).toBeNull();
    expect(verifyUserAppToken(secret, token, new Date(Date.now() + 10 * 60_000))).toBeNull();
  });

  it('keeps a session in a signed cookie that a door key cannot stand in for', () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const cookie = signAppSession(secret, { accountId: 'a1', userId: 'u1', displayName: 'Ann', isAgent: false, exp });
    expect(verifyAppSession(secret, cookie)).toMatchObject({ accountId: 'a1' });
    expect(verifyAppSession(randomBytes(32), cookie)).toBeNull();
    expect(verifyAppSession(secret, cookie, new Date((exp + 1) * 1000))).toBeNull();
    expect(verifyAppSession(secret, mintUserAppToken(secret, who).token)).toBeNull();
  });
});
