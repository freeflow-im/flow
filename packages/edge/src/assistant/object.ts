// The assistant (docs/specs/platform.md §5.5): one object per account (`idFromName(accountId)`), holding the account's
// chats, its assistant settings and its daily usage, and running the model loop (docs/server/agent/agent.ts, the providers
// and the prompt, the same code the standalone and desktop Docs servers run in-process). Its tools come from the registry
// (§5.4): the open app's browser tools by the turn's page (the manifests' `assistant.pages`), which the browser runs, and
// every server tool, run here against the apps over HTTP as the person: Docs' against the organization's Docs object
// (docsTools.ts), Mail's against the account's Mail object, Calendar's through calendarRequest as the routes do, and an app
// added by manifest's against its object (apps.ts).
//
// The Worker (routes/assistant.ts) serves Docs' old paths here (/api/agent, /api/agent/turn, /api/agent/reset,
// /api/agent/permission, /api/settings/assistant), so the three clients' panels talk to it unchanged. The chats used to be
// in each organization's Docs object; POST /v1/admin/assistant/migrate copies them here once (`importChat`, `importRows`).
import Anthropic from '@anthropic-ai/sdk';
import { DurableObject } from 'cloudflare:workers';
import { Hono, type Context } from 'hono';
import type { AccountDTO, AgentJobDTO, HostedRuntimeDTO, UserDTO } from '@flow/shared';
import type { CallerContext } from '../org/routes/compat';
import type { ImportRow } from '../importing';
import { exportTables, importTable, ownerMismatch, ownerRefusal } from '../perAccount';
import { calendarRequest, type AccountCaller } from '../calendar/forward';
import type { CalendarToolContext } from '../calendar/calendarTools';
import type { MailToolContext } from '../imap/mailTools';
import { appToolContexts } from '../apps';
import { withDocsContext, type DocsContext } from '@flow/docs/server/runtime/workerd/context.ts';
import type { Caller as DocsCaller } from '@flow/docs/server/runtime/workerd/http.ts';
import { DatabaseSync } from '@flow/docs/server/runtime/workerd/sqlite.ts';
import { AgentError, AgentService, type ModelCall } from '@flow/docs/server/agent/agent.ts';
import { openaiErrorMessage } from '@flow/docs/server/agent/openai.ts';
import { OpenRouterError } from '@flow/docs/server/agent/openrouter.ts';
import { checkAssistantKey, OwnKeyError } from '@flow/docs/server/agent/providers.ts';
import { AssistantSettingsStore, SettingsError, type KeyCheck, type SearchKeyCheck } from '@flow/docs/server/agent/settings.ts';
import { ORG_ROW, OrgModelSettings, orgModelKey, type OrgModel } from './orgModel';
import type { AssistantSettings } from '@flow/shared/assistant';
import { AgentStore } from '@flow/docs/server/agent/store.ts';
import { checkBraveKey } from '@flow/docs/server/agent/tools.ts';
import { ASSISTANT_PAGES, SUITE_GUIDANCE } from '../docs/assistantTools.ts';
import { isFileId } from '@flow/docs/server/ids.ts';
import { scopeOf, type ScopeArg } from '@flow/docs/server/scope.ts';
import { chatScope, HOME_CHAT, isChatScope, type AgentDefinition, type AgentEvent, type AgentTurnRequest, type AssistantSettingsUpdate } from '@flow/docs/shared/agent/protocol.ts';
import { docsPageUrl, docsToolContext, importToDocs, type DocsFetch, type DocsPlace } from './docsTools.ts';

export type { DocsCaller };

export interface AssistantEnv {
  /** Seals the settings' API keys, as it did in the Docs object (connectors/secrets.ts), so moved keys still open. */
  FLOW_DATA_KEY?: string;
  FLOW_WEB_URL?: string;
  /** The platform's own model key: with it, "the built-in model" is a choice; without it, the organization must set one. */
  ANTHROPIC_API_KEY?: string;
  BLOBS?: R2Bucket;
  DIRECTORY?: DurableObjectNamespace<import('../directory/object').Directory>;
  /** The organizations' Docs objects: Docs' tools, as the person. */
  DOCS?: DurableObjectNamespace<import('../docs/object').Docs>;
  /** The account's Mail object: Mail's tools. */
  MAIL?: DurableObjectNamespace<import('../imap/object').Mail>;
  /** Calendar's objects and the organization's share index: Calendar's tools, as routes/calendar.ts reaches them. */
  CALENDAR?: DurableObjectNamespace<import('../calendar/object').Calendar>;
  ORG?: DurableObjectNamespace<import('../org/object').Org>;
  /** The organizations' event logs: a wake job's steps (ack, done), when this runtime takes one (agents.md §6). */
  EVENTS?: DurableObjectNamespace<import('../events/object').Events>;
  /** Itself: the `org:<id>` object keeps the organization's model, which every runtime runs on (orgModel.ts). */
  ASSISTANT?: DurableObjectNamespace<Assistant>;
}

/** How long an async turn may run before it is given up. */
const WAKE_TURN_MS = 8 * 60_000;

/**
 * The tables, Docs' own DDL for them (docs/server/db.ts, with its later columns) without the `users` references: this
 * object has no users table. Append-only: a change is a new entry.
 */
export const ASSISTANT_MIGRATIONS: string[][] = [
  [
    `CREATE TABLE IF NOT EXISTS agent_conversations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, ended_at TEXT, pending TEXT,
      driver TEXT, session_id TEXT, scope TEXT, workspace_id TEXT)`,
    'CREATE INDEX IF NOT EXISTS agent_conversations_user ON agent_conversations(user_id, ended_at)',
    `CREATE TABLE IF NOT EXISTS agent_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL)`,
    'CREATE INDEX IF NOT EXISTS agent_messages_conv ON agent_messages(conversation_id, id)',
    `CREATE TABLE IF NOT EXISTS agent_usage (user_id TEXT NOT NULL, day TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day))`,
    `CREATE TABLE IF NOT EXISTS assistant_settings (user_id TEXT PRIMARY KEY, provider TEXT NOT NULL, openai_model TEXT NOT NULL, openai_key TEXT, openai_key_masked TEXT,
      updated_at TEXT NOT NULL, anthropic_model TEXT, anthropic_key TEXT, anthropic_key_masked TEXT, openrouter_model TEXT, openrouter_key TEXT, openrouter_key_masked TEXT,
      brave_key TEXT, brave_key_masked TEXT)`,
    // Whose object this is (perAccount.ts' owner keys).
    'CREATE TABLE IF NOT EXISTS assistant_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  ],
];
/** Every table, for exportRows. */
export const ASSISTANT_TABLES = ['agent_conversations', 'agent_messages', 'agent_usage', 'assistant_settings', 'assistant_state'] as const;
/** The tables importRows takes whole; a conversation comes with its messages (importChat). */
const IMPORTED = ['agent_usage', 'assistant_settings'] as const;

/** The rows of a move between accounts (pruneMoved, presentRows): conversations by id, usage by (user, day), settings by user. */
export interface MovedChats { conversations: string[]; usage: { user_id: string; day: string }[]; settings: string[] }

/** Who is asking, per request: the caller context (the account) and the same person as the Docs object's caller. */
/** `conversationUser`: whose conversation a request is in; the agent's own identity when it is not the caller's (a shared agent asked by a person). */
interface Who { caller: AccountCaller; docs: DocsCaller; conversationUser?: string }
type Bindings = { who: Who };
type C = Context<{ Bindings: Bindings }>;

/** No organization model and no platform key (operator ruling 2026-11-11: one model per organization). */
const NO_MODEL = 'No model is set for this organization yet. An owner or admin chooses one in Organization settings → Agents.';

/** What the panel is told of a failed turn (the Docs server's agentErrorMessage, as it was). */
function agentErrorMessage(e: unknown): string {
  if (e instanceof AgentError || e instanceof OwnKeyError || e instanceof OpenRouterError) return e.message;
  const openai = openaiErrorMessage(e);
  if (openai) return openai;
  if (e instanceof Anthropic.RateLimitError) return 'The assistant is getting too many requests right now. Try again in a minute.';
  if (e instanceof Anthropic.AuthenticationError) return 'The assistant is not configured correctly on this server (API key).';
  if (e instanceof Anthropic.APIError && e.status && e.status >= 500) return 'The AI service had a problem. Try again in a moment.';
  if (e instanceof Anthropic.AnthropicError && /api ?key|authentication/i.test(e.message)) return NO_MODEL;
  // The SDK made with no key at all says so before any request.
  if (e instanceof Error && /resolve authentication method/i.test(e.message)) return NO_MODEL;
  return 'Something went wrong while the assistant was working. Try again.';
}

/** The most a definition's instructions may run to. */
const MAX_INSTRUCTIONS = 8_000;

/** The definition's instructions as prompt lines (prompt.ts `systemPrompt`'s guidance): one block, marked as the owner's. */
export function definitionGuidance(d: AgentDefinition): string[] {
  const text = d.instructions.trim();
  return text ? [`- Instructions from the person or organization this agent belongs to, which you follow within the rules above:\n${text}`] : [];
}

/** Whose conversation a request is in: the caller's, or, for a shared agent asked by a person, that person's (one thread per asker). */
const conversationUserOf = (c: { env: { who: Who } }) => c.env.who.conversationUser ?? c.env.who.docs.userId!;

export class Assistant extends DurableObject<AssistantEnv> {
  private readonly sql: SqlStorage;
  private readonly context: DocsContext;
  private readonly app = new Hono<{ Bindings: Bindings }>();
  private services: { agent: AgentService; settings: OrgModelSettings } | null = null;
  /** The organization's model as last asked (orgModel.ts), and when: kept a minute. */
  private orgModelAt = 0;
  private orgModelOf: string | null = null;
  /** The latest request's caller: the account is always this object's, but its channels and session may change. */
  private who: Who | null = null;
  /** The caller of each turn that is running, by its conversation user: tools read theirs, never a later request's. */
  private readonly turnWho = new Map<string, Who>();
  /** Wake jobs this runtime is running now. */
  private readonly runningJobs = new Set<string>();
  /** The prompt lines the loop reads on every model call; a definition change rewrites them in place (no new loop, so
   * the loop's guard against two turns in one conversation stays). */
  private readonly guidanceLines: string[] = [];

  constructor(ctx: DurableObjectState, env: AssistantEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.migrate();
    // The settings' keys are sealed with CONNECTOR_ENCRYPTION_KEY (connectors/secrets.ts), FLOW_DATA_KEY in the suite, as in the Docs object.
    if (!process.env.CONNECTOR_ENCRYPTION_KEY && env.FLOW_DATA_KEY) process.env.CONNECTOR_ENCRYPTION_KEY = env.FLOW_DATA_KEY;
    // The Docs stores (AgentStore, AssistantSettingsStore) run on this object's SQLite through the Docs runtime's node:sqlite.
    this.context = { sql: this.sql, bucket: env.BLOBS as R2Bucket, prefix: `assistant/${ctx.id.toString()}/`, transactionSync: (fn) => ctx.storage.transactionSync(fn) };
    this.routes();
  }

  private migrate(): void {
    this.sql.exec('CREATE TABLE IF NOT EXISTS assistant_migrations (version INTEGER PRIMARY KEY)');
    const done = new Set(this.sql.exec('SELECT version FROM assistant_migrations').toArray().map((r) => Number(r.version)));
    ASSISTANT_MIGRATIONS.forEach((statements, i) => {
      if (done.has(i + 1)) return;
      for (const s of statements) this.sql.exec(s);
      this.sql.exec('INSERT INTO assistant_migrations (version) VALUES (?)', i + 1);
    });
  }

  state(key: string): string | null {
    return (this.sql.exec('SELECT value FROM assistant_state WHERE key = ?', key).toArray()[0]?.value as string | undefined) ?? null;
  }

  /** The suite's prompt lines and the definition's instructions, written into the array the loop reads. */
  private refreshGuidance(): string[] {
    this.guidanceLines.splice(0, this.guidanceLines.length, ...SUITE_GUIDANCE, ...definitionGuidance(this.definition()));
    return this.guidanceLines;
  }

  /** The hosted agent's definition (agents.md §6), as set, or the default: a name and no instructions. */
  definition(): AgentDefinition {
    const raw = this.state('definition');
    if (raw) {
      try { return JSON.parse(raw) as AgentDefinition; } catch { /* a bad row reads as the default */ }
    }
    return { name: this.state('definition_default_name') ?? 'Assistant', instructions: '', updatedAt: null };
  }

  /** Sets the definition; the loop is remade so the next turn's prompt carries the new instructions. */
  setDefinition(d: { name?: string; instructions?: string }): AgentDefinition {
    const now = this.definition();
    const next: AgentDefinition = {
      name: (d.name ?? now.name).trim().slice(0, 80) || now.name,
      instructions: (d.instructions ?? now.instructions).trim().slice(0, MAX_INSTRUCTIONS),
      updatedAt: new Date().toISOString(),
    };
    this.setState('definition', JSON.stringify(next));
    this.refreshGuidance();
    return next;
  }

  setState(key: string, value: string): void {
    this.sql.exec('INSERT INTO assistant_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
  }

  /** The model loop's own model call (null: Claude on the Worker's key). Tests give a scripted one. */
  protected model(): ModelCall | null {
    return null;
  }

  /** How a key is checked before Settings saves it (the provider's API). Tests give one that answers at once. */
  protected keyChecks(): { key: KeyCheck; search: SearchKeyCheck } {
    return { key: checkAssistantKey, search: checkBraveKey };
  }

  private get origin(): string {
    return (this.env.FLOW_WEB_URL ?? 'https://app.freeflow.im').replace(/\/+$/, '');
  }

  /** The stores and the loop, made on first use (inside the Docs runtime's context, which their SQL needs). */
  private service(): { agent: AgentService; settings: OrgModelSettings } {
    if (this.services) return this.services;
    const db = new DatabaseSync();
    // Every agent runs on its organization's model (operator ruling 2026-11-11): the loop reads it through this store.
    const settings = new OrgModelSettings(db as never, 'data/connector.key', { builtIn: !!this.env.ANTHROPIC_API_KEY, agents: false });
    const model = this.model();
    const agent = new AgentService(new AgentStore(db as never), null as never, settings, {
      jobs: false,
      ...(model ? { model } : {}),
      // The suite's assistant (docs/assistantTools.ts): the pages of every app, its tools' environment, its prompt lines.
      pages: ASSISTANT_PAGES,
      // The definition's instructions (agents.md §6) ride with the suite's guidance; a change remakes the service.
      guidance: this.refreshGuidance(),
      extend: (userId: string, scope: ScopeArg) => {
        // The turn's own caller (a concurrent request or wake job may have come in since it started).
        const who = this.turnWho.get(userId) ?? this.who;
        const place = placeOf(scope);
        const docsFetch = place ? this.docsFetch(place.workspace, who) : undefined;
        const docs = place && docsFetch ? docsToolContext(docsFetch, place, this.origin) : undefined;
        const mail = this.mailContext(scope, who);
        // Calendar's shared calendars go by the channels of whom the turn runs as: the agent's own, not its asker's.
        const calendar = this.calendarContext(who?.docs.userId ?? userId, who);
        // The apps added by manifest (apps.ts): their objects, as the account this object belongs to.
        const apps = appToolContexts(this.env, async () => who?.caller ?? null, this.origin);
        return { ...(docs ? { docs } : {}), ...(mail ? { mail } : {}), ...(calendar ? { calendar } : {}), ...(apps ? { apps } : {}) };
      },
    });
    return (this.services = { agent, settings });
  }

  /** The organization's Docs object's /api/*, as the person (routes/docs.ts' caller): undefined without Docs or a caller. */
  private docsFetch(organizationId: string, who: Who | null = this.who): DocsFetch | undefined {
    const ns = this.env.DOCS, docs = who?.docs;
    if (!ns || !docs) return undefined;
    const stub = ns.get(ns.idFromName(organizationId));
    return (path, init) => stub.handle(new Request(`${this.origin}${path}`, init), docs, organizationId);
  }

  /** Mail's tools: the account's Mail object, and saving an attachment into the chat's root in Docs. */
  private mailContext(scope: ScopeArg, who: Who | null = this.who): MailToolContext | undefined {
    const ns = this.env.MAIL, caller = who?.caller;
    if (!ns || !caller) return undefined;
    const place = placeOf(scope);
    const docs = place ? this.docsFetch(place.workspace, who) : undefined;
    const stub = ns.get(ns.idFromName(caller.account.id));
    return {
      mail: (path, init) => stub.handle(new Request(`${this.origin}${path}`, init), caller),
      origin: this.origin,
      ...(docs && place
        ? {
            saveToDocs: async (bytes: Buffer, filename: string) => {
              const made = await importToDocs(docs, place, bytes, filename);
              const s = made.sheet;
              // With its page in the suite: the user in Mail gets a link, not a guess (docsTools.ts docsPageUrl).
              const file = s
                ? { id: s.id, kind: s.kind, title: s.title, [s.kind === 'deck' ? 'deck_id' : s.kind === 'sheet' ? 'sheet_id' : 'doc_id']: s.id, url: docsPageUrl(this.origin, place, 'sheet', s.id, s.kind) }
                : { id: made.file.id, kind: 'file', file_id: made.file.id, filename: made.file.filename, type: made.file.type, url: docsPageUrl(this.origin, place, 'file', made.file.id) };
              return { file, warnings: made.warnings };
            },
          }
        : {}),
    };
  }

  /** Calendar's tools: the account's Calendar object (or a shared calendar's owner's), as routes/calendar.ts reaches them. */
  private calendarContext(userId: string, who: Who | null = this.who): CalendarToolContext | undefined {
    const { CALENDAR, ORG } = this.env;
    const caller = who?.caller;
    if (!CALENDAR || !ORG || !caller) return undefined;
    const organizationId = caller.account.organizationId || caller.organizationId;
    return {
      calendar: (path, init) => calendarRequest({ CALENDAR, ORG }, new Request(`${this.origin}${path}`, init), caller, userId),
      origin: this.origin,
      member: async (address) => {
        const a = await this.directory<AccountDTO | null>('accountByAddress', address).catch(() => null);
        return a && a.organizationId === organizationId && a.state !== 'suspended' && a.state !== 'removed' ? { accountId: a.id, name: a.displayName ?? address } : null;
      },
    };
  }

  private directory<T>(method: string, ...args: unknown[]): Promise<T> {
    const ns = this.env.DIRECTORY;
    if (!ns) return Promise.reject(new Error('no directory'));
    const stub = ns.get(ns.idFromName('directory'));
    return (stub.call as never as (m: string, a: unknown[]) => Promise<{ ok: boolean; value: T }>)(method, args).then((a) => a.value);
  }

  /**
   * A request for the account this object belongs to (routes/assistant.ts), with its caller context and the same person
   * as the Docs object knows them; a caller of another account is refused.
   */
  async handle(request: Request, caller: CallerContext, docs: DocsCaller, agentName?: string, opts: { conversationUser?: string } = {}): Promise<Response> {
    const wrong = ownerMismatch(this, caller, 'the Assistant');
    if (wrong) { console.error(`[assistant] ${wrong}`); return ownerRefusal(wrong); }
    if (caller.organizationId) await this.useOrgModel(caller.organizationId);
    // The agent's name as the directory knows it (agents.md §6), the definition's default until the person sets one.
    if (agentName && this.state('definition_default_name') !== agentName) this.setState('definition_default_name', agentName);
    const who: Who = { caller: caller as AccountCaller, docs, ...(opts.conversationUser ? { conversationUser: opts.conversationUser } : {}) };
    this.who = who;
    return withDocsContext(this.context, () => this.app.fetch(request, { who } satisfies Bindings));
  }

  /**
   * A hosted shared agent's runtime, claimed for the agent's account when the Admin app makes the agent (agents.md §6): the
   * owner keys the first request would set, and the definition's name. Idempotent.
   */
  async adopt(account: AccountDTO, name: string): Promise<AgentDefinition> {
    const wrong = ownerMismatch(this, { user: null, account, organizationId: account.organizationId }, 'the agent runtime');
    if (wrong) throw new Error(wrong);
    if (this.state('definition_default_name') !== name) this.setState('definition_default_name', name);
    return this.definition();
  }

  /** A hosted agent's definition, set from the Admin app (agents.md §6): the runtime remakes its loop for the next turn. */
  async updateDefinition(d: { name?: string; instructions?: string }): Promise<AgentDefinition> {
    return this.setDefinition(d);
  }

  async currentDefinition(): Promise<AgentDefinition> {
    return this.definition();
  }

  /**
   * A wake job for the hosted agent this object runs (agents.md §6), handed over by the organization's Events object: the
   * job is acked, the prompt run as an async turn (no page, so no browser tools; the server tools as the agent), the answer
   * posted in the job's channel as the agent (a personal agent: as its sponsor, marked `via`), and the job stepped to done.
   * One conversation per subscription keeps an automation's memory apart from the person's chats.
   */
  async wake(p: { organizationId: string; job: AgentJobDTO; runtime: HostedRuntimeDTO }): Promise<void> {
    await this.useOrgModel(p.organizationId);
    const { job, runtime, organizationId } = p;
    const events = this.env.EVENTS?.get(this.env.EVENTS.idFromName(organizationId));
    const step = (s: 'ack' | 'done', opts: { ok?: boolean; note?: string } = {}) => events?.jobStep(job.id, job.agent, s, opts).catch((err: Error) => console.error(`[assistant] job ${job.id} ${s}: ${err.message}`));
    // A job delivered again while this runtime still runs it (a lease that lapsed): leave it to the run in progress.
    if (this.runningJobs.has(job.id)) return console.log(`[assistant] job ${job.id}: already running here`);
    const acked = await step('ack');
    if (acked && 'conflict' in acked) return console.log(`[assistant] job ${job.id}: not taken, it is ${acked.conflict}`);
    this.runningJobs.add(job.id);
    const ORG = this.env.ORG;
    const org = ORG?.get(ORG.idFromName(organizationId));
    let note = '';
    let ok = false;
    try {
      // Whom the turn runs as: the shared agent itself, or the personal agent's sponsor (marked via).
      this.requireModel();
      const actorId = runtime.mode === 'personal' ? runtime.sponsorId! : runtime.agentId;
      const actorAccountId = runtime.mode === 'personal' ? runtime.sponsorAccountId! : runtime.agentAccountId;
      const [user, account, channelIds] = await Promise.all([
        this.directory<UserDTO>('getUser', actorId, actorId),
        this.directory<AccountDTO | null>('accountById', actorAccountId),
        org ? org.channelIdsOf(actorId) : Promise.resolve([] as string[]),
      ]);
      if (!account) throw new Error('the agent has no account');
      const caller = { user, token: '', authKind: 'agent' as const, ip: '', organizationId, account, ...(runtime.mode === 'personal' ? { via: runtime.agentId } : {}) } as AccountCaller;
      const wrong = ownerMismatch(this, caller, 'the agent runtime');
      if (wrong) throw new Error(wrong);
      const docs: DocsCaller = { userId: actorId, email: user.email, token: '', ip: '', accountId: account.id, channelIds };
      const who: Who = { caller, docs, conversationUser: `auto:${job.subscriptionId}` };
      this.turnWho.set(`auto:${job.subscriptionId}`, who);
      const text = await withDocsContext(this.context, async () => {
        const { agent } = this.service();
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), WAKE_TURN_MS);
        let out = '';
        let failed: string | null = null;
        try {
          await agent.runTurn(`auto:${job.subscriptionId}`, { message: job.prompt, context: { page: 'home' }, workspace: organizationId }, (e) => {
            if (e.type === 'text') out += e.text;
            else if (e.type === 'error') failed = e.message;
          }, abort.signal, { scope: { ownerId: actorId, workspaceId: organizationId, private: true }, viewer: actorId });
        } finally {
          clearTimeout(timer);
        }
        if (failed) throw new Error(failed);
        return out.trim();
      });
      if (job.channelId && text && org) {
        await org.postAutomation({ ownerAccountId: actorAccountId, channelId: job.channelId, body: text, clientMsgId: job.id, depth: job.depth + 1, causedBy: job.id, ...(runtime.mode === 'personal' ? { via: runtime.agentId } : {}) });
      }
      ok = true;
      note = text ? text.slice(0, 200) : 'nothing to say';
    } catch (err) {
      note = agentErrorMessage(err).slice(0, 500);
      console.error(`[assistant] job ${job.id}: ${(err as Error)?.stack ?? err}`);
    }
    this.turnWho.delete(`auto:${job.subscriptionId}`);
    this.runningJobs.delete(job.id);
    await step('done', { ok, note });
  }

  /**
   * A request to a person's assistant in Chat (agents.md §1.1), handed over by the organization's object: run as an async
   * turn with the sponsor's access (marked `via` the assistant), in one conversation per thread or DM so its memory of
   * one exchange stays with it, and the answer posted in Chat as the assistant itself.
   */
  async chatTurn(p: { organizationId: string; runtime: HostedRuntimeDTO; channelId: string; threadRootId: string | null; messageId: string; prompt: string }): Promise<void> {
    await this.useOrgModel(p.organizationId);
    const { runtime, organizationId } = p;
    if (runtime.mode !== 'personal' || !runtime.sponsorId || !runtime.sponsorAccountId) return;
    if (this.runningJobs.has(p.messageId)) return;
    this.runningJobs.add(p.messageId);
    const ORG = this.env.ORG;
    const org = ORG?.get(ORG.idFromName(organizationId));
    const conversation = `chat:${p.channelId}:${p.threadRootId ?? 'main'}`;
    try {
      this.requireModel();
      const actorId = runtime.sponsorId;
      const [user, account, channelIds] = await Promise.all([
        this.directory<UserDTO>('getUser', actorId, actorId),
        this.directory<AccountDTO | null>('accountById', runtime.sponsorAccountId),
        org ? org.channelIdsOf(actorId) : Promise.resolve([] as string[]),
      ]);
      if (!account) throw new Error('the sponsor has no account');
      const caller = { user, token: '', authKind: 'agent' as const, ip: '', organizationId, account, via: runtime.agentId } as AccountCaller;
      const wrong = ownerMismatch(this, caller, 'the assistant in Chat');
      if (wrong) throw new Error(wrong);
      const docs: DocsCaller = { userId: actorId, email: user.email, token: '', ip: '', accountId: account.id, channelIds };
      this.turnWho.set(conversation, { caller, docs, conversationUser: conversation });
      const text = await withDocsContext(this.context, async () => {
        const { agent } = this.service();
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), WAKE_TURN_MS);
        let out = '';
        let failed: string | null = null;
        try {
          await agent.runTurn(conversation, { message: p.prompt, context: { page: 'home' }, workspace: organizationId }, (e) => {
            if (e.type === 'text') out += e.text;
            else if (e.type === 'error') failed = e.message;
          }, abort.signal, { scope: { ownerId: actorId, workspaceId: organizationId, private: true }, viewer: actorId });
        } finally {
          clearTimeout(timer);
        }
        if (failed) throw new Error(failed);
        return out.trim();
      });
      if (text && org) await org.postAsAssistant({ agentUserId: runtime.agentId, channelId: p.channelId, threadRootId: p.threadRootId, body: text, clientMsgId: `assistant:${p.messageId}` });
    } catch (err) {
      console.error(`[assistant] chat ${p.messageId}: ${(err as Error)?.stack ?? err}`);
      if (org) await org.postAsAssistant({ agentUserId: runtime.agentId, channelId: p.channelId, threadRootId: p.threadRootId, body: `Sorry, I could not answer that: ${agentErrorMessage(err).slice(0, 300)}`, clientMsgId: `assistant:${p.messageId}` }).catch(() => null);
    } finally {
      this.turnWho.delete(conversation);
      this.runningJobs.delete(p.messageId);
    }
  }

  /** The senders the sponsor allows to mail their assistant (agents.md §1.1): empty by default, and empty means no mail is read. */
  async mailAllowlist(): Promise<string[]> {
    try { return JSON.parse(this.state('mail_allowlist') ?? '[]') as string[]; } catch { return []; }
  }

  /**
   * Mail to the person's assistant from an allowlisted sender (the assistant's Mail object screened it): an async turn
   * with the sponsor's access, one conversation per sender, and the answer mailed back from the assistant's mailbox.
   */
  async mailTurn(p: { organizationId: string; runtime: HostedRuntimeDTO; mailboxAccountId: string; from: string; subject: string; text: string; messageId: string }): Promise<void> {
    await this.useOrgModel(p.organizationId);
    const { runtime, organizationId } = p;
    if (runtime.mode !== 'personal' || !runtime.sponsorId || !runtime.sponsorAccountId || !this.env.MAIL) return;
    if (this.runningJobs.has(p.messageId)) return;
    this.runningJobs.add(p.messageId);
    const conversation = `mail:${p.from.toLowerCase()}`;
    const mail = this.env.MAIL.get(this.env.MAIL.idFromName(p.mailboxAccountId));
    const subject = /^re:/i.test(p.subject) ? p.subject : `Re: ${p.subject}`;
    try {
      this.requireModel();
      const actorId = runtime.sponsorId;
      const ORG = this.env.ORG;
      const org = ORG?.get(ORG.idFromName(organizationId));
      const [user, account, channelIds] = await Promise.all([
        this.directory<UserDTO>('getUser', actorId, actorId),
        this.directory<AccountDTO | null>('accountById', runtime.sponsorAccountId),
        org ? org.channelIdsOf(actorId) : Promise.resolve([] as string[]),
      ]);
      if (!account) throw new Error('the sponsor has no account');
      const caller = { user, token: '', authKind: 'agent' as const, ip: '', organizationId, account, via: runtime.agentId } as AccountCaller;
      const wrong = ownerMismatch(this, caller, 'the assistant by mail');
      if (wrong) throw new Error(wrong);
      const docs: DocsCaller = { userId: actorId, email: user.email, token: '', ip: '', accountId: account.id, channelIds };
      this.turnWho.set(conversation, { caller, docs, conversationUser: conversation });
      const prompt = `A message came to your mailbox from ${p.from}, a sender ${user.displayName} allows. Treat it as ${user.displayName}'s request. Your answer is mailed back to ${p.from}.\n\nSubject: ${p.subject}\n\n${p.text}`;
      const text = await withDocsContext(this.context, async () => {
        const { agent } = this.service();
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), WAKE_TURN_MS);
        let out = '';
        let failed: string | null = null;
        try {
          await agent.runTurn(conversation, { message: prompt, context: { page: 'home' }, workspace: organizationId }, (e) => {
            if (e.type === 'text') out += e.text;
            else if (e.type === 'error') failed = e.message;
          }, abort.signal, { scope: { ownerId: actorId, workspaceId: organizationId, private: true }, viewer: actorId });
        } finally {
          clearTimeout(timer);
        }
        if (failed) throw new Error(failed);
        return out.trim();
      });
      if (text) await mail.sendAsAssistant({ to: p.from, subject, text, inReplyTo: p.messageId });
    } catch (err) {
      console.error(`[assistant] mail ${p.messageId}: ${(err as Error)?.stack ?? err}`);
      await mail.sendAsAssistant({ to: p.from, subject, text: `Sorry, I could not answer that: ${agentErrorMessage(err).slice(0, 300)}`, inReplyTo: p.messageId }).catch(() => null);
    } finally {
      this.turnWho.delete(conversation);
      this.runningJobs.delete(p.messageId);
    }
  }

  // ---- the organization's model (orgModel.ts) ------------------------------------------------------------------------

  /** Asks the organization's object for its model, at most once a minute, before a turn. A failure keeps the last one. */
  private async useOrgModel(organizationId: string): Promise<void> {
    if (this.orgModelOf === organizationId && Date.now() - this.orgModelAt < 60_000) return;
    try {
      const model = await this.env.ASSISTANT!.get(this.env.ASSISTANT!.idFromName(orgModelKey(organizationId))).orgModel();
      withDocsContext(this.context, () => { this.service().settings.current = model; });
      this.orgModelOf = organizationId;
      this.orgModelAt = Date.now();
    } catch (err) {
      console.error(`[assistant] organization model: ${(err as Error).message}`);
    }
  }

  /** Before a turn the person is not watching (Chat, mail, a wake): a plain reason when nothing can run it. */
  private requireModel(): void {
    const settings = withDocsContext(this.context, () => this.service().settings);
    if (!settings.current?.choice && !settings.builtIn) throw new AgentError(400, NO_MODEL);
  }

  /** In the `org:<id>` object: the organization's model, for the runtimes (its keys opened). */
  async orgModel(): Promise<OrgModel> {
    return withDocsContext(this.context, () => {
      const base = new AssistantSettingsStore(new DatabaseSync() as never, 'data/connector.key', { builtIn: !!this.env.ANTHROPIC_API_KEY, agents: false });
      return { shown: base.get(ORG_ROW), choice: base.choice(ORG_ROW), braveKey: base.braveKey(ORG_ROW), openaiKey: base.openaiKey(ORG_ROW) };
    });
  }

  /** In the `org:<id>` object: the organization's model, as shown (masked). */
  async orgSettings(): Promise<AssistantSettings> {
    return (await this.orgModel()).shown;
  }

  /** In the `org:<id>` object: an admin changes the organization's model; a key is checked first. Errors come back as answers. */
  async updateOrgSettings(body: Partial<AssistantSettingsUpdate>): Promise<{ ok: true; settings: AssistantSettings } | { ok: false; message: string }> {
    try {
      const checks = this.keyChecks();
      const settings = await withDocsContext(this.context, () => new AssistantSettingsStore(new DatabaseSync() as never, 'data/connector.key', { builtIn: !!this.env.ANTHROPIC_API_KEY, agents: false }).update(ORG_ROW, body, checks.key, checks.search));
      return { ok: true, settings };
    } catch (e) {
      if (e instanceof SettingsError) return { ok: false, message: e.message };
      throw e;
    }
  }

  /** The person's own OpenAI key, for Docs' edit_image (its host.assistant.openaiKey); null for none or another person. */
  async openaiKey(userId: string): Promise<string | null> {
    const owner = this.state('owner_user_id');
    if (owner && owner !== userId) return null;
    return withDocsContext(this.context, () => this.service().settings.openaiKey());
  }

  private routes(): void {
    const app = this.app;
    const userOf = conversationUserOf;
    const fail = (c: C, e: unknown) => {
      if (e instanceof AgentError) return c.json({ error: e.message }, e.status as 400);
      throw e;
    };

    // A chat: a file's (scope = its id), the home page's, Mail's or Calendar's, with the file's name for the panel to show.
    app.get('/api/agent', async (c) => {
      const scope = c.req.query('scope') ?? HOME_CHAT;
      if (!isChatScope(scope)) return c.json({ error: 'That is not a chat.' }, 400);
      const title = scope === HOME_CHAT ? null : ((await this.placeOfFile(scope, c.env.who))?.title ?? null);
      return c.json({ items: this.service().agent.transcript(userOf(c), scope), title });
    });

    // The user's own agent's permission questions: there is none here (the desktop app's Claude Code only).
    app.post('/api/agent/permission', async (c) => {
      const { id, allow } = ((await c.req.json().catch(() => ({}))) ?? {}) as { id?: unknown; allow?: unknown };
      if (typeof id !== 'string' || typeof allow !== 'boolean') return c.json({ error: 'Give the question’s id and allow.' }, 400);
      if (!this.service().agent.answerPermission(id, allow)) return c.json({ error: 'That question is no longer open.' }, 404);
      return c.json({ ok: true });
    });

    app.post('/api/agent/reset', async (c) => {
      const scope = (((await c.req.json().catch(() => ({}))) ?? {}) as { scope?: unknown }).scope ?? HOME_CHAT;
      if (!isChatScope(scope)) return c.json({ error: 'That is not a chat.' }, 400);
      try {
        this.service().agent.reset(userOf(c), scope);
      } catch (e) {
        return fail(c, e);
      }
      return c.json({ ok: true });
    });

    app.post('/api/agent/turn', async (c) => this.turn(c));

    app.get('/api/settings/assistant', (c) => c.json({ settings: this.service().settings.get(userOf(c)) }));

    // The agent's definition (agents.md §6): read by anyone the object answers (its owner); set the same way. The default
    // name is the one the route gives on the first request (the directory's "<name>'s assistant").
    app.get('/api/agent/definition', (c) => c.json({ definition: this.definition() }));
    // The assistant's mail allowlist (agents.md §1.1): only the senders the person adds; empty, its mailbox is never checked.
    app.get('/api/agent/mail-allowlist', async (c) => c.json({ senders: await this.mailAllowlist() }));
    app.put('/api/agent/mail-allowlist', async (c) => {
      const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { senders?: unknown };
      const { cleanAllowlist } = await import('../imap/allowlist');
      const senders = cleanAllowlist(body.senders);
      this.setState('mail_allowlist', JSON.stringify(senders));
      return c.json({ senders });
    });
    app.put('/api/agent/definition', async (c) => {
      const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { name?: unknown; instructions?: unknown };
      if (body.name !== undefined && typeof body.name !== 'string') return c.json({ error: 'name: a string' }, 400);
      if (body.instructions !== undefined && typeof body.instructions !== 'string') return c.json({ error: 'instructions: a string' }, 400);
      if (typeof body.instructions === 'string' && body.instructions.length > MAX_INSTRUCTIONS) return c.json({ error: `instructions: at most ${MAX_INSTRUCTIONS} characters` }, 400);
      return c.json({ definition: this.setDefinition(body as { name?: string; instructions?: string }) });
    });

    app.put('/api/settings/assistant', async (c) => {
      const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Partial<AssistantSettingsUpdate>;
      const checks = this.keyChecks();
      try {
        return c.json({ settings: await this.service().settings.update(userOf(c), body, checks.key, checks.search) });
      } catch (e) {
        if (e instanceof SettingsError) return c.json({ error: e.message }, 400);
        throw e;
      }
    });

    app.notFound((c) => c.json({ error: 'Not found' }, 404));
    app.onError((err, c) => {
      console.error(`[assistant] ${c.req.method} ${new URL(c.req.url).pathname}: ${err.stack ?? err.message}`);
      return c.json({ error: 'Something went wrong on the server' }, 500);
    });
  }

  /** A file chat's name and root, from the Docs object of the account's organization (its /api/places). */
  private async placeOfFile(scope: string, who: Who): Promise<{ title: string; place?: DocsPlace } | null> {
    if (!isFileId(scope)) return null;
    const docs = this.docsFetch(who.caller.account.organizationId || who.caller.organizationId!, who);
    if (!docs) return null;
    const res = await docs(`/api/places/${encodeURIComponent(scope)}`);
    return res.ok ? ((await res.json()) as { title: string; place?: DocsPlace }) : null;
  }

  /** Runs or resumes a turn, streaming AgentEvents as server-sent events (as the Docs server's /api/agent/turn did). */
  private async turn(c: C): Promise<Response> {
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as AgentTurnRequest;
    const userId = conversationUserOf(c);
    const { agent } = this.service();
    try {
      agent.checkTurn(userId, body);
    } catch (e) {
      if (e instanceof AgentError) return c.json({ error: e.message }, e.status as 400);
      throw e;
    }
    // The root the server tools work in (Docs' server/scope.ts): a file's chat, that file's (an organization file's chat
    // lists and makes Organization files); any other chat, the person's own files in the account's organization.
    const organizationId = c.env.who.caller.account.organizationId || c.env.who.caller.organizationId!;
    const chat = body.scope ?? chatScope(body.context);
    const place = (chat !== HOME_CHAT ? (await this.placeOfFile(chat, c.env.who))?.place : undefined) ?? { workspace: organizationId, shared: false };
    // The files the turn works in are its actor's: the person, or the shared agent itself (never its asker's).
    const scope = { ownerId: c.env.who.docs.userId!, workspaceId: place.workspace, private: !place.shared };

    const abort = new AbortController();
    const encoder = new TextEncoder();
    let out!: ReadableStreamDefaultController<Uint8Array>;
    let open = true;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => { out = controller; },
      // The browser stopped the request (Stop button, navigation): abort the model call too.
      cancel: () => { open = false; abort.abort(); },
    });
    const emit = (e: AgentEvent) => {
      if (open) out.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
    };
    const who = c.env.who;
    this.turnWho.set(userId, who);
    const done = agent
      .runTurn(userId, body, emit, abort.signal, { scope, viewer: who.docs.userId! })
      .catch((e) => {
        if (abort.signal.aborted) return;
        console.error(`[assistant] turn failed: ${(e as Error)?.stack ?? e}`);
        emit({ type: 'error', message: agentErrorMessage(e) });
      })
      .finally(() => {
        if (this.turnWho.get(userId) === who) this.turnWho.delete(userId);
        if (!open) return;
        open = false;
        out.close();
      });
    this.ctx.waitUntil(done);
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' } });
  }

  // ---- the one-time move from the Docs objects (routes/admin.ts, POST /v1/admin/assistant/migrate) ----------------------

  /** A page of every table's rows (or the one named), to compare a move with its source. */
  exportRows(opts: { table?: string; offset?: number; limit?: number } = {}): { table: string; rows: ImportRow[] }[] {
    return exportTables(this.sql, ASSISTANT_TABLES, opts);
  }

  /** Settings or usage rows from a Docs object, keeping any already here (`INSERT OR IGNORE`: the move can run again). */
  importRows(table: string, rows: ImportRow[]): { added: number } {
    if (!(IMPORTED as readonly string[]).includes(table)) throw new Error(`not imported whole: ${table}`);
    return importTable(this.sql, ASSISTANT_TABLES, 'assistant_state', table, rows);
  }

  // ---- a person's chats to their account in another organization (routes/admin.ts, POST /v1/admin/accounts/move) ----

  /** A page of one conversation's messages, in their order. */
  conversationMessages(conversationId: string, offset = 0, limit = 200): ImportRow[] {
    return this.sql.exec('SELECT * FROM agent_messages WHERE conversation_id = ? ORDER BY id LIMIT ? OFFSET ?', conversationId, Math.max(1, Math.min(limit, 1000)), Math.max(0, offset)).toArray() as ImportRow[];
  }

  /** Which of these rows are here: conversations by id, usage by (user, day), settings by user. */
  presentRows(want: MovedChats): MovedChats {
    const has = (q: string, ...a: string[]) => this.sql.exec(q, ...a).toArray().length > 0;
    return {
      conversations: want.conversations.filter((id) => has('SELECT 1 FROM agent_conversations WHERE id = ?', id)),
      usage: want.usage.filter((u) => has('SELECT 1 FROM agent_usage WHERE user_id = ? AND day = ?', u.user_id, u.day)),
      settings: want.settings.filter((userId) => has('SELECT 1 FROM assistant_settings WHERE user_id = ?', userId)),
    };
  }

  /** The moved rows taken away (a conversation with its messages): how many of each. */
  pruneMoved(rows: MovedChats): Record<string, number> {
    const gone = (q: string, ...a: string[]) => this.sql.exec(`${q} RETURNING 1`, ...a).toArray().length;
    return this.ctx.storage.transactionSync(() => {
      const n = { conversations: 0, messages: 0, agent_usage: 0, assistant_settings: 0 };
      for (const id of rows.conversations) {
        n.messages += gone('DELETE FROM agent_messages WHERE conversation_id = ?', id);
        n.conversations += gone('DELETE FROM agent_conversations WHERE id = ?', id);
      }
      for (const u of rows.usage) n.agent_usage += gone('DELETE FROM agent_usage WHERE user_id = ? AND day = ?', u.user_id, u.day);
      for (const userId of rows.settings) n.assistant_settings += gone('DELETE FROM assistant_settings WHERE user_id = ?', userId);
      return n;
    });
  }

  /**
   * One conversation and its messages, in their order, from a Docs object: added once, whole; one already here is left
   * as it is (a second run adds nothing). The messages get this object's ids, as several Docs objects' would collide.
   */
  importChat(conversation: ImportRow, messages: ImportRow[]): { added: boolean; messages: number } {
    const id = String(conversation.id);
    if (this.sql.exec('SELECT 1 FROM agent_conversations WHERE id = ?', id).toArray().length) return { added: false, messages: 0 };
    const c = conversation as Record<string, unknown>;
    return this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        'INSERT INTO agent_conversations (id, user_id, created_at, ended_at, pending, driver, session_id, scope, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, c.user_id as string, c.created_at as string, (c.ended_at ?? null) as string | null, (c.pending ?? null) as string | null, (c.driver ?? null) as string | null,
        (c.session_id ?? null) as string | null, (c.scope ?? null) as string | null, (c.workspace_id ?? null) as string | null,
      );
      const ordered = [...messages].sort((a, b) => Number(a.id) - Number(b.id));
      for (const m of ordered) {
        this.sql.exec('INSERT INTO agent_messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)', id, m.role as string, m.content as string, m.created_at as string);
      }
      return { added: true, messages: ordered.length };
    });
  }
}

/** A chat's root as Docs' place: its organization and whether it is the organization's files; null outside any. */
function placeOf(scope: ScopeArg): DocsPlace | null {
  const s = scopeOf(scope);
  return s.workspaceId ? { workspace: s.workspaceId, shared: !s.private } : null;
}
