// Hosted apps' screen hosts and sessions (docs/specs/user-apps.md §6.1, §6.2).
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { appHostLabel, appOrigin, draftEgress, parseAppHost } from './hosted';
import type { UserAppManifest } from '@flow/shared';
import { oauthDonePage } from '../routes/userApps';
import { mintUserAppToken, signAppSession, signAppTicket, verifyAppSession, verifyAppTicket, verifyUserAppToken } from '../org/lib/appSigning';

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

describe('tickets (§6.3)', () => {
  const secret = randomBytes(32);
  const who = { app: 'notes', org: ORG, accountId: 'a1', userId: 'u1', via: null, invokedBy: null };

  it('name the caller for two minutes, with the install\'s secret only', () => {
    const ticket = signAppTicket(secret, who);
    expect(verifyAppTicket(secret, ticket)).toMatchObject({ accountId: 'a1', app: 'notes' });
    expect(verifyAppTicket(randomBytes(32), ticket)).toBeNull();
    expect(verifyAppTicket(secret, ticket, new Date(Date.now() + 3 * 60_000))).toBeNull();
  });

  it('cannot stand in for a session, or a session for one', () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    expect(verifyAppTicket(secret, signAppSession(secret, { accountId: 'a1', userId: 'u1', displayName: 'A', isAgent: false, exp }))).toBeNull();
    expect(verifyAppSession(secret, signAppTicket(secret, who))).toBeNull();
  });
});

describe('a draft\'s outside hosts (§9.3)', () => {
  const m = (egress?: string[]) => ({ egress }) as UserAppManifest;
  it('are only those an admin approved for the installed version', () => {
    expect(draftEgress(m(['api.github.com', 'evil.example.com']), m(['api.github.com']))).toEqual(['api.github.com']);
    expect(draftEgress(m(['api.github.com']), null)).toEqual([]);
    expect(draftEgress(m(undefined), m(['api.github.com']))).toEqual([]);
  });
});

describe('the sign-in window\'s last page (§6.5)', () => {
  it('tells the app\'s screen, only at its origin, and escapes what it shows', () => {
    const ok = oauthDonePage({ ok: true, label: 'Git<b>Hub', provider: 'github', returnOrigin: 'https://taskboard--x.flowtoo.org' });
    expect(ok).toContain('Signed in to Git&#60;b&#62;Hub');
    expect(ok).toContain('"https://taskboard--x.flowtoo.org"');
    expect(ok).toContain('"type":"freeflow:oauth"');
    const unknown = oauthDonePage({ ok: false, label: 'the service', returnOrigin: null, error: 'gone' });
    expect(unknown).not.toContain('<script>');
  });
});
