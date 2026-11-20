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
import { subscriptionsAs } from '../events/subscriptions';
import type { EventToolContext } from '../events/eventTools';
import { DurableObject } from 'cloudflare:workers';
import { Hono, type Context } from 'hono';
import { mailApprovalPath, type AccountDTO, type AgentJobDTO, type HostedRuntimeDTO, type MailApprovalDTO, type UserDTO } from '@flow/shared';
import type { CallerContext } from '../org/routes/compat';
import type { ImportRow } from '../importing';
import { exportTables, importTable, ownerMismatch, ownerRefusal } from '../perAccount';
import { calendarRequest, type AccountCaller } from '../calendar/forward';
import type { CalendarToolContext } from '../calendar/calendarTools';
import { FREEFLOW_SENDER, MailToolError, prepareFreeflowMail, prepareMail, sendPrepared, type DraftInput, type MailToolContext, type PreparedMail } from '../imap/mailTools';
import { parseAddress } from '../imap/mailText';
import { memberAddress } from '../contacts/email';
import { sendMail, type MailEnv } from '../mail';
import { MAIL_APPROVALS_DDL, MailApprovals, type NewApproval } from './mailApprovals.ts';
import { appToolContexts } from '../apps';
import { runnerOf } from '../registry';
import { mailWakeSubscription } from './mailWake.ts';
import { withDocsContext, type DocsContext } from '@flow/docs/server/runtime/workerd/context.ts';
import type { Caller as DocsCaller } from '@flow/docs/server/runtime/workerd/http.ts';
import { DatabaseSync } from '@flow/docs/server/runtime/workerd/sqlite.ts';
import type { AgentService, ModelCall } from '@flow/docs/server/agent/agent.ts';
import { AssistantSettingsStore, SettingsError, type KeyCheck, type SearchKeyCheck } from '@flow/docs/server/agent/settings.ts';
import { ORG_ROW, OrgModelSettings, orgModelKey, type OrgModel } from './orgModel';
import { appToolsFor, runAppTool, type AppToolCaller } from '../registry/userApps';
import type { AppToolOffer } from '@flow/docs/shared/agent/protocol.ts';
import type { AssistantSettings } from '@flow/shared/assistant';
import { isFileId } from '@flow/docs/server/ids.ts';
import { scopeOf, type ScopeArg } from '@flow/docs/server/scope.ts';
import { chatScope, HOME_CHAT, isChatScope, type AgentContext, type AgentDefinition, type AgentEvent, type AgentTurnRequest, type AssistantSettingsUpdate, type ClientToolCall, type ClientToolResult } from '@flow/docs/shared/agent/protocol.ts';
import { ASSISTANT_CHAT_TOOLS } from './chatTools.ts';
import type { McpRequestCaller } from '../docs/mcp.ts';
import { ADMIN_GUIDANCE, AdminToolError, type AdminToolContext } from './adminTools.ts';
import { MEMORY_DDL, MemoryError, MemoryStore, type MemoryScope } from './memory.ts';
import type { Org } from '../org/object';
import type { DocsFetch, DocsPlace } from './docsTools.ts';

/** agentLib.ts, loaded by the first object made (the constructor waits for it before any request); see that file for why. */
let lib!: typeof import('./agentLib.ts');
const loadLib = async () => { lib ??= await import('./agentLib.ts'); };

export type { DocsCaller };

export interface AssistantEnv {
  /** Seals the settings' API keys, as it did in the Docs object (connectors/secrets.ts), so moved keys still open. */
  FLOW_DATA_KEY?: string;
  FLOW_WEB_URL?: string;
  /** The platform's own model key: with it, "the built-in model" is a choice; without it, the organization must set one. */
  /** Local development only (scripts/dev-suite.mjs sets DEV_ADOPT_MODEL_KEYS): an organization with no model chosen yet
   * takes the first of these keys from .dev.vars, Anthropic's, then OpenAI's, then OpenRouter's. Production never sets it. */
  DEV_ADOPT_MODEL_KEYS?: string;
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
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
/** How often a Chat turn says it is still at work (Chat drops a typing event after 5 s). */
const TYPING_EVERY_MS = 3_000;
/** Most times a headless turn goes back to the model after running the tools it paused on (each round is up to the loop's own steps). */
const MAX_HEADLESS_ROUNDS = 8;
/** Most of a headless Docs tool's answer the model is given. */
const MAX_HEADLESS_RESULT = 60_000;

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
  // The agent's memory (agents.md §6.1, memory.ts).
  MEMORY_DDL,
  // Email waiting for the person's click (mailApprovals.ts).
  MAIL_APPROVALS_DDL,
];
/** Every table, for exportRows. */
export const ASSISTANT_TABLES = ['agent_conversations', 'agent_messages', 'agent_usage', 'assistant_settings', 'assistant_state', 'agent_memory_files', 'mail_approvals'] as const;
/** The tables importRows takes whole; a conversation comes with its messages (importChat). */
const IMPORTED = ['agent_usage', 'assistant_settings'] as const;

/** The rows of a move between accounts (pruneMoved, presentRows): conversations by id, usage by (user, day), settings by user. */
export interface MovedChats { conversations: string[]; usage: { user_id: string; day: string }[]; settings: string[] }

/** Who is asking, per request: the caller context (the account) and the same person as the Docs object's caller. */
/** `conversationUser`: whose conversation a request is in; the agent's own identity when it is not the caller's (a shared agent asked by a person). */
/** `asker`: the person a shared agent's turn is for, where the conversation is not named after them (a Chat turn). */
interface Who { caller: AccountCaller; docs: DocsCaller; conversationUser?: string; asker?: string }
type Bindings = { who: Who };
type C = Context<{ Bindings: Bindings }>;

/** No organization model and no platform key (operator ruling 2026-11-11: one model per organization). */
const NO_MODEL = 'No model is set for this organization yet. An owner or admin chooses one in Organization settings → Agents.';

/** What the panel is told of a failed turn (the Docs server's agentErrorMessage, as it was). */
function agentErrorMessage(e: unknown): string {
  if (e instanceof lib.AgentError || e instanceof lib.OwnKeyError || e instanceof lib.OpenRouterError) return e.message;
  const openai = lib.openaiErrorMessage(e);
  if (openai) return openai;
  if (e instanceof lib.Anthropic.RateLimitError) return 'The assistant is getting too many requests right now. Try again in a minute.';
  if (e instanceof lib.Anthropic.AuthenticationError) return 'The assistant is not configured correctly on this server (API key).';
  if (e instanceof lib.Anthropic.APIError && e.status && e.status >= 500) return 'The AI service had a problem. Try again in a moment.';
  if (e instanceof lib.Anthropic.AnthropicError && /api ?key|authentication/i.test(e.message)) return NO_MODEL;
  // The SDK made with no key at all says so before any request.
  if (e instanceof Error && /resolve authentication method/i.test(e.message)) return NO_MODEL;
  return 'Something went wrong while the assistant was working. Try again.';
}

/** The most a definition's instructions may run to. */
const MAX_INSTRUCTIONS = 8_000;

/**
 * The definition as prompt lines (prompt.ts `systemPrompt`'s guidance): who the agent is, by the name members see it under
 * (`name`, the directory's, else the definition's), and the instructions, one block marked as the owner's.
 */
export function definitionGuidance(d: AgentDefinition, name: string = d.name): string[] {
  const text = d.instructions.trim();
  const who = name.trim() || d.name;
  return [
    `- Your name is ${who}. You are an AI agent in FreeFlow, and people know you by this name in Chat, Mail and the assistant panel. When someone asks who or what you are, you are ${who}: never call yourself by the name of the model you run on or the company that made it (such as ChatGPT, GPT, Claude, OpenAI or Anthropic).`,
    ...(text ? [`- Instructions from the person or organization this agent belongs to, which you follow within the rules above:\n${text}`] : []),
  ];
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
  /** The turns no page runs, by conversation: where send_email tells the person (their DM with the agent in Chat). */
  private readonly headlessTurns = new Map<string, { organizationId: string; agentUserId: string }>();
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
    void ctx.blockConcurrencyWhile(loadLib);
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
    const d = this.definition();
    const admin = this.isAdminAgent() ? ADMIN_GUIDANCE : [];
    this.guidanceLines.splice(0, this.guidanceLines.length, ...lib.SUITE_GUIDANCE, ...admin, ...definitionGuidance(d, this.state('definition_default_name') ?? d.name), ...this.mailboxGuidance());
    return this.guidanceLines;
  }

  /**
   * What the agent is told of its own mailbox (agents.md §1.1): its address, who may mail it, and that its mail tools reach
   * it. Nothing for an agent with no address (an external personal agent, the admin agent).
   */
  private mailboxGuidance(): string[] {
    const address = this.state('agent_address');
    if (!address) return [];
    if (this.state('agent_mode') !== 'personal') {
      return [`- Your own email address is ${address}, with its own mailbox and calendar. The mail tools work on your mailbox: search_mail and read_mail read the mail sent to you.`];
    }
    const answering = this.state('mail_auto_reply') === '1'
      ? 'and you answer that mail yourself, by email'
      : 'and you do not answer it on your own: you read it when the user asks, or when an automation they made wakes you (the user can turn on answering it in Organization settings → Your assistant)';
    return [
      `- You have your own email address, ${address}, with its own mailbox, separate from the user's. Mail to it reaches you only from the senders the user allows (they set them in Organization settings → Your assistant; until they add one, your mailbox is not read), ${answering}. In the panel and in Chat, your mailbox is one of the mail accounts: list_mail_accounts marks it yours: true, and search_mail and read_mail read it when you name it (account: "${address}"). When the user asks about "your inbox" or mail sent to you, look there; "my inbox" is the user's own accounts.`,
    ];
  }

  /**
   * The agent's own account here (agents.md §1.1): a personal agent's runtime runs its turns as its sponsor, so it learns its
   * own account to reach its mailbox, and its address for its prompt. Looked up again at most every ten minutes.
   */
  private async learnAgentAccount(accountId: string | undefined, mode: 'personal' | 'shared'): Promise<void> {
    if (!accountId) return;
    const at = Number(this.state('agent_account_at') ?? 0);
    if (this.state('agent_account_id') === accountId && this.state('agent_mode') === mode && Date.now() - at < 10 * 60_000) return;
    const account = await this.directory<AccountDTO | null>('accountById', accountId).catch(() => null);
    if (!account) return;
    const before = `${this.state('agent_address') ?? ''}|${this.state('agent_mode') ?? ''}`;
    this.setState('agent_account_id', accountId);
    this.setState('agent_mode', mode);
    this.setState('agent_address', account.address ?? '');
    this.setState('agent_account_at', String(Date.now()));
    if (before !== `${account.address ?? ''}|${mode}`) this.refreshGuidance();
  }

  /**
   * A personal agent's own mailbox (agents.md §1.1), when the turn runs as its sponsor: the agent's Mail object, as the
   * agent's account. Null for a shared agent (its turns already run as itself) and an agent with no address.
   */
  private async ownMailbox(caller: AccountCaller): Promise<{ fetch: (path: string, init?: RequestInit) => Promise<Response>; ids: Set<string>; accounts: Record<string, unknown>[] } | null> {
    const id = this.state('agent_account_id'), ns = this.env.MAIL;
    if (!ns || !id || !this.state('agent_address') || id === caller.account.id) return null;
    const account = await this.directory<AccountDTO | null>('accountById', id).catch(() => null);
    if (!account || account.state === 'removed' || account.state === 'suspended' || account.organizationId !== caller.account.organizationId) return null;
    const user = await this.directory<UserDTO | null>('getUser', account.principalId, account.principalId).catch(() => null);
    if (!user) return null;
    const asAgent = { user, token: '', authKind: 'agent' as const, ip: '', organizationId: account.organizationId, account } as unknown as CallerContext;
    const stub = ns.get(ns.idFromName(account.id));
    const fetch = (path: string, init?: RequestInit) => stub.handle(new Request(`${this.origin}${path}`, init), asAgent);
    const res = await fetch('/v1/mail/accounts');
    const accounts = res.ok ? (((await res.json()) as { accounts?: Record<string, unknown>[] }).accounts ?? []) : [];
    return { fetch, ids: new Set(accounts.map((a) => String(a.id))), accounts };
  }

  /** The turn's caller as an installed app sees it (user-apps.md §5): its account, and the agent it acts through. */
  private appCallerOf(who: Who | null): AppToolCaller | null {
    const c = who?.caller;
    if (!c?.account) return null;
    return {
      organizationId: c.account.organizationId, account: c.account, userId: c.user?.id ?? who!.docs.userId ?? c.account.principalId,
      displayName: c.user?.displayName ?? c.account.displayName, via: c.via ?? null, invokedBy: c.invokedBy ?? null,
    };
  }

  /** The installed apps' tools this turn's caller may use (user-apps.md §3.3), for the turn's context. */
  private async appToolOffers(who: Who | null): Promise<AppToolOffer[]> {
    const caller = this.appCallerOf(who);
    const ORG = this.env.ORG;
    if (!caller || !ORG) return [];
    return (await appToolsFor({ ORG }, caller, 'assistant')).map((d) => ({ name: d.name, description: d.description, input: d.input as unknown as Record<string, unknown> }));
  }

  /** This runtime is the organization's admin agent's (agents.md §1.4): its panel turns get the admin tools. */
  private isAdminAgent(): boolean {
    return this.state('agent_role') === 'admin';
  }

  /** Marks this runtime as the admin agent's (once, when the Org object makes it), and its prompt says so from then on. */
  private learnRole(role: 'admin' | undefined): void {
    if (role !== 'admin' || this.isAdminAgent()) return;
    this.setState('agent_role', 'admin');
    this.refreshGuidance();
  }

  /**
   * The admin agent's way into the /v1 routes (adminTools.ts), as the owner or admin who asked for the turn: their token,
   * so each route checks their role, and the agent as `via`, so the Event log reads "Scott, via Carl". Undefined for any
   * other runtime, and for a turn no person asked for (a wake job carries no token).
   */
  private adminContext(who: Who | null): AdminToolContext | undefined {
    const caller = who?.caller;
    if (!this.isAdminAgent() || !caller?.user || !caller.token || !caller.invokedBy) return undefined;
    const token = caller.token, via = caller.user.id, organizationId = caller.account.organizationId;
    const origin = this.origin;
    return {
      organizationId,
      call: async (method, path, body) => {
        const req = new Request(`${origin}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        const res = await this.workerFetch(req, via);
        const text = await res.text();
        let json: unknown = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = text; }
        if (!res.ok) {
          const err = (json as { error?: { message?: string } | string } | null)?.error;
          throw new AdminToolError(typeof err === 'string' ? err : err?.message ?? `The request failed (${res.status}).`);
        }
        return json ?? { ok: true };
      },
    };
  }

  /** The agent's name as the directory knows it, which members see (agents.md §6): kept, and put in the prompt when it changes. */
  private learnName(name: string | undefined): void {
    if (!name || this.state('definition_default_name') === name) return;
    this.setState('definition_default_name', name);
    this.refreshGuidance();
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
    // A new name is the directory's too (the routes rename both), so the prompt takes it at once.
    if (d.name !== undefined) this.setState('definition_default_name', next.name);
    this.refreshGuidance();
    return next;
  }

  setState(key: string, value: string): void {
    this.sql.exec('INSERT INTO assistant_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
  }

  /**
   * A request to this Worker's own routes, in this isolate, with `via` on the env (routes/auth.ts resolveCaller reads it):
   * the admin agent's tools. The module is the Worker's entry, imported when first needed. Tests give a stand-in.
   */
  protected async workerFetch(req: Request, via: string): Promise<Response> {
    const { default: worker } = await import('../index');
    const ctx = { waitUntil: (p: Promise<unknown>) => this.ctx.waitUntil(p), passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
    return worker.fetch(req, { ...(this.env as object), ADMIN_AGENT_VIA: via } as never, ctx);
  }

  /** The model loop's own model call (null: Claude on the Worker's key). Tests give a scripted one. */
  protected model(): ModelCall | null {
    return null;
  }

  /** How a key is checked before Settings saves it (the provider's API). Tests give one that answers at once. */
  protected keyChecks(): { key: KeyCheck; search: SearchKeyCheck } {
    return { key: lib.checkAssistantKey, search: lib.checkBraveKey };
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
    const agent = new lib.AgentService(new lib.AgentStore(db as never), null as never, settings, {
      jobs: false,
      ...(model ? { model } : {}),
      // The suite's assistant (docs/assistantTools.ts): the pages of every app, its tools' environment, its prompt lines.
      pages: lib.ASSISTANT_PAGES,
      // The definition's instructions (agents.md §6) ride with the suite's guidance; a change remakes the service.
      guidance: this.refreshGuidance(),
      extend: (userId: string, scope: ScopeArg) => {
        // The turn's own caller (a concurrent request or wake job may have come in since it started).
        const who = this.turnWho.get(userId) ?? this.who;
        const place = placeOf(scope);
        const docsFetch = place ? this.docsFetch(place.workspace, who) : undefined;
        const docs = place && docsFetch ? lib.docsToolContext(docsFetch, place, this.origin) : undefined;
        const mail = this.mailContext(scope, who);
        // Calendar's shared calendars go by the channels of whom the turn runs as: the agent's own, not its asker's.
        const calendar = this.calendarContext(who?.docs.userId ?? userId, who);
        // The apps added by manifest (apps.ts): their objects, as the account this object belongs to.
        const apps = appToolContexts(this.env, async () => who?.caller ?? null, this.origin);
        const memory = new MemoryStore(this.sql, this.memoryScope(userId, who));
        const admin = this.adminContext(who);
        // Automations (onboarding.md §4): a person's own assistant makes and lists them as the person; a shared agent none.
        const events = who && personalTurn(who) ? this.eventsContext(who) : undefined;
        // send_email (mailApprovals.ts): a personal agent's, as its person; a shared agent sends none.
        const mailApproval = mail && who && personalTurn(who) ? (input: DraftInput) => this.requestMailApproval(input, mail, who, userId) : undefined;
        // The installed apps' tools (user-apps.md §5), as the turn's caller: the Org object checks the scopes again.
        const appCaller = this.appCallerOf(who);
        const ORG = this.env.ORG;
        const userApps = appCaller && ORG ? (name: string, input: Record<string, unknown>) => runAppTool({ ORG }, appCaller, name, input) : undefined;
        return { ...(docs ? { docs } : {}), ...(mail ? { mail } : {}), ...(calendar ? { calendar } : {}), ...(apps ? { apps } : {}), ...(admin ? { admin } : {}), ...(mailApproval ? { mailApproval } : {}), ...(userApps ? { userApps } : {}), ...(events ? { events } : {}), memory };
      },
      // The agent's memory files, listed at the start of each request (agents.md §6.1, loading).
      notes: (userId: string) => new MemoryStore(this.sql, this.memoryScope(userId, this.turnWho.get(userId) ?? this.who)).listing(),
    });
    return (this.services = { agent, settings });
  }

  /**
   * Whose memory a turn sees (agents.md §6.1). A personal agent acts `via` itself as its sponsor: one tree. Otherwise it is a
   * shared agent: its team folder, and the `you` folder of the person who asked (`invokedBy`, the conversation's user). A
   * turn mail or a wake job started is someone else's content: what it writes is marked external.
   */
  memoryScope(userId: string, who: Who | null): MemoryScope {
    const caller = who?.caller;
    const shared = !!caller && !caller.via;
    const external = userId.startsWith('auto:') || userId.startsWith('mail:');
    return { shared, asker: shared && caller?.invokedBy ? (who?.asker ?? who?.conversationUser ?? userId) : null, external };
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
    // A personal agent's own mailbox sits beside its sponsor's accounts (agents.md §1.1): listed with them, marked
    // `yours`, and a request for one of its accounts goes to the agent's Mail object.
    const mail = async (path: string, init?: RequestInit): Promise<Response> => {
      const own = await this.ownMailbox(caller);
      const named = /^\/v1\/mail\/accounts\/([^/?]+)/.exec(path)?.[1];
      if (own && named && own.ids.has(decodeURIComponent(named))) return own.fetch(path, init);
      const res = await stub.handle(new Request(`${this.origin}${path}`, init), caller);
      if (!own || !own.accounts.length || path !== '/v1/mail/accounts' || (init?.method ?? 'GET') !== 'GET' || !res.ok) return res;
      const theirs = ((await res.json()) as { accounts?: Record<string, unknown>[] }).accounts ?? [];
      return Response.json({ accounts: [...theirs, ...own.accounts.map((a) => ({ ...a, yours: true }))] });
    };
    return {
      mail,
      origin: this.origin,
      ...(docs && place
        ? {
            saveToDocs: async (bytes: Buffer, filename: string) => {
              const made = await lib.importToDocs(docs, place, bytes, filename);
              const s = made.sheet;
              // With its page in the suite: the user in Mail gets a link, not a guess (docsTools.ts docsPageUrl).
              const file = s
                ? { id: s.id, kind: s.kind, title: s.title, [s.kind === 'deck' ? 'deck_id' : s.kind === 'sheet' ? 'sheet_id' : 'doc_id']: s.id, url: lib.docsPageUrl(this.origin, place, 'sheet', s.id, s.kind) }
                : { id: made.file.id, kind: 'file', file_id: made.file.id, filename: made.file.filename, type: made.file.type, url: lib.docsPageUrl(this.origin, place, 'file', made.file.id) };
              return { file, warnings: made.warnings };
            },
          }
        : {}),
    };
  }

  /** The event tools' context (events/eventTools.ts) as the turn's person: their subscriptions, as the HTTP routes make them. */
  private eventsContext(who: Who): EventToolContext | undefined {
    const { EVENTS, ORG } = this.env;
    const c = who.caller;
    if (!EVENTS || !ORG || !c.user || !c.account) return undefined;
    const org = c.account.organizationId;
    return { subscriptions: subscriptionsAs(EVENTS.get(EVENTS.idFromName(org)), ORG.get(ORG.idFromName(org)) as never, c.account.id, c.user.id, c.account.role, org) };
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
  async handle(request: Request, caller: CallerContext, docs: DocsCaller, agentName?: string, opts: { conversationUser?: string; agentRole?: 'admin'; agentAccountId?: string; agentMode?: 'personal' | 'shared' } = {}): Promise<Response> {
    const wrong = ownerMismatch(this, caller, 'the Assistant');
    if (wrong) { console.error(`[assistant] ${wrong}`); return ownerRefusal(wrong); }
    if (caller.organizationId) await this.useOrgModel(caller.organizationId);
    // The agent's name as the directory knows it (agents.md §6), the definition's default until the person sets one.
    this.learnName(agentName);
    this.learnRole(opts.agentRole);
    await this.learnAgentAccount(opts.agentAccountId, opts.agentMode ?? 'personal');
    const who: Who = { caller: caller as AccountCaller, docs, ...(opts.conversationUser ? { conversationUser: opts.conversationUser } : {}) };
    this.who = who;
    return withDocsContext(this.context, () => this.app.fetch(request, { who } satisfies Bindings));
  }

  /**
   * A hosted shared agent's runtime, claimed for the agent's account when the Admin app makes the agent (agents.md §6): the
   * owner keys the first request would set, and the definition's name. Idempotent.
   */
  async adopt(account: AccountDTO, name: string, role?: 'admin'): Promise<AgentDefinition> {
    const wrong = ownerMismatch(this, { user: null, account, organizationId: account.organizationId }, 'the agent runtime');
    if (wrong) throw new Error(wrong);
    this.learnName(name);
    this.learnRole(role);
    return this.definition();
  }

  /** A hosted agent's definition, set from the Admin app (agents.md §6): the runtime remakes its loop for the next turn. */
  async updateDefinition(d: { name?: string; instructions?: string }): Promise<AgentDefinition> {
    return this.setDefinition(d);
  }

  /** The agent's memory files a person may see (agents.md §6.1, the Memory tab), by the scope the route worked out. */
  async memoryFiles(scope: MemoryScope): Promise<{ path: string; body: string; trust: string; updatedAt: string }[]> {
    return new MemoryStore(this.sql, scope).files();
  }

  /** A person's edit of one memory file from the Memory tab: the answer is null, or the refusal to show. */
  async memoryPut(scope: MemoryScope, path: string, body: string): Promise<string | null> {
    try { new MemoryStore(this.sql, scope).put(path, body); return null; } catch (e) { if (e instanceof MemoryError) return e.message.replace(/^Error: /, ''); throw e; }
  }

  /** A person's delete from the Memory tab: one file, or everything this scope sees. Returns how many went. */
  async memoryRemove(scope: MemoryScope, path?: string): Promise<number> {
    try { return new MemoryStore(this.sql, scope).remove(path); } catch (e) { if (e instanceof MemoryError) return 0; throw e; }
  }

  async currentDefinition(): Promise<AgentDefinition> {
    return this.definition();
  }

  /**
   * A wake job for the hosted agent this object runs (agents.md §6), handed over by the organization's Events object: the
   * job is acked, the prompt run as a headless turn with every tool the agent may use (runHeadless), the answer posted in
   * the job's channel as the agent (a personal agent: as its sponsor, marked `via`), and the job stepped to done. Each job
   * runs in a new conversation of its subscription's own (`auto:<subscription>`), apart from the person's chats.
   */
  async wake(p: { organizationId: string; job: AgentJobDTO; runtime: HostedRuntimeDTO }): Promise<void> {
    this.learnName(p.runtime.agentName);
    await this.learnAgentAccount(p.runtime.agentAccountId, p.runtime.mode);
    await this.useOrgModel(p.organizationId);
    const { job, runtime, organizationId } = p;
    const events = this.env.EVENTS?.get(this.env.EVENTS.idFromName(organizationId));
    const step = (s: 'ack' | 'done', opts: { ok?: boolean; note?: string } = {}) => events?.jobStep(job.id, job.agent, s, opts).catch((err: Error) => console.error(`[assistant] job ${job.id} ${s}: ${err.message}`));
    // A job delivered again while this runtime still runs it (a lease that lapsed): leave it to the run in progress.
    if (this.runningJobs.has(job.id)) return console.log(`[assistant] job ${job.id}: already running here`);
    const acked = await step('ack');
    if (acked && 'conflict' in acked) return console.log(`[assistant] job ${job.id}: not taken, it is ${acked.conflict}`);
    this.runningJobs.add(job.id);
    const org = this.orgStub(organizationId);
    let note = '';
    let ok = false;
    // A job whose output step mails the answer back (assistant/mailWake.ts): the email it answers, and its sender's mailbox.
    let mail: { from: string; subject: string; body: string; messageId: string | null } | null = null;
    const mailbox = runtime.agentAccountId && this.env.MAIL ? this.env.MAIL.get(this.env.MAIL.idFromName(runtime.agentAccountId)) : null;
    const reSubject = (s: string) => (/^re:/i.test(s) ? s : `Re: ${s}`);
    try {
      const sub = events ? await Promise.resolve().then(() => events.getSubscription(job.subscriptionId)).catch(() => null) : null;
      const replyByMail = sub?.action?.kind === 'wake' && sub.action.reply === 'mail' && runtime.mode === 'personal';
      let conversation = `auto:${job.subscriptionId}`;
      const { who, user, actorAccountId } = await this.actorOf(runtime, organizationId, conversation, 'the agent runtime');
      // The brief (events/core.ts wakeBrief) says an automation woke the agent and for which event; a mail reply job's
      // turn is framed by its own prompt and the email below it instead.
      let prompt = replyByMail ? job.prompt : ((await Promise.resolve().then(() => events?.jobBrief(job.id, job.agent)).catch(() => null)) ?? job.prompt);
      if (replyByMail) {
        mail = await this.triggeringMail(job, organizationId, who.caller);
        if (!mail) throw new Error('the email that woke this job is no longer in the mailbox');
        // One conversation per sender, kept across their emails (as the assistant's mail turns always were).
        conversation = `mail:${mail.from.toLowerCase()}`;
        who.conversationUser = conversation;
        prompt = `${job.prompt}\n\nFrom: ${mail.from} (a sender ${user.displayName} allows)\nSubject: ${mail.subject}\n\n${mail.body}`;
      }
      this.requireModel();
      // Each automation's job starts a new conversation: an earlier run's answer ("the mail tools are unavailable") must not
      // stand in for trying again. What an automation should keep across runs goes in its memory files. Old runs are kept.
      if (!replyByMail) withDocsContext(this.context, () => this.service().agent.reset(conversation));
      const { text } = await this.runHeadless({
        organizationId, runtime, conversation, who, timezone: user.timezone, context: { page: 'home', headless: true },
        first: { message: prompt }, stamp: { depth: job.depth + 1, causedBy: job.id },
      });
      if (mail && text && mailbox) {
        const sent = await mailbox.sendAsAssistant({ to: mail.from, subject: reSubject(mail.subject), text, ...(mail.messageId ? { inReplyTo: mail.messageId } : {}) });
        if (!sent.ok) throw new Error(`the answer could not be mailed: ${sent.message ?? 'refused'}`);
      } else if (job.channelId && text && org) {
        await org.postAutomation({ ownerAccountId: actorAccountId, channelId: job.channelId, body: text, clientMsgId: job.id, depth: job.depth + 1, causedBy: job.id, ...(runtime.mode === 'personal' ? { via: runtime.agentId } : {}) });
      }
      ok = true;
      note = text ? text.slice(0, 200) : 'nothing to say';
    } catch (err) {
      note = agentErrorMessage(err).slice(0, 500);
      console.error(`[assistant] job ${job.id}: ${(err as Error)?.stack ?? err}`);
      // The sender is told the assistant could not answer, as a mail turn always did.
      if (mail && mailbox) await mailbox.sendAsAssistant({ to: mail.from, subject: reSubject(mail.subject), text: `Sorry, I could not answer that: ${agentErrorMessage(err).slice(0, 300)}`, ...(mail.messageId ? { inReplyTo: mail.messageId } : {}) }).catch(() => null);
    }
    this.runningJobs.delete(job.id);
    await step('done', { ok, note });
  }

  /**
   * A request to a person's assistant in Chat (agents.md §1.1), handed over by the organization's object: run as a
   * headless turn with the sponsor's access (marked `via` the assistant), in one conversation per thread or DM so its
   * memory of one exchange stays with it, and the answer posted in Chat as the assistant itself. `audience`: whether
   * others read that conversation (a mention in a channel) or only the two of them do.
   */
  async chatTurn(p: { organizationId: string; runtime: HostedRuntimeDTO; channelId: string; threadRootId: string | null; messageId: string; prompt: string; audience?: 'private' | 'shared' }): Promise<void> {
    this.learnName(p.runtime.agentName);
    await this.learnAgentAccount(p.runtime.agentAccountId, p.runtime.mode);
    const run: ChatRun = { organizationId: p.organizationId, runtime: p.runtime, channelId: p.channelId, threadRootId: p.threadRootId, audience: p.audience ?? (p.threadRootId ? 'shared' : 'private') };
    await this.runChat(run, p.messageId, { message: p.prompt });
  }

  /**
   * A member asked a hosted shared agent in Chat (agents.md §1; Org.askSharedAgents). The turn runs as the agent, with its
   * own grants and channels, asked by the member (`invokedBy`), in a conversation of that member's in that channel, with
   * every tool it may use (runHeadless; its Chat tools reach what the agent itself can), and the answer is posted as the agent.
   */
  async sharedChatTurn(p: { organizationId: string; runtime: HostedRuntimeDTO; askerUserId: string; askerAccountId: string; channelId: string; threadRootId: string | null; messageId: string; prompt: string; audience: 'private' | 'shared' }): Promise<void> {
    const { runtime, organizationId } = p;
    if (runtime.mode !== 'shared') return;
    this.learnName(runtime.agentName);
    await this.learnAgentAccount(runtime.agentAccountId, 'shared');
    await this.useOrgModel(organizationId);
    const jobKey = `shared-chat:${p.messageId}`;
    if (this.runningJobs.has(jobKey)) return;
    this.runningJobs.add(jobKey);
    const org = this.orgStub(organizationId);
    const conversation = `chat:${p.channelId}:${p.threadRootId ?? ''}:${p.askerUserId}`;
    let stopTyping: ReturnType<typeof setInterval> | undefined;
    try {
      this.requireModel();
      const { who, user } = await this.actorOf(runtime, organizationId, conversation, 'the shared agent in Chat', { invokedBy: p.askerAccountId, asker: p.askerUserId });
      const typing = () => void org?.agentTyping({ agentUserId: runtime.agentId, channelId: p.channelId, threadRootId: p.threadRootId }).catch(() => undefined);
      typing();
      stopTyping = setInterval(typing, TYPING_EVERY_MS);
      const { text } = await this.runHeadless({
        organizationId, runtime, conversation, who, timezone: user.timezone,
        context: { page: 'chat', channelId: p.channelId, threadRootId: p.threadRootId, audience: p.audience, headless: true },
        first: { message: p.prompt }, stamp: { invokedBy: p.askerAccountId },
      });
      clearInterval(stopTyping);
      if (text) await org?.postAsSharedAgent({ agentUserId: runtime.agentId, channelId: p.channelId, threadRootId: p.threadRootId, body: text, clientMsgId: `shared-agent:${p.messageId}`, invokedBy: p.askerAccountId });
    } catch (err) {
      clearInterval(stopTyping);
      const message = (err as Error).message;
      console.error(`[assistant] shared chat ${p.messageId}: ${message}`);
      await org?.postAsSharedAgent({ agentUserId: runtime.agentId, channelId: p.channelId, threadRootId: p.threadRootId, body: `⚠️ I could not answer that: ${message}`, clientMsgId: `shared-agent-error:${p.messageId}`, invokedBy: p.askerAccountId }).catch(() => undefined);
    } finally {
      this.runningJobs.delete(jobKey);
    }
  }

  /**
   * One run of a Chat conversation's turn (runHeadless, with the sponsor's access): the text the turn wrote is posted as
   * the assistant where it was asked. Its send_message posts go out at once (operator ruling 2026-11-17, R-C).
   */
  private async runChat(run: ChatRun, jobKey: string, first: Pick<AgentTurnRequest, 'message' | 'toolResults'>): Promise<void> {
    await this.useOrgModel(run.organizationId);
    const { runtime, organizationId } = run;
    if (runtime.mode !== 'personal' || !runtime.sponsorId || !runtime.sponsorAccountId) return;
    if (this.runningJobs.has(jobKey)) return;
    this.runningJobs.add(jobKey);
    const org = this.orgStub(organizationId);
    const conversation = chatConversation(run);
    const post = (body: string, clientMsgId: string) => org?.postAsAssistant({ agentUserId: runtime.agentId, channelId: run.channelId, threadRootId: run.threadRootId, body, clientMsgId }) ?? Promise.resolve(null);
    let stopTyping: ReturnType<typeof setInterval> | undefined;
    try {
      this.requireModel();
      const { who, user } = await this.actorOf(runtime, organizationId, conversation, 'the assistant in Chat');
      // "Thinking…" in Chat while the turn runs: a typing event now and every few seconds (the clients drop one after 5 s).
      const typing = () => void org?.agentTyping({ agentUserId: runtime.agentId, channelId: run.channelId, threadRootId: run.threadRootId }).catch(() => undefined);
      typing();
      stopTyping = setInterval(typing, TYPING_EVERY_MS);
      const { text } = await this.runHeadless({
        organizationId, runtime, conversation, who, timezone: user.timezone,
        context: { page: 'chat', channelId: run.channelId, threadRootId: run.threadRootId, audience: run.audience, headless: true },
        first,
      });
      clearInterval(stopTyping);
      if (text) await post(text, `assistant:${jobKey}`);
    } catch (err) {
      clearInterval(stopTyping);
      console.error(`[assistant] chat ${jobKey}: ${(err as Error)?.stack ?? err}`);
      await post(`Sorry, I could not answer that: ${agentErrorMessage(err).slice(0, 300)}`, `assistant:${jobKey}`)?.catch(() => null);
    } finally {
      clearInterval(stopTyping);
      this.runningJobs.delete(jobKey);
    }
  }

  // ---- the one tool loop of every turn with no page open (decision_log 2026-11-17, "Every agent turn runs its tools") ----

  /**
   * Whom a turn of this runtime runs as (agents.md §1): a personal agent's sponsor, marked `via` the agent; a shared agent
   * itself, marked `invokedBy` the member who asked, when one did. The caller context, the same person as the Docs object
   * knows them, and the conversation they are in.
   */
  private async actorOf(runtime: HostedRuntimeDTO, organizationId: string, conversation: string, label: string, opts: { invokedBy?: string; asker?: string } = {}): Promise<{ who: Who; user: UserDTO; actorId: string; actorAccountId: string }> {
    const personal = runtime.mode === 'personal';
    const actorId = personal ? runtime.sponsorId : runtime.agentId;
    const actorAccountId = personal ? runtime.sponsorAccountId : runtime.agentAccountId;
    if (!actorId || !actorAccountId) throw new Error(personal ? 'the agent has no sponsor' : 'the agent has no account');
    const org = this.orgStub(organizationId);
    const [user, account, channelIds] = await Promise.all([
      this.directory<UserDTO>('getUser', actorId, actorId),
      this.directory<AccountDTO | null>('accountById', actorAccountId),
      org ? org.channelIdsOf(actorId) : Promise.resolve([] as string[]),
    ]);
    if (!account) throw new Error(personal ? 'the sponsor has no account' : 'the agent has no account');
    const caller = { user, token: '', authKind: 'agent' as const, ip: '', organizationId, account, ...(personal ? { via: runtime.agentId } : {}), ...(opts.invokedBy ? { invokedBy: opts.invokedBy } : {}) } as AccountCaller;
    const wrong = ownerMismatch(this, caller, label);
    if (wrong) throw new Error(wrong);
    const docs: DocsCaller = { userId: actorId, email: user.email, token: '', ip: '', accountId: account.id, channelIds };
    return { who: { caller, docs, conversationUser: conversation, ...(opts.asker ? { asker: opts.asker } : {}) }, user, actorId, actorAccountId };
  }

  /**
   * A turn no browser runs (agents.md §6, "async turn"): an automation's wake job, a message in Chat, an email. The model
   * loop is offered every tool the agent may use without a page (AgentContext `headless`, assistantTools.ts
   * headlessTools): the server tools run in the loop itself; when the model pauses on the others, they run here
   * (runHeadlessTool) and the loop goes on with their results, up to MAX_HEADLESS_ROUNDS times. Returns what the turn
   * wrote, for the caller to deliver.
   */
  private async runHeadless(t: HeadlessTurn): Promise<{ text: string }> {
    const org = this.orgStub(t.organizationId);
    this.turnWho.set(t.conversation, t.who);
    this.headlessTurns.set(t.conversation, { organizationId: t.organizationId, agentUserId: t.runtime.agentId });
    const context = { ...t.context, appTools: await this.appToolOffers(t.who) };
    try {
      let req = t.first;
      let text = '';
      for (let round = 0; round < MAX_HEADLESS_ROUNDS; round++) {
        const { out, calls } = await withDocsContext(this.context, async () => {
          const { agent } = this.service();
          const abort = new AbortController();
          const timer = setTimeout(() => abort.abort(), WAKE_TURN_MS);
          let out = '';
          let calls: ClientToolCall[] = [];
          let failed: string | null = null;
          try {
            await agent.runTurn(t.conversation, { ...req, context, workspace: t.organizationId, ...(t.timezone ? { timezone: t.timezone } : {}) }, (e) => {
              if (e.type === 'text') out += e.text;
              else if (e.type === 'client_tools') calls = e.calls;
              else if (e.type === 'error') failed = e.message;
            }, abort.signal, { scope: { ownerId: t.who.docs.userId!, workspaceId: t.organizationId, private: true }, viewer: t.who.docs.userId! });
          } finally {
            clearTimeout(timer);
          }
          if (failed) throw new Error(failed);
          return { out, calls };
        });
        text += out;
        if (!calls.length) break;
        const results: ClientToolResult[] = [];
        // One at a time and in order: a post may depend on what a read before it found.
        for (const c of calls) results.push(await this.runHeadlessTool(c, t, org));
        req = { toolResults: results };
      }
      return { text: text.trim() };
    } finally {
      if (this.turnWho.get(t.conversation) === t.who) this.turnWho.delete(t.conversation);
      this.headlessTurns.delete(t.conversation);
    }
  }

  /**
   * One call the loop paused on, run here: Chat's tools through the Org object (as the personal agent's sponsor, or as the
   * shared agent itself), Docs' editing tools headless on the stored file (the Docs object's /mcp door), and anything else,
   * which needs a page, refused with the reason.
   */
  private async runHeadlessTool(c: ClientToolCall, t: HeadlessTurn, org: OrgStub | undefined): Promise<ClientToolResult> {
    if (ASSISTANT_CHAT_TOOLS.has(c.name)) return this.runChatTool(c, t, org);
    if (lib.HEADLESS_DOCS_TOOLS.has(c.name)) return this.runDocsHeadless(c, t);
    return { id: c.id, content: lib.headlessRefusal(c.name), isError: true };
  }

  /** A Chat tool, through the Org object: with the sponsor's reach for a person's assistant, the agent's own for a shared one. */
  private async runChatTool(c: ClientToolCall, t: HeadlessTurn, org: OrgStub | undefined): Promise<ClientToolResult> {
    if (!org) return { id: c.id, content: 'Chat is not reachable here.', isError: true };
    const agentUserId = t.runtime.agentId;
    try {
      if (c.name === 'send_message') {
        const input = c.input as { channelId: string; text: string; threadRootId?: string };
        const posted = await org.assistantPost({ agentUserId, channelId: input.channelId, threadRootId: input.threadRootId ?? null, body: input.text, clientMsgId: `assistant-post:${c.id}`, ...(t.stamp ?? {}) });
        return { id: c.id, content: `Posted in #${posted.channel}${input.threadRootId ? ' (in the thread)' : ''}${posted.joined ? ', after joining it' : ''}.` };
      }
      const op = c.name === 'list_channels' ? 'channels' : c.name === 'read_messages' ? 'read' : c.name === 'search_messages' ? 'search' : 'leave';
      const input = c.input as { channelId?: string; limit?: number; query?: string; sort?: 'relevance' | 'recent' };
      return { id: c.id, content: JSON.stringify(await org.assistantChat({ agentUserId, op, channelId: input.channelId, limit: input.limit, query: input.query, sort: input.sort })) };
    } catch (err) {
      return { id: c.id, content: (err as Error).message, isError: true };
    }
  }

  /**
   * A Docs editing tool with no page open (agents.md §5, "headless"): its /mcp twin, in the organization's Docs object, as
   * whom the turn runs as (the personal agent's sponsor via the agent, or the shared agent itself), on the stored file
   * the call names. The same client code the open editor runs, and a saved revision.
   */
  private async runDocsHeadless(c: ClientToolCall, t: HeadlessTurn): Promise<ClientToolResult> {
    const ns = this.env.DOCS;
    if (!ns) return { id: c.id, content: 'Docs is not reachable here.', isError: true };
    const { caller, docs } = t.who;
    const as: McpRequestCaller = {
      userId: docs.userId!, email: docs.email ?? '', orgId: t.organizationId, accountId: caller.account.id,
      via: caller.via ?? null, invokedBy: caller.invokedBy ?? null, scope: 'files:read files:write', endpoint: '/mcp', origin: this.origin,
    };
    const request = new Request(`${this.origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: c.name, arguments: c.input ?? {} } }),
    });
    try {
      const res = await ns.get(ns.idFromName(t.organizationId)).mcp(request, as);
      const body = (await res.json().catch(() => null)) as { result?: { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean }; error?: { message?: string } } | null;
      if (!body || body.error || !body.result) return { id: c.id, content: body?.error?.message ?? `Docs answered ${res.status}.`, isError: true };
      const text = (body.result.content ?? []).filter((x) => x.type === 'text' && x.text).map((x) => x.text).join('\n') || JSON.stringify(body.result.structuredContent ?? {});
      return { id: c.id, content: text.length > MAX_HEADLESS_RESULT ? `${text.slice(0, MAX_HEADLESS_RESULT)}\n[Result truncated.]` : text, ...(body.result.isError ? { isError: true } : {}) };
    } catch (err) {
      return { id: c.id, content: `Docs could not run ${c.name}: ${(err as Error).message}`, isError: true };
    }
  }

  private orgStub(organizationId: string): OrgStub | undefined {
    const ORG = this.env.ORG;
    return ORG?.get(ORG.idFromName(organizationId));
  }

  /** The senders the sponsor allows to mail their assistant (agents.md §1.1): empty by default, and empty means no mail is read. */
  /** Whether allowlisted mail starts a turn that answers it by email (agents.md §1.1): off unless the sponsor turns it on. */
  async mailAutoReply(): Promise<boolean> {
    return this.state('mail_auto_reply') === '1';
  }

  async mailAllowlist(): Promise<string[]> {
    try { return JSON.parse(this.state('mail_allowlist') ?? '[]') as string[]; } catch { return []; }
  }

  /**
   * Keeps the assistant's answering subscription in step with its settings (assistant/mailWake.ts; decision_log 2026-11-17,
   * R-B): one `wake` subscription on its own mailbox's `mail.received` while "Agent always responds to incoming email" is
   * on and the allowlist names a sender, none otherwise. Asked when the sponsor changes either, and by the assistant's Mail
   * object each time it reads them again (every few minutes while it checks mail), so an assistant that had answering on
   * before this existed gets its subscription on its next check: that is the migration. Idempotent; one at a time.
   */
  async syncMailWake(p: { organizationId: string; agentAccountId?: string | null }): Promise<'on' | 'off'> {
    const run = this.mailWakeSync.then(() => this.syncMailWakeNow(p));
    this.mailWakeSync = run.catch(() => undefined);
    return run;
  }

  private mailWakeSync: Promise<unknown> = Promise.resolve();

  private async syncMailWakeNow(p: { organizationId: string; agentAccountId?: string | null }): Promise<'on' | 'off'> {
    const ns = this.env.EVENTS;
    if (!ns || !p.organizationId) return 'off';
    const events = ns.get(ns.idFromName(p.organizationId));
    const agent = p.agentAccountId || this.state('agent_account_id');
    const sponsor = this.state('owner_account_id');
    const want = !!agent && !!sponsor && agent !== sponsor && this.state('agent_mode') !== 'shared' && (await this.mailAutoReply()) && (await this.mailAllowlist()).length > 0;
    const id = this.state('mail_wake_subscription');
    const existing = id ? await events.getSubscription(id) : null;
    if (id && !existing) {
      // The sponsor deleted it from their Automations list: that turns answering off, rather than the next check making it again.
      this.sql.exec('DELETE FROM assistant_state WHERE key = ?', 'mail_wake_subscription');
      this.setState('mail_auto_reply', '0');
      return 'off';
    }
    if (want && existing && existing.consumer === agent && existing.owner === sponsor && existing.filter.consumerOwn && existing.action?.kind === 'wake' && existing.action.reply === 'mail') return 'on';
    if (existing) await events.deleteSubscription(existing.id);
    if (!want) {
      if (id) this.sql.exec('DELETE FROM assistant_state WHERE key = ?', 'mail_wake_subscription');
      return 'off';
    }
    const sub = await events.createSubscription(mailWakeSubscription({ organizationId: p.organizationId, agentAccountId: agent!, sponsorAccountId: sponsor! }));
    this.setState('mail_wake_subscription', sub.id);
    console.log(`[assistant] mail wake for ${agent}: subscription ${sub.id}`);
    return 'on';
  }

  // ---- email waiting for the person's click (mailApprovals.ts) ------------------------------------------------------

  /**
   * send_email: the email composed as Mail would send it, kept in the person's own object as waiting, and, when no page
   * runs the turn, a note in the person's DM with the agent linking to it. The person sends it (or not) with a click.
   */
  private async requestMailApproval(input: DraftInput, mail: MailToolContext, who: Who, conversation: string): Promise<MailApprovalDTO> {
    const prepared = await this.prepareForSend(input, mail, who);
    const own = await this.ownMailbox(who.caller);
    // Email to the person themself needs no click (operator ruling 2026-11-17): it goes now, and is kept as sent.
    const mine = await this.ownAddresses(who, mail);
    const recipients = [...prepared.to, ...prepared.cc, ...prepared.bcc].map((r) => parseAddress(r)?.address.toLowerCase() ?? r.toLowerCase());
    const toSelf = recipients.length > 0 && recipients.every((r) => mine.has(r));
    if (toSelf) await this.deliver(prepared, mail);
    const approval: NewApproval = {
      agentName: this.definition().name, prepared, fromAgent: !!own?.ids.has(prepared.account.id), body: input.body,
      quotes: input.reply_to_id ? 'reply' : input.forward_id ? 'forward' : null, ...(toSelf ? { sent: true } : {}),
    };
    const ns = this.env.ASSISTANT;
    const home = ns?.idFromName(who.caller.account.id);
    const saved = !ns || !home || home.equals(this.ctx.id) ? this.addMailApproval(approval) : ((await ns.get(home).addMailApproval(approval)) as MailApprovalDTO);
    if (toSelf) {
      console.log(`[assistant] email ${saved.id} sent to the person themself, no click needed`);
      await this.publishMailSent(who.caller, saved, 'self');
      return saved;
    }
    const away = this.headlessTurns.get(conversation);
    if (away && who.docs.userId) {
      const link = `${this.origin}${mailApprovalPath(saved.id, away.organizationId)}`;
      const lines = [
        `✉️ I wrote an email for you to approve. It is not sent until you click **Send message**.`,
        `**From:** ${saved.from}  `, `**To:** ${[...saved.to, ...saved.cc].join(', ')}  `, `**Subject:** ${saved.subject || '(no subject)'}`,
        '', ...saved.body.slice(0, 1500).split('\n').map((l) => `> ${l}`), ...(saved.body.length > 1500 ? ['> …'] : []),
        '', `[Review and send](${link})`,
      ];
      await this.orgStub(away.organizationId)?.agentDmNotice({ agentUserId: away.agentUserId, personUserId: who.docs.userId, text: lines.join('\n') })
        .catch((err: Error) => console.error(`[assistant] email approval note: ${err.message}`));
    }
    return saved;
  }

  /** The email as it will go: from the person's mail account, or, with none connected, from FreeFlow's address in their name. */
  private async prepareForSend(raw: DraftInput, mail: MailToolContext, who: Who): Promise<PreparedMail> {
    // "me" is the person: their member address, else the one they sign in with.
    const self = memberAddress(who.caller.account) ?? who.caller.user?.email ?? null;
    const meToSelf = (list: string[] | undefined) => list?.map((r) => (r.trim().toLowerCase() === 'me' && self ? self : r));
    const input: DraftInput = { ...raw, ...(raw.to ? { to: meToSelf(raw.to) } : {}), ...(raw.cc ? { cc: meToSelf(raw.cc) } : {}), ...(raw.bcc ? { bcc: meToSelf(raw.bcc) } : {}) };
    try {
      return await prepareMail(mail, input);
    } catch (e) {
      if (!(e instanceof MailToolError) || !/^No mail account is connected/.test(e.message) || input.reply_to_id || input.forward_id) throw e;
      const account = who.caller.account;
      return prepareFreeflowMail(input, { name: account.displayName || who.caller.user?.displayName || 'A member', replyTo: memberAddress(account) ?? who.caller.user?.email ?? null });
    }
  }

  /** Sends a prepared email: from its mail account, or from FreeFlow's address, one message to each recipient. */
  private async deliver(prepared: Pick<PreparedMail, 'account' | 'body'>, mail: MailToolContext): Promise<void> {
    if (prepared.account.id !== FREEFLOW_SENDER) {
      await sendPrepared(mail, prepared);
      return;
    }
    const b = prepared.body as { to: { address: string }[]; cc?: { address: string }[]; bcc?: { address: string }[]; subject: string; html: string; text: string; fromName: string; replyTo?: string };
    for (const r of [...b.to, ...(b.cc ?? []), ...(b.bcc ?? [])]) {
      await sendMail(this.env as MailEnv, { to: r.address, subject: b.subject, text: b.text, html: b.html, fromName: b.fromName, ...(b.replyTo ? { replyTo: b.replyTo } : {}) });
    }
  }

  /** The person's own addresses: sign-in, account and linked mailbox, and each mail account they connected (not the agent's). */
  private async ownAddresses(who: Who, mail: MailToolContext): Promise<Set<string>> {
    const out = new Set<string>();
    const add = (a: string | null | undefined) => { if (a) out.add(a.trim().toLowerCase()); };
    add(who.caller.user?.email);
    add(who.caller.account.address);
    add(who.caller.account.linkedAddress);
    try {
      const res = await mail.mail('/v1/mail/accounts');
      const list = res.ok ? (((await res.json()) as { accounts?: { email?: string; yours?: boolean }[] }).accounts ?? []) : [];
      for (const a of list) if (!a.yours) add(a.email);
    } catch {
      // No mail here: the account's own addresses are enough.
    }
    return out;
  }

  /**
   * `mail.sent` into the organization's log, for the person's account: whom send_email's email went to, its subject, the
   * account it went from, and how it was approved (`self`: to the person, no click; `click`: their Send message). Never
   * its text. Marked as the agent's (`via`) when it sent on its own.
   */
  private async publishMailSent(caller: AccountCaller, a: MailApprovalDTO, approval: 'self' | 'click'): Promise<void> {
    const ns = this.env.EVENTS, org = caller.account.organizationId || caller.organizationId;
    if (!ns || !org) return;
    try {
      await ns.get(ns.idFromName(org)).publish({
        type: 'mail.sent', organizationId: org, actor: caller.account.id,
        ...(caller.via ? { via: caller.via } : {}), ...(caller.invokedBy ? { invokedBy: caller.invokedBy } : {}),
        ref: { organizationId: org, app: 'mail', kind: 'approval', id: a.id },
        audience: `account:${caller.account.id}`, ts: new Date().toISOString(),
        data: { to: [...a.to, ...a.cc, ...a.bcc], subject: a.subject, from: a.from, how: 'send_email', approval, agent: a.agentName },
      });
    } catch (err) {
      console.error(`[assistant] mail.sent: ${(err as Error).message.slice(0, 200)}`);
    }
  }

  /** Keeps an email waiting here (an RPC from the person's other agents' runtimes, or this object's own turn). */
  addMailApproval(a: NewApproval): MailApprovalDTO {
    try {
      return new MailApprovals(this.sql).add(a);
    } catch (e) {
      throw new MailToolError((e as Error).message);
    }
  }

  /**
   * The email that woke a `reply: 'mail'` job (assistant/mailWake.ts): the trigger's reference names the message in the
   * assistant's own mailbox, read there with the mail tools' read_mail, as the assistant. Null when it is not there.
   */
  private async triggeringMail(job: AgentJobDTO, organizationId: string, caller: AccountCaller): Promise<{ from: string; subject: string; body: string; messageId: string | null } | null> {
    const events = this.env.EVENTS?.get(this.env.EVENTS.idFromName(organizationId));
    const trigger = await events?.jobTrigger(job.id, job.agent);
    if (!trigger || trigger.type !== 'mail.received' || trigger.ref?.app !== 'mail') return null;
    const own = await this.ownMailbox(caller);
    const runner = runnerOf('assistant', 'read_mail');
    if (!own || !runner) return null;
    const out = (await runner.run({ mail: { mail: own.fetch, origin: this.origin } } as never, { ids: [trigger.ref.id] })) as { messages?: { from?: string | null; subject?: string; body?: string; message_id?: string | null }[] };
    const m = out.messages?.[0];
    const from = m?.from ? (/<([^<>\s]+@[^<>\s]+)>/.exec(m.from)?.[1] ?? m.from).trim() : '';
    if (!m || !from) return null;
    return { from, subject: m.subject ?? '', body: (m.body ?? '').slice(0, 20_000), messageId: m.message_id ?? null };
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
    if (!settings.current?.choice && !settings.builtIn) throw new lib.AgentError(400, NO_MODEL);
  }

  /** In the `org:<id>` object: the organization's model, for the runtimes (its keys opened). */
  async orgModel(): Promise<OrgModel> {
    return withDocsContext(this.context, () => {
      const base = new AssistantSettingsStore(new DatabaseSync() as never, 'data/connector.key', { builtIn: !!this.env.ANTHROPIC_API_KEY, agents: false });
      // Local development: the first time, the organization runs on the key in .dev.vars (none of production's).
      if (this.env.DEV_ADOPT_MODEL_KEYS === '1') {
        const adopted = base.adoptFromEnvironment(ORG_ROW, { ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY, OPENAI_API_KEY: this.env.OPENAI_API_KEY, OPENROUTER_API_KEY: this.env.OPENROUTER_API_KEY });
        if (adopted) console.log(`[assistant] local development: the organization runs on the ${adopted} key from .dev.vars`);
      }
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
      if (e instanceof lib.AgentError) return c.json({ error: e.message }, e.status as 400);
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

    // The panel's ‹ ›: a chat's conversations, newest first, and going back to one of them.
    app.get('/api/agent/history', (c) => {
      const scope = c.req.query('scope') ?? HOME_CHAT;
      if (!isChatScope(scope)) return c.json({ error: 'That is not a chat.' }, 400);
      return c.json({ chats: this.service().agent.history(userOf(c), scope) });
    });

    app.post('/api/agent/reopen', async (c) => {
      const { scope = HOME_CHAT, id } = (((await c.req.json().catch(() => ({}))) ?? {}) as { scope?: unknown; id?: unknown });
      if (!isChatScope(scope) || typeof id !== 'string') return c.json({ error: 'Give the chat and the conversation.' }, 400);
      try {
        this.service().agent.reopen(userOf(c), scope, id);
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
    // And whether it answers that mail on its own (`autoReply`, off by default): each part is set alone.
    // Email waiting for the person's click (mailApprovals.ts): the list, one, and Send message or Discard. Only the person,
    // signed in with a session, decides: never an agent's or an app's token, so no agent can approve its own email.
    app.get('/api/agent/mail-approvals', (c) => c.json({ approvals: new MailApprovals(this.sql).waiting() }));
    app.get('/api/agent/mail-approvals/:id', (c) => {
      const a = new MailApprovals(this.sql).get(c.req.param('id'));
      return a ? c.json({ approval: a }) : c.json({ error: 'That email is not here.' }, 404);
    });
    app.post('/api/agent/mail-approvals/:id/:action', async (c) => {
      const caller = c.env.who.caller;
      if (caller.authKind !== 'session' || caller.user?.isAgent) return c.json({ error: 'Only you can send or discard this email, signed in to FreeFlow.', code: 'person_only' }, 403);
      const store = new MailApprovals(this.sql);
      const id = c.req.param('id'), action = c.req.param('action');
      if (action === 'discard') return store.discard(id) ? c.json({ approval: store.get(id) }) : c.json({ error: 'That email is no longer waiting.', approval: store.get(id) }, 409);
      if (action !== 'send') return c.json({ error: 'Not found' }, 404);
      const claimed = store.claim(id);
      if (!claimed) return c.json({ error: 'That email is no longer waiting.', approval: store.get(id) }, 409);
      const mail = this.mailContext(HOME_CHAT, c.env.who);
      try {
        if (!mail) throw new Error('Mail is not available here.');
        await this.deliver(claimed, mail);
        console.log(`[assistant] email ${id} sent on the person's click`);
        // The person sent it with their own click: no `via` (the route marks every request to this object with the assistant).
        await this.publishMailSent({ ...c.env.who.caller, via: undefined }, store.get(id)!, 'click');
        return c.json({ approval: store.get(id) });
      } catch (e) {
        // Still waiting: the person may try again, or discard it.
        store.release(id, (e as Error).message.slice(0, 300));
        return c.json({ error: `It could not be sent: ${(e as Error).message.slice(0, 300)}`, approval: store.get(id) }, 502);
      }
    });
    app.get('/api/agent/mail-allowlist', async (c) => c.json({ senders: await this.mailAllowlist(), autoReply: await this.mailAutoReply() }));
    app.put('/api/agent/mail-allowlist', async (c) => {
      const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { senders?: unknown; autoReply?: unknown };
      if (body.senders !== undefined) {
        const { cleanAllowlist } = await import('../imap/allowlist');
        this.setState('mail_allowlist', JSON.stringify(cleanAllowlist(body.senders)));
      }
      if (typeof body.autoReply === 'boolean' && body.autoReply !== (await this.mailAutoReply())) {
        this.setState('mail_auto_reply', body.autoReply ? '1' : '0');
        this.refreshGuidance();
      }
      // Answering is a subscription on the mailbox's mail.received (assistant/mailWake.ts): made or removed to match.
      const organizationId = c.env.who.caller.account.organizationId || c.env.who.caller.organizationId;
      if (organizationId) await this.syncMailWake({ organizationId }).catch((err: Error) => console.error(`[assistant] mail wake: ${err.message}`));
      return c.json({ senders: await this.mailAllowlist(), autoReply: await this.mailAutoReply() });
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
    // The admin tools are the admin agent's, in a turn an owner or admin asked for (agents.md §1.4): the server says so,
    // never the browser.
    if (body.context && typeof body.context === 'object') {
      delete (body.context as { admin?: boolean }).admin;
      // A panel turn has its page: only the runtime's own turns are headless (runHeadless).
      delete (body.context as { headless?: boolean }).headless;
      if (this.isAdminAgent() && c.env.who.caller.invokedBy) (body.context as { admin?: boolean }).admin = true;
      // The installed apps' tools are the server's to say (user-apps.md §3.3), never the browser's.
      (body.context as { appTools?: AppToolOffer[] }).appTools = await this.appToolOffers(c.env.who);
    }
    // Where the asker is: their browser's zone (the panels send it), else their profile's.
    body.timezone = c.req.header('x-timezone') || body.timezone || c.env.who.caller.user?.timezone || undefined;
    const userId = conversationUserOf(c);
    const { agent } = this.service();
    try {
      // No organization model and no platform key: the plain reason, as Chat's turns give it (before Docs' own check,
      // which would point at Docs' Settings).
      this.requireModel();
      agent.checkTurn(userId, body);
    } catch (e) {
      if (e instanceof lib.AgentError) return c.json({ error: e.message }, e.status as 400);
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

/** Where a Chat conversation is, and who reads it. */
interface ChatRun {
  organizationId: string;
  runtime: HostedRuntimeDTO;
  channelId: string;
  threadRootId: string | null;
  audience: 'private' | 'shared';
}

/** One turn runHeadless runs: whose, where, as whom, and how its posts are stamped. */
interface HeadlessTurn {
  organizationId: string;
  runtime: HostedRuntimeDTO;
  /** The loop's conversation (`auto:<subscription>`, `chat:…`, `mail:<sender>`). */
  conversation: string;
  who: Who;
  timezone?: string;
  /** The page the turn has (`home` or `chat`), always `headless`. */
  context: AgentContext;
  first: Pick<AgentTurnRequest, 'message' | 'toolResults'>;
  /** What a send_message post carries: a wake job's depth and cause (loop safety, platform.md §5.2), who asked a shared agent. */
  stamp?: { depth?: number; causedBy?: string; invokedBy?: string };
}

type OrgStub = DurableObjectStub<Org>;

/** A Chat conversation's chat in the loop's store: one per DM or thread, so its memory stays with that exchange. */
const chatConversation = (run: Pick<ChatRun, 'channelId' | 'threadRootId'>) => `chat:${run.channelId}:${run.threadRootId ?? 'main'}`;

/** A turn of a person's own agent (it acts as them, marked `via` it), or the person's own panel: not a shared agent's. */
function personalTurn(who: Who): boolean {
  return who.caller.authKind === 'session' || !!who.caller.via;
}
