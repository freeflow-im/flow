// One organization: its database and its sockets. HTTP requests arrive from the Worker with the caller already known.
import { DurableObject } from 'cloudflare:workers';
import type { Event, UserDTO } from '@flow/shared';
import type { DirectoryCore } from '../directory/core';
import type { Directory } from '../directory/object';
import { withPublisher } from './bus';
import { openDb, withDb, type DB, schema } from './db/index';
import { ORG_MIGRATIONS } from './db/migrations';
import { setMailEnv } from './email/index';
import { presetWorkspaceId } from './lib/ids';
import { CompatApp, type CallerContext } from './routes/compat';
import { registerRoutes } from './routes/index';
import { socketControl } from './sockets';
import { setStorageEnv, type StorageEnv } from './storage/index';
import { eq, and } from 'drizzle-orm';

export type OrgEnv = StorageEnv & { FLOW_DATA_KEY?: string; DIRECTORY: DurableObjectNamespace<Directory> };

/** What each id-only path needs (`routes/org.ts`), and who belongs here (`memberships`), reported to the directory by trigger. */
const OUTBOX = [
  `CREATE TABLE IF NOT EXISTS _outbox (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, id TEXT NOT NULL, user_id TEXT, role TEXT)`,
  ...[['channels', 'id'], ['messages', 'id'], ['files', 'id'], ['artifacts', 'id'], ['scheduled_messages', 'id']].map(([t, c]) =>
    `CREATE TRIGGER IF NOT EXISTS _index_${t} AFTER INSERT ON ${t} BEGIN INSERT INTO _outbox (kind, id) VALUES ('index', NEW.${c}); END`),
  `CREATE TRIGGER IF NOT EXISTS _index_invites AFTER INSERT ON invites BEGIN INSERT INTO _outbox (kind, id) VALUES ('index', lower(hex(NEW.token_hash))); INSERT INTO _outbox (kind, id) VALUES ('index', NEW.id); END`,
  `CREATE TRIGGER IF NOT EXISTS _index_links AFTER INSERT ON workspace_join_links BEGIN INSERT INTO _outbox (kind, id) VALUES ('token', NEW.token); END`,
  `CREATE TRIGGER IF NOT EXISTS _member_add AFTER INSERT ON workspace_members BEGIN INSERT INTO _outbox (kind, id, user_id, role) VALUES ('join', NEW.workspace_id, NEW.user_id, NEW.role); END`,
  `CREATE TRIGGER IF NOT EXISTS _member_del AFTER DELETE ON workspace_members BEGIN INSERT INTO _outbox (kind, id, user_id) VALUES ('leave', OLD.workspace_id, OLD.user_id); END`,
];

const app = new CompatApp();
registerRoutes(app as never);

interface Attachment { userId: string }
const USER_SUBJECT = /(?:^|\.)user\.([0-9a-f-]{36})(?:\.|$)/;

export class Org extends DurableObject<OrgEnv> {
  private readonly db: DB;

  constructor(ctx: DurableObjectState, env: OrgEnv) {
    super(ctx, env);
    setStorageEnv(env);
    setMailEnv(env as never);
    this.db = openDb(ctx.storage);
    const sql = ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS _migrations (n INTEGER PRIMARY KEY)');
    const done = (sql.exec('SELECT COALESCE(MAX(n), -1) AS n FROM _migrations').one().n as number) + 1;
    ORG_MIGRATIONS.slice(done).forEach((m, i) => {
      for (const statement of m.split('--> statement-breakpoint')) sql.exec(statement);
      sql.exec('INSERT INTO _migrations (n) VALUES (?)', done + i);
    });
    for (const statement of OUTBOX) sql.exec(statement);
    // Answered by the runtime, so a client's heartbeat does not wake the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"op":"ping"}', '{"op":"pong"}'));
  }

  private directory() {
    return this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName('directory'));
  }

  /** The organization's copy of a member's profile, which its joins read. */
  private ensureUser(u: UserDTO): void {
    const copy = { displayName: u.displayName, avatarUrl: u.avatarUrl, timezone: u.timezone, statusEmoji: u.statusEmoji, statusText: u.statusText, website: u.website, bio: u.bio, title: u.title, privacyMode: u.privacyMode, statusSuppressAlerts: u.statusSuppressAlerts, notificationPrefs: u.notificationPrefs as Record<string, boolean> };
    this.db.insert(schema.users).values({ id: u.id, email: u.email || `${u.id}@hidden.invalid`, passwordHash: '!directory', isAgent: u.isAgent, emailVerifiedAt: new Date(), ...copy })
      .onConflictDoUpdate({ target: schema.users.id, set: copy }).run();
  }

  private sockets(): { ws: WebSocket; userId: string | undefined }[] {
    return this.ctx.getWebSockets().map((ws) => ({ ws, userId: (ws.deserializeAttachment() as Attachment | null)?.userId }));
  }

  /** Who may see an event, as the gateway decided on Node: a user's own subject goes to that user, and a private channel to its members. */
  private broadcast(subject: string, event: Event): void {
    const onlyUser = USER_SUBJECT.exec(subject)?.[1];
    let allowed: Set<string> | null = null;
    if (!onlyUser && event.channelId) {
      const chan = this.ctx.storage.sql.exec('SELECT is_private FROM channels WHERE id = ?', event.channelId).toArray()[0];
      if (chan?.is_private) {
        allowed = new Set(this.ctx.storage.sql.exec('SELECT user_id FROM channel_members WHERE channel_id = ?', event.channelId).toArray().map((r) => r.user_id as string));
        // One's own departure is the event that removes one: it still has to arrive.
        const leaving = (event.data as { userId?: string } | undefined)?.userId;
        if (event.type === 'member.left' && leaving) allowed.add(leaving);
      }
    }
    const frame = JSON.stringify({ op: 'event', event });
    for (const { ws, userId } of this.sockets()) {
      if (!userId || (onlyUser && userId !== onlyUser) || (allowed && !allowed.has(userId))) continue;
      try { ws.send(frame); } catch { /* the socket is closing */ }
    }
  }

  /** Runs with this object's database, event bus and socket controls in scope. */
  private scoped<T>(fn: () => Promise<T>): Promise<T> {
    return socketControl.run({ disconnectUser: (id) => this.closeUser(id) }, () =>
      withPublisher((subject, event) => this.broadcast(subject, event), () => withDb(this.db, fn)));
  }

  private closeUser(userId: string): void {
    for (const s of this.sockets()) if (s.userId === userId) s.ws.close(4003, 'removed');
  }

  /** Tells the directory about new ids and changed memberships before the caller gets its answer, so a following request can be routed. */
  private async flushOutbox(organizationId: string | null): Promise<void> {
    const sql = this.ctx.storage.sql;
    const rows = sql.exec('SELECT * FROM _outbox ORDER BY seq').toArray();
    if (!rows.length) return;
    const org = organizationId ?? (this.db.select({ id: schema.workspaces.id }).from(schema.workspaces).get()?.id as string);
    const answer = await this.directory().call('applyOrgChanges' as keyof DirectoryCore as never, [org, rows]);
    if (answer.ok) sql.exec('DELETE FROM _outbox WHERE seq <= ?', rows.at(-1)!.seq as number);
    else console.error(`directory refused org changes: ${answer.message}`);
  }

  async handle(request: Request, caller: CallerContext, newWorkspaceId: string | null): Promise<Response> {
    const run = () => this.scoped(async () => {
      if (caller.user) this.ensureUser(caller.user);
      return app.handle(request, caller);
    });
    const res = await (newWorkspaceId ? presetWorkspaceId.run(newWorkspaceId, run) : run());
    await this.flushOutbox(newWorkspaceId);
    return res;
  }

  /** The organization's own answer to GET /v1/me/workspaces. */
  async workspaceFor(user: UserDTO): Promise<unknown> {
    return this.scoped(async () => (await import('./services/workspaces')).myWorkspaces(user.id));
  }

  /** A client's socket. It proves who it is in its first frame, which is the protocol the clients already speak. */
  override async fetch(_request: Request): Promise<Response> {
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private presence(workspaceId: string, userId: string, status: 'online' | 'offline'): Event {
    return { type: 'presence', workspaceId, ts: new Date().toISOString(), data: { userId, status } } as Event;
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let frame: { op?: string; token?: string; channelId?: string; threadRootId?: string };
    try { frame = JSON.parse(String(raw)); } catch { return ws.send(JSON.stringify({ op: 'error', code: 'bad_frame', message: 'invalid JSON' })); }
    const att = ws.deserializeAttachment() as Attachment | null;
    const workspace = this.db.select().from(schema.workspaces).get();

    if (frame.op === 'auth') {
      if (att) return;
      const answer = await this.directory().call('authenticate' as never, [frame.token] as never);
      const user = answer.ok ? ((answer as unknown as { value: { user: UserDTO } }).value.user) : null;
      const member = user && workspace && this.db.select().from(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.workspaceId, workspace.id), eq(schema.workspaceMembers.userId, user.id))).get();
      if (!user || !member) {
        ws.send(JSON.stringify({ op: 'error', code: 'unauthorized', message: 'invalid token' }));
        return ws.close(4003, 'unauthorized');
      }
      const alreadyOnline = this.sockets().some((s) => s.userId === user.id);
      ws.serializeAttachment({ userId: user.id } satisfies Attachment);
      ws.send(JSON.stringify({ op: 'hello', sessionId: crypto.randomUUID(), heartbeat: 'client' }));
      const online = new Set(this.sockets().map((s) => s.userId).filter((id): id is string => !!id && id !== user.id));
      for (const id of online) ws.send(JSON.stringify({ op: 'event', event: this.presence(workspace!.id, id, 'online') }));
      if (!alreadyOnline) this.broadcast(`ws.${workspace!.id}.presence`, this.presence(workspace!.id, user.id, 'online'));
      return;
    }
    if (!att) return ws.send(JSON.stringify({ op: 'error', code: 'unauthorized', message: 'authenticate first' }));
    if (frame.op === 'typing' && frame.channelId && workspace) {
      this.broadcast(`ws.${workspace.id}.chan.${frame.channelId}.typing`, {
        type: 'typing', workspaceId: workspace.id, channelId: frame.channelId, ts: new Date().toISOString(),
        data: { userId: att.userId, channelId: frame.channelId, ...(frame.threadRootId ? { threadRootId: frame.threadRootId } : {}) },
      } as Event);
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    const workspace = this.db.select({ id: schema.workspaces.id }).from(schema.workspaces).get();
    const stillHere = this.sockets().some((s) => s.ws !== ws && s.userId === att.userId);
    if (workspace && !stillHere) this.broadcast(`ws.${workspace.id}.presence`, this.presence(workspace.id, att.userId, 'offline'));
  }
}
