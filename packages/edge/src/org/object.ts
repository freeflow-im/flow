// One organization: its database and its sockets. HTTP requests arrive from the Worker with the caller already known.
import { DurableObject } from 'cloudflare:workers';
import type { AccountDTO, Event, MemberRole, UserDTO } from '@flow/shared';
import { accountGate, type DirectoryCore } from '../directory/core';
import { ApiError } from '../errors';
import { directoryLink } from './directoryLink';
import type { Directory, DirectoryAnswer } from '../directory/object';
import { withPublisher } from './bus';
import { HUDDLE_ROSTER_DDL } from './huddles';
import { openDb, withDb, type DB, schema } from './db/index';
import { ORG_MIGRATIONS } from './db/migrations';
import { setMailEnv } from './email/index';
import { setImagesEnv } from './lib/images';
import { presetWorkspaceId } from './lib/ids';
import { CompatApp, type CallerContext } from './routes/compat';
import { registerRoutes } from './routes/index';
import { deleteMyAccount } from './services/accountDeletion';
import { drainDuePushes, nextPushDueAt } from './services/pushOutbox';
import { runSchedulerTick } from './services/scheduledMessages';
import { accountAddressForJoin, announceJoin, enrollInWorkspace, toWorkspaceDTO } from './services/workspaces';
import { socketControl } from './sockets';
import { setStorageEnv, type StorageEnv } from './storage/index';
import { insertRows, tableCounts } from '../importing';
import { eq, and } from 'drizzle-orm';

/** IMAGES (Cloudflare Images) resizes preview images and thumbnails; without it they are kept as they came (lib/images.ts). */
export type OrgEnv = StorageEnv & { FLOW_DATA_KEY?: string; DIRECTORY: DurableObjectNamespace<Directory>; IMAGES?: ImagesBinding };

/** What each id-only path needs (`routes/org.ts`), and who belongs here (`memberships`), reported to the directory by trigger. */
const OUTBOX = [
  `CREATE TABLE IF NOT EXISTS _outbox (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, id TEXT NOT NULL, user_id TEXT, role TEXT, payload TEXT)`,
  ...[['channels', 'id'], ['messages', 'id'], ['files', 'id'], ['artifacts', 'id'], ['scheduled_messages', 'id']].map(([t, c]) =>
    `CREATE TRIGGER IF NOT EXISTS _index_${t} AFTER INSERT ON ${t} BEGIN INSERT INTO _outbox (kind, id) VALUES ('index', NEW.${c}); END`),
  `CREATE TRIGGER IF NOT EXISTS _index_invites AFTER INSERT ON invites BEGIN INSERT INTO _outbox (kind, id) VALUES ('index', lower(hex(NEW.token_hash))); INSERT INTO _outbox (kind, id) VALUES ('index', NEW.id); END`,
  `CREATE TRIGGER IF NOT EXISTS _index_links AFTER INSERT ON workspace_join_links BEGIN INSERT INTO _outbox (kind, id) VALUES ('token', NEW.token); END`,
  `CREATE TRIGGER IF NOT EXISTS _index_huddle_invites AFTER INSERT ON huddle_invites BEGIN INSERT INTO _outbox (kind, id) VALUES ('index', NEW.id); END`,
  // An agent's account and tokens begin here, at redeem, and have to reach the directory, which authenticates every request.
  `CREATE TRIGGER IF NOT EXISTS _index_agent_invites AFTER INSERT ON agent_invites BEGIN INSERT INTO _outbox (kind, id) VALUES ('index', lower(hex(NEW.code_hash))); END`,
  `CREATE TRIGGER IF NOT EXISTS _agent_add AFTER INSERT ON users WHEN NEW.is_agent BEGIN INSERT INTO _outbox (kind, id, payload) VALUES ('agent_user', NEW.id, json_object('username', NEW.agent_username, 'keyHash', NEW.agent_key_hash, 'passwordHash', NEW.password_hash, 'email', NEW.email, 'displayName', NEW.display_name, 'sponsorId', NEW.sponsor_user_id, 'createdAt', NEW.created_at)); END`,
  `CREATE TRIGGER IF NOT EXISTS _agent_change AFTER UPDATE OF agent_username, agent_key_hash, display_name ON users WHEN NEW.is_agent BEGIN INSERT INTO _outbox (kind, id, payload) VALUES ('agent_user', NEW.id, json_object('username', NEW.agent_username, 'keyHash', NEW.agent_key_hash, 'passwordHash', NEW.password_hash, 'email', NEW.email, 'displayName', NEW.display_name, 'sponsorId', NEW.sponsor_user_id, 'createdAt', NEW.created_at)); END`,
  `CREATE TRIGGER IF NOT EXISTS _agent_token AFTER INSERT ON agent_tokens BEGIN INSERT INTO _outbox (kind, id, user_id, payload) VALUES ('agent_token', NEW.id, NEW.user_id, lower(hex(NEW.token_hash))); END`,
  `CREATE TRIGGER IF NOT EXISTS _agent_revoke AFTER UPDATE OF revoked_at ON agent_tokens WHEN NEW.revoked_at IS NOT NULL BEGIN INSERT INTO _outbox (kind, id) VALUES ('agent_revoke', NEW.id); END`,
  `CREATE TRIGGER IF NOT EXISTS _domain_add AFTER INSERT ON workspaces WHEN NEW.google_self_register_domain IS NOT NULL BEGIN INSERT INTO _outbox (kind, id, payload) VALUES ('domain', NEW.id, NEW.google_self_register_domain); END`,
  `CREATE TRIGGER IF NOT EXISTS _domain_change AFTER UPDATE OF google_self_register_domain ON workspaces BEGIN INSERT INTO _outbox (kind, id, payload) VALUES ('domain', NEW.id, NEW.google_self_register_domain); END`,
  `CREATE TRIGGER IF NOT EXISTS _member_add AFTER INSERT ON workspace_members BEGIN INSERT INTO _outbox (kind, id, user_id, role) VALUES ('join', NEW.workspace_id, NEW.user_id, NEW.role); END`,
  `CREATE TRIGGER IF NOT EXISTS _member_del AFTER DELETE ON workspace_members BEGIN INSERT INTO _outbox (kind, id, user_id) VALUES ('leave', OLD.workspace_id, OLD.user_id); END`,
  // A role change is a join with the new role to the directory; a new owner also moves the organization's owner (§3.1).
  `CREATE TRIGGER IF NOT EXISTS _member_role AFTER UPDATE OF role ON workspace_members WHEN NEW.role <> OLD.role BEGIN INSERT INTO _outbox (kind, id, user_id, role) VALUES ('join', NEW.workspace_id, NEW.user_id, NEW.role); INSERT INTO _outbox (kind, id, user_id) SELECT 'owner', NEW.workspace_id, NEW.user_id WHERE NEW.role = 'owner'; END`,
  `CREATE TRIGGER IF NOT EXISTS _policies_change AFTER UPDATE OF policies ON workspaces BEGIN INSERT INTO _outbox (kind, id, payload) VALUES ('policies', NEW.id, NEW.policies); END`,
];

const app = new CompatApp();
registerRoutes(app as never);

interface Attachment { userId: string; accountId: string | null }
const pushLog = { info: (o: unknown, msg?: string) => console.log(`[push] ${msg}`, JSON.stringify(o)), warn: (o: unknown, msg?: string) => console.warn(`[push] ${msg}`, JSON.stringify(o)) };
const USER_SUBJECT = /(?:^|\.)user\.([0-9a-f-]{36})(?:\.|$)/;

export class Org extends DurableObject<OrgEnv> {
  private readonly db: DB;

  constructor(ctx: DurableObjectState, env: OrgEnv) {
    super(ctx, env);
    setStorageEnv(env);
    setImagesEnv(env);
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
    sql.exec(HUDDLE_ROSTER_DDL);
    // Answered by the runtime, so a client's heartbeat does not wake the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"op":"ping"}', '{"op":"pong"}'));
    if (sql.exec('SELECT 1 FROM workspace_members WHERE address IS NULL LIMIT 1').toArray().length) {
      void ctx.blockConcurrencyWhile(() => this.backfillAddresses());
    }
  }

  /** Members who joined before addresses (or whose address the join could not get): the directory's accounts fill
   * them in, once. A failure leaves them for the next start. */
  private async backfillAddresses(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const org = sql.exec('SELECT id FROM workspaces LIMIT 1').toArray()[0]?.id as string | undefined;
    if (!org) return;
    try {
      const answer = await this.directory().call('accountsOfOrganization' as never, [org] as never) as DirectoryAnswer<AccountDTO[]>;
      if (!answer.ok) return console.error(`address backfill: ${answer.message}`);
      for (const a of answer.value) {
        sql.exec('UPDATE workspace_members SET address = ? WHERE workspace_id = ? AND user_id = ? AND address IS NULL', a.address, org, a.principalId);
      }
    } catch (err) {
      console.error(`address backfill: ${(err as Error).message}`);
    }
  }

  /** The directory's half of a join, asked for before the member row is written (directoryLink.ts). A new agent's
   * principal reaches the directory through the outbox, so a pending one is sent first. */
  private async ensureAccount(organizationId: string, userId: string, role: MemberRole, displayName: string): Promise<AccountDTO> {
    if (this.ctx.storage.sql.exec("SELECT 1 FROM _outbox WHERE kind = 'agent_user' LIMIT 1").toArray().length) await this.flushOutbox(organizationId);
    const answer = await this.directory().call('ensureAccount' as never, [userId, organizationId, role, displayName] as never) as DirectoryAnswer<AccountDTO>;
    if (!answer.ok) throw new ApiError(answer.status, answer.code, answer.message);
    return answer.value;
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
      directoryLink.run({ ensureAccount: (...args) => this.ensureAccount(...args) }, () =>
        withPublisher((subject, event) => this.broadcast(subject, event), () => withDb(this.db, fn))));
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
    await this.armAlarm();
    return res;
  }

  /** The next thing due: a scheduled message or a push. On Node tickers polled for them; an object sleeps until then. */
  private async armAlarm(): Promise<void> {
    const scheduled = this.ctx.storage.sql.exec('SELECT MIN(next_run_at) AS at FROM scheduled_messages WHERE enabled AND next_run_at IS NOT NULL').one().at as number | null;
    const push = withDb(this.db, nextPushDueAt);
    const due = [scheduled, push].filter((n): n is number => n !== null);
    if (!due.length) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.min(...due));
  }

  override async alarm(): Promise<void> {
    await this.scoped(async () => {
      await runSchedulerTick();
      // After the scheduler, so a scheduled message's mentions push in the same alarm.
      await drainDuePushes(pushLog);
    });
    await this.flushOutbox(null);
    await this.armAlarm();
  }

  /** A person's whole account is going: leave this organization as the Node server's deletion did. */
  async removeAccount(user: UserDTO): Promise<void> {
    await this.scoped(async () => {
      this.ensureUser(user);
      await deleteMyAccount(user.id);
    });
    await this.flushOutbox(null);
  }

  /** Domain self-registration: someone signing in with an address at this organization's domain becomes a member. */
  async joinByDomain(user: UserDTO): Promise<unknown> {
    const joined = await this.scoped(async () => {
      this.ensureUser(user);
      const workspace = this.db.select().from(schema.workspaces).get();
      if (!workspace) return null;
      const address = await accountAddressForJoin(workspace.id, user.id);
      const isNew = await this.db.transaction((tx) => enrollInWorkspace(tx, workspace.id, user.id, 'member', undefined, address));
      if (!isNew) return null;
      await announceJoin(workspace.id, user.id);
      return JSON.parse(JSON.stringify(toWorkspaceDTO(workspace, 'member')));
    });
    await this.flushOutbox(null);
    return joined;
  }

  /** A member's profile changed in the directory: refresh this organization's copy and tell its sockets. */
  async syncUser(user: UserDTO): Promise<void> {
    this.ensureUser(user);
    const workspace = this.db.select({ id: schema.workspaces.id }).from(schema.workspaces).get();
    if (!workspace) return;
    const redacted = user.privacyMode ? { ...user, email: '' } : user;
    this.broadcast(`ws.${workspace.id}.meta`, { type: 'user.updated', workspaceId: workspace.id, ts: new Date().toISOString(), data: redacted } as Event);
  }

  /** The one-time import (routes/admin.ts). The triggers report ids and memberships as for any insert. */
  async importRows(table: string, rows: Record<string, unknown>[]): Promise<{ added: number }> {
    const added = insertRows(this.ctx.storage.sql, table, rows);
    return { added };
  }

  /** Row counts per table, to compare an import with its source. */
  counts(): Record<string, number> {
    return tableCounts(this.ctx.storage.sql);
  }

  /** After the last table: tell the directory, and set the next scheduled message's alarm. */
  async importDone(): Promise<{ reported: number }> {
    const pending = this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM _outbox').one().n as number;
    await this.flushOutbox(null);
    await this.backfillAddresses();
    await this.armAlarm();
    return { reported: pending };
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
      // The principal and its account here, in one call (platform.md §3.6): a suspended or removed account is refused.
      const answer = workspace ? await this.directory().call('authenticateIn' as never, [frame.token, workspace.id] as never) : null;
      const value = answer?.ok ? (answer as unknown as { value: { user: UserDTO; account: AccountDTO | null } }).value : null;
      const user = value?.user ?? null;
      if (user && accountGate(value!.account)) {
        ws.send(JSON.stringify({ op: 'error', code: 'account_inactive', message: 'account inactive' }));
        return ws.close(4003, 'account inactive');
      }
      const member = user && workspace && this.db.select().from(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.workspaceId, workspace.id), eq(schema.workspaceMembers.userId, user.id))).get();
      if (!user || !member) {
        ws.send(JSON.stringify({ op: 'error', code: 'unauthorized', message: 'invalid token' }));
        return ws.close(4003, 'unauthorized');
      }
      const alreadyOnline = this.sockets().some((s) => s.userId === user.id);
      ws.serializeAttachment({ userId: user.id, accountId: value!.account?.id ?? null } satisfies Attachment);
      ws.send(JSON.stringify({ op: 'hello', sessionId: crypto.randomUUID(), heartbeat: 'client' }));
      const online = new Set(this.sockets().map((s) => s.userId).filter((id): id is string => !!id && id !== user.id));
      for (const id of online) ws.send(JSON.stringify({ op: 'event', event: this.presence(workspace!.id, id, 'online') }));
      if (!alreadyOnline) this.broadcast(`ws.${workspace!.id}.presence`, this.presence(workspace!.id, user.id, 'online'));
      return;
    }
    if (!att) return ws.send(JSON.stringify({ op: 'error', code: 'unauthorized', message: 'authenticate first' }));
    // A client sends typing to all its organizations' sockets, since it does not track which holds a channel.
    if (frame.op === 'typing' && frame.channelId && workspace && this.ctx.storage.sql.exec('SELECT 1 FROM channels WHERE id = ?', frame.channelId).toArray().length) {
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
