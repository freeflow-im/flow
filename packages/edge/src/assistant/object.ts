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
import type { AccountDTO } from '@flow/shared';
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
import { AgentStore } from '@flow/docs/server/agent/store.ts';
import { checkBraveKey } from '@flow/docs/server/agent/tools.ts';
import { ASSISTANT_PAGES, SUITE_GUIDANCE } from '../docs/assistantTools.ts';
import { isFileId } from '@flow/docs/server/ids.ts';
import { scopeOf, type ScopeArg } from '@flow/docs/server/scope.ts';
import { chatScope, HOME_CHAT, isChatScope, type AgentEvent, type AgentTurnRequest, type AssistantSettingsUpdate } from '@flow/docs/shared/agent/protocol.ts';
import { docsToolContext, importToDocs, type DocsFetch, type DocsPlace } from './docsTools.ts';

export type { DocsCaller };

export interface AssistantEnv {
  /** Seals the settings' API keys, as it did in the Docs object (connectors/secrets.ts), so moved keys still open. */
  FLOW_DATA_KEY?: string;
  FLOW_WEB_URL?: string;
  BLOBS?: R2Bucket;
  DIRECTORY?: DurableObjectNamespace<import('../directory/object').Directory>;
  /** The organizations' Docs objects: Docs' tools, as the person. */
  DOCS?: DurableObjectNamespace<import('../docs/object').Docs>;
  /** The account's Mail object: Mail's tools. */
  MAIL?: DurableObjectNamespace<import('../imap/object').Mail>;
  /** Calendar's objects and the organization's share index: Calendar's tools, as routes/calendar.ts reaches them. */
  CALENDAR?: DurableObjectNamespace<import('../calendar/object').Calendar>;
  ORG?: DurableObjectNamespace<import('../org/object').Org>;
}

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
interface Who { caller: AccountCaller; docs: DocsCaller }
type Bindings = { who: Who };
type C = Context<{ Bindings: Bindings }>;

/** What the panel is told of a failed turn (the Docs server's agentErrorMessage, as it was). */
function agentErrorMessage(e: unknown): string {
  if (e instanceof AgentError || e instanceof OwnKeyError || e instanceof OpenRouterError) return e.message;
  const openai = openaiErrorMessage(e);
  if (openai) return openai;
  if (e instanceof Anthropic.RateLimitError) return 'The assistant is getting too many requests right now. Try again in a minute.';
  if (e instanceof Anthropic.AuthenticationError) return 'The assistant is not configured correctly on this server (API key).';
  if (e instanceof Anthropic.APIError && e.status && e.status >= 500) return 'The AI service had a problem. Try again in a moment.';
  if (e instanceof Anthropic.AnthropicError && /api ?key|authentication/i.test(e.message)) return 'The assistant is not configured on this server (no API key).';
  return 'Something went wrong while the assistant was working. Try again.';
}

export class Assistant extends DurableObject<AssistantEnv> {
  private readonly sql: SqlStorage;
  private readonly context: DocsContext;
  private readonly app = new Hono<{ Bindings: Bindings }>();
  private services: { agent: AgentService; settings: AssistantSettingsStore } | null = null;
  /** The latest request's caller: the account is always this object's, but its channels and session may change. */
  private who: Who | null = null;

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
  private service(): { agent: AgentService; settings: AssistantSettingsStore } {
    if (this.services) return this.services;
    const db = new DatabaseSync();
    const settings = new AssistantSettingsStore(db as never, 'data/connector.key', { builtIn: true, agents: false });
    const model = this.model();
    const agent = new AgentService(new AgentStore(db as never), null as never, settings, {
      jobs: false,
      ...(model ? { model } : {}),
      // The suite's assistant (docs/assistantTools.ts): the pages of every app, its tools' environment, its prompt lines.
      pages: ASSISTANT_PAGES,
      guidance: SUITE_GUIDANCE,
      extend: (userId: string, scope: ScopeArg) => {
        const place = placeOf(scope);
        const docs = place && this.docsFetch(place.workspace) ? docsToolContext(this.docsFetch(place.workspace)!, place) : undefined;
        const mail = this.mailContext(scope);
        const calendar = this.calendarContext(userId);
        // The apps added by manifest (apps.ts): their objects, as the account this object belongs to.
        const apps = appToolContexts(this.env, async () => this.who?.caller ?? null, this.origin);
        return { ...(docs ? { docs } : {}), ...(mail ? { mail } : {}), ...(calendar ? { calendar } : {}), ...(apps ? { apps } : {}) };
      },
    });
    return (this.services = { agent, settings });
  }

  /** The organization's Docs object's /api/*, as the person (routes/docs.ts' caller): undefined without Docs or a caller. */
  private docsFetch(organizationId: string): DocsFetch | undefined {
    const ns = this.env.DOCS, docs = this.who?.docs;
    if (!ns || !docs) return undefined;
    const stub = ns.get(ns.idFromName(organizationId));
    return (path, init) => stub.handle(new Request(`${this.origin}${path}`, init), docs, organizationId);
  }

  /** Mail's tools: the account's Mail object, and saving an attachment into the chat's root in Docs. */
  private mailContext(scope: ScopeArg): MailToolContext | undefined {
    const ns = this.env.MAIL, caller = this.who?.caller;
    if (!ns || !caller) return undefined;
    const place = placeOf(scope);
    const docs = place ? this.docsFetch(place.workspace) : undefined;
    const stub = ns.get(ns.idFromName(caller.account.id));
    return {
      mail: (path, init) => stub.handle(new Request(`${this.origin}${path}`, init), caller),
      origin: this.origin,
      ...(docs && place
        ? {
            saveToDocs: async (bytes: Buffer, filename: string) => {
              const made = await importToDocs(docs, place, bytes, filename);
              const s = made.sheet;
              const file = s
                ? { id: s.id, kind: s.kind, title: s.title, [s.kind === 'deck' ? 'deck_id' : s.kind === 'sheet' ? 'sheet_id' : 'doc_id']: s.id }
                : { id: made.file.id, kind: 'file', file_id: made.file.id, filename: made.file.filename, type: made.file.type };
              return { file, warnings: made.warnings };
            },
          }
        : {}),
    };
  }

  /** Calendar's tools: the account's Calendar object (or a shared calendar's owner's), as routes/calendar.ts reaches them. */
  private calendarContext(userId: string): CalendarToolContext | undefined {
    const { CALENDAR, ORG } = this.env;
    const caller = this.who?.caller;
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
  async handle(request: Request, caller: CallerContext, docs: DocsCaller): Promise<Response> {
    const wrong = ownerMismatch(this, caller, 'the Assistant');
    if (wrong) { console.error(`[assistant] ${wrong}`); return ownerRefusal(wrong); }
    const who: Who = { caller: caller as AccountCaller, docs };
    this.who = who;
    return withDocsContext(this.context, () => this.app.fetch(request, { who } satisfies Bindings));
  }

  /** The person's own OpenAI key, for Docs' edit_image (its host.assistant.openaiKey); null for none or another person. */
  async openaiKey(userId: string): Promise<string | null> {
    const owner = this.state('owner_user_id');
    if (owner && owner !== userId) return null;
    return withDocsContext(this.context, () => this.service().settings.openaiKey(userId));
  }

  private routes(): void {
    const app = this.app;
    const userOf = (c: C) => c.env.who.docs.userId!;
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
    const docs = this.docsFetch(who.caller.account.organizationId || who.caller.organizationId!);
    if (!docs) return null;
    const res = await docs(`/api/places/${encodeURIComponent(scope)}`);
    return res.ok ? ((await res.json()) as { title: string; place?: DocsPlace }) : null;
  }

  /** Runs or resumes a turn, streaming AgentEvents as server-sent events (as the Docs server's /api/agent/turn did). */
  private async turn(c: C): Promise<Response> {
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as AgentTurnRequest;
    const userId = c.env.who.docs.userId!;
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
    const scope = { ownerId: userId, workspaceId: place.workspace, private: !place.shared };

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
    const done = agent
      .runTurn(userId, body, emit, abort.signal, { scope, viewer: userId })
      .catch((e) => {
        if (abort.signal.aborted) return;
        console.error(`[assistant] turn failed: ${(e as Error)?.stack ?? e}`);
        emit({ type: 'error', message: agentErrorMessage(e) });
      })
      .finally(() => {
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
