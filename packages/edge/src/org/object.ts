// One organization: its database and its sockets. HTTP requests arrive from the Worker with the caller already known.
import { DurableObject } from 'cloudflare:workers';
import { MAX_EVENT_DEPTH, type AccountDTO, type AccountKind, type Event, type MemberRole, type UserDTO } from '@flow/shared';
import { accountGate, type DirectoryCore } from '../directory/core';
import { ApiError } from '../errors';
import { directoryLink } from './directoryLink';
import type { Directory, DirectoryAnswer } from '../directory/object';
import { publishEvent, subjectMeta, withPublisher } from './bus';
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
import { accountForJoin, announceJoin, enrollInWorkspace, toMemberDTO, toWorkspaceDTO } from './services/workspaces';
import { socketControl } from './sockets';
import { setStorageEnv, type StorageEnv } from './storage/index';
import { insertRows, tableCounts } from '../importing';
import type { Events } from '../events/object';
import type { PublishInput, SubscriptionRead } from '../events/core';
import { agentStampFor, logEntryFor, type AgentStamp } from './eventLog';
import { config } from './config';
import { isActiveAccount, recordShare, revokeShare, shareEvents, sharedRefsOf, sharedWith, type RecordShareInput, type RevokeShareInput, type SharedItem } from './services/shares';
import { eq, and } from 'drizzle-orm';
import { resolveInOrg, type OrgReferenceAnswer } from './services/references';
import { hostedMailEnabled, type MailProviderEnv } from '../mailprovider/index';

/** IMAGES (Cloudflare Images) resizes preview images and thumbnails; without it they are kept as they came (lib/images.ts). */
/** EVENTS is the organization's event log (events/object.ts), which every socket event but presence and typing also goes to. */
/** MAIL_PROVIDER with PROVISIONING turns on the daily sweep of removed accounts' mailboxes, kept MAIL_RETENTION_DAYS (30). */
export type OrgEnv = StorageEnv & MailProviderEnv & {
  FLOW_DATA_KEY?: string; DIRECTORY: DurableObjectNamespace<Directory>; IMAGES?: ImagesBinding; EVENTS?: DurableObjectNamespace<Events>;
  PROVISIONING?: Queue<unknown>; MAIL_RETENTION_DAYS?: string;
};

const DAY_MS = 86_400_000;
/** The storage key of the next mailbox retention sweep's time. */
const SWEEP_KEY = 'mail_sweep_at';
/** Set once the agents the directory retired when agents gained kinds (agents.md phase A) have left this roster. */
const AGENTS_RETIRED_KEY = 'agents_retired_v1';

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
  // A join carries the member row's sponsor (an agent's, here), so the directory knows whom the agent's account follows (§3.3).
  `DROP TRIGGER IF EXISTS _member_add`,
  `CREATE TRIGGER IF NOT EXISTS _member_join AFTER INSERT ON workspace_members BEGIN INSERT INTO _outbox (kind, id, user_id, role, payload) VALUES ('join', NEW.workspace_id, NEW.user_id, NEW.role, NEW.sponsor_user_id); END`,
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
/** A reconnecting socket's backlog: read in pages of this many, and no more than the cap (the client refetches past it). */
const BACKLOG_PAGE = 200;
const BACKLOG_MAX = 2_000;

/** What the events a request publishes carry into the log (platform.md §5.2, loop safety): a job's turn stamps its id
 * and one more than the job's depth; an automation's post, one more than its trigger's. */
interface Stamp extends AgentStamp { causedBy?: string; depth?: number }

export class Org extends DurableObject<OrgEnv> {
  private readonly db: DB;
  /** Socket events waiting to go into the event log, and the chain of sends, so they arrive in the order they happened. */
  private logQueue: PublishInput[] = [];
  private logging: Promise<void> = Promise.resolve();
  /** Each job's depth, once asked of the Events object: it never changes. */
  private readonly jobDepths = new Map<string, number>();

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
    // A guest's row has no address for good (platform.md §3.3), so a missing account id is what says "not filled in yet".
    if (sql.exec('SELECT 1 FROM workspace_members WHERE account_id IS NULL LIMIT 1').toArray().length) {
      void ctx.blockConcurrencyWhile(() => this.backfillAddresses());
    }
    if (sql.exec("SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE u.is_agent LIMIT 1").toArray().length) {
      void ctx.blockConcurrencyWhile(() => this.retireRemovedAgents());
    }
  }

  /**
   * Agents the directory retired when agents gained kinds (DirectoryCore.backfillAgents: their accounts removed, tokens
   * revoked) still sit on this roster until this runs, once: each leaves as a removed agent does (channels, DMs, the join
   * line's counterpart), its user row kept for authorship. A failure leaves it for the next start.
   */
  private async retireRemovedAgents(): Promise<void> {
    if (await this.ctx.storage.get<boolean>(AGENTS_RETIRED_KEY)) return;
    const sql = this.ctx.storage.sql;
    const org = sql.exec('SELECT id FROM workspaces LIMIT 1').toArray()[0]?.id as string | undefined;
    if (!org) return;
    try {
      const answer = await this.directory().call('accountsOfOrganization' as never, [org] as never) as DirectoryAnswer<AccountDTO[]>;
      if (!answer.ok) return console.error(`agent retirement: ${answer.message}`);
      const gone = new Set(answer.value.filter((a) => a.state === 'removed' && a.agentMode).map((a) => a.principalId));
      const members = sql.exec('SELECT m.user_id FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE u.is_agent').toArray().map((r) => r.user_id as string);
      for (const userId of members.filter((id) => gone.has(id))) {
        await this.scoped(async () => {
          const { removeAgentFromWorkspace } = await import('./services/memberRemoval');
          await removeAgentFromWorkspace(org, userId);
        });
        console.log(`[agents] ${userId} retired from ${org}`);
      }
      await this.flushOutbox(org);
      await this.ctx.storage.put(AGENTS_RETIRED_KEY, true);
    } catch (err) {
      console.error(`agent retirement: ${(err as Error).message}`);
    }
  }

  /** Members who joined before addresses and account ids (or whose join could not get them): the directory's accounts
   * fill them in, once. A failure leaves them for the next start. */
  private async backfillAddresses(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const org = sql.exec('SELECT id FROM workspaces LIMIT 1').toArray()[0]?.id as string | undefined;
    if (!org) return;
    try {
      const answer = await this.directory().call('accountsOfOrganization' as never, [org] as never) as DirectoryAnswer<AccountDTO[]>;
      if (!answer.ok) return console.error(`address backfill: ${answer.message}`);
      for (const a of answer.value) {
        sql.exec('UPDATE workspace_members SET address = COALESCE(address, ?), account_id = COALESCE(account_id, ?) WHERE workspace_id = ? AND user_id = ? AND (address IS NULL OR account_id IS NULL)', a.address, a.id, org, a.principalId);
      }
    } catch (err) {
      console.error(`address backfill: ${(err as Error).message}`);
    }
  }

  /** The directory's half of a join, asked for before the member row is written (directoryLink.ts). A new agent's
   * principal reaches the directory through the outbox, so a pending one is sent first. */
  private async ensureAccount(organizationId: string, userId: string, role: MemberRole, displayName: string, kind: AccountKind = 'native'): Promise<AccountDTO> {
    if (this.ctx.storage.sql.exec("SELECT 1 FROM _outbox WHERE kind = 'agent_user' LIMIT 1").toArray().length) await this.flushOutbox(organizationId);
    const answer = await this.directory().call('ensureAccount' as never, [userId, organizationId, role, displayName, kind] as never) as DirectoryAnswer<AccountDTO>;
    if (!answer.ok) throw new ApiError(answer.status, answer.code, answer.message);
    return answer.value;
  }

  /**
   * A shared agent made from the OAuth consent page (agents.md §1, phase B): a member of this organization with the person
   * as sponsor, as an invite's redeem makes one, but with no key (its credential is the OAuth token the directory issues
   * for it). The directory learns it before the answer, so the grant can name it.
   */
  async createSharedAgent(p: { sponsorId: string; name: string }): Promise<{ userId: string; username: string }> {
    const out = await this.scoped(async () => (await import('./services/agents')).createSharedAgent(p.sponsorId, p.name));
    await this.flushOutbox(null);
    return out;
  }

  private async accountFor(organizationId: string, userId: string): Promise<AccountDTO | null> {
    const answer = await this.directory().call('accountFor' as never, [userId, organizationId] as never) as DirectoryAnswer<AccountDTO | null>;
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
  private broadcast(subject: string, event: Event, stamp?: Stamp): void {
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
    this.logEvent(subject, event, frame, stamp);
  }

  /** Into the organization's event log as well (platform.md §5.2), in order, batched per turn of the event loop. */
  private logEvent(subject: string, event: Event, frame: string, stamp?: Stamp): void {
    if (!this.env.EVENTS) return;
    let entry: PublishInput | null;
    try {
      entry = logEntryFor(this.ctx.storage.sql, subject, event);
    } catch (err) {
      return console.error(`[events] ${event.type}: ${(err as Error).message}`);
    }
    if (!entry) return;
    // The data as the sockets got it (dates as strings), which the log stores as JSON.
    this.logQueue.push({ ...entry, ...(stamp ?? {}), data: (JSON.parse(frame) as { event: Event }).event.data });
    if (this.logQueue.length === 1) this.logging = this.logging.then(() => this.flushLog());
  }

  private async flushLog(): Promise<void> {
    const batch = this.logQueue.splice(0);
    if (!batch.length || !this.env.EVENTS) return;
    let head: number | undefined;
    try {
      const org = batch[0]!.organizationId;
      head = (await this.env.EVENTS.get(this.env.EVENTS.idFromName(org)).publishMany(batch)).at(-1)?.seq;
    } catch (err) {
      return console.error(`[events] publish of ${batch.length}: ${(err as Error).message}`);
    }
    // The socket is a consumer (§5.2): each socket learns how far the log has got, and sends it back as `since` on reconnect.
    if (head === undefined) return;
    const frame = JSON.stringify({ op: 'cursor', seq: head });
    for (const { ws, userId } of this.sockets()) {
      if (!userId) continue;
      try { ws.send(frame); } catch { /* the socket is closing */ }
    }
  }

  /** A `socket` subscription has new events (events/object.ts): its consumer's sockets here are told to read it. */
  pokeSubscription(accountId: string, subscriptionId: string): number {
    const frame = JSON.stringify({ op: 'subscription', id: subscriptionId });
    let sent = 0;
    for (const ws of this.ctx.getWebSockets()) {
      if ((ws.deserializeAttachment() as Attachment | null)?.accountId !== accountId) continue;
      try { ws.send(frame); sent++; } catch { /* the socket is closing */ }
    }
    return sent;
  }

  /**
   * An `auth` with `since`: what the log kept after it that this reader may see, as socket events with their `seq`, in
   * pages of 200 up to 2,000, then the cursor. Events of other apps (`mail.*`) are not socket events and are not read.
   * A `since` older than the window sends `gap` first. The events still on their way to the log go in first.
   */
  private async sendBacklog(ws: WebSocket, workspaceId: string, userId: string, accountId: string, since: number): Promise<void> {
    if (!this.env.EVENTS) return;
    await this.logging;
    const events = this.env.EVENTS.get(this.env.EVENTS.idFromName(workspaceId));
    const reader = { accountId, channelIds: this.privateChannelIdsOf(userId) };
    let cursor = Math.max(0, Math.floor(since));
    let sent = 0;
    try {
      for (let page = 0; sent < BACKLOG_MAX; page++) {
        const out = (await events.readFrom({ since: cursor, limit: Math.min(BACKLOG_PAGE, BACKLOG_MAX - sent), types: ['chat.*'] }, reader)) as SubscriptionRead;
        if (page === 0 && out.gap) ws.send(JSON.stringify({ op: 'gap', from: out.gap.from, to: out.gap.to }));
        for (const e of out.events) {
          const event = { type: e.type.slice('chat.'.length), workspaceId, ...(e.channelId ? { channelId: e.channelId } : {}), ts: e.ts, data: e.data };
          ws.send(JSON.stringify({ op: 'event', event, seq: e.seq }));
        }
        sent += out.events.length;
        const moved = out.next > cursor;
        cursor = Math.max(cursor, out.next);
        if (!out.events.length || !moved) break;
      }
      ws.send(JSON.stringify({ op: 'cursor', seq: cursor }));
    } catch (err) {
      console.error(`[events] backlog from ${since}: ${(err as Error).message}`);
    }
  }

  /** The event log's half of GET /v1/events (routes/events.ts): the private channels this member is in. */
  privateChannelIdsOf(userId: string): string[] {
    return this.ctx.storage.sql.exec('SELECT c.id FROM channels c JOIN channel_members m ON m.channel_id = c.id WHERE c.is_private AND m.user_id = ?', userId)
      .toArray().map((r) => r.id as string);
  }

  /** Every channel this member is in, public and private: what Docs matches `channel:` grants against (routes/docs.ts). */
  channelIdsOf(userId: string): string[] {
    return this.ctx.storage.sql.exec('SELECT channel_id FROM channel_members WHERE user_id = ?', userId).toArray().map((r) => r.channel_id as string);
  }

  /** Each account's private channels, for an action subscription's owner (events/object.ts reads as the owner). */
  privateChannelIdsOfAccounts(accountIds: string[]): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const id of accountIds) {
      const user = this.userOfAccount(id);
      out[id] = user ? this.privateChannelIdsOf(user) : [];
    }
    return out;
  }

  private userOfAccount(accountId: string): string | null {
    return (this.ctx.storage.sql.exec('SELECT user_id FROM workspace_members WHERE account_id = ?', accountId).toArray()[0]?.user_id as string | undefined) ?? null;
  }

  /**
   * Who may make a `wake` subscription for the agent whose account this is (routes/events.ts): its sponsor, or an
   * owner or admin of the organization. Null when the account is no agent of this organization.
   */
  agentSponsorOf(agentAccountId: string): { userId: string; sponsorUserId: string | null } | null {
    const row = this.ctx.storage.sql.exec(
      'SELECT m.user_id, COALESCE(m.sponsor_user_id, u.sponsor_user_id) AS sponsor FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.account_id = ? AND u.is_agent',
      agentAccountId,
    ).toArray()[0];
    return row ? { userId: row.user_id as string, sponsorUserId: (row.sponsor as string | null) ?? null } : null;
  }

  /**
   * A `post` subscription's action: the message posted into the channel as the owner, through the message service, with
   * the trigger's depth plus one on its event. `clientMsgId` names the subscription and the event, so it posts once.
   */
  async postAutomation(p: { ownerAccountId: string; channelId: string; body: string; clientMsgId: string; depth: number }): Promise<string | null> {
    const user = this.userOfAccount(p.ownerAccountId);
    if (!user) return null;
    const { sendMessage } = await import('./services/messages');
    const msg = await this.scoped(() => sendMessage(p.channelId, user, p.clientMsgId, p.body, undefined, undefined, undefined, { expandMentions: true }), { depth: p.depth });
    await this.logging;
    await this.armAlarm();
    return msg.id;
  }

  /**
   * Tells an automation's owner it stopped: "Automation X could not wake Y" (a job parked) or reached the depth cap.
   * The agent says so in its DM with the owner, so it arrives as a DM notification; its event is at the depth cap, so it
   * wakes nothing. With no agent (a post automation) it is a log line.
   */
  async automationNotice(p: { ownerAccountId: string; agentAccountId: string | null; name: string; why: 'parked' | 'capped' }): Promise<void> {
    const owner = this.userOfAccount(p.ownerAccountId);
    const agent = p.agentAccountId ? this.userOfAccount(p.agentAccountId) : null;
    const workspace = this.db.select({ id: schema.workspaces.id }).from(schema.workspaces).get();
    if (!owner || !agent || !workspace) return console.log(`[events] automation "${p.name}": ${p.why} (no one to tell)`);
    const agentName = (this.ctx.storage.sql.exec('SELECT display_name FROM users WHERE id = ?', agent).toArray()[0]?.display_name as string | undefined) ?? 'its agent';
    const text = p.why === 'parked'
      ? `⚠️ Automation “${p.name}” could not wake ${agentName}: the job was delivered several times and never finished, so it is parked.`
      : `⚠️ Automation “${p.name}” stopped waking ${agentName}: a chain of events it set off reached the depth limit (${MAX_EVENT_DEPTH}).`;
    const [{ createDm }, { sendMessage }] = await Promise.all([import('./services/channels'), import('./services/messages')]);
    await this.scoped(async () => {
      const dm = await createDm(workspace.id, agent, [owner]);
      await sendMessage(dm.id, agent, crypto.randomUUID(), text);
    }, { depth: MAX_EVENT_DEPTH });
    await this.logging;
    await this.armAlarm();
  }

  /**
   * Provisioning could not make an account's mailbox (provisioning/consumer.ts): each owner and admin hears it in their DM
   * with that account's holder, as a DM notification, or in their own DM when the account is theirs.
   */
  async provisioningNotice(p: { accountId: string; text: string }): Promise<void> {
    const workspace = this.db.select({ id: schema.workspaces.id }).from(schema.workspaces).get();
    if (!workspace) return console.log(`[provisioning] ${p.text} (no one to tell)`);
    const holder = this.userOfAccount(p.accountId);
    const admins = this.ctx.storage.sql.exec("SELECT m.user_id FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.role IN ('owner', 'admin') AND NOT u.is_agent").toArray().map((r) => r.user_id as string);
    const [{ createDm }, { sendMessage }] = await Promise.all([import('./services/channels'), import('./services/messages')]);
    await this.scoped(async () => {
      const post = async (from: string, to: string) => {
        const dm = await createDm(workspace.id, from, [to]);
        await sendMessage(dm.id, from, crypto.randomUUID(), `⚠️ ${p.text}`);
      };
      for (const admin of admins) {
        // A holder who is no member (any more) cannot write: the admin's own DM then.
        if (holder && holder !== admin) await post(holder, admin).catch(() => post(admin, admin));
        else await post(admin, admin);
      }
    });
    await this.logging;
    await this.armAlarm();
  }

  /** The daily sweep of removed accounts' hosted mailboxes, when it is due: the directory sends those past the retention
   * period to be deleted (directory/core.ts `sweepRemoved`). */
  private async sweepMailboxes(): Promise<void> {
    if (!hostedMailEnabled(this.env)) return;
    const due = await this.ctx.storage.get<number>(SWEEP_KEY);
    if (due === undefined || due > Date.now()) return;
    await this.ctx.storage.put(SWEEP_KEY, Date.now() + DAY_MS);
    const workspace = this.db.select({ id: schema.workspaces.id }).from(schema.workspaces).get();
    if (!workspace) return;
    const days = Number(this.env.MAIL_RETENTION_DAYS) > 0 ? Number(this.env.MAIL_RETENTION_DAYS) : 30;
    const answer = await this.directory().call('sweepRemoved' as never, [workspace.id, days] as never) as DirectoryAnswer<number>;
    if (!answer.ok) console.error(`[provisioning] sweep: ${answer.message}`);
    else if (answer.value) console.log(`[provisioning] sweep: ${answer.value} mailbox(es) past ${days} days sent to be deleted`);
  }

  // ---- the share index (services/shares.ts, platform.md §4.5) ---------------------------------------------------------

  /**
   * An app object's grant, given or changed (Docs reports each one, docs/object.ts): into the index, the notice for a
   * new share (a DM line to an account, a card in a channel), and `sharing.granted` into the event log.
   */
  async recordShare(input: RecordShareInput): Promise<void> {
    const event = await this.scoped(() => recordShare(input, config.webUrlBase));
    await this.publishShareEvent(event);
    await this.logging;
    await this.armAlarm();
  }

  /** An app object's grant taken away: out of the index, and `sharing.revoked` into the event log. */
  async revokeShare(input: RevokeShareInput): Promise<void> {
    await this.publishShareEvent(await this.scoped(() => revokeShare(input)));
  }

  private async publishShareEvent(event: PublishInput | null): Promise<void> {
    if (!event || !this.env.EVENTS) return;
    await this.env.EVENTS.get(this.env.EVENTS.idFromName(event.organizationId)).publish(event)
      .catch((err: Error) => console.error(`[shares] ${event.type}: ${err.message}`));
  }

  /** The reader's channels as this object knows them (every one it is in, public too), with any it was given. */
  private shareReader(reader: { accountId: string; channelIds?: string[] }): { accountId: string; channelIds: string[] } {
    const user = this.userOfAccount(reader.accountId);
    return { accountId: reader.accountId, channelIds: [...new Set([...(reader.channelIds ?? []), ...(user ? this.channelIdsOf(user) : [])])] };
  }

  /** What is shared with the reader (GET /v1/workspaces/:id/shared-with-me, GET /v1/calendar/shared); `includeOrg` adds
   * what is shared with the whole organization. */
  async sharedWith(reader: { accountId: string; channelIds?: string[] }, opts?: { includeOrg?: boolean }): Promise<SharedItem[]> {
    return withDb(this.db, () => sharedWith(this.shareReader(reader), opts));
  }

  /** Whether the account is an active member here: an app object checks an `account:` grant's principal with this. */
  async isActiveAccount(accountId: string): Promise<boolean> {
    return typeof accountId === 'string' && !!accountId && withDb(this.db, () => isActiveAccount(accountId));
  }

  /** The references shared with the reader: the Events object's `ref:` audience (events/core.ts). */
  async sharedRefsOf(reader: { accountId: string; channelIds?: string[] }): Promise<string[]> {
    return withDb(this.db, () => sharedRefsOf(this.shareReader(reader)));
  }

  /** References resolved for a member (GET /v1/references, routes/references.ts): Chat's kinds here, and anything in the
   * share index shared with them; another app's object not in it comes back as `ask`. */
  async resolveReferences(userId: string, workspaceId: string, refs: string[]): Promise<OrgReferenceAnswer[]> {
    return this.scoped(() => resolveInOrg(userId, workspaceId, refs));
  }

  /** The account ids of this organization's agents, for an `actorKind` filter. */
  agentAccountIds(): string[] {
    return this.ctx.storage.sql.exec('SELECT m.account_id FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE u.is_agent AND m.account_id IS NOT NULL')
      .toArray().map((r) => r.account_id as string);
  }

  /** Runs with this object's database, event bus and socket controls in scope; `stamp` marks the events it publishes. */
  private scoped<T>(fn: () => Promise<T>, stamp?: Stamp): Promise<T> {
    return socketControl.run({ disconnectUser: (id) => this.closeUser(id) }, () =>
      directoryLink.run({ ensureAccount: (...args) => this.ensureAccount(...args), accountFor: (...args) => this.accountFor(...args) }, () =>
        shareEvents.run((event) => this.publishShareEvent(event), () =>
          withPublisher((subject, event) => this.broadcast(subject, event, stamp), () => withDb(this.db, fn)))));
  }

  /**
   * A request made during a job's turn (`x-flow-job`, on the caller context): its events carry the job's id and one
   * more than the job's depth. A job that is not the caller's, or unknown, stamps nothing.
   */
  private async stampOf(caller: CallerContext): Promise<Stamp | undefined> {
    if (!caller.account || !caller.organizationId || !this.env.EVENTS) return undefined;
    // The agent fields (agents.md §3): a personal agent acting as the caller, or who asked a shared agent for this turn.
    const agent: Stamp = agentStampFor(this.ctx.storage.sql, caller.organizationId, caller);
    const jobId = caller.jobId;
    if (!jobId) return Object.keys(agent).length ? agent : undefined;
    const key = `${caller.account.id}|${jobId}`;
    let depth = this.jobDepths.get(key);
    if (depth === undefined) {
      const found = await this.env.EVENTS.get(this.env.EVENTS.idFromName(caller.organizationId)).jobDepth(jobId, caller.account.id).catch(() => null);
      if (found === null) return Object.keys(agent).length ? agent : undefined;
      depth = found;
      this.jobDepths.set(key, depth);
    }
    return { ...agent, causedBy: jobId, depth: depth + 1 };
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
    const stamp = await this.stampOf(caller);
    const run = () => this.scoped(async () => {
      if (caller.user) this.ensureUser(caller.user);
      return app.handle(request, caller);
    }, stamp);
    const res = await (newWorkspaceId ? presetWorkspaceId.run(newWorkspaceId, run) : run()).finally(() => this.logging);
    await this.flushOutbox(newWorkspaceId);
    await this.armAlarm();
    return res;
  }

  /** The next thing due: a scheduled message or a push. On Node tickers polled for them; an object sleeps until then. */
  private async armAlarm(): Promise<void> {
    const scheduled = this.ctx.storage.sql.exec('SELECT MIN(next_run_at) AS at FROM scheduled_messages WHERE enabled AND next_run_at IS NOT NULL').one().at as number | null;
    const push = withDb(this.db, nextPushDueAt);
    let sweep: number | null = null;
    if (hostedMailEnabled(this.env)) {
      sweep = (await this.ctx.storage.get<number>(SWEEP_KEY)) ?? null;
      if (sweep === null) await this.ctx.storage.put(SWEEP_KEY, (sweep = Date.now() + DAY_MS));
    }
    const due = [scheduled, push, sweep].filter((n): n is number => n !== null);
    if (!due.length) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.min(...due));
  }

  override async alarm(): Promise<void> {
    await this.scoped(async () => {
      await runSchedulerTick();
      // After the scheduler, so a scheduled message's mentions push in the same alarm.
      await drainDuePushes(pushLog);
    });
    await this.logging;
    await this.flushOutbox(null);
    await this.sweepMailboxes().catch((err) => console.error(`[provisioning] sweep: ${(err as Error).message}`));
    await this.armAlarm();
  }

  /**
   * Accounts made guests or native (routes/accounts.ts, platform.md §3.3): each member row's address follows the
   * directory's (null for a guest), and the organization's sockets hear `member.updated`.
   */
  async accountAddresses(changes: { userId: string; address: string | null }[]): Promise<void> {
    const workspace = this.db.select({ id: schema.workspaces.id }).from(schema.workspaces).get();
    if (!workspace || !changes.length) return;
    await this.scoped(async () => {
      for (const c of changes) {
        const updated = this.ctx.storage.sql.exec('UPDATE workspace_members SET address = ? WHERE workspace_id = ? AND user_id = ? RETURNING user_id', c.address, workspace.id, c.userId).toArray();
        if (!updated.length) continue;
        publishEvent(subjectMeta(workspace.id), { type: 'member.updated', workspaceId: workspace.id, ts: new Date().toISOString(), data: await toMemberDTO(workspace.id, c.userId) } as Event);
      }
    });
    await this.logging;
  }

  /** A person's whole account is going: leave this organization as the Node server's deletion did. */
  async removeAccount(user: UserDTO): Promise<void> {
    await this.scoped(async () => {
      this.ensureUser(user);
      await deleteMyAccount(user.id);
    });
    await this.logging;
    await this.flushOutbox(null);
  }

  /** Domain self-registration: someone signing in with an address at this organization's domain becomes a member. */
  async joinByDomain(user: UserDTO): Promise<unknown> {
    const joined = await this.scoped(async () => {
      this.ensureUser(user);
      const workspace = this.db.select().from(schema.workspaces).get();
      if (!workspace) return null;
      const account = await accountForJoin(workspace.id, user.id);
      const isNew = await this.db.transaction((tx) => enrollInWorkspace(tx, workspace.id, user.id, 'member', undefined, account));
      if (!isNew) return null;
      await announceJoin(workspace.id, user.id);
      return JSON.parse(JSON.stringify(toWorkspaceDTO(workspace, 'member')));
    });
    await this.logging;
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
    await this.logging;
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
    let frame: { op?: string; token?: string; channelId?: string; threadRootId?: string; since?: unknown };
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
      const accountId = value!.account?.id ?? null;
      if (typeof frame.since === 'number' && Number.isFinite(frame.since) && frame.since >= 0 && accountId) {
        await this.sendBacklog(ws, workspace!.id, user.id, accountId, frame.since);
      }
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
