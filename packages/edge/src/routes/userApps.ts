// User apps (docs/specs/user-apps.md, phase 1: external apps). The routes check who is calling and their role; the Org
// object keeps the app's rows (org/services/userApps.ts).
//
//   GET    /v1/workspaces/:id/apps                  every installed app, as the caller sees it (members; a guest gets none)
//   POST   /v1/workspaces/:id/apps/preview          an app's manifest fetched from a URL and checked, for the install card
//   POST   /v1/workspaces/:id/apps                  install from a manifest URL, or a hosted app's uploaded version, with who
//                                                   gets its scopes (owners, admins)
//   POST   /v1/workspaces/:id/apps/versions         upload a hosted app's version: manifest and files (members, agents)
//   GET    /v1/workspaces/:id/apps/versions         the hosted versions uploaded here
//   POST   /v1/workspaces/:id/apps/:name/restore    go back before a hosted app's latest update: its data and its version
//   GET    /v1/workspaces/:id/apps/drafts           the caller's drafts (§9.6); POST makes one (starter, or the installed app)
//   GET    /v1/workspaces/:id/apps/drafts/:name     one draft: its files and problems; DELETE drops it
//   GET|PUT|DELETE …/drafts/:name/file             one file's text (?path=), written, or deleted
//   POST   …/drafts/:name/try                       one of its tools in its dev install, as its author (§9.3)
//   POST   …/drafts/:name/publish                   the draft as a version an owner or admin installs
//   GET    /v1/workspaces/:id/apps/:name/export     a hosted app's data here, as JSON
//   PUT    /v1/workspaces/:id/apps/:name            install the manifest again (an update), with who gets its scopes
//   PUT    /v1/workspaces/:id/apps/:name/grants     change who holds its scopes
//   DELETE /v1/workspaces/:id/apps/:name            remove it
//   POST   /v1/workspaces/:id/apps/:name/secret     a new secret; the old one stops at once
//   PUT    /v1/workspaces/:id/apps/:name/agents     a person turns the app on or off for their personal agents (§5.2)
//   POST   /v1/workspaces/:id/apps/:name/screen     the screen's URL with a one-use door key (§6.2)
//   GET    /v1/workspaces/:id/apps/:name/icon       an image icon (§4): the installed version's, or ?v=<version>'s (members)
//   POST   /v1/workspaces/:id/tools/call            the bridge runs an app tool (the bridge runs built-in tools itself)
//   POST   /v1/apps/:org/:name/events               an event from the app, signed with its secret (§5.1): no session
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { appIconUrl, checkAppIcon, checkHostedFiles, checkUserAppManifest, isHosted, isImageIcon, parseAppToolName, USER_APP_LIMITS, type AccountDTO, type UserAppManifest } from '@flow/shared';
import type { AppSource, AppUpload } from '../org/services/userApps';
import { filesPrefix, type HostedEnv } from '../apps/hosted';
import { ApiError, badRequest, forbidden, unauthorized } from '../errors';
import { directory, guestRefusal, resolveCaller, type AuthEnv } from './auth';
import { holderOf, runAppTool } from '../registry/userApps';
import { SIGNATURE_HEADER } from '../org/lib/appSigning';

type C = Context<{ Bindings: AuthEnv }>;

export const userAppRoutes = new Hono<{ Bindings: AuthEnv }>();

const ORG_ID = /^[0-9a-f-]{36}$/;
const Grants = z.object({ members: z.boolean(), accounts: z.array(z.string().min(1).max(100)).max(200).default([]) });
// An external app from its manifest URL; a hosted app from its uploaded version (§14 phase 2, step 1).
const InstallBody = z.union([
  z.object({ url: z.string().url().max(2000), grants: Grants }),
  z.object({ name: z.string().min(1).max(20), version: z.number().int().positive(), grants: Grants }),
]);
const UpdateBody = z.object({ url: z.string().url().max(2000).optional(), version: z.number().int().positive().optional(), grants: Grants });
// A hosted app's version: its manifest and its files, each base64 (§14 phase 2, step 1).
const UploadBody = z.object({ manifest: z.unknown(), files: z.record(z.string(), z.string().max(7_000_000)) });
const PreviewBody = z.object({ url: z.string().url().max(2000) });
const AgentsBody = z.object({ on: z.boolean() });
const CallBody = z.object({ name: z.string().min(1).max(64), input: z.record(z.string(), z.unknown()).default({}) });

const orgStub = (c: C, id: string) => c.env.ORG.get(c.env.ORG.idFromName(id));

/** The Org object's answer as a value, or its refusal as the ApiError it was. */
function unwrap<T>(a: { ok: true; value: T } | { ok: false; status: number; code: string; message: string }): T {
  if (!a.ok) throw new ApiError(a.status, a.code, a.message);
  return a.value;
}

async function body<S extends z.ZodTypeAny>(c: C, schema: S): Promise<z.output<S>> {
  const r = schema.safeParse(await c.req.json().catch(() => undefined));
  if (!r.success) {
    const issue = r.error.issues[0];
    throw badRequest('validation', issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid request');
  }
  return r.data;
}

interface Member { organizationId: string; userId: string; displayName: string; isAgent: boolean; account: AccountDTO; via: string | null; invokedBy: string | null }

/** The caller's account in the organization the path names, or a 4xx. */
async function memberOf(c: C): Promise<Member> {
  const organizationId = c.req.param('id') ?? '';
  if (!ORG_ID.test(organizationId)) throw badRequest('validation', 'not an organization id');
  const who = await resolveCaller(c, organizationId);
  if (!who.user) throw unauthorized('missing bearer token');
  if (!who.account) throw new ApiError(403, 'no_account', 'not a member of this organization');
  return {
    organizationId, userId: who.user.id, displayName: who.user.displayName, isAgent: !!who.user.isAgent, account: who.account,
    via: who.via ?? null, invokedBy: who.invokedBy ?? null,
  };
}

const isAdmin = (m: Member) => m.account.role === 'owner' || m.account.role === 'admin';

/** An owner or an admin, as a person: an agent never installs or changes an app for the organization (§9.4). */
async function adminOf(c: C): Promise<Member> {
  const m = await memberOf(c);
  if (m.isAgent || m.via || !isAdmin(m)) throw forbidden('only owners and admins install and change apps');
  return m;
}

/** A local suite (http://localhost) may reach an app on http://; a deployed one only on https (§4). */
const allowHttp = (c: C) => c.env.WEB_URL_BASE.startsWith('http://');

/** Fetches and checks a manifest from its URL: at most 128 KB, ten seconds, no redirects. */
async function fetchManifest(c: C, url: string): Promise<{ ok: true; manifest: UserAppManifest } | { ok: false; problems: string[] }> {
  if (!url.startsWith('https://') && !(allowHttp(c) && url.startsWith('http://'))) return { ok: false, problems: ['url: the manifest URL must be https'] };
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'FreeFlow-Apps/1' }, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  } catch {
    return { ok: false, problems: [`url: ${url} could not be reached`] };
  }
  if (!res.ok) return { ok: false, problems: [`url: ${url} answered ${res.status}`] };
  const text = await res.text();
  if (text.length > USER_APP_LIMITS.manifestBytes) return { ok: false, problems: [`url: the manifest is over ${USER_APP_LIMITS.manifestBytes} bytes`] };
  let json: unknown;
  try { json = JSON.parse(text); } catch { return { ok: false, problems: ['url: the manifest is not JSON'] }; }
  return checkUserAppManifest(json, { allowHttp: allowHttp(c) });
}

/** A manifest that does not pass: 400, with every problem, so its author can fix them all. */
const refused = (c: C, problems: string[]) => c.json({ error: { code: 'manifest', message: problems.join('\n') || 'the manifest is not valid', problems } }, 400);

userAppRoutes.get('/v1/workspaces/:id/apps', async (c) => {
  const m = await memberOf(c);
  // `canBuild`: the Apps menu's Build an app (§9.6): every member and agent but a guest.
  if (m.account.kind === 'guest') return c.json({ apps: [], canBuild: false });
  const listed = await orgStub(c, m.organizationId).listUserApps({ ...holderOf({ ...m, account: m.account }), via: null, admin: isAdmin(m) && !m.isAgent });
  // An image icon's address, on this organization's path (the Org object names it from the app's own).
  const apps = listed.map((a) => (a.iconUrl ? { ...a, iconUrl: `/v1/workspaces/${m.organizationId}/${a.iconUrl}` } : a));
  c.header('Cache-Control', 'no-store');
  return c.json({ apps, canBuild: true });
});

userAppRoutes.post('/v1/workspaces/:id/apps/preview', async (c) => {
  await adminOf(c);
  const { url } = await body(c, PreviewBody);
  const r = await fetchManifest(c, url);
  return r.ok ? c.json({ manifest: r.manifest }) : refused(c, r.problems);
});

userAppRoutes.post('/v1/workspaces/:id/apps', async (c) => {
  const m = await adminOf(c);
  const b = await body(c, InstallBody);
  let source: AppSource;
  if ('url' in b) {
    const r = await fetchManifest(c, b.url);
    if (!r.ok) return refused(c, r.problems);
    source = { manifest: r.manifest, manifestUrl: b.url };
  } else {
    source = { name: b.name, version: b.version };
  }
  const installed = unwrap(await orgStub(c, m.organizationId).installUserApp({ source, by: m.account.id, grants: b.grants }));
  return c.json({ app: installed.name, version: installed.version, secret: installed.secret }, 201);
});

userAppRoutes.put('/v1/workspaces/:id/apps/:name', async (c) => {
  const m = await adminOf(c);
  const name = c.req.param('name');
  const { url, version, grants } = await body(c, UpdateBody);
  const org = orgStub(c, m.organizationId);
  const current = (await org.listUserApps({ ...holderOf(m), via: null, admin: true })).find((a) => a.name === name);
  if (!current) throw new ApiError(404, 'not_found', 'no such app here');
  let source: AppSource;
  let bookmark: string | undefined;
  if (version !== undefined) {
    source = { name, version };
    // A hosted app's restore point (§8): its store as it is now, taken before the new version's migrations can run.
    const store = (c.env as AuthEnv & HostedEnv).APP_STORE;
    if (current.hosted && store) bookmark = await store.get(store.idFromName(`${name}:${m.organizationId}`)).bookmark();
  }
  else if (current.hosted) throw badRequest('validation', 'a hosted app is updated to an uploaded version: name it as version');
  else {
    const from = url ?? current.manifestUrl;
    const r = await fetchManifest(c, from);
    if (!r.ok) return refused(c, r.problems);
    source = { manifest: r.manifest, manifestUrl: from };
  }
  const updated = unwrap(await org.updateUserApp({ name, source, by: m.account.id, grants, ...(bookmark ? { bookmark } : {}) }));
  return c.json({ ok: true, version: updated.version });
});

/**
 * Uploads a hosted app's version (§14 phase 2, step 1): the manifest and the files, checked; the files to R2 under a
 * prefix of their own, the rest to the Org object. It runs nowhere until an owner or admin installs it.
 */
userAppRoutes.post('/v1/workspaces/:id/apps/versions', async (c) => {
  // Any member or agent but a guest may upload (§9.4's default, members and their agents): a version runs nowhere until
  // an owner or admin installs it.
  const m = await memberOf(c);
  const guest = guestRefusal(m.account, 'apps');
  if (guest) throw guest;
  const bucket = (c.env as AuthEnv & { BLOBS?: R2Bucket }).BLOBS;
  if (!bucket) throw new ApiError(503, 'no_storage', 'this server has no file storage for apps');
  const { manifest: raw, files } = await body(c, UploadBody);
  const checked = checkUserAppManifest(raw);
  if (!checked.ok) return refused(c, checked.problems);
  if (!isHosted(checked.manifest)) return refused(c, ['server: an uploaded version is a hosted app\'s: { "hosted": true }']);
  const bytes: Record<string, Uint8Array> = {};
  for (const [path, b64] of Object.entries(files)) bytes[path] = Buffer.from(b64, 'base64');
  const problems = [...checkHostedFiles(checked.manifest, Object.fromEntries(Object.entries(bytes).map(([p, b]) => [p, b.byteLength]))), ...checkAppIcon(checked.manifest, bytes)];
  if (problems.length) return refused(c, problems);
  const prefix = `apps/${m.organizationId}/${checked.manifest.name}/${crypto.randomUUID()}/`;
  await Promise.all(Object.entries(bytes).map(([path, b]) => bucket.put(prefix + path, b)));
  const uploaded = await orgStub(c, m.organizationId).recordUserAppUpload({
    manifest: checked.manifest, files: Object.fromEntries(Object.entries(bytes).map(([p, b]) => [p, b.byteLength])), prefix, by: m.account.id,
  });
  return c.json(uploaded, 201);
});

/**
 * Goes back before a hosted app's latest update (§8): its store to the restore point taken then, and the version it ran
 * then. What was written since is lost; the card says so, and offers the export first.
 */
userAppRoutes.post('/v1/workspaces/:id/apps/:name/restore', async (c) => {
  const m = await adminOf(c);
  const name = c.req.param('name');
  const org = orgStub(c, m.organizationId);
  const point = await org.userAppRestorePoint(name);
  if (!point) throw new ApiError(404, 'not_found', 'there is no update of this app to go back from');
  const store = (c.env as AuthEnv & HostedEnv).APP_STORE;
  if (!store) throw new ApiError(503, 'no_storage', 'this server has no app stores');
  // The object restarts as it goes back: the call may end with that restart.
  await store.get(store.idFromName(`${name}:${m.organizationId}`)).restore(point.bookmark).catch(() => undefined);
  const reverted = unwrap(await org.revertUserApp(name, point.at));
  return c.json({ ok: true, version: reverted.version });
});

/** A hosted app's data in this organization, every table and its rows, as JSON (owners and admins, §8). */
userAppRoutes.get('/v1/workspaces/:id/apps/:name/export', async (c) => {
  const m = await adminOf(c);
  const name = c.req.param('name');
  const store = (c.env as AuthEnv & HostedEnv).APP_STORE;
  if (!store) throw new ApiError(503, 'no_storage', 'this server has no app stores');
  const stub = store.get(store.idFromName(`${name}:${m.organizationId}`));
  const tables = await stub.dump();
  // Its files (§8): each with its bytes in base64 while the export stays under 50 MB, else listed only.
  const list = (await stub.fileList('')) as { key: string; size: number; type: string; at: number }[];
  const bucket = (c.env as AuthEnv & HostedEnv).BLOBS;
  const whole = list.reduce((n, f) => n + f.size, 0) <= 50_000_000;
  const files = [];
  for (const f of list) {
    const o = whole && bucket ? await bucket.get(filesPrefix({ org: m.organizationId, app: name }) + f.key) : null;
    files.push({ ...f, at: new Date(f.at).toISOString(), ...(o ? { base64: Buffer.from(await o.arrayBuffer()).toString('base64') } : {}) });
  }
  c.header('Cache-Control', 'no-store');
  c.header('Content-Disposition', `attachment; filename="${name}-data.json"`);
  return c.json({ app: name, organizationId: m.organizationId, exportedAt: new Date().toISOString(), tables, files, ...(whole ? {} : { note: 'The files are over 50 MB together, so they are listed without their contents.' }) });
});

// ---- drafts (§9.6): apps being built in the suite, each its author's ----

const DraftBody = z.object({ name: z.string().min(2).max(20), label: z.string().trim().min(1).max(40).optional(), fromInstalled: z.boolean().optional() });
const FileBody = z.object({ path: z.string().min(1).max(200), text: z.string().max(1_500_000) });
const TryBody = z.object({ tool: z.string().min(1).max(32), input: z.record(z.string(), z.unknown()).default({}) });

/** Who builds: any member or agent but a guest (Scott, 2026-11-17); the draft is the caller's account's. */
async function builderOf(c: C): Promise<Member> {
  const m = await memberOf(c);
  const guest = guestRefusal(m.account, 'building apps');
  if (guest) throw guest;
  return m;
}

userAppRoutes.get('/v1/workspaces/:id/apps/drafts', async (c) => {
  const m = await builderOf(c);
  c.header('Cache-Control', 'no-store');
  return c.json({ drafts: await orgStub(c, m.organizationId).listAppDrafts(m.account.id) });
});

userAppRoutes.post('/v1/workspaces/:id/apps/drafts', async (c) => {
  const m = await builderOf(c);
  const b = await body(c, DraftBody);
  const draft = unwrap(await orgStub(c, m.organizationId).createAppDraft({ name: b.name, label: b.label ?? b.name, author: m.account.id, ...(b.fromInstalled ? { fromInstalled: true } : {}) }));
  return c.json({ draft }, 201);
});

userAppRoutes.get('/v1/workspaces/:id/apps/drafts/:name', async (c) => {
  const m = await builderOf(c);
  c.header('Cache-Control', 'no-store');
  return c.json({ draft: unwrap(await orgStub(c, m.organizationId).getAppDraft(c.req.param('name'), m.account.id)) });
});

userAppRoutes.delete('/v1/workspaces/:id/apps/drafts/:name', async (c) => {
  const m = await builderOf(c);
  unwrap(await orgStub(c, m.organizationId).deleteAppDraft(c.req.param('name'), m.account.id, m.organizationId));
  return c.json({ ok: true });
});

/** Stops an agent editing the draft (§9.6): the author's call alone. The agent got it when picked in the Build page's panel. */
userAppRoutes.delete('/v1/workspaces/:id/apps/drafts/:name/editors/:editor', async (c) => {
  const m = await builderOf(c);
  return c.json({ draft: unwrap(await orgStub(c, m.organizationId).removeAppDraftEditor(c.req.param('name'), m.account.id, c.req.param('editor'))) });
});

/** One file's text: `?path=server.js`. */
userAppRoutes.get('/v1/workspaces/:id/apps/drafts/:name/file', async (c) => {
  const m = await builderOf(c);
  const path = c.req.query('path') ?? '';
  c.header('Cache-Control', 'no-store');
  return c.json({ path, text: unwrap(await orgStub(c, m.organizationId).readAppDraftFile(c.req.param('name'), m.account.id, path)) });
});

userAppRoutes.put('/v1/workspaces/:id/apps/drafts/:name/file', async (c) => {
  const m = await builderOf(c);
  const f = await body(c, FileBody);
  return c.json({ draft: unwrap(await orgStub(c, m.organizationId).writeAppDraftFile(c.req.param('name'), m.account.id, f.path, f.text)) });
});

userAppRoutes.delete('/v1/workspaces/:id/apps/drafts/:name/file', async (c) => {
  const m = await builderOf(c);
  return c.json({ draft: unwrap(await orgStub(c, m.organizationId).deleteAppDraftFile(c.req.param('name'), m.account.id, c.req.query('path') ?? '')) });
});

/** Tries a draft's tool in its dev install, as its author (§9.3). */
userAppRoutes.post('/v1/workspaces/:id/apps/drafts/:name/try', async (c) => {
  const m = await builderOf(c);
  const t = await body(c, TryBody);
  return c.json(await orgStub(c, m.organizationId).tryAppDraftTool({
    organizationId: m.organizationId, name: c.req.param('name'), author: m.account.id, userId: m.userId, displayName: m.displayName, role: m.account.role, tool: t.tool, input: t.input,
  }));
});

/** The draft's preview address with a one-use door key (§9.6), for the Build app page's frame. */
userAppRoutes.post('/v1/workspaces/:id/apps/drafts/:name/preview', async (c) => {
  const m = await builderOf(c);
  c.header('Cache-Control', 'no-store');
  return c.json(unwrap(await orgStub(c, m.organizationId).draftPreview({ organizationId: m.organizationId, name: c.req.param('name'), author: m.account.id, userId: m.userId, displayName: m.displayName })));
});

/** Publishes a draft as a version an owner or admin installs (§9.6). */
userAppRoutes.post('/v1/workspaces/:id/apps/drafts/:name/publish', async (c) => {
  const m = await builderOf(c);
  return c.json(unwrap(await orgStub(c, m.organizationId).publishAppDraft({ organizationId: m.organizationId, name: c.req.param('name'), author: m.account.id })), 201);
});

/** The hosted versions uploaded here, newest first (owners and admins). */
userAppRoutes.get('/v1/workspaces/:id/apps/versions', async (c) => {
  const m = await adminOf(c);
  c.header('Cache-Control', 'no-store');
  const versions = (await orgStub(c, m.organizationId).listUserAppUploads()) as AppUpload[];
  // The install card shows each version's image icon from its own files.
  return c.json({ versions: versions.map((v) => (isImageIcon(v.manifest.icon) ? { ...v, iconUrl: appIconUrl(m.organizationId, v.name, v.version) } : v)) });
});

userAppRoutes.put('/v1/workspaces/:id/apps/:name/grants', async (c) => {
  const m = await adminOf(c);
  const grants = await body(c, Grants);
  unwrap(await orgStub(c, m.organizationId).setUserAppGrants(c.req.param('name'), grants));
  return c.json({ ok: true });
});

userAppRoutes.delete('/v1/workspaces/:id/apps/:name', async (c) => {
  const m = await adminOf(c);
  unwrap(await orgStub(c, m.organizationId).removeUserApp(c.req.param('name')));
  return c.json({ ok: true });
});

userAppRoutes.post('/v1/workspaces/:id/apps/:name/secret', async (c) => {
  const m = await adminOf(c);
  const secret = unwrap(await orgStub(c, m.organizationId).rotateUserAppSecret(c.req.param('name')));
  return c.json({ secret });
});

userAppRoutes.put('/v1/workspaces/:id/apps/:name/agents', async (c) => {
  const m = await memberOf(c);
  const guest = guestRefusal(m.account, 'apps');
  if (guest) throw guest;
  if (m.isAgent || m.via) throw forbidden('a person turns an app on for their own agents');
  const { on } = await body(c, AgentsBody);
  unwrap(await orgStub(c, m.organizationId).setUserAppAgents(c.req.param('name'), m.account.id, on));
  return c.json({ ok: true });
});

userAppRoutes.post('/v1/workspaces/:id/apps/:name/screen', async (c) => {
  const m = await memberOf(c);
  const guest = guestRefusal(m.account, 'apps');
  if (guest) throw guest;
  const screen = await orgStub(c, m.organizationId).userAppScreen({
    organizationId: m.organizationId, name: c.req.param('name'), holder: { ...holderOf(m), via: null }, userId: m.userId, displayName: m.displayName, isAgent: m.isAgent,
  });
  if (!screen) throw new ApiError(404, 'not_found', 'no such app, or it has no screen for you');
  c.header('Cache-Control', 'no-store');
  return c.json(screen);
});

userAppRoutes.post('/v1/workspaces/:id/tools/call', async (c) => {
  const m = await memberOf(c);
  const { name, input } = await body(c, CallBody);
  if (!parseAppToolName(name)) throw badRequest('validation', `${name} is not an app tool: the bridge runs built-in tools itself`);
  const answer = await runAppTool(c.env, { ...m, account: m.account }, name, input);
  return c.json(answer);
});

/**
 * An app's image icon (§4), for the Apps menu, the app cards, Admin and the install card: the installed version's, or the
 * version `?v=` names. Any member but a guest. An SVG gets a policy that runs nothing in it, if it is opened on its own.
 */
userAppRoutes.get('/v1/workspaces/:id/apps/:name/icon', async (c) => {
  const m = await memberOf(c);
  const guest = guestRefusal(m.account, 'apps');
  if (guest) throw guest;
  const v = Number(c.req.query('v'));
  const found = await orgStub(c, m.organizationId).userAppIcon({ name: c.req.param('name'), version: Number.isInteger(v) && v > 0 ? v : null });
  if (!found.ok) {
    console.error(`[apps] icon of ${c.req.param('name')} in ${m.organizationId}: ${found.error}`);
    throw new ApiError(500, 'icon_failed', `the icon could not be read: ${found.error}`);
  }
  const icon = found.icon;
  const bucket = (c.env as AuthEnv & { BLOBS?: R2Bucket }).BLOBS;
  const o = icon && bucket ? await bucket.get(icon.key) : null;
  if (!icon || !o) throw new ApiError(404, 'not_found', 'this app has no image icon');
  return new Response(o.body, { headers: {
    'content-type': icon.type, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
  } });
});

userAppRoutes.post('/v1/apps/:org/:name/events', async (c) => {
  const organizationId = c.req.param('org');
  if (!ORG_ID.test(organizationId)) throw badRequest('validation', 'not an organization id');
  // An organization the directory knows: a stranger's request never wakes an object of its own.
  if (!(await directory(c, 'organization', organizationId))) return c.json({ error: { code: 'refused', message: 'bad or missing signature' } }, 401);
  const raw = await c.req.text();
  if (raw.length > 80_000) return c.json({ error: { code: 'too_large', message: 'the event is too large' } }, 413);
  const r = await orgStub(c, organizationId).publishUserAppEvent({ organizationId, name: c.req.param('name'), body: raw, signature: c.req.header(SIGNATURE_HEADER) ?? null });
  return r.ok ? c.json({ id: r.id }, 201) : c.json({ error: { code: 'refused', message: r.error } }, r.status as 400);
});
