// Channel visitors (docs/specs/chat-visitors.md): a person with no account, let into one public channel by a link.
//
// The visitor's page reuses Chat's own message list, thread and composer. Those reach the server through a
// ConnectionRuntime (and the FlowBackend over it), so a visitor gets a runtime of their own, `VisitorRuntime`, which
// speaks the visitor's routes instead: the member paths the components build are rewritten to `/v1/visitor/*`
// (`visitorPath`), the reads a visitor has no route for are answered from `GET /v1/visitor/me` (`visitorAnswer`), and
// everything else is refused before it leaves the page. The session is the HttpOnly `vsid` cookie, scoped to
// `/v1/visitor`, so the runtime carries no bearer at all.
import {
  CHAT_PATH,
  capabilitiesFrom,
  supported,
  unavailable,
  type Capabilities,
  type ChannelDTO,
  type ChannelVisitorDTO,
  type UserDTO,
  type VisitorMeDTO,
  type WorkspaceDTO,
  type WorkspaceMemberDTO,
} from '@flow/shared';
import { ApiError, ConnectionRuntime, type FileImageVariant } from './connectionRuntime';
import { SocketClient, SocketCursors, type SocketHandlers } from './ws';

/** The public Turnstile site key of the visitor name screen (V10). The secret is the Worker's TURNSTILE_SECRET. */
export const TURNSTILE_SITE_KEY = '0x4AAAAAAGET25jnXsEghv9O';
export const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
export const VISITOR_NAME_MAX = 40;
export const LINK_GONE = 'This link no longer works. Ask the person who sent it for a new one.';

/** A person as Chat's name and member maps hold them, with the visitor flag the roster DTO does not carry. */
export type ChannelPerson = WorkspaceMemberDTO & { visitor?: boolean };

/** The token in `/chat/visit/<token>`, or null for any other page. */
export function parseVisitPath(pathname: string): string | null {
  const base = CHAT_PATH.replace(/\/$/, '');
  const m = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/visit/([A-Za-z0-9_-]{16,64})/?$`).exec(pathname);
  return m?.[1] ?? null;
}

/** The name a visitor typed, trimmed; null when it is empty or too long (the server checks the same). */
export function cleanName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, ' ');
  return name.length >= 1 && name.length <= VISITOR_NAME_MAX ? name : null;
}

/**
 * The visitor route for a member path the shared components build, or null when a visitor has no such route. Messages,
 * threads, reactions, edits and deletes are their own (`/v1/visitor/messages…`), and so are files: uploads, downloads,
 * thumbnails and the channel's file list.
 */
export function visitorPath(path: string): string | null {
  const q = path.indexOf('?');
  const p = q === -1 ? path : path.slice(0, q);
  const query = q === -1 ? '' : path.slice(q);
  if (p.startsWith('/v1/visitor/')) return path;
  if (/^\/v1\/channels\/[^/]+\/messages$/.test(p)) return `/v1/visitor/messages${query}`;
  const msg = /^\/v1\/messages\/([^/]+)(\/thread|\/reactions\/[^/]+)?$/.exec(p);
  if (msg) return `/v1/visitor/messages/${msg[1]}${msg[2] ?? ''}${msg[2] === '/thread' ? query : ''}`;
  if (/^\/v1\/workspaces\/[^/]+\/files\/presign$/.test(p)) return '/v1/visitor/files/presign';
  if (/^\/v1\/channels\/[^/]+\/files$/.test(p)) return `/v1/visitor/files${query}`;
  const file = /^\/v1\/files\/([^/]+)(\/thumb|\/content|\/complete)?$/.exec(p);
  if (file) return `/v1/visitor/files/${file[1]}${file[2] ?? ''}`;
  return null;
}

const person = (p: VisitorMeDTO['channel']['people'][number]): ChannelPerson => ({
  userId: p.userId,
  displayName: p.displayName,
  email: '',
  avatarUrl: p.avatarUrl,
  statusEmoji: '',
  statusText: '',
  title: '',
  isAgent: p.isAgent,
  isBot: false,
  sponsorId: null,
  privacyMode: true,
  role: 'member',
  joinedAt: '',
  ...(p.visitor ? { visitor: true } : {}),
});

/** The visitor as the shared components know a signed-in user. */
export function visitorUser(me: VisitorMeDTO): UserDTO {
  return {
    id: me.user.id, email: '', displayName: me.user.displayName, avatarUrl: null, timezone: 'UTC', statusEmoji: '', statusText: '',
    website: '', bio: '', title: '', isAgent: false, visitor: true, sponsorId: null, notificationPrefs: {}, statusSuppressAlerts: false,
    privacyMode: true, createdAt: me.seesFrom,
  } as unknown as UserDTO;
}

/** The visitor's one channel, as the channel list would carry it. */
export function visitorChannel(me: VisitorMeDTO): ChannelDTO {
  return {
    id: me.channel.id, workspaceId: me.organization.id, name: me.channel.name, kind: 'standard', topic: me.channel.topic, isPrivate: false,
    createdBy: '', createdAt: me.seesFrom, archivedAt: null, isMember: true, lastReadMsgId: null, unreadCount: 0, unreadNotifications: 0,
    unreadThreadRootIds: [], notifyLevel: 'all', parentId: null, memberIds: [],
  } as unknown as ChannelDTO;
}

/**
 * The answer to a read the visitor has no route for, from what `GET /v1/visitor/me` said: their channel, the people in
 * it (members and agents as the roster, visitors as the channel's visitors), and empty lists for what is not open to
 * them (pins, artifacts, custom emoji, references). `undefined`: no local answer.
 */
export function visitorAnswer(method: string, path: string, me: VisitorMeDTO): unknown {
  const p = path.split('?')[0]!;
  const people = me.channel.people;
  if (method === 'POST' && /^\/v1\/channels\/[^/]+\/read$/.test(p)) return { ok: true };
  if (method !== 'GET') return undefined;
  if (p === '/v1/me') return visitorUser(me);
  if (p === '/v1/me/workspaces') return { workspaces: [{ id: me.organization.id, slug: '', name: me.organization.name, avatarUrl: me.organization.avatarUrl } as WorkspaceDTO] };
  if (/^\/v1\/workspaces\/[^/]+\/channels$/.test(p)) return { channels: [visitorChannel(me)] };
  if (/^\/v1\/workspaces\/[^/]+\/members$/.test(p)) return { members: people.filter((x) => !x.visitor).map(person) };
  if (/^\/v1\/channels\/[^/]+\/members$/.test(p)) return { userIds: people.filter((x) => !x.visitor).map((x) => x.userId) };
  if (/^\/v1\/channels\/[^/]+\/visitors$/.test(p)) {
    return {
      visitors: people.filter((x) => x.visitor).map((x): ChannelVisitorDTO => ({
        userId: x.userId, displayName: x.displayName, visitor: true, linkId: null, seesFrom: '', lastSeenAt: '',
      })),
    };
  }
  if (/^\/v1\/workspaces\/[^/]+\/emoji$/.test(p)) return { emoji: [] };
  if (/^\/v1\/workspaces\/[^/]+\/(app-)?artifacts$/.test(p)) return { artifacts: [] };
  if (/^\/v1\/channels\/[^/]+\/pins$/.test(p)) return { messages: [] };
  if (p === '/v1/references') return { references: [] };
  if (p === '/v1/me/notifications') return { notifications: [], unreadCount: 0, hasMore: false };
  return undefined;
}

/** What a visitor can do (§1.3): read, post, thread, react, edit, delete and upload in their one channel; nothing else. */
export function visitorCapabilities(): Capabilities {
  const yes = supported();
  return capabilitiesFrom(unavailable('Not open to visitors.'), {
    conversations: yes, history: yes, threads: yes, send: yes, edit: yes, delete: yes, reactions: yes, files: yes, liveUpdates: yes, typing: yes,
  });
}

/** The runtime the visitor's page runs the shared components on (see the top of this file). */
export class VisitorRuntime extends ConnectionRuntime {
  private current: VisitorMeDTO;

  constructor(me: VisitorMeDTO, origin: string = location.origin) {
    super(
      { connectionId: 'visitor', provider: 'flow', providerIdentity: origin, origin, label: me.organization.name, apiVersion: null, capabilities: {} } as never,
      { storageKey: `flow.visitor.${me.user.id}`, userId: me.user.id, authGeneration: 0 },
    );
    this.current = me;
  }

  get me(): VisitorMeDTO {
    return this.current;
  }

  setMe(me: VisitorMeDTO): void {
    this.current = me;
  }

  override getToken(): string | null {
    return null;
  }

  override url(path: string): string {
    return super.url(visitorPath(path) ?? path);
  }

  override api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const local = visitorAnswer(method, path, this.current);
    if (local !== undefined) return Promise.resolve(local as T);
    const mapped = visitorPath(path);
    if (!mapped) return Promise.reject(new ApiError(403, 'visitor', 'This is not open to visitors.'));
    return super.api<T>(method, mapped, body);
  }

  // Files: the visitor's routes answer with the bytes, or with a redirect to storage. A cookie session has nothing to
  // keep off another origin, so the page's elements load the visitor URL directly and the browser follows the redirect.
  override fileStreamUrl(fileId: string): Promise<{ url: string | null; expiresInSeconds: number }> {
    return Promise.resolve({ url: this.url(`/v1/files/${fileId}`), expiresInSeconds: 3600 });
  }

  override fileThumbUrl(fileId: string): Promise<{ url: string | null; expiresInSeconds: number }> {
    return Promise.resolve({ url: this.url(`/v1/files/${fileId}/thumb`), expiresInSeconds: 3600 });
  }

  override fileImageUrl(fileId: string, variant: FileImageVariant): Promise<string> {
    return Promise.resolve(this.url(`/v1/files/${fileId}${variant === 'thumbnail' ? '/thumb' : ''}`));
  }

  override cachedBlobUrl(path: string): string | undefined {
    return visitorPath(path) ? this.url(path) : undefined;
  }

  override blobUrl(path: string): Promise<string> {
    return visitorPath(path) ? Promise.resolve(this.url(path)) : Promise.reject(new ApiError(403, 'visitor', 'This is not open to visitors.'));
  }
}

/** The visitor's live socket: `/v1/visitor/ws`, which the browser opens with the `vsid` cookie; the first frame is
 * `{op: 'visitor'}` rather than a member's `{op: 'auth'}`. */
export class VisitorSocketClient extends SocketClient {
  constructor(handlers: SocketHandlers, origin: string = location.origin) {
    const url = `${origin.replace(/^http/, 'ws')}/v1/visitor/ws`;
    super('', handlers, url, Math.random, new SocketCursors(() => null));
  }

  protected override authFrame(since: number | null): Record<string, unknown> {
    return { op: 'visitor', ...(since !== null ? { since } : {}) };
  }
}

/** "Works until tomorrow 3:40 PM": when a visitor link stops working, said the way people say it. */
export function worksUntil(expiresAt: string, now: Date = new Date()): string {
  const end = new Date(expiresAt);
  const time = end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(end) - day(now)) / 86_400_000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  return `${end.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`;
}
