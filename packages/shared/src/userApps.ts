// User apps (docs/specs/user-apps.md): an app an organization installs without a deploy of the suite. Its manifest is
// the built-in AppManifest's shape stored as data (§4); phase 1 installs external apps only, whose server is the
// author's (§7.1). This file is the manifest's type, its checks at install (§4) and the registry's names (§3.3).
import { z } from 'zod';
import { APP_MANIFESTS } from './manifests.js';

/** An app's name: a letter, then letters and digits, 2-20 in all. No `_`, so `<app>__<tool>` is never ambiguous. */
export const APP_NAME = /^[a-z][a-z0-9]{1,19}$/;
/** A tool's name inside its app: no `__`, which joins it to the app's name. */
export const APP_TOOL_NAME = /^[a-z][a-z0-9_]{1,31}$/;
/** An event's short name; the registry adds `app.<name>.` (§4). */
export const APP_EVENT_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
/** The consent page's scope for installed apps' tools at /mcp (user-apps.md §5.2): with it, a token gets the app tools its
 * account holds the scopes of, and for a personal agent only those of the apps its person turned on. */
export const USER_APPS_SCOPE = 'apps:use';
/** The separator between an app's name and its tool's in the registry (§3.3). */
export const APP_TOOL_SEPARATOR = '__';

const RESERVED_WORDS = ['dev', 'app', 'apps', 'suite', 'admin', 'system', 'drafts', 'versions', 'preview', 'export', 'restore', 'publish', 'file', 'try'];

/** Names no user app may take: a few words, every built-in app's name and every built-in scope's prefix (§4). */
export const RESERVED_APP_NAMES: ReadonlySet<string> = new Set([
  ...RESERVED_WORDS,
  ...APP_MANIFESTS.map((m) => m.name),
  ...APP_MANIFESTS.flatMap((m) => (m.scopes ?? []).flatMap((g) => g.scopes.map((s) => s.split(':')[0]!))),
]);

/** One of the app's scopes, as the install card and the consent page show it. `read`: it lets an account see the app's events (§5.1). */
export interface UserAppScope {
  id: string;
  label: string;
  detail?: string;
  read?: boolean;
}

/** A tool the app answers: a `ToolDefinition` without `app`, `kind` and `doors`, which the registry fills in (§4). */
export interface UserAppTool {
  name: string;
  description: string;
  input: { type: 'object'; properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown };
  scopes: string[];
  destructive?: boolean;
  confirm?: boolean;
}

/** The manifest of an external app (§3.1, §7.1): `freeflow-app.json`, fetched from a URL at install. */
export interface UserAppManifest {
  name: string;
  label: string;
  icon?: string;
  description?: string;
  scope?: 'organization';
  kinds?: { kind: string; container?: boolean; label?: string }[];
  scopes: UserAppScope[];
  tools: UserAppTool[];
  events?: string[];
  /**
   * An external app's server: where the registry sends tool calls, signed POSTs (§5). A hosted app's: `hosted`, its code
   * in the version's `server.js`, run by the platform (§7.2).
   */
  server: { url: string } | { hosted: true };
  /** The screen the tab frames: an external app's behind the author's guard, a hosted app's from its `ui/` files (§6). */
  ui?: { url: string } | { hosted: true };
  /** A hosted app's access to the suite (§6.3): the methods it may call, each checked against the caller's access too. */
  uses?: AppUse[];
  /** The hosts a hosted app's server may reach (§7.2). */
  egress?: string[];
}

/** What a hosted app may ask to use of the suite (§6.3): each is an AppSuite method the platform checks. */
export const APP_USES = ['docs:read', 'chat:write', 'members:read', 'files:read'] as const;
export type AppUse = (typeof APP_USES)[number];

/** Whether the app's server is the platform's (§7.1). */
export const isHosted = (m: Pick<UserAppManifest, 'server'>): boolean => 'hosted' in m.server;

/** The limits of §4 and §11. */
export const USER_APP_LIMITS = {
  tools: 50,
  scopes: 10,
  events: 50,
  kinds: 20,
  description: 1000,
  inputSchemaBytes: 16_000,
  manifestBytes: 128_000,
  label: 40,
} as const;

/** The most a hosted app's version may hold (§14 phase 2, step 1). */
export const HOSTED_APP_LIMITS = { bytes: 5_000_000, files: 200, path: 200 } as const;

const url = z.string().url().max(2000);

const Manifest = z
  .object({
    name: z.string(),
    label: z.string().min(1).max(USER_APP_LIMITS.label),
    // An emoji, or a hosted app's image in ui/ ("ui/icon.png", PNG or SVG): checkAppIcon checks the file.
    icon: z.string().min(1).max(HOSTED_APP_LIMITS.path).optional(),
    description: z.string().max(USER_APP_LIMITS.description).optional(),
    scope: z.literal('organization').optional(),
    kinds: z.array(z.object({ kind: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), container: z.boolean().optional(), label: z.string().max(40).optional() }).strict()).max(USER_APP_LIMITS.kinds).optional(),
    scopes: z.array(z.object({ id: z.string(), label: z.string().min(1).max(120), detail: z.string().max(400).optional(), read: z.boolean().optional() }).strict()).min(1).max(USER_APP_LIMITS.scopes),
    tools: z
      .array(
        z
          .object({
            name: z.string(),
            description: z.string().min(1).max(USER_APP_LIMITS.description),
            input: z.object({ type: z.literal('object') }).passthrough(),
            scopes: z.array(z.string()).min(1),
            destructive: z.boolean().optional(),
            confirm: z.boolean().optional(),
          })
          .strict(),
      )
      .max(USER_APP_LIMITS.tools),
    events: z.array(z.string().max(64)).max(USER_APP_LIMITS.events).optional(),
    server: z.union([z.object({ url }).strict(), z.object({ hosted: z.literal(true) }).strict()]),
    ui: z.union([z.object({ url }).strict(), z.object({ hosted: z.literal(true) }).strict()]).optional(),
    // Hosted apps only (§7.1): an external app that declares them is told why below.
    uses: z.array(z.enum(APP_USES)).max(APP_USES.length).optional(),
    egress: z.array(z.string().max(253)).max(20).optional(),
  })
  .strict();

export type ManifestCheck = { ok: true; manifest: UserAppManifest } | { ok: false; problems: string[] };

/**
 * Checks a manifest for install (§4): its shape, then the rules a schema cannot say. Every problem is listed, so an
 * author (often an agent) can fix them all and try again. `allowHttp`: a local suite may reach an app on http://.
 */
export function checkUserAppManifest(input: unknown, opts: { allowHttp?: boolean } = {}): ManifestCheck {
  const parsed = Manifest.safeParse(input);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join('.') || 'manifest'}: ${i.message}`) };
  const m = parsed.data;
  const problems: string[] = [];

  if (!APP_NAME.test(m.name)) problems.push(`name: "${m.name}" must be 2-20 lowercase letters and digits, starting with a letter`);
  else if (RESERVED_APP_NAMES.has(m.name)) problems.push(`name: "${m.name}" is reserved`);

  const hosted = 'hosted' in m.server;
  if (!hosted && m.uses !== undefined) problems.push('uses: an external app gets no suite token, so it declares no uses (user-apps.md §7.1)');
  if (!hosted && m.egress !== undefined) problems.push('egress: an external app declares no egress; its server is its own (user-apps.md §7.1)');
  if (!hosted && m.ui && 'hosted' in m.ui) problems.push('ui: only a hosted app has a hosted screen (user-apps.md §7.1)');
  if (m.icon !== undefined) {
    if (isImageIcon(m.icon)) {
      if (!hosted) problems.push('icon: only a hosted app\'s icon can be an image in ui/; an external app uses an emoji');
    } else if (m.icon.includes('/') || /\.(png|svg|jpe?g|gif|webp|ico)$/i.test(m.icon)) problems.push(`icon: "${m.icon}" must be an emoji, or a PNG or SVG in ui/ ("ui/icon.png")`);
    else if (m.icon.length > ICON_TEXT_MAX) problems.push(`icon: an emoji icon is at most ${ICON_TEXT_MAX} characters; for an image, name a PNG or SVG in ui/ ("ui/icon.png")`);
  }
  for (const h of m.egress ?? []) if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h)) problems.push(`egress: "${h}" must be a host name, such as api.example.com`);

  const urls: [string, string | undefined][] = [['server.url', 'url' in m.server ? m.server.url : undefined], ['ui.url', m.ui && 'url' in m.ui ? m.ui.url : undefined]];
  for (const [field, value] of urls) {
    if (!value) continue;
    if (!value.startsWith('https://') && !(opts.allowHttp && value.startsWith('http://'))) problems.push(`${field}: must be https`);
  }

  const scopeIds = new Set<string>();
  for (const s of m.scopes) {
    if (!s.id.startsWith(`${m.name}:`) || !/^[a-z][a-z0-9]*:[a-z][a-z0-9_]{0,31}$/.test(s.id)) problems.push(`scopes: "${s.id}" must be "${m.name}:<word>"`);
    if (scopeIds.has(s.id)) problems.push(`scopes: "${s.id}" is declared twice`);
    scopeIds.add(s.id);
  }

  const toolNames = new Set<string>();
  for (const t of m.tools) {
    if (!APP_TOOL_NAME.test(t.name) || t.name.includes(APP_TOOL_SEPARATOR)) problems.push(`tools: "${t.name}" must be 2-32 lowercase letters, digits and single underscores, starting with a letter`);
    if (toolNames.has(t.name)) problems.push(`tools: "${t.name}" is declared twice`);
    toolNames.add(t.name);
    for (const s of t.scopes) if (!scopeIds.has(s)) problems.push(`tools.${t.name}: scope "${s}" is not declared in scopes`);
    if (JSON.stringify(t.input).length > USER_APP_LIMITS.inputSchemaBytes) problems.push(`tools.${t.name}: input schema is over ${USER_APP_LIMITS.inputSchemaBytes} bytes`);
  }

  const events = m.events ?? [];
  const eventNames = new Set<string>();
  for (const e of events) {
    if (!APP_EVENT_NAME.test(e)) problems.push(`events: "${e}" must be lowercase words joined by dots`);
    if (eventNames.has(e)) problems.push(`events: "${e}" is declared twice`);
    eventNames.add(e);
  }
  if (events.length && !m.scopes.some((s) => s.read)) problems.push('scopes: an app with events marks at least one scope "read": true, which lets an account see them (user-apps.md §5.1)');

  if (problems.length) return { ok: false, problems };
  return { ok: true, manifest: m as UserAppManifest };
}

const VERSION_FILE = /^(server\.js|migrations\/[0-9]{4}_[a-z0-9_]{1,60}\.sql|ui\/[A-Za-z0-9._\-/]{1,190})$/;

/** An emoji icon's longest text (some emoji are several code points). */
const ICON_TEXT_MAX = 16;
/** An image icon: a PNG or SVG among the version's ui/ files. */
const IMAGE_ICON = /^ui\/[A-Za-z0-9._\-/]{1,190}\.(png|svg)$/;
/** The limits of an image icon: small and square. */
export const APP_ICON_LIMITS = { bytes: 64_000, minPx: 16, maxPx: 512 } as const;

/** Whether a manifest's icon names an image in ui/ (else it is an emoji). */
export const isImageIcon = (icon: string | null | undefined): boolean => !!icon && IMAGE_ICON.test(icon) && !icon.includes('..') && !icon.includes('//');

/** An app version's image icon on the suite's origin (GET /v1/workspaces/:id/apps/:name/icon?v=). */
export const appIconUrl = (organizationId: string, name: string, version: number): string =>
  `/v1/workspaces/${encodeURIComponent(organizationId)}/apps/${encodeURIComponent(name)}/icon?v=${version}`;

/** An image icon's content type, by its extension. */
export const appIconType = (icon: string): string => (icon.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : 'image/png');

/** The width and height of a PNG from its header, or null when it is not a PNG. */
function pngSize(b: Uint8Array): { w: number; h: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || sig.some((x, i) => b[i] !== x)) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { w: v.getUint32(16), h: v.getUint32(20) };
}

/** An SVG's width and height, from its viewBox else its width and height attributes; null when it says neither. */
function svgSize(text: string): { w: number; h: number } | null {
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0];
  if (!tag) return null;
  const box = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(tag);
  if (box) return { w: Number(box[1]), h: Number(box[2]) };
  const w = /\swidth\s*=\s*["']([\d.]+)(px)?["']/i.exec(tag), h = /\sheight\s*=\s*["']([\d.]+)(px)?["']/i.exec(tag);
  return w && h ? { w: Number(w[1]), h: Number(h[1]) } : null;
}

/**
 * Checks a hosted app's image icon against its files (at publish and upload): the file is there, a PNG or an SVG, small,
 * and square. Nothing to check for an emoji icon. Every problem is listed.
 */
export function checkAppIcon(manifest: Pick<UserAppManifest, 'icon'>, files: Record<string, Uint8Array>): string[] {
  const icon = manifest.icon;
  if (!icon || !isImageIcon(icon)) return [];
  const b = files[icon];
  if (!b) return [`icon: ${icon} is not among the files`];
  if (b.byteLength > APP_ICON_LIMITS.bytes) return [`icon: ${icon} is ${b.byteLength} bytes; an icon is at most ${APP_ICON_LIMITS.bytes}`];
  const { minPx, maxPx } = APP_ICON_LIMITS;
  if (appIconType(icon) === 'image/png') {
    const size = pngSize(b);
    if (!size) return [`icon: ${icon} is not a PNG`];
    if (size.w !== size.h) return [`icon: ${icon} is ${size.w}×${size.h}; an icon is square`];
    if (size.w < minPx || size.w > maxPx) return [`icon: ${icon} is ${size.w}×${size.h}; an icon is ${minPx} to ${maxPx} pixels square`];
    return [];
  }
  // Its start, as text: enough to find the <svg> tag (an SVG's markup is ASCII there).
  let text = '';
  for (let i = 0; i < Math.min(b.length, 8192); i++) text += String.fromCharCode(b[i]!);
  if (!/<svg\b/i.test(text)) return [`icon: ${icon} is not an SVG`];
  const size = svgSize(text);
  if (size && Math.abs(size.w - size.h) > 0.01 * Math.max(size.w, size.h)) return [`icon: ${icon} is ${size.w}×${size.h}; an icon is square`];
  return [];
}

/**
 * Checks a hosted app version's files (§14 phase 2, step 1), given their sizes in bytes: `server.js` (one ES module),
 * `migrations/NNNN_name.sql` applied in order, and `ui/*`, the screen's static files, with `ui/index.html` when the
 * manifest has a hosted screen. Every problem is listed.
 */
export function checkHostedFiles(manifest: UserAppManifest, sizes: Record<string, number>): string[] {
  const problems: string[] = [];
  if (!isHosted(manifest)) return ['server: this manifest is an external app\'s; a version with files is a hosted app\'s ({ "hosted": true })'];
  const paths = Object.keys(sizes);
  if (paths.length > HOSTED_APP_LIMITS.files) problems.push(`files: at most ${HOSTED_APP_LIMITS.files}`);
  const total = Object.values(sizes).reduce((a, b) => a + b, 0);
  if (total > HOSTED_APP_LIMITS.bytes) problems.push(`files: ${total} bytes, over the ${HOSTED_APP_LIMITS.bytes} a version may hold`);
  for (const p of paths) if (!VERSION_FILE.test(p) || p.includes('..') || p.includes('//')) problems.push(`files: "${p}" is not server.js, migrations/NNNN_name.sql or ui/<path>`);
  if (!('server.js' in sizes)) problems.push('files: server.js is missing');
  if (manifest.ui && 'hosted' in manifest.ui && !('ui/index.html' in sizes)) problems.push('files: ui/index.html is missing, and the manifest has a hosted screen');
  return problems;
}

/** The registry's name for an app's tool: `taskboard__claim_task` (§3.3). */
export const appToolName = (app: string, tool: string): string => `${app}${APP_TOOL_SEPARATOR}${tool}`;

/** The app and tool of a registry name, or null for a built-in tool's name. */
export function parseAppToolName(name: string): { app: string; tool: string } | null {
  const i = name.indexOf(APP_TOOL_SEPARATOR);
  if (i <= 0) return null;
  const app = name.slice(0, i);
  const tool = name.slice(i + APP_TOOL_SEPARATOR.length);
  return APP_NAME.test(app) && APP_TOOL_NAME.test(tool) ? { app, tool } : null;
}

/** An app event's full type: `app.taskboard.task.assigned` (§4). */
export const appEventType = (app: string, short: string): string => `app.${app}.${short}`;

/** The app an event type belongs to, or null for a built-in type. */
export function appOfEventType(type: string): string | null {
  const m = /^app\.([a-z][a-z0-9]{1,19})\./.exec(type);
  return m ? m[1]! : null;
}

/** Who an installed app's scope is given to (§5.2): every member, or one account (a person or a shared agent). */
export type AppGrantee = 'members' | { accountId: string };

/** An installed app as the suite bar, Admin and the app's page see it (GET /v1/workspaces/:id/apps). */
export interface InstalledAppDTO {
  name: string;
  label: string;
  /** An emoji icon. */
  icon?: string;
  /** An image icon (§4): its address on the suite's origin (GET /v1/workspaces/:id/apps/:name/icon). */
  iconUrl?: string;
  description?: string;
  manifestUrl: string;
  /** An external app's server origin, for the install card's notice (§7.1); null for a hosted app. */
  serverOrigin: string | null;
  /** The platform runs it (§7.2). */
  hosted: boolean;
  /** The installed version. */
  version: number;
  /** Owners and admins: the restore point that undoes the latest update of a hosted app, within 30 days (§8). */
  restorePoint?: { fromVersion: number; at: string };
  hasScreen: boolean;
  scopes: UserAppScope[];
  tools: { name: string; description: string; scopes: string[] }[];
  events: string[];
  /** Per scope: `members` or the account ids it is given to (§5.2). Owners and admins only. */
  grants?: Record<string, ('members' | string)[]>;
  /** The viewer holds at least one of the app's scopes, so the tab is theirs. */
  usable: boolean;
  /** The viewer has turned the app on for their personal agents (§5.2). */
  agentsOn: boolean;
  installedBy: string;
  installedAt: string;
  updatedAt: string;
}
