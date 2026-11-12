// Docs' MCP endpoint on the suite's own host: app.freeflow.im/mcp (docs/specs/web-mcp.md). Its OAuth lives in the directory
// (directory/mcpOAuth.ts), because authorization comes before an organization is known; the person signs in with FreeFlow's
// own session and chooses an organization on the consent page. /mcp then runs in that organization's Docs object, as them.
// Only on the ported hosts: docs.freeflow.im and mcpdocs.freeflow.im keep the ChatGPT plugin's /mcp and OAuth on AWS.
import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { UserDTO } from '@flow/shared';
import type { Docs } from '../docs/object';
import type { OAuthMethod } from '../directory/object';
import { authorizationServerMetadata, OAuthError, protectedResourceMetadata, SCOPE_GROUPS, wwwAuthenticate, type AgentChoice, type McpOAuth, type OAuthAnswer } from '../directory/mcpOAuth';
import { directory, type AuthEnv } from './auth';
import { consentPage, deviceDonePage, devicePage, errorPage } from './mcpPages';

export interface McpRouteEnv extends AuthEnv { DOCS: DurableObjectNamespace<Docs> }
type C = Context<{ Bindings: McpRouteEnv }>;

export const mcpRoutes = new Hono<{ Bindings: McpRouteEnv }>();

/** Calls the directory's MCP authorization server, turning an OAuth error back into an `OAuthError`. */
async function oauth<M extends OAuthMethod>(c: { env: AuthEnv }, method: M, ...args: Parameters<McpOAuth[M]>): Promise<Awaited<ReturnType<McpOAuth[M]>>> {
  const stub = c.env.DIRECTORY.get(c.env.DIRECTORY.idFromName('directory'));
  const answer = (await stub.oauth(method, args)) as OAuthAnswer<never>;
  if (!answer.ok) throw new OAuthError(answer.code, answer.description, answer.status);
  return answer.value;
}

/** The issuer and resource are the request's own origin (https://app.freeflow.im). */
const issuerOf = (c: C) => new URL(c.req.url).origin;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-expose-headers': 'www-authenticate, mcp-session-id, mcp-protocol-version',
};
const PAGE_HEADERS = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'", 'referrer-policy': 'no-referrer' };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
const html = (body: string, status = 200) => new Response(body, { status, headers: PAGE_HEADERS });
const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to, 'cache-control': 'no-store' } });
const oauthFailure = (e: unknown, headers: Record<string, string> = {}) => {
  if (e instanceof OAuthError) return json({ error: e.code, error_description: e.message }, e.status, headers);
  throw e;
};

/** The person signed in to FreeFlow in this browser: only the session cookie, never a bearer token, can allow an agent. */
async function sessionUser(c: C): Promise<UserDTO | null> {
  const sid = getCookie(c, 'sid');
  if (!sid) return null;
  try {
    const { user, kind } = await directory(c, 'authenticate', sid);
    return kind === 'session' ? user : null;
  } catch {
    return null;
  }
}

/** FreeFlow's sign-in, coming back to `back` (a path on this host), as /docs does (routes/pages.ts). */
const signIn = (back: string) => redirect(`/?next=${encodeURIComponent(back)}`);

/** A form body, or a JSON one, as flat strings. */
async function readForm(c: C): Promise<Record<string, string>> {
  const text = await c.req.text();
  if ((c.req.header('content-type') ?? '').includes('application/json')) {
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(j).filter(([, v]) => typeof v === 'string') as [string, string][]);
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

const clientAddress = (c: C) => {
  const agent = (c.req.header('user-agent') ?? '').slice(0, 80);
  return `${c.req.header('cf-connecting-ip') ?? 'unknown'}${agent ? ` (${agent})` : ''}`;
};

/** The organizations' names, each from its own object. */
async function organizationNames(c: C, user: UserDTO, ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  await Promise.all(
    [...new Set(ids)].map(async (id) => {
      try {
        const answer = (await (c.env.ORG.get(c.env.ORG.idFromName(id)) as unknown as { workspaceFor(u: UserDTO): Promise<unknown> }).workspaceFor(user)) as { id?: string; name?: string }[];
        const w = answer.find((x) => x.id === id) ?? answer[0];
        names.set(id, w?.name ?? '');
      } catch (err) {
        console.error(`organization name ${id}: ${(err as Error).message}`);
        names.set(id, '');
      }
    }),
  );
  return names;
}

// --- Discovery: the documents MCP clients probe, on the request's origin ----------------------------------------------

const VERSION = '{v[0-9]+}';
const resourceMetadata = (endpoint: string) => (c: C) => json(protectedResourceMetadata(issuerOf(c), endpoint), 200, CORS);
const serverMetadata = (c: C) => json(authorizationServerMetadata(issuerOf(c)), 200, CORS);
mcpRoutes.get('/.well-known/oauth-protected-resource', resourceMetadata('/mcp'));
mcpRoutes.get('/.well-known/oauth-protected-resource/mcp', resourceMetadata('/mcp'));
mcpRoutes.get(`/.well-known/oauth-protected-resource/mcp/:v${VERSION}`, (c) => resourceMetadata(`/mcp/${c.req.param('v')}`)(c));
mcpRoutes.get('/mcp/.well-known/oauth-protected-resource', resourceMetadata('/mcp'));
mcpRoutes.get(`/mcp/:v${VERSION}/.well-known/oauth-protected-resource`, (c) => resourceMetadata(`/mcp/${c.req.param('v')}`)(c));
mcpRoutes.get('/.well-known/oauth-authorization-server', serverMetadata);
mcpRoutes.get('/.well-known/oauth-authorization-server/mcp', serverMetadata);
mcpRoutes.get(`/.well-known/oauth-authorization-server/mcp/:v${VERSION}`, serverMetadata);
mcpRoutes.get('/mcp/.well-known/oauth-authorization-server', serverMetadata);

// --- OAuth ----------------------------------------------------------------------------------------------------------

for (const p of ['/oauth/register', '/oauth/token', '/oauth/revoke', '/oauth/device_authorization', '/mcp', '/mcp/*']) mcpRoutes.options(p, () => new Response(null, { status: 204, headers: CORS }));

mcpRoutes.post('/oauth/register', async (c) => {
  try {
    return json(await oauth(c, 'register', await c.req.json().catch(() => ({}))), 201, CORS);
  } catch (e) {
    return oauthFailure(e, CORS);
  }
});

/** Starts the flow; a person not signed in goes to FreeFlow's sign-in and comes back to the consent page. */
mcpRoutes.get('/oauth/authorize', async (c) => {
  let out;
  try {
    out = await oauth(c, 'authorize', issuerOf(c), Object.fromEntries(new URL(c.req.url).searchParams));
  } catch (e) {
    if (e instanceof OAuthError) return html(errorPage(e.message), e.status);
    throw e;
  }
  if (out.kind === 'redirect') return redirect(out.url);
  const consent = `/oauth/consent?p=${encodeURIComponent(out.pendingId)}`;
  return (await sessionUser(c)) ? redirect(consent) : signIn(consent);
});

/** The consent page: who is signed in, the client, what it may do, and which of their organizations it is for. */
async function renderConsent(c: C, user: UserDTO, pendingId: string, error?: string, status = 200): Promise<Response> {
  let info;
  try {
    info = await oauth(c, 'consent', pendingId, user.id);
  } catch (e) {
    if (e instanceof OAuthError) return html(errorPage(e.message), e.status);
    throw e;
  }
  const names = await organizationNames(c, user, [...info.organizations, ...info.agents.map((a) => a.organizationId)]);
  const organizations = info.organizations.map((id) => ({ id, name: names.get(id) ?? '' })).sort((a, b) => a.name.localeCompare(b.name));
  const agents = info.agents.map((a) => ({ id: a.id, displayName: a.displayName, mode: a.mode, organizationId: a.organizationId, organizationName: names.get(a.organizationId) ?? '' }));
  return html(consentPage({ pendingId, csrf: info.csrf, clientName: info.clientName, scopes: info.scopes, email: user.email, device: info.device, organizations, preselect: info.preselect, agents, ...(error ? { error } : {}) }), status);
}

mcpRoutes.get('/oauth/consent', async (c) => {
  const pendingId = c.req.query('p') ?? '';
  const user = await sessionUser(c);
  if (!user) {
    if (!(await oauth(c, 'pendingExists', pendingId))) return html(errorPage('This sign-in link has expired. Start again from your agent.'), 400);
    return signIn(`/oauth/consent?p=${encodeURIComponent(pendingId)}`);
  }
  return renderConsent(c, user, pendingId);
});

/**
 * Allow or deny. Protected against forgery three ways: the session cookie is SameSite=Lax (another site's form posts
 * without it), the page's CSRF token must match the pending authorization's, and an Origin header must be this host.
 */
mcpRoutes.post('/oauth/decision', async (c) => {
  const origin = c.req.header('origin');
  if (origin && origin !== issuerOf(c)) return html(errorPage('This request came from another site.'), 403);
  const user = await sessionUser(c);
  if (!user) return html(errorPage('You are signed out. Start again from your agent.'), 401);
  const form = await readForm(c);
  try {
    // The page's checkboxes (grant_docs, grant_mail, grant_send, grant_calendar, grant_events); a form without them takes each group as the page starts it.
    const ticked = form.scopes_form === '1' ? SCOPE_GROUPS.map((g) => g.id).filter((id) => form[`grant_${id}`]) : undefined;
    // Connect as (agents.md §1): a personal agent (the default), one of the person's own, or a new shared agent, which the
    // organization's object makes first (a member sponsored by the person, under its sponsoring policy), then the grant names.
    let choice: AgentChoice = { as: 'personal' };
    const as = form.as ?? 'personal';
    if (form.allow === 'yes' && as.startsWith('existing:')) choice = { as: 'existing', agentId: as.slice('existing:'.length) };
    else if (form.allow === 'yes' && as === 'shared') {
      // Everything the decision would refuse is checked first, so a stale page or an empty scope makes no orphan member.
      await oauth(c, 'checkDecision', form.p, user.id, form.csrf, true, form.org, ticked);
      const name = (form.agent_name ?? '').trim();
      if (!name) throw new OAuthError('access_denied', 'Give the shared agent a name.', 403);
      const org = c.env.ORG.get(c.env.ORG.idFromName(form.org)) as unknown as { createSharedAgent(p: { sponsorId: string; name: string }): Promise<{ userId: string }> };
      let made: { userId: string };
      try {
        made = await org.createSharedAgent({ sponsorId: user.id, name });
      } catch (err) {
        throw new OAuthError('access_denied', (err as Error).message, 403);
      }
      choice = { as: 'existing', agentId: made.userId };
    }
    return redirect(await oauth(c, 'decide', issuerOf(c), form.p, user.id, form.csrf, form.allow === 'yes', form.org, ticked, choice));
  } catch (e) {
    if (!(e instanceof OAuthError)) throw e;
    // The wrong organization: the page again, still pending, saying so.
    if (e.code === 'access_denied') return renderConsent(c, user, form.p ?? '', e.message, 403);
    return html(errorPage(e.message), e.status);
  }
});

mcpRoutes.post('/oauth/token', async (c) => {
  try {
    return json(await oauth(c, 'token', issuerOf(c), await readForm(c), clientAddress(c)), 200, CORS);
  } catch (e) {
    return oauthFailure(e, CORS);
  }
});

mcpRoutes.post('/oauth/revoke', async (c) => {
  await oauth(c, 'revoke', await readForm(c));
  return new Response(null, { status: 200, headers: CORS });
});

// --- Device sign-in (RFC 8628): the agent asks for a code, the person enters it on /oauth/device -------------------------

mcpRoutes.post('/oauth/device_authorization', async (c) => {
  try {
    return json(await oauth(c, 'deviceAuthorization', issuerOf(c), await readForm(c), clientAddress(c)), 200, CORS);
  } catch (e) {
    return oauthFailure(e, CORS);
  }
});

mcpRoutes.get('/oauth/device', async (c) => ((await sessionUser(c)) ? html(devicePage()) : signIn('/oauth/device')));

mcpRoutes.post('/oauth/device', async (c) => {
  const origin = c.req.header('origin');
  if (origin && origin !== issuerOf(c)) return html(errorPage('This request came from another site.'), 403);
  const user = await sessionUser(c);
  if (!user) return signIn('/oauth/device');
  const r = await oauth(c, 'startDevice', (await readForm(c)).code, c.req.header('cf-connecting-ip') ?? 'unknown');
  if ('error' in r) return html(devicePage(r.error));
  return redirect(`/oauth/consent?p=${encodeURIComponent(r.pendingId)}`);
});

mcpRoutes.get('/oauth/device/done', (c) => html(deviceDonePage(c.req.query('ok') === '1')));

// Every other /oauth path is answered here, so none reaches the plugin on AWS from this host.
mcpRoutes.all('/oauth/*', () => json({ error: 'not_found' }, 404));

// --- The MCP endpoint -------------------------------------------------------------------------------------------------

/** An agent's upload to the address upload_file gave it (the ticket in it is the credential), in the organization named. */
mcpRoutes.post('/mcp/import/:org', async (c) => {
  const org = c.req.param('org');
  if (!(await directory(c, 'organizationKnown', org))) return json({ error: 'No such organization.' }, 404, CORS);
  const res = await c.env.DOCS.get(c.env.DOCS.idFromName(org)).mcpImport(c.req.raw, org);
  return withHeaders(res, CORS);
});

const withHeaders = (res: Response, headers: Record<string, string>) => {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
};

async function mcpEndpoint(c: C): Promise<Response> {
  const endpoint = new URL(c.req.url).pathname;
  const issuer = issuerOf(c);
  const authorization = c.req.header('authorization');
  const who = await oauth(c, 'authenticate', issuer, authorization, endpoint);
  if (!who.ok && who.status === 403) {
    console.log(`${c.req.method} ${endpoint} -> 403 ${who.reason}`);
    return json({ error: who.reason, error_description: who.description }, 403, CORS);
  }
  if (!who.ok) {
    console.log(`${c.req.method} ${endpoint} -> 401 ${who.reason} [${(c.req.header('user-agent') ?? '').slice(0, 24)}]`);
    return json({ error: 'unauthorized', reason: who.reason, error_description: who.description }, 401, { ...CORS, 'www-authenticate': wwwAuthenticate(issuer, endpoint, authorization ? 'invalid_token' : undefined, who.description) });
  }
  const { userId, email, orgId, accountId, scope, agentId, agentMode, sponsorAccountId } = who.caller;
  // A personal agent acts as its sponsor, marked `via`; a shared agent acts as itself, asked by the person whose client it is.
  const res = await c.env.DOCS.get(c.env.DOCS.idFromName(orgId)).mcp(c.req.raw, { userId, email, orgId, accountId, via: agentMode === 'shared' ? null : agentId, invokedBy: agentMode === 'shared' ? sponsorAccountId : null, scope, endpoint, origin: issuer });
  return withHeaders(res, CORS);
}
mcpRoutes.all('/mcp', mcpEndpoint);
mcpRoutes.all(`/mcp/:v${VERSION}`, mcpEndpoint);
// Every other /mcp path is answered here too.
mcpRoutes.all('/mcp/*', () => json({ error: 'not_found' }, 404));

// --- Docs' Settings, Connect your agent: the agents connected through this host's OAuth, with their organization ---------

async function apiUser(c: C): Promise<UserDTO | null> {
  const header = c.req.header('authorization');
  const token = (header?.startsWith('Bearer ') ? header.slice(7).trim() : getCookie(c, 'sid')) || null;
  if (!token) return null;
  return directory(c, 'authenticate', token).then((a) => a.user, () => null);
}

mcpRoutes.get('/api/settings/agents', async (c) => {
  const user = await apiUser(c);
  if (!user) return json({ error: 'Not signed in' }, 401);
  const agents = await oauth(c, 'connections', user.id);
  const names = await organizationNames(c, user, agents.map((a) => a.organizationId));
  return json({ enabled: true, everySignIn: true, mcpUrl: `${issuerOf(c)}/mcp`, agents: agents.map((a) => ({ ...a, organization: names.get(a.organizationId) || 'An organization you left' })) });
});

/** The same, for the Admin app's "Connect an agent" (the platform's /v1, its error shape): the person's connected agents. */
mcpRoutes.get('/v1/me/agent-connections', async (c) => {
  const user = await apiUser(c);
  if (!user) return json({ error: { code: 'unauthorized', message: 'Not signed in' } }, 401);
  const agents = await oauth(c, 'connections', user.id);
  const names = await organizationNames(c, user, agents.map((a) => a.organizationId));
  return json({ mcpUrl: `${issuerOf(c)}/mcp`, agents: agents.map((a) => ({ ...a, organization: names.get(a.organizationId) || 'An organization you left' })) });
});
mcpRoutes.delete('/v1/me/agent-connections/:id', async (c) => {
  const user = await apiUser(c);
  if (!user) return json({ error: { code: 'unauthorized', message: 'Not signed in' } }, 401);
  return (await oauth(c, 'disconnect', user.id, c.req.param('id'))) ? json({ ok: true }) : json({ error: { code: 'not_found', message: 'No such agent.' } }, 404);
});

mcpRoutes.delete('/api/settings/agents/:id', async (c) => {
  const user = await apiUser(c);
  if (!user) return json({ error: 'Not signed in' }, 401);
  return (await oauth(c, 'disconnect', user.id, c.req.param('id'))) ? json({ ok: true }) : json({ error: 'No such agent.' }, 404);
});
