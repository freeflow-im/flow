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

const RESERVED_WORDS = ['dev', 'app', 'apps', 'suite', 'admin', 'system'];

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
  /** Where the registry sends tool calls: signed POSTs (§5). */
  server: { url: string };
  /** The screen the tab frames, behind the author's guard (§6.2). None: the app has no tab. */
  ui?: { url: string };
}

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

const url = z.string().url().max(2000);

const Manifest = z
  .object({
    name: z.string(),
    label: z.string().min(1).max(USER_APP_LIMITS.label),
    icon: z.string().max(16).optional(),
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
    server: z.object({ url }).strict(),
    ui: z.object({ url }).strict().optional(),
    // Hosted apps only (§7.1): named so the check below can say why, not just "unknown key".
    uses: z.unknown().optional(),
    egress: z.unknown().optional(),
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

  if (m.uses !== undefined) problems.push('uses: an external app gets no suite token, so it declares no uses (user-apps.md §7.1)');
  if (m.egress !== undefined) problems.push('egress: an external app declares no egress; its server is its own (user-apps.md §7.1)');

  for (const [field, value] of [['server.url', m.server.url], ['ui.url', m.ui?.url]] as const) {
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
  const { uses: _u, egress: _e, ...manifest } = m;
  return { ok: true, manifest: manifest as UserAppManifest };
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
  icon?: string;
  description?: string;
  manifestUrl: string;
  /** The external server's origin, for the install card's notice (§7.1). */
  serverOrigin: string;
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
