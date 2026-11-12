// Addresses from references and back (docs/specs/platform.md §5.3, phase 6.4): the one table of where each kind of object
// opens in the suite's clients, relative to the suite's origin. The server's share index and sharing events (edge
// org/services/shares.ts), Docs' `docs.file.changed`, the suite bar's intents (@flow/suite-bar lib/intents.ts) and Chat's
// chips all read it, so a link one of them writes is a reference to every other.
import { APP_MANIFESTS } from './manifests.js';
import { formatReference, type AppManifest, type Reference, type Role } from './platform.js';

// The WHATWG URL classes every runtime the suite runs on has (browsers, Workers, Node); this package builds without the
// DOM or Node typings, so the little it uses is declared here.
interface Params { get(name: string): string | null; set(name: string, value: string): void; toString(): string }
declare const URL: new (url: string, base?: string | { href: string }) => { origin: string; pathname: string; href: string; searchParams: Params };
declare const URLSearchParams: new () => Params;

/** A reference as an address carries it: a Docs file says which kind of document it is (`sheet`, `deck`, `doc`,
 * `markdown`, `file`), which its page depends on and the reference does not. */
export type AddressedReference = Reference & { fileKind?: string };

/** What `addressOf` takes: a reference, or its app, kind and id (a Docs folder's address names its organization). */
export type ReferenceTarget = Pick<Reference, 'app' | 'kind' | 'id'> & { organizationId?: string; fileKind?: string };

/** Chat's pages the other apps' suite bars open (`/?open=<page>`, Chat's App.tsx). Administration is the Admin app
 * (`adminAddress`, docs/specs/workspace-admin.md). */
export const CHAT_PAGES = ['chooser', 'invite', 'activity', 'profile'] as const;
export type ChatPage = (typeof CHAT_PAGES)[number];

/** The Admin app's sections (docs/specs/workspace-admin.md §3), each at `/admin/<section>`. */
export const ADMIN_SECTIONS = ['general', 'members', 'domains', 'agents', 'assistant', 'connect', 'automations', 'events'] as const;
export type AdminSection = (typeof ADMIN_SECTIONS)[number];

/** The Admin app, at a section or at its first one. */
export const adminAddress = (section?: AdminSection): string => (section ? `/admin/${section}` : '/admin');

/** Chat's kinds an address opens: `/?open=<kind>:<id>`. */
const CHAT_OPENS = ['artifact', 'channel', 'message'] as const;

/** A Docs document's page by its kind (packages/docs client main.tsx' routes). */
const DOCS_PATHS: Record<string, string> = { sheet: 's', deck: 'd', doc: 'doc', markdown: 'md', file: 'f' };
const DOCS_KINDS: Record<string, string> = Object.fromEntries(Object.entries(DOCS_PATHS).map(([k, p]) => [p, k]));

/** A kind as its app's manifest declares it (`address`, `icon`, `label`): what the tables below fall back to, so an app
 * added by manifest has addresses and chips with no entry here. */
const manifestKind = (app: string, kind: string): AppManifest['kinds'][number] | undefined => APP_MANIFESTS.find((m) => m.name === app)?.kinds.find((k) => k.kind === kind);

/** Each manifest kind's address template split into the path and the query parameter that carries the id
 * (`/contacts/?contact={id}`), for `referenceOf`. */
const TEMPLATES = APP_MANIFESTS.flatMap((m) => m.kinds.flatMap((k) => {
  const t = k.address ? /^([^?]+)\?([a-z][a-z0-9_-]*)=\{id\}$/i.exec(k.address) : null;
  return t ? [{ app: m.name, kind: k.kind, path: t[1]!.replace(/\/$/, ''), param: t[2]! }] : [];
}));

/** Chat's page, its manifest's path: `/chat` (the root until 2026-11-10, which the readers below still accept). */
export const CHAT_PATH = APP_MANIFESTS.find((m) => m.name === 'chat')?.path ?? '/chat';

/** Where each app's own page is, for an intent that opens it with a query (`?share=`). */
const APP_PAGES: Record<string, string> = { chat: `${CHAT_PATH}/`, docs: '/docs/', calendar: '/calendar/' };

/**
 * The address of an object (its canonical URL, relative to the suite's origin), or null for a kind with no page: Chat
 * `/chat/?open=artifact:<id>` (also `channel:` and `message:`), Docs `/docs/<s|d|doc|md|f>/<id>` by the kind of file (a
 * folder opens in Shared with me), Calendar `/calendar/?calendar=<id>` and `/calendar/?event=<id>`.
 */
export function addressOf(ref: ReferenceTarget | null | undefined, fileKind?: string): string | null {
  if (!ref) return null;
  const id = encodeURIComponent(ref.id);
  if (ref.app === 'chat') return (CHAT_OPENS as readonly string[]).includes(ref.kind) ? `${APP_PAGES.chat}?open=${encodeURIComponent(`${ref.kind}:${ref.id}`)}` : null;
  if (ref.app === 'docs') {
    if (ref.kind === 'folder') return `/docs/?withme=1&in=${id}${ref.organizationId ? `&org=${encodeURIComponent(ref.organizationId)}` : ''}`;
    if (ref.kind !== 'sheet' && ref.kind !== 'file') return null;
    const path = DOCS_PATHS[fileKind ?? ref.fileKind ?? ''] ?? (ref.kind === 'file' ? 'f' : 's');
    return `/docs/${path}/${id}`;
  }
  if (ref.app === 'calendar') {
    if (ref.kind === 'calendar') return `/calendar/?calendar=${id}`;
    if (ref.kind === 'event') return `/calendar/?event=${id}`;
  }
  const declared = manifestKind(ref.app, ref.kind)?.address;
  return declared ? declared.replace('{id}', id) : null;
}

/** Chat's page for another app's suite bar: `/chat/?open=<page>`. */
export const chatPageAddress = (page: ChatPage): string => `${APP_PAGES.chat}?open=${page}`;

/**
 * The reference an address names (the inverse of `addressOf`), or null for anything else: another origin, a page that
 * names no object. `url` may be absolute or relative to `origin`; an address carries no organization (but a Docs
 * folder's), so the reader's (`organizationId`) is the reference's.
 */
export function referenceOf(url: string, ctx: { origin: string; organizationId: string }): AddressedReference | null {
  let u: InstanceType<typeof URL>, base: InstanceType<typeof URL>;
  try {
    base = new URL(ctx.origin);
    u = new URL(url, base);
  } catch {
    return null;
  }
  if (u.origin !== base.origin) return null;
  const q = u.searchParams;
  const org = ctx.organizationId;
  const path = u.pathname;
  // Chat's page, and the root, Chat's page until 2026-11-10 (the root still sends there, its query kept).
  if (path === '/' || path === CHAT_PATH || path === `${CHAT_PATH}/`) {
    const m = /^([a-z]+):(.+)$/.exec(q.get('open') ?? '');
    return m && (CHAT_OPENS as readonly string[]).includes(m[1]!) ? { organizationId: org, app: 'chat', kind: m[1]!, id: m[2]! } : null;
  }
  // Docs' pages, and the same under /workspace, its base until 2026-11-10: a link written before then still names its file.
  if (/^\/(docs|workspace)\/?$/.test(path)) {
    const folder = q.get('in');
    return q.get('withme') === '1' && folder ? { organizationId: q.get('org') || org, app: 'docs', kind: 'folder', id: folder } : null;
  }
  const doc = /^\/(?:docs|workspace)\/(s|d|doc|md|f)\/([^/]+)\/?$/.exec(path);
  if (doc) {
    const fileKind = DOCS_KINDS[doc[1]!]!;
    let id: string;
    try { id = decodeURIComponent(doc[2]!); } catch { return null; }
    return { organizationId: org, app: 'docs', kind: fileKind === 'file' ? 'file' : 'sheet', id, fileKind };
  }
  if (path === '/calendar' || path.startsWith('/calendar/')) {
    const event = q.get('event'), calendar = q.get('calendar');
    if (event) return { organizationId: org, app: 'calendar', kind: 'event', id: event };
    if (calendar) return { organizationId: org, app: 'calendar', kind: 'calendar', id: calendar };
  }
  for (const t of TEMPLATES) {
    const id = (path === t.path || path === `${t.path}/`) ? q.get(t.param) : null;
    if (id) return { organizationId: org, app: t.app, kind: t.kind, id };
  }
  return null;
}

/** The owning app's page with `?share=<ref>`, which opens its Share dialog on the object; null for an app that shares
 * nothing (Mail). */
export function shareAddressOf(ref: Reference): string | null {
  const page = APP_PAGES[ref.app];
  return page ? `${page}?share=${encodeURIComponent(formatReference(ref))}` : null;
}

/** A guest of a new event: an address, or a name and an address. */
export type Attendee = string | { email: string; name?: string | null };

/** What `create` makes, and what it is told: a Calendar event (the edit dialog, filled in), or a Chat message (the
 * channel opened, the composer filled in). */
export interface CreateFields {
  calendar: { title?: string; attendees?: readonly Attendee[]; start?: string };
  'chat-message': { channel: string; text?: string };
}

/**
 * The address that asks an app to create something: Calendar's `/calendar/?new=<title>&guests=Name <a@x>,b@y&start=`
 * (packages/calendar lib/deeplink.ts reads it), Chat's `/chat/?open=channel:<id>&text=<text>`.
 */
export function createAddress<K extends keyof CreateFields>(what: K, fields: CreateFields[K]): string {
  const q = new URLSearchParams();
  if (what === 'chat-message') {
    const f = fields as CreateFields['chat-message'];
    q.set('open', `channel:${f.channel}`);
    if (f.text) q.set('text', f.text);
    return `${APP_PAGES.chat}?${q}`;
  }
  const f = fields as CreateFields['calendar'];
  q.set('new', (f.title ?? '').trim());
  const guests = (f.attendees ?? []).map((a) => {
    if (typeof a === 'string') return a;
    const name = (a.name ?? '').replace(/[<>,]/g, ' ').trim();
    return name ? `${name} <${a.email}>` : a.email;
  });
  if (guests.length) q.set('guests', guests.join(','));
  if (f.start) q.set('start', f.start);
  return `/calendar/?${q}`;
}

/** A glyph for a kind of object, as a chip draws it. */
export function iconOf(app: string, kind: string, fileKind?: string): string {
  if (app === 'chat') return ({ channel: '#', message: '💬', artifact: '📌', file: '📎' } as Record<string, string>)[kind] ?? '🔗';
  if (app === 'docs') return kind === 'folder' ? '📁' : (({ sheet: '📊', deck: '📽️', doc: '📄', markdown: '📝', file: '📎' } as Record<string, string>)[fileKind ?? ''] ?? '📄');
  if (app === 'calendar') return kind === 'event' ? '🗓️' : '📅';
  return manifestKind(app, kind)?.icon ?? '🔗';
}

/** What a kind of object is called, as a chip says it. */
export function kindLabelOf(app: string, kind: string, fileKind?: string): string {
  if (app === 'docs' && kind !== 'folder') return ({ sheet: 'Spreadsheet', deck: 'Presentation', doc: 'Document', markdown: 'Markdown', file: 'File' } as Record<string, string>)[fileKind ?? ''] ?? 'File';
  return ({ channel: 'Channel', message: 'Message', artifact: 'Artifact', file: 'File', folder: 'Folder', calendar: 'Calendar', event: 'Event' } as Record<string, string>)[kind] ?? manifestKind(app, kind)?.label ?? kind;
}

/**
 * One reference resolved for a reader (GET /v1/references): what it is, its title and address, and the reader's role;
 * or, for one the reader may not see (or that does not exist), `denied` and nothing else.
 */
export type ResolvedReference =
  | { ref: string; app: string; kind: string; title: string; url: string; icon: string; summary?: string; role?: Role; fileKind?: string; denied?: undefined }
  | { ref: string; denied: true };
