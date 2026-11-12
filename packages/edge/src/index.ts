// The suite's Worker. Today it is the front door: built files from the edge, everything else from the AWS origin.
// docs/specs/cloudflare-migration.md is the plan; each context that is ported gets its routes here, ahead of the proxy.
import { Hono, type Context } from 'hono';
import { ApiError } from './errors';
import { proxy, type ProxyEnv } from './proxy';
import { authRoutes, type AuthEnv } from './routes/auth';
import { orgRoutes } from './routes/org';
import { domainRoutes } from './routes/domains';
import { provisioningRoutes } from './routes/provisioning';
import { accountRoutes } from './routes/accounts';
import { agentRoutes } from './routes/agents';
import { promptRoutes } from './routes/prompts';
import { docsRoutes } from './routes/docs';
import { previewRoutes } from './routes/previews';
import { handoffRoutes } from './routes/handoff';
import { crossHostRoutes } from './routes/crossHost';
import { pageRoutes } from './routes/pages';
import { adminRoutes } from './routes/admin';
import { helpRoutes } from './routes/help';
import { mailRoutes } from './routes/mail';
import { calendarRoutes } from './routes/calendar';
import { mcpRoutes } from './routes/mcp';
import { eventRoutes } from './routes/events';
import { toolRoutes } from './routes/tools';
import { assistantRoutes } from './routes/assistant';
import { referenceRoutes } from './routes/references';
import { contactsRoutes } from './routes/contacts';
import { APP_MANIFESTS } from '@flow/shared/manifests';

export { Directory } from './directory/object';
export { Org } from './org/object';
export { Docs } from './docs/object';
export { PdfOcr } from './pdfOcr';
export { Mail } from './imap/object';
export { Calendar } from './calendar/object';
export { Events } from './events/object';
export { Assistant } from './assistant/object';
export { Contacts } from './contacts/object';
import type { Org as OrgObject } from './org/object';
import type { JobMessage } from './events/object';
import { handleJobBatch } from './events/queue';
import type { ProvisioningMessage } from './directory/core';
import { handleProvisioningBatch, handleProvisioningDeadLetters } from './provisioning/consumer';

export interface Env extends ProxyEnv, AuthEnv {
  DOCS: DurableObjectNamespace<import('./docs/object').Docs>;
  BLOBS: R2Bucket;
  ASSETS: Fetcher;
  ASSET_HOSTS: string;
  /** The hosts the ported API answers on: the rehearsal host until the cut-over, then the app's too. */
  PORTED_HOSTS: string;
  /** The ChatGPT plugin's hosts, still on the origin: their sign-in comes through here (routes/crossHost.ts). */
  PLUGIN_HOSTS?: string;
  ORG: DurableObjectNamespace<OrgObject>;
  /** Scanned PDFs' OCR; only the Docs object calls it. */
  PDF_OCR?: DurableObjectNamespace<import('./pdfOcr').PdfOcr>;
  /** FreeFlow Mail: one object per account (`idFromName(accountId)`), holding the mail accounts connected there (src/imap/object.ts). */
  MAIL: DurableObjectNamespace<import('./imap/object').Mail>;
  /** `1` in local dev only: mail accounts may then use unencrypted connections, any port and local hosts. Never set in production. */
  MAIL_ALLOW_INSECURE?: string;
  /** FreeFlow Calendar: one object per account, holding the calendar accounts connected there and their calendars (src/calendar/object.ts). */
  CALENDAR: DurableObjectNamespace<import('./calendar/object').Calendar>;
  /** `1` in local dev only: calendar accounts may then use http and local hosts (Radicale). Never set in production. */
  CALENDAR_ALLOW_INSECURE?: string;
  /** The event bus: one object per organization (`idFromName(organizationId)`), its event log (src/events/object.ts). */
  EVENTS: DurableObjectNamespace<import('./events/object').Events>;
  /** The assistant: one object per account (`idFromName(accountId)`), its chats, settings and usage (src/assistant/object.ts). */
  ASSISTANT: DurableObjectNamespace<import('./assistant/object').Assistant>;
  /** FreeFlow Contacts: one object per account, its own contacts and their one grant (src/contacts/object.ts). */
  CONTACTS?: DurableObjectNamespace<import('./contacts/object').Contacts>;
  /** The `flow-jobs` Queue (producer): each wake job's check, sent by the Events object and consumed by `queue` below. */
  JOBS?: Queue<JobMessage>;
  /** The `flow-provisioning` Queue (producer): the Directory object sends accounts' mailbox work there (provisioning/). */
  PROVISIONING?: Queue<ProvisioningMessage>;
  /** How long after a job's delivery its first check comes, in seconds (default 60). */
  JOBS_ACK_DELAY_SECONDS?: string;
  /** Google Calendar's OAuth client secret (with GOOGLE_CLIENT_ID). A secret; unset turns Google Calendar off. */
  GOOGLE_CLIENT_SECRET?: string;
  /** The OAuth callback's address when it is not the Worker's own origin (local dev). */
  GOOGLE_REDIRECT_URL?: string;
  /** Seals Chat's messages and files, and the passwords of mail and calendar accounts (org/crypto). A secret. */
  FLOW_DATA_KEY?: string;
}

/** Paths that are never files: they skip the look in the assets. */
const NEVER_A_FILE = /^\/(v1|api|mcp|oauth|plugin|\.well-known)(\/|$)/;
/** Vite's content-hashed output, under each client's base path in the manifests (the web client's root, /docs, /mail, …). */
const BASES = APP_MANIFESTS.flatMap((m) => (m.client && m.client.basePath !== '/' ? [m.client.basePath.replace(/^\/|\/$/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')] : []));
const HASHED_FILE = new RegExp(`^(/(${BASES.join('|')}))?/assets/`);

const app = new Hono<{ Bindings: Env }>();

const onError = (err: Error, c: Context) => {
  if (err instanceof ApiError) return c.json({ error: { code: err.code, message: err.message } }, err.statusCode as 400);
  console.error(err);
  return c.json({ error: { code: 'internal', message: 'internal server error' } }, 500);
};
app.onError(onError);

app.get('/edge/health', (c) => c.json({ ok: true }));
app.route('/', adminRoutes as never);

// Ported routes, only on the hosts that have been switched. A path not ported yet falls through to the proxy.
const ported = new Hono<{ Bindings: Env }>();
ported.onError(onError);
// Docs' MCP endpoint and its OAuth (/mcp, /oauth/*, /.well-known/oauth-*), and the agents it lists under Docs' /api/settings.
// The plugin's hosts (docs., mcpdocs.) are not ported, so their /mcp and OAuth still go to AWS.
ported.route('/', mcpRoutes as never);
// Before Docs' /api/*: the desktop app's sign-in lives under /api/auth on the Workspace app's old paths.
ported.route('/', handoffRoutes as never);
ported.route('/', crossHostRoutes as never);
// Mail's attachment previews, before Docs' /api/*: the Worker reads the bytes from Mail and hands them to Docs.
ported.route('/', previewRoutes as never);
// The assistant's paths under /api (/api/agent, its turn, reset and permission, /api/settings/assistant), before Docs' /api/*.
ported.route('/', assistantRoutes as never);
ported.route('/', docsRoutes as never);
ported.route('/', authRoutes as never);
ported.route('/', helpRoutes as never);
ported.route('/', mailRoutes as never);
ported.route('/', calendarRoutes as never);
ported.route('/', contactsRoutes as never);
ported.route('/', eventRoutes as never);
ported.route('/', referenceRoutes as never);
ported.route('/', toolRoutes as never);
ported.route('/', domainRoutes as never);
ported.route('/', provisioningRoutes as never);
ported.route('/', accountRoutes as never);
ported.route('/', agentRoutes as never);
ported.route('/', promptRoutes as never);
ported.route('/', orgRoutes as never);
ported.route('/', pageRoutes as never);
app.use('*', async (c, next) => {
  if (!c.env.PORTED_HOSTS.split(',').includes(new URL(c.req.url).hostname)) return next();
  const res = await ported.fetch(c.req.raw, c.env, c.executionCtx);
  return res.status === 404 && !res.headers.get('content-type')?.includes('json') ? next() : res;
});

app.all('*', async (c) => {
  const req = c.req.raw;
  const url = new URL(req.url);
  const isRead = req.method === 'GET' || req.method === 'HEAD';
  if (isRead && !NEVER_A_FILE.test(url.pathname) && c.env.ASSET_HOSTS.split(',').includes(url.hostname)) {
    const file = await c.env.ASSETS.fetch(req);
    if (file.status !== 404) {
      if (!HASHED_FILE.test(url.pathname)) return file;
      const hashed = new Response(file.body, file);
      hashed.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      return hashed;
    }
    // A build file this deploy does not have: a page loaded before the deploy asks for its old code. A plain 404, never the
    // origin, whose answer is its HTML page: the app then sees a failed import and reloads itself (@flow/suite-bar
    // reloadOnStaleBuild), where HTML in place of a script was a "MIME type" error and a dead button.
    if (HASHED_FILE.test(url.pathname)) return new Response('Not found: this file is from an older version of the app.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  }
  return proxy(req, c.env);
});

// The Queues' consumers beside the routes: `flow-jobs` (events/queue.ts), `flow-provisioning` and its dead letters
// (provisioning/consumer.ts).
export default Object.assign(app, {
  queue: (batch: MessageBatch<unknown>, env: Env) => {
    if (batch.queue === 'flow-provisioning') return handleProvisioningBatch(batch as MessageBatch<ProvisioningMessage>, env as never);
    if (batch.queue === 'flow-provisioning-dlq') return handleProvisioningDeadLetters(batch as MessageBatch<ProvisioningMessage>, env as never);
    return handleJobBatch(batch as MessageBatch<JobMessage>, env);
  },
});
