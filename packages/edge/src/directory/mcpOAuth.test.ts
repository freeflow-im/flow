import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { APP_MANIFESTS } from '@flow/shared/manifests';
import { DirectoryCore, type Sql } from './core';
import { authorizationServerMetadata, cleanScope, grantedScope, isResource, McpOAuth, OAuthError, offeredGroups, protectedResourceMetadata, redirectMatches, wwwAuthenticate } from './mcpOAuth';

const ISSUER = 'https://app.test';

function nodeSql(): Sql {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query: string, ...args: unknown[]) {
      if (!args.length && query.trim().replace(/;$/, '').includes(';')) {
        db.exec(query);
        return { toArray: () => [] };
      }
      const stmt = db.prepare(query);
      const rows = stmt.columns().length ? stmt.all(...(args as never[])) : (stmt.run(...(args as never[])), []);
      return { toArray: () => rows as Record<string, unknown>[] };
    },
  };
}

let sql: Sql;
let oauth: McpOAuth;
const verifier = 'a-very-long-code-verifier-of-at-least-43-characters-xyz';
const challenge = createHash('sha256').update(verifier).digest('base64url');

beforeEach(() => {
  sql = nodeSql();
  new DirectoryCore(sql, { webUrlBase: ISSUER, registrationEnabled: true, send: async () => {} });
  for (const id of ['u1', 'u2']) sql.exec("INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, '', ?, 0)", id, `${id}@example.com`, id);
  // Who belongs where is read from the accounts (platform.md §3.3), not from `memberships`.
  for (const [u, o, r] of [['u1', 'orgA', 'owner'], ['u1', 'orgB', 'member'], ['u2', 'orgC', 'owner']]) {
    sql.exec('INSERT INTO accounts (id, user_id, organization_id, address, display_name, role, created_at) VALUES (?, ?, ?, ?, ?, ?, 0)', `acc-${u}-${o}`, u, o, `${u}@${o}.freeflow.im`, u, r);
  }
  oauth = new McpOAuth(sql, (async () => new Response('{}', { status: 404 })) as typeof fetch);
});

function registerClient() {
  return oauth.register({ client_name: 'Test agent', redirect_uris: ['http://localhost/callback'] }).client_id;
}

async function codeFor(userId = 'u1', org = 'orgA', scope?: string, ticked?: string[]) {
  const client = registerClient();
  const out = await oauth.authorize(ISSUER, { response_type: 'code', client_id: client, redirect_uri: 'http://localhost:4567/callback', code_challenge: challenge, code_challenge_method: 'S256', state: 'st', ...(scope ? { scope } : {}) });
  if (out.kind !== 'consent') throw new Error(out.url);
  const info = oauth.consent(out.pendingId, userId);
  const to = new URL(oauth.decide(ISSUER, out.pendingId, userId, info.csrf, true, org, ticked));
  return { client, code: to.searchParams.get('code')!, to, info };
}

describe('MCP OAuth in the directory', () => {
  it('describes itself on the request origin', () => {
    expect(authorizationServerMetadata(ISSUER).token_endpoint).toBe(`${ISSUER}/oauth/token`);
    expect(protectedResourceMetadata(ISSUER, '/mcp')).toMatchObject({ resource: `${ISSUER}/mcp`, authorization_servers: [ISSUER] });
    expect(wwwAuthenticate(ISSUER, '/mcp', 'invalid_token')).toBe(`Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp", error="invalid_token"`);
    expect(isResource(ISSUER, `${ISSUER}/mcp/v2`)).toBe(true);
    expect(isResource(ISSUER, 'https://docs.freeflow.im/mcp')).toBe(false);
    // Every scope the manifests' consent groups declare, in their order (the first eight the suite's first four apps').
    const declared = APP_MANIFESTS.flatMap((m) => m.scopes ?? []).flatMap((g) => g.scopes);
    expect(declared.slice(0, 8)).toEqual(['files:read', 'files:write', 'mail:read', 'mail:write', 'mail:send', 'calendar:read', 'calendar:write', 'events:read']);
    expect(cleanScope(undefined)).toBe(declared.join(' '));
    expect(protectedResourceMetadata(ISSUER).scopes_supported).toEqual(declared);
    expect(authorizationServerMetadata(ISSUER).scopes_supported).toContain('mail:send');
    expect(cleanScope('files:read nope')).toBeNull();
    expect(redirectMatches('http://localhost/cb', 'http://localhost:9999/cb')).toBe(true);
    expect(redirectMatches('https://a.test/cb', 'https://a.test/cb2')).toBe(false);
  });

  it('lists the person’s organizations on consent and preselects the last one connected', async () => {
    const first = await codeFor('u1', 'orgB');
    expect(first.info.organizations).toEqual(['orgA', 'orgB']);
    expect(first.info.preselect).toBe('orgA');
    expect(first.to.searchParams.get('state')).toBe('st');
    expect(first.to.searchParams.get('iss')).toBe(ISSUER);
    oauth.token(ISSUER, { grant_type: 'authorization_code', code: first.code, code_verifier: verifier, client_id: first.client });
    const again = await oauth.authorize(ISSUER, { response_type: 'code', client_id: first.client, redirect_uri: 'http://localhost/callback', code_challenge: challenge, code_challenge_method: 'S256' });
    expect(again.kind === 'consent' && oauth.consent(again.pendingId, 'u1').preselect).toBe('orgB');
  });

  it('issues tokens for the chosen organization, which refreshes keep', async () => {
    const { client, code } = await codeFor('u1', 'orgB');
    const t = oauth.token(ISSUER, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client });
    // Nothing ticked on the page (a form without its checkboxes): every group that starts ticked; never sending.
    const ticked = APP_MANIFESTS.flatMap((m) => m.scopes ?? []).filter((g) => g.checkedByDefault).flatMap((g) => g.scopes).join(' ');
    expect(ticked.startsWith('files:read files:write mail:read mail:write calendar:read calendar:write events:read')).toBe(true);
    expect(oauth.authenticate(ISSUER, `Bearer ${t.access_token}`)).toEqual({ ok: true, caller: { userId: 'u1', email: 'u1@example.com', orgId: 'orgB', accountId: 'acc-u1-orgB', scope: ticked, agentId: expect.any(String), agentMode: 'personal', sponsorAccountId: null } });
    const r = oauth.token(ISSUER, { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: client });
    expect(oauth.authenticate(ISSUER, `Bearer ${r.access_token}`)).toMatchObject({ ok: true, caller: { orgId: 'orgB' } });
    // A rotated refresh token used again ends the family.
    expect(() => oauth.token(ISSUER, { grant_type: 'refresh_token', refresh_token: t.refresh_token })).toThrow(OAuthError);
    expect(oauth.authenticate(ISSUER, `Bearer ${r.access_token}`)).toMatchObject({ ok: false, reason: 'revoked' });
  });

  it('checks PKCE and refuses a replayed code', async () => {
    const { client, code } = await codeFor();
    expect(() => oauth.token(ISSUER, { grant_type: 'authorization_code', code, code_verifier: 'wrong', client_id: client })).toThrow(/code_verifier/);
    oauth.token(ISSUER, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client });
    expect(() => oauth.token(ISSUER, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client })).toThrow(/already used/);
  });

  it('refuses an organization the person is not in, and a decision from someone else or without the page’s token', async () => {
    const client = registerClient();
    const out = await oauth.authorize(ISSUER, { response_type: 'code', client_id: client, redirect_uri: 'http://localhost/callback', code_challenge: challenge, code_challenge_method: 'S256' });
    if (out.kind !== 'consent') throw new Error('expected consent');
    const { csrf } = oauth.consent(out.pendingId, 'u1');
    expect(() => oauth.decide(ISSUER, out.pendingId, 'u1', csrf, true, 'orgC')).toThrow(/Choose one of your organizations/);
    expect(() => oauth.decide(ISSUER, out.pendingId, 'u2', csrf, true, 'orgC')).toThrow(OAuthError);
    expect(() => oauth.decide(ISSUER, out.pendingId, 'u1', 'forged', true, 'orgA')).toThrow(OAuthError);
    // Still pending after the refusals: the right answer goes through.
    expect(new URL(oauth.decide(ISSUER, out.pendingId, 'u1', csrf, true, 'orgA')).searchParams.get('code')).toBeTruthy();
  });

  it('denies back to the client', async () => {
    const client = registerClient();
    const out = await oauth.authorize(ISSUER, { response_type: 'code', client_id: client, redirect_uri: 'http://localhost/callback', code_challenge: challenge, code_challenge_method: 'S256', state: 's' });
    if (out.kind !== 'consent') throw new Error('expected consent');
    const { csrf } = oauth.consent(out.pendingId, 'u1');
    expect(new URL(oauth.decide(ISSUER, out.pendingId, 'u1', csrf, false, undefined)).searchParams.get('error')).toBe('access_denied');
  });

  it('stops a token when its person leaves the organization', async () => {
    const { client, code } = await codeFor('u1', 'orgA');
    const t = oauth.token(ISSUER, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client });
    sql.exec("UPDATE accounts SET state = 'removed' WHERE user_id = 'u1' AND organization_id = 'orgA'");
    expect(oauth.authenticate(ISSUER, `Bearer ${t.access_token}`)).toMatchObject({ ok: false, reason: 'not_a_member' });
    expect(() => oauth.token(ISSUER, { grant_type: 'refresh_token', refresh_token: t.refresh_token })).toThrow(/no longer a member/);
  });

  it('carries the account, and refuses a suspended one with a 403', async () => {
    const { client, code } = await codeFor('u1', 'orgA');
    const t = oauth.token(ISSUER, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client });
    expect(oauth.authenticate(ISSUER, `Bearer ${t.access_token}`)).toMatchObject({ ok: true, caller: { accountId: 'acc-u1-orgA' } });
    sql.exec("UPDATE accounts SET state = 'suspended' WHERE id = 'acc-u1-orgA'");
    expect(oauth.authenticate(ISSUER, `Bearer ${t.access_token}`)).toMatchObject({ ok: false, reason: 'account_inactive', status: 403 });
  });

  it('lists connections with their organization, and disconnects one', async () => {
    const { client, code } = await codeFor('u1', 'orgB');
    const t = oauth.token(ISSUER, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client }, '203.0.113.9 (curl)');
    const [c] = oauth.connections('u1');
    expect(c).toMatchObject({ name: 'Test agent', organizationId: 'orgB', endpoint: `${ISSUER}/mcp`, origin: '203.0.113.9 (curl)' });
    expect(oauth.disconnect('u2', c!.id)).toBe(false);
    expect(oauth.disconnect('u1', c!.id)).toBe(true);
    expect(oauth.authenticate(ISSUER, `Bearer ${t.access_token}`)).toMatchObject({ ok: false, reason: 'revoked' });
    expect(oauth.connections('u1')).toEqual([]);
  });

  it('acts through a personal agent, one per person, client and organization (agents.md §1), which retires with its last connection', async () => {
    const { code, client } = await codeFor('u1', 'orgA');
    const t = oauth.token(ISSUER, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client, redirect_uri: 'http://localhost:4567/callback' });
    const who = oauth.authenticate(ISSUER, `Bearer ${t.access_token}`);
    expect(who.ok).toBe(true);
    const agentId = (who as { caller: { agentId: string } }).caller.agentId;
    expect(agentId).toBeTruthy();
    const agent = sql.exec('SELECT * FROM users WHERE id = ?', agentId).toArray()[0]!;
    expect(agent).toMatchObject({ is_agent: 1, mode: 'personal', sponsor_user_id: 'u1', organization_id: 'orgA', display_name: 'Test agent' });
    const account = sql.exec('SELECT * FROM accounts WHERE user_id = ?', agentId).toArray();
    expect(account).toHaveLength(1);
    expect(account[0]).toMatchObject({ organization_id: 'orgA', kind: 'personal_agent', address: null, state: 'active', sponsor_user_id: 'u1' });
    expect(oauth.connections('u1')[0]).toMatchObject({ agentId });
    // The same client, connected again: the same agent. Another organization: another agent.
    const second = await codeFor('u1', 'orgA');
    oauth.token(ISSUER, { grant_type: 'authorization_code', code: second.code, code_verifier: verifier, client_id: second.client, redirect_uri: 'http://localhost:4567/callback' });
    expect(new Set(oauth.connections('u1').map((c) => c.agentId))).toEqual(new Set([agentId]));
    const other = await codeFor('u1', 'orgB');
    const t2 = oauth.token(ISSUER, { grant_type: 'authorization_code', code: other.code, code_verifier: verifier, client_id: other.client, redirect_uri: 'http://localhost:4567/callback' });
    const agentB = (oauth.authenticate(ISSUER, `Bearer ${t2.access_token}`) as { caller: { agentId: string } }).caller.agentId;
    expect(agentB).not.toBe(agentId);
    // An admin removes the agent's account: the delegation is over.
    sql.exec("UPDATE accounts SET state = 'removed' WHERE user_id = ?", agentB);
    expect(oauth.authenticate(ISSUER, `Bearer ${t2.access_token}`)).toMatchObject({ ok: false, reason: 'agent_removed', status: 403 });
    // Disconnecting the first of two connections keeps the agent; the last retires it.
    const [c1, c2] = oauth.connections('u1').filter((c) => c.agentId === agentId);
    expect(oauth.disconnect('u1', c1!.id)).toBe(true);
    expect(sql.exec('SELECT state FROM accounts WHERE user_id = ?', agentId).toArray()[0]!.state).toBe('active');
    expect(oauth.disconnect('u1', c2!.id)).toBe(true);
    expect(sql.exec('SELECT state FROM accounts WHERE user_id = ?', agentId).toArray()[0]!.state).toBe('removed');
    expect(sql.exec('SELECT deleted_at FROM users WHERE id = ?', agentId).toArray()[0]!.deleted_at).not.toBeNull();
  });

  it('connects a client as one of the person’s own agents, or as a shared agent whose tokens are the agent’s (agents.md §1, phase B)', async () => {
    const authorize = async () => {
      const o = await oauth.authorize(ISSUER, { response_type: 'code', client_id: client, redirect_uri: 'http://localhost:4567/callback', code_challenge: challenge, code_challenge_method: 'S256', state: 'st' });
      if (o.kind !== 'consent') throw new Error(o.url);
      return { p: o.pendingId, info: oauth.consent(o.pendingId, 'u1') };
    };
    const exchange = (to: URL) => oauth.token(ISSUER, { grant_type: 'authorization_code', code: to.searchParams.get('code')!, code_verifier: verifier, client_id: client, redirect_uri: 'http://localhost:4567/callback' });
    // The first connection makes the client's personal agent; the page then offers it to reconnect, and reconnecting reuses it.
    const first = await codeFor('u1', 'orgA');
    const client = first.client;
    exchange(first.to);
    const mine = await authorize();
    expect(mine.info.agents).toEqual([expect.objectContaining({ displayName: 'Test agent', mode: 'personal', organizationId: 'orgA' })]);
    const personalId = mine.info.agents[0]!.id;
    const t2 = exchange(new URL(oauth.decide(ISSUER, mine.p, 'u1', mine.info.csrf, true, 'orgA', undefined, { as: 'existing', agentId: personalId })));
    expect(oauth.authenticate(ISSUER, `Bearer ${t2.access_token}`)).toMatchObject({ ok: true, caller: { userId: 'u1', agentId: personalId, agentMode: 'personal', sponsorAccountId: null } });
    expect(sql.exec("SELECT COUNT(*) AS n FROM users WHERE is_agent = 1 AND sponsor_user_id = 'u1'").toArray()[0]!.n).toBe(1);
    // An agent of another organization, or someone else's, is refused.
    const third = await authorize();
    expect(() => oauth.decide(ISSUER, third.p, 'u1', third.info.csrf, true, 'orgB', undefined, { as: 'existing', agentId: personalId })).toThrow('belongs to another organization');
    expect(() => oauth.decide(ISSUER, third.p, 'u1', third.info.csrf, true, 'orgA', undefined, { as: 'existing', agentId: 'nope' })).toThrow('Choose one of your own agents');
    // A shared agent made by the organization's object (here as its outbox would report it), chosen on the page: the tokens
    // are the agent's own; the caller is the agent, asked by the person whose client it is.
    sql.exec("INSERT INTO users (id, email, password_hash, display_name, is_agent, sponsor_user_id, organization_id, mode, created_at) VALUES ('omni', 'omni@agents.flow.local', '!agent', 'Omni', 1, 'u1', 'orgA', 'shared', 0)");
    sql.exec("INSERT INTO accounts (id, user_id, organization_id, address, display_name, role, created_at, sponsor_user_id) VALUES ('acc-omni', 'omni', 'orgA', 'omni@orga.freeflow.im', 'Omni', 'member', 0, 'u1')");
    const t3 = exchange(new URL(oauth.decide(ISSUER, third.p, 'u1', third.info.csrf, true, 'orgA', undefined, { as: 'existing', agentId: 'omni' })));
    expect(oauth.authenticate(ISSUER, `Bearer ${t3.access_token}`)).toMatchObject({ ok: true, caller: { userId: 'omni', orgId: 'orgA', accountId: 'acc-omni', agentId: 'omni', agentMode: 'shared', sponsorAccountId: 'acc-u1-orgA' } });
    expect(oauth.connections('u1').find((c) => c.agentId === 'omni')).toMatchObject({ mode: 'shared', agentName: 'Omni' });
    // Disconnecting ends the tokens, not the agent: it is a member.
    expect(oauth.disconnect('u1', oauth.connections('u1').find((c) => c.agentId === 'omni')!.id)).toBe(true);
    expect(oauth.authenticate(ISSUER, `Bearer ${t3.access_token}`)).toMatchObject({ ok: false, reason: 'revoked' });
    expect(sql.exec("SELECT deleted_at, (SELECT state FROM accounts WHERE user_id = 'omni') AS state FROM users WHERE id = 'omni'").toArray()[0]).toMatchObject({ deleted_at: null, state: 'active' });
    // The device grant carries the choice too.
    const reg = oauth.register({ client_name: 'CLI', grant_types: ['urn:ietf:params:oauth:grant-type:device_code'] });
    const d = await oauth.deviceAuthorization(ISSUER, { client_id: reg.client_id }, '198.51.100.1');
    const started = oauth.startDevice(d.user_code, 'ip');
    if (!('pendingId' in started)) throw new Error(started.error);
    const di = oauth.consent(started.pendingId, 'u1');
    oauth.decide(ISSUER, started.pendingId, 'u1', di.csrf, true, 'orgA', undefined, { as: 'existing', agentId: 'omni' });
    sql.exec('UPDATE oauth_device SET last_poll_at = 0');
    const dt = oauth.token(ISSUER, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: d.device_code });
    expect(oauth.authenticate(ISSUER, `Bearer ${dt.access_token}`, '/mcp')).toMatchObject({ ok: true, caller: { userId: 'omni', agentMode: 'shared' } });
  });

  it('lets no agent connect an agent', async () => {
    sql.exec("INSERT INTO users (id, email, password_hash, display_name, is_agent, mode, organization_id, created_at) VALUES ('bot', 'bot@agents.flow.local', '', 'Bot', 1, 'shared', 'orgA', 0)");
    sql.exec("INSERT INTO accounts (id, user_id, organization_id, address, display_name, role, created_at) VALUES ('acc-bot', 'bot', 'orgA', 'bot@orga.freeflow.im', 'Bot', 'member', 0)");
    const client = registerClient();
    const out = await oauth.authorize(ISSUER, { response_type: 'code', client_id: client, redirect_uri: 'http://localhost:4567/callback', code_challenge: challenge, code_challenge_method: 'S256', state: 'st' });
    if (out.kind !== 'consent') throw new Error(out.url);
    expect(() => oauth.consent(out.pendingId, 'bot')).toThrow('An agent cannot connect an agent');
  });

  it('revokes a refresh token’s whole family', async () => {
    const { client, code } = await codeFor();
    const t = oauth.token(ISSUER, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client });
    oauth.revoke({ token: t.refresh_token });
    expect(oauth.authenticate(ISSUER, `Bearer ${t.access_token}`)).toMatchObject({ ok: false, reason: 'revoked' });
  });

  it('signs in a device for the organization chosen', async () => {
    const reg = oauth.register({ client_name: 'CLI', grant_types: ['urn:ietf:params:oauth:grant-type:device_code'] });
    const d = await oauth.deviceAuthorization(ISSUER, { client_id: reg.client_id }, '198.51.100.1');
    expect(() => oauth.token(ISSUER, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: d.device_code })).toThrow(/Waiting/);
    expect(oauth.startDevice('XXXX-XXXX', 'ip')).toHaveProperty('error');
    const started = oauth.startDevice(d.user_code, 'ip');
    if (!('pendingId' in started)) throw new Error(started.error);
    const info = oauth.consent(started.pendingId, 'u1');
    expect(info.device).toEqual({ origin: '198.51.100.1' });
    expect(oauth.decide(ISSUER, started.pendingId, 'u1', info.csrf, true, 'orgB')).toBe('/oauth/device/done?ok=1');
    sql.exec('UPDATE oauth_device SET last_poll_at = 0');
    const t = oauth.token(ISSUER, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: d.device_code });
    expect(oauth.authenticate(ISSUER, `Bearer ${t.access_token}`, '/mcp')).toMatchObject({ ok: true, caller: { orgId: 'orgB' } });
    expect(oauth.authenticate(ISSUER, `Bearer ${t.access_token}`, '/mcp/v2')).toMatchObject({ ok: false, reason: 'wrong_endpoint' });
  });

  it('refuses a bad redirect URI and an unknown client', async () => {
    expect(() => oauth.register({ redirect_uris: ['http://evil.test/cb'] })).toThrow(OAuthError);
    await expect(oauth.authorize(ISSUER, { client_id: 'nope', redirect_uri: 'http://localhost/cb' })).rejects.toThrow(/Unknown client_id/);
    const client = registerClient();
    await expect(oauth.authorize(ISSUER, { client_id: client, redirect_uri: 'https://other.test/cb' })).rejects.toThrow(/not registered/);
    const bad = await oauth.authorize(ISSUER, { response_type: 'code', client_id: client, redirect_uri: 'http://localhost/callback' });
    expect(bad.kind === 'redirect' && new URL(bad.url).searchParams.get('error')).toBe('invalid_request');
  });

  it('offers the scopes asked for as the consent page’s checkboxes, and grants what is ticked', async () => {
    expect(offeredGroups('files:read files:write mail:read mail:write mail:send')).toEqual([
      { id: 'docs', scopes: ['files:read', 'files:write'], checked: true },
      { id: 'mail', scopes: ['mail:read', 'mail:write'], checked: true },
      { id: 'send', scopes: ['mail:send'], checked: false },
    ]);
    // Calendar is its own checkbox, on as the page starts; a client asking for calendar:read only is offered that.
    expect(offeredGroups('files:read calendar:read calendar:write').map((g) => [g.id, g.checked])).toEqual([['docs', true], ['calendar', true]]);
    expect(offeredGroups('calendar:read')).toEqual([{ id: 'calendar', scopes: ['calendar:read'], checked: true }]);
    expect(grantedScope('files:read files:write calendar:read calendar:write', ['calendar'])).toBe('calendar:read calendar:write');
    // Events is its own checkbox too, on as the page starts.
    expect(offeredGroups('files:read events:read')).toEqual([{ id: 'docs', scopes: ['files:read'], checked: true }, { id: 'events', scopes: ['events:read'], checked: true }]);
    expect(grantedScope('files:read events:read', ['events'])).toBe('events:read');
    expect(grantedScope('files:read events:read', ['docs'])).toBe('files:read');
    // A client that asked for files alone is offered files alone, and cannot be given mail.
    expect(offeredGroups('files:read').map((g) => g.id)).toEqual(['docs']);
    expect(grantedScope('files:read', ['docs', 'mail', 'send'])).toBe('files:read');
    expect(grantedScope('files:read files:write mail:read mail:write mail:send', undefined)).toBe('files:read files:write mail:read mail:write');
    expect(grantedScope('files:read files:write mail:read mail:write mail:send', ['mail', 'send'])).toBe('mail:read mail:write mail:send');
    expect(grantedScope('files:read files:write mail:read mail:write mail:send', [])).toBeNull();

    const send = await codeFor('u1', 'orgA', undefined, ['docs', 'mail', 'send']);
    const t = oauth.token(ISSUER, { grant_type: 'authorization_code', code: send.code, code_verifier: verifier, client_id: send.client });
    expect(t.scope).toBe('files:read files:write mail:read mail:write mail:send');
    const mailOnly = await codeFor('u1', 'orgA', undefined, ['mail']);
    expect(oauth.token(ISSUER, { grant_type: 'authorization_code', code: mailOnly.code, code_verifier: verifier, client_id: mailOnly.client }).scope).toBe('mail:read mail:write');
    // Nothing ticked is refused, and the authorization stays pending.
    const client = registerClient();
    const out = await oauth.authorize(ISSUER, { response_type: 'code', client_id: client, redirect_uri: 'http://localhost/callback', code_challenge: challenge, code_challenge_method: 'S256' });
    if (out.kind !== 'consent') throw new Error('no consent');
    const { csrf } = oauth.consent(out.pendingId, 'u1');
    expect(() => oauth.decide(ISSUER, out.pendingId, 'u1', csrf, true, 'orgA', [])).toThrow(/at least one/);
    expect(new URL(oauth.decide(ISSUER, out.pendingId, 'u1', csrf, true, 'orgA', ['docs'])).searchParams.get('code')).toBeTruthy();
    // A refresh cannot widen the grant.
    const docsOnly = await codeFor('u1', 'orgA', undefined, ['docs']);
    const d = oauth.token(ISSUER, { grant_type: 'authorization_code', code: docsOnly.code, code_verifier: verifier, client_id: docsOnly.client });
    expect(() => oauth.token(ISSUER, { grant_type: 'refresh_token', refresh_token: d.refresh_token, client_id: docsOnly.client, scope: 'files:read mail:read' })).toThrow(/exceeds/);
  });

  it('gives a device sign-in the scopes ticked on its consent page', async () => {
    const reg = oauth.register({ client_name: 'CLI', redirect_uris: [], grant_types: ['urn:ietf:params:oauth:grant-type:device_code'] });
    const d = await oauth.deviceAuthorization(ISSUER, { client_id: reg.client_id }, '198.51.100.1');
    const started = oauth.startDevice(d.user_code, 'ip');
    if (!('pendingId' in started)) throw new Error(started.error);
    const info = oauth.consent(started.pendingId, 'u1');
    expect(oauth.decide(ISSUER, started.pendingId, 'u1', info.csrf, true, 'orgB', ['mail', 'send'])).toBe('/oauth/device/done?ok=1');
    sql.exec('UPDATE oauth_device SET last_poll_at = 0');
    const t = oauth.token(ISSUER, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: d.device_code });
    expect(t.scope).toBe('mail:read mail:write mail:send');
  });
});
