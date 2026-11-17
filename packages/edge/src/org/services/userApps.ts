// Apps installed in this organization (docs/specs/user-apps.md, phase 1: external apps). These functions run inside the
// Org object's database scope (withDb): install, update and remove an app, give out its scopes (§5.2), decide which of
// an account's calls may use it, and send a tool call to the app's server, signed (§5).
import { and, eq, inArray, max } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { AccountKind, AgentMode, InstalledAppDTO, UserAppManifest } from '@flow/shared';
import { appToolName } from '@flow/shared';
import { db, schema } from '../db/index.js';
import { decryptBody, encryptBody } from '../crypto/index.js';
import { ApiError, badRequest, notFound } from '../../errors';
import { isActiveAccount } from './shares.js';
import { signBody, SIGNATURE_HEADER } from '../lib/appSigning';

const { userApps, userAppVersions, userAppGrants, userAppAgents, workspaceMembers, users } = schema;
type AppRow = typeof userApps.$inferSelect;

/** The grantee that means every member who is not a guest (§5.2). */
export const MEMBERS = 'members';
/** A tool call's longest wait for the app's server (§5). */
export const APP_CALL_TIMEOUT_MS = 30_000;
/** The most of an app's answer the registry keeps. */
export const APP_RESULT_MAX_BYTES = 256_000;

/**
 * Who is asking, as far as an app's scopes go: an account here, its kind, and for an agent its mode. `via`: a personal
 * agent acting as this account (agents.md §3), which gets the account's scopes only where the person turned the app on
 * for their agents (§5.2).
 */
export interface AppHolder { accountId: string; kind: AccountKind; agentMode?: AgentMode | null; via?: string | null }

/** Who an install or an update gives the scopes to (§5.2): every member, and named accounts (people or shared agents). */
export interface AppGrants { members: boolean; accounts: string[] }

const manifestOf = (row: AppRow): UserAppManifest => JSON.parse(row.manifest) as UserAppManifest;

function secretOf(row: AppRow): Buffer {
  return Buffer.from(decryptBody({ body: row.secret, bodyNonce: row.secretNonce, encKeyId: row.encKeyId, encScheme: row.encScheme }), 'base64');
}

function newSecret(): { secret: Buffer; cols: Pick<AppRow, 'secret' | 'secretNonce' | 'encKeyId' | 'encScheme'> } {
  const secret = randomBytes(32);
  const enc = encryptBody(secret.toString('base64'));
  return { secret, cols: { secret: enc.body, secretNonce: enc.bodyNonce, encKeyId: enc.encKeyId, encScheme: enc.encScheme } };
}

async function rowOf(name: string): Promise<AppRow | null> {
  const [row] = await db.select().from(userApps).where(eq(userApps.name, name)).limit(1);
  return row ?? null;
}

async function requireRow(name: string): Promise<AppRow> {
  const row = await rowOf(name);
  if (!row) throw notFound('no such app here');
  return row;
}

async function checkGrantees(accounts: string[]): Promise<void> {
  for (const a of accounts) if (!(await isActiveAccount(a))) throw badRequest('validation', `grants: ${a} is not an active member here`);
}

async function writeGrants(name: string, manifest: UserAppManifest, grants: AppGrants): Promise<void> {
  await db.delete(userAppGrants).where(eq(userAppGrants.name, name));
  const grantees = [...(grants.members ? [MEMBERS] : []), ...new Set(grants.accounts)];
  const rows = manifest.scopes.flatMap((s) => grantees.map((grantee) => ({ name, scope: s.id, grantee })));
  if (rows.length) await db.insert(userAppGrants).values(rows);
}

/** The next version number of an app here: one past every version it had, uploaded or installed. */
async function nextVersion(name: string): Promise<number> {
  const [r] = await db.select({ v: max(userAppVersions.version) }).from(userAppVersions).where(eq(userAppVersions.name, name));
  return (r?.v ?? 0) + 1;
}

/**
 * What an install or an update puts in place: an external app's manifest from its URL, or a hosted app's uploaded
 * version, by number (its manifest is the one uploaded with it).
 */
export type AppSource = { manifest: UserAppManifest; manifestUrl: string } | { name: string; version: number };

async function versionFrom(source: AppSource, by: string): Promise<{ manifest: UserAppManifest; manifestUrl: string; version: number }> {
  if ('manifest' in source) {
    const version = await nextVersion(source.manifest.name);
    await db.insert(userAppVersions).values({ name: source.manifest.name, version, manifest: JSON.stringify(source.manifest), by, at: Date.now() });
    return { manifest: source.manifest, manifestUrl: source.manifestUrl, version };
  }
  const [row] = await db.select().from(userAppVersions).where(and(eq(userAppVersions.name, source.name), eq(userAppVersions.version, source.version))).limit(1);
  if (!row?.prefix) throw notFound(`no uploaded version ${source.version} of "${source.name}" here`);
  await db.update(userAppVersions).set({ state: 'installed' }).where(and(eq(userAppVersions.name, source.name), eq(userAppVersions.version, source.version)));
  return { manifest: JSON.parse(row.manifest) as UserAppManifest, manifestUrl: '', version: source.version };
}

/**
 * Keeps a hosted app's uploaded version (§14 phase 2, step 1): its manifest, its file list (path → bytes) and where the
 * files are in R2. It runs nowhere until an owner or admin installs it.
 */
export async function recordUpload(p: { manifest: UserAppManifest; files: Record<string, number>; prefix: string; by: string }): Promise<{ name: string; version: number }> {
  const version = await nextVersion(p.manifest.name);
  await db.insert(userAppVersions).values({
    name: p.manifest.name, version, manifest: JSON.stringify(p.manifest), by: p.by, at: Date.now(), state: 'uploaded', files: JSON.stringify(p.files), prefix: p.prefix,
  });
  return { name: p.manifest.name, version };
}

/** A hosted app's version as uploaded, for Admin's install card. */
export interface AppUpload { name: string; version: number; manifest: UserAppManifest; files: Record<string, number>; by: string; at: string; installed: boolean }

/** The hosted versions uploaded here, newest first. */
export async function listUploads(): Promise<AppUpload[]> {
  const rows = await db.select().from(userAppVersions);
  const installed = new Map((await db.select({ name: userApps.name, version: userApps.version }).from(userApps)).map((r) => [r.name, r.version]));
  return rows
    .filter((r) => r.prefix)
    .sort((a, b) => b.at - a.at)
    .map((r) => ({ name: r.name, version: r.version, manifest: JSON.parse(r.manifest) as UserAppManifest, files: JSON.parse(r.files ?? '{}') as Record<string, number>, by: r.by, at: new Date(r.at).toISOString(), installed: installed.get(r.name) === r.version }));
}

/** The installed version of a hosted app, as its runner loads it: the manifest, the version, and its files' place in R2. */
export async function installedCode(name: string): Promise<{ manifest: UserAppManifest; version: number; prefix: string; files: Record<string, number> } | null> {
  const app = await rowOf(name);
  if (!app) return null;
  const [v] = await db.select().from(userAppVersions).where(and(eq(userAppVersions.name, name), eq(userAppVersions.version, app.version))).limit(1);
  if (!v?.prefix) return null;
  return { manifest: JSON.parse(v.manifest) as UserAppManifest, version: v.version, prefix: v.prefix, files: JSON.parse(v.files ?? '{}') as Record<string, number> };
}

/** Installs an app: an external one from its checked manifest, a hosted one from its uploaded version. The secret comes back once, here (§5, §6.2). */
export async function installApp(p: { source: AppSource; by: string; grants: AppGrants }): Promise<{ name: string; secret: string; version: number }> {
  const name = 'manifest' in p.source ? p.source.manifest.name : p.source.name;
  if (await rowOf(name)) throw new ApiError(409, 'app_exists', `an app named "${name}" is already installed here`);
  await checkGrantees(p.grants.accounts);
  const v = await versionFrom(p.source, p.by);
  const { secret, cols } = newSecret();
  const now = Date.now();
  await db.insert(userApps).values({ name, version: v.version, manifest: JSON.stringify(v.manifest), manifestUrl: v.manifestUrl, ...cols, installedBy: p.by, installedAt: now, updatedAt: now });
  await writeGrants(name, v.manifest, p.grants);
  return { name, secret: secret.toString('base64url'), version: v.version };
}

/** Puts a new version of an installed app in place, and who gets its scopes now: the admin confirms them again (§9.3). */
export async function updateApp(p: { name: string; source: AppSource; by: string; grants: AppGrants }): Promise<{ version: number }> {
  await requireRow(p.name);
  const named = 'manifest' in p.source ? p.source.manifest.name : p.source.name;
  if (named !== p.name) throw badRequest('validation', `the new version names "${named}", not "${p.name}"`);
  await checkGrantees(p.grants.accounts);
  const v = await versionFrom(p.source, p.by);
  await db.update(userApps).set({ version: v.version, manifest: JSON.stringify(v.manifest), manifestUrl: v.manifestUrl, updatedAt: Date.now() }).where(eq(userApps.name, p.name));
  await writeGrants(p.name, v.manifest, p.grants);
  return { version: v.version };
}

/** Changes who holds the app's scopes (§5.2). */
export async function setAppGrants(name: string, grants: AppGrants): Promise<void> {
  const row = await requireRow(name);
  await checkGrantees(grants.accounts);
  await writeGrants(name, manifestOf(row), grants);
}

/** Removes an app: its grants and its agents' switch go with it; its versions stay as the record of what was approved. */
export async function removeApp(name: string): Promise<void> {
  await requireRow(name);
  await db.delete(userAppGrants).where(eq(userAppGrants.name, name));
  await db.delete(userAppAgents).where(eq(userAppAgents.name, name));
  await db.delete(userApps).where(eq(userApps.name, name));
}

/** A new secret for the app; the old one stops at once. The new one comes back once. */
export async function rotateAppSecret(name: string): Promise<string> {
  await requireRow(name);
  const { secret, cols } = newSecret();
  await db.update(userApps).set({ ...cols, updatedAt: Date.now() }).where(eq(userApps.name, name));
  return secret.toString('base64url');
}

/** A person turns an app on or off for their personal agents (§5.2). */
export async function setAgentsOn(name: string, accountId: string, on: boolean): Promise<void> {
  await requireRow(name);
  if (on) await db.insert(userAppAgents).values({ name, accountId, at: Date.now() }).onConflictDoNothing();
  else await db.delete(userAppAgents).where(and(eq(userAppAgents.name, name), eq(userAppAgents.accountId, accountId)));
}

/** The scopes of each installed app that `who` holds (§5.2): app name → scope ids. Apps it holds none of are left out. */
export async function heldScopes(who: AppHolder): Promise<Map<string, Set<string>>> {
  const held = new Map<string, Set<string>>();
  if (who.kind === 'guest') return held;
  // A personal agent's own account holds nothing: it acts through its sponsor's, with `via` (agents.md §1).
  if (who.agentMode === 'personal' || who.kind === 'personal_agent') return held;
  const grantees = who.agentMode === 'shared' ? [who.accountId] : [MEMBERS, who.accountId];
  const rows = await db.select({ name: userAppGrants.name, scope: userAppGrants.scope }).from(userAppGrants).where(inArray(userAppGrants.grantee, grantees));
  let allowed: Set<string> | null = null;
  if (who.via) {
    const on = await db.select({ name: userAppAgents.name }).from(userAppAgents).where(eq(userAppAgents.accountId, who.accountId));
    allowed = new Set(on.map((r) => r.name));
  }
  for (const r of rows) {
    if (allowed && !allowed.has(r.name)) continue;
    let set = held.get(r.name);
    if (!set) held.set(r.name, (set = new Set()));
    set.add(r.scope);
  }
  return held;
}

/** An account of this organization as an app holder, from the member list: a person, a guest, or an agent and its mode. */
export async function appHolderOf(accountId: string): Promise<AppHolder | null> {
  const [row] = await db
    .select({ kind: workspaceMembers.kind, isAgent: users.isAgent, deletedAt: users.deletedAt })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.accountId, accountId))
    .limit(1);
  if (!row || row.deletedAt) return null;
  const agentMode = row.kind === 'personal_agent' ? 'personal' : row.isAgent ? 'shared' : null;
  return { accountId, kind: row.kind, agentMode };
}

/** The names of the apps whose events `who` may see: it holds one of the app's read scopes (§5.1). */
export async function readableApps(who: AppHolder): Promise<string[]> {
  const held = await heldScopes(who);
  if (!held.size) return [];
  const rows = await db.select({ name: userApps.name, manifest: userApps.manifest }).from(userApps).where(inArray(userApps.name, [...held.keys()]));
  return rows.filter((r) => (JSON.parse(r.manifest) as UserAppManifest).scopes.some((s) => s.read && held.get(r.name)!.has(s.id))).map((r) => r.name);
}

/** One app tool as the registry offers it (§3.3, §4): the full name, and the tool as its manifest declares it. */
export interface OfferedAppTool { name: string; app: string; label: string; tool: UserAppManifest['tools'][number] }

/** The app tools `who` may call: those whose every scope it holds. */
export async function offeredAppTools(who: AppHolder): Promise<OfferedAppTool[]> {
  const held = await heldScopes(who);
  if (!held.size) return [];
  const rows = await db.select({ name: userApps.name, manifest: userApps.manifest }).from(userApps).where(inArray(userApps.name, [...held.keys()]));
  return rows.flatMap((r) => {
    const m = JSON.parse(r.manifest) as UserAppManifest;
    const scopes = held.get(r.name)!;
    return m.tools.filter((t) => t.scopes.every((s) => scopes.has(s))).map((tool) => ({ name: appToolName(r.name, tool.name), app: r.name, label: m.label, tool }));
  });
}

/** Every installed app, as `viewer` sees it; owners and admins also get the grants. */
export async function listApps(viewer: AppHolder & { admin: boolean }): Promise<InstalledAppDTO[]> {
  const rows = await db.select().from(userApps);
  if (!rows.length) return [];
  const held = await heldScopes({ ...viewer, via: null });
  const grants = viewer.admin ? await db.select().from(userAppGrants) : [];
  const on = new Set((await db.select({ name: userAppAgents.name }).from(userAppAgents).where(eq(userAppAgents.accountId, viewer.accountId))).map((r) => r.name));
  return rows.sort((a, b) => a.name.localeCompare(b.name)).map((row) => {
    const m = manifestOf(row);
    const dto: InstalledAppDTO = {
      name: m.name,
      label: m.label,
      ...(m.icon ? { icon: m.icon } : {}),
      ...(m.description ? { description: m.description } : {}),
      manifestUrl: row.manifestUrl,
      serverOrigin: 'url' in m.server ? new URL(m.server.url).origin : null,
      hosted: !('url' in m.server),
      hasScreen: !!m.ui,
      scopes: m.scopes,
      tools: m.tools.map((t) => ({ name: t.name, description: t.description, scopes: t.scopes })),
      events: m.events ?? [],
      usable: (held.get(m.name)?.size ?? 0) > 0,
      agentsOn: on.has(m.name),
      installedBy: row.installedBy,
      installedAt: new Date(row.installedAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
    if (viewer.admin) {
      const g: Record<string, string[]> = {};
      for (const s of m.scopes) g[s.id] = grants.filter((r) => r.name === m.name && r.scope === s.id).map((r) => r.grantee);
      dto.grants = g;
    }
    return dto;
  });
}

/** An installed app's manifest and secret, for a tool call, an event or a screen token. */
export async function appForUse(name: string): Promise<{ manifest: UserAppManifest; secret: Buffer } | null> {
  const row = await rowOf(name);
  return row ? { manifest: manifestOf(row), secret: secretOf(row) } : null;
}

/** What the app's server is told about the caller (§5): checked by the signature, so it cannot be lied to. */
export interface AppCallerContext {
  organizationId: string;
  accountId: string;
  userId: string;
  displayName: string;
  kind: 'person' | 'guest' | 'personal_agent' | 'shared_agent';
  role: string;
  via: string | null;
  invokedBy: string | null;
  scopes: string[];
}

/** The answer of a tool call: what the agent reads (data, never instructions), or the app's error. */
export type AppToolAnswer = { ok: true; result: unknown } | { ok: false; error: string };

/**
 * Sends one tool call to the app's server (§5), signed with the install's secret, and waits at most 30 seconds. The body
 * is `{ v: 1, kind: 'tool', app, tool, input, caller, requestId }`; the app answers `{ result }` or `{ error }`.
 */
export async function callAppTool(app: { manifest: UserAppManifest; secret: Buffer }, tool: string, input: unknown, caller: AppCallerContext, fetcher: typeof fetch = fetch): Promise<AppToolAnswer> {
  const server = app.manifest.server;
  if (!('url' in server)) return { ok: false, error: `${app.manifest.label} is a hosted app; it is not called over the network` };
  const body = JSON.stringify({ v: 1, kind: 'tool', app: app.manifest.name, tool, input: input ?? {}, caller, requestId: crypto.randomUUID() });
  let res: Response;
  try {
    res = await fetcher(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signBody(app.secret, body), 'user-agent': 'FreeFlow-Apps/1' },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(APP_CALL_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = (err as Error).name === 'TimeoutError';
    return { ok: false, error: timedOut ? `${app.manifest.label} did not answer within 30 seconds` : `${app.manifest.label} could not be reached` };
  }
  const text = await res.text();
  if (text.length > APP_RESULT_MAX_BYTES) return { ok: false, error: `${app.manifest.label} answered with more than ${APP_RESULT_MAX_BYTES} bytes` };
  let answer: { result?: unknown; error?: unknown } | null = null;
  try { answer = JSON.parse(text) as { result?: unknown; error?: unknown }; } catch { /* below */ }
  if (!res.ok || !answer || typeof answer !== 'object') {
    const said = answer && typeof answer.error === 'string' ? `: ${answer.error.slice(0, 500)}` : '';
    return { ok: false, error: `${app.manifest.label} answered ${res.status}${said}` };
  }
  if (typeof answer.error === 'string') return { ok: false, error: answer.error.slice(0, 2000) };
  return { ok: true, result: answer.result ?? null };
}

/** The limits on an app's events (§5.1): per install, per minute, and per event. */
export const APP_EVENTS_PER_MINUTE = 600;
export const APP_EVENT_MAX_BYTES = 64_000;
export const APP_EVENT_ABOUT_MAX = 20;

/** One event as an app sends it (§5.1): its short type, its data, the app object it is about, and the accounts it names. */
export interface AppEventIn { type: string; data: unknown; ref?: { kind: string; id: string }; about: string[] }

/** Checks an event the app sent against its manifest: a declared type, a declared kind, the size and `about` limits. */
export function checkAppEvent(manifest: UserAppManifest, body: unknown): { ok: true; event: AppEventIn } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'the body is a JSON object' };
  const b = body as Record<string, unknown>;
  if (typeof b.type !== 'string' || !(manifest.events ?? []).includes(b.type)) return { ok: false, error: `type: "${String(b.type)}" is not one of the manifest's events` };
  const data = b.data ?? null;
  if (JSON.stringify(data).length > APP_EVENT_MAX_BYTES) return { ok: false, error: `data: over ${APP_EVENT_MAX_BYTES} bytes` };
  let ref: AppEventIn['ref'];
  if (b.ref !== undefined) {
    const r = b.ref as Record<string, unknown> | null;
    if (!r || typeof r.kind !== 'string' || typeof r.id !== 'string' || !r.id || r.id.length > 200) return { ok: false, error: 'ref: { kind, id } with a kind of the manifest' };
    if (!(manifest.kinds ?? []).some((k) => k.kind === r.kind)) return { ok: false, error: `ref.kind: "${r.kind}" is not one of the manifest's kinds` };
    ref = { kind: r.kind, id: r.id };
  }
  const about = b.about ?? [];
  if (!Array.isArray(about) || about.length > APP_EVENT_ABOUT_MAX || !about.every((a) => typeof a === 'string' && a.length > 0 && a.length <= 100)) {
    return { ok: false, error: `about: at most ${APP_EVENT_ABOUT_MAX} account ids` };
  }
  return { ok: true, event: { type: b.type, data, ...(ref ? { ref } : {}), about: [...new Set(about as string[])] } };
}

/** Events per app in the current minute, kept by the Org object while it is awake: enough to stop a flood (§5.1). */
export class AppEventLimiter {
  private readonly counts = new Map<string, { minute: number; n: number }>();
  /** Counts one event; false when the app is over its limit this minute. */
  hit(name: string, now = Date.now()): boolean {
    const minute = Math.floor(now / 60_000);
    const c = this.counts.get(name);
    if (!c || c.minute !== minute) { this.counts.set(name, { minute, n: 1 }); return true; }
    return ++c.n <= APP_EVENTS_PER_MINUTE;
  }
}
