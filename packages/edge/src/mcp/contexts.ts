// What an /mcp caller's tools reach, made in the Worker for each request (docs/specs/suite-mcp.md §3.1): the caller's
// account's Mail, Calendar and per-account app objects, the organization's event subscriptions and the agent's wakes, the
// installed apps' tools, and the organization's Docs object. These used to be made inside the Docs object, which ran every
// /mcp request; now the suite's server runs in the Worker and Docs is one app it calls.
import type { AccountDTO } from '@flow/shared';
import { USER_APPS_SCOPE } from '@flow/shared';
import type { CallerContext } from '../org/routes/compat';
import type { Directory } from '../directory/object';
import type { Docs } from '../docs/object';
import { lazySubscriptions, subscriptionsAs, wakesAs, type SubscriptionOps, type WakeOps } from '../events/subscriptions.ts';
import { alertsAs, type AlertOps } from '../events/alerts.ts';
import { calendarRequest, type AccountCaller } from '../calendar/forward';
import { appToolContexts, type AppToolContext } from '../apps';
import type { DoorTool } from '../registry';
import { appDoorTools } from '../registry/userApps';
import type { DocsPort, McpRequestCaller, SuiteDeps } from './suite.ts';
import type { ChatToolContext } from '../chat/mcpTools.ts';
import type { MeetToolContext } from '../meet/mcpTools.ts';
import { eventSearchAs, type EventSearchOps } from '../events/search.ts';

export interface McpContextEnv {
  DIRECTORY: DurableObjectNamespace<Directory>;
  DOCS: DurableObjectNamespace<Docs>;
  BROWSER?: Fetcher;
  MAIL?: DurableObjectNamespace<import('../imap/object').Mail>;
  CALENDAR?: DurableObjectNamespace<import('../calendar/object').Calendar>;
  EVENTS?: DurableObjectNamespace<import('../events/object').Events>;
  ORG?: DurableObjectNamespace<import('../org/object').Org>;
}

/** The agent fields of a caller context (agents.md §3), as the /mcp door resolves them. */
interface AgentFields { via?: string | null; invokedBy?: string | null }

/** Mail's or Calendar's namespace, as the tools reach an account's object. */
type AccountObjects = { idFromName(name: string): DurableObjectId; get(id: DurableObjectId): { handle(request: Request, caller: CallerContext): Promise<Response> } };

function directory<T>(env: McpContextEnv, method: string, ...args: unknown[]): Promise<T> {
  const stub = env.DIRECTORY.get(env.DIRECTORY.idFromName('directory'));
  return (stub.call as never as (m: string, a: unknown[]) => Promise<{ ok: boolean; value: T }>)(method, args).then((a) => a.value);
}

/**
 * The caller context for the per-account objects of the person's account in this organization (platform.md §3.6), asked
 * of the directory once. Null for no account here, or one suspended or removed.
 */
export function accountCaller(env: McpContextEnv, userId: string, organizationId: string, agent: AgentFields = {}): () => Promise<CallerContext | null> {
  let found: Promise<CallerContext | null> | null = null;
  return () =>
    (found ??= directory<AccountDTO | null>(env, 'accountFor', userId, organizationId).then((account) =>
      // `via`, the personal agent the /mcp client acts through, or `invokedBy`, who asked a shared one (agents.md §3), so
      // the objects' events say so.
      account && account.state !== 'suspended' && account.state !== 'removed' ? { user: null, token: null, authKind: null, ip: '', organizationId, account, ...(agent.via ? { via: agent.via } : {}), ...(agent.invokedBy ? { invokedBy: agent.invokedBy } : {}) } : null,
    ));
}

/** A per-account object's HTTP API, as the tools call it: the account's object, or a 403 `no_account`. */
function accountFetch(ns: AccountObjects, app: string, origin: string, caller: () => Promise<CallerContext | null>) {
  return async (path: string, init?: RequestInit): Promise<Response> => {
    const who = await caller();
    if (!who?.account) return Response.json({ error: { code: 'no_account', message: `join an organization to use ${app}` } }, { status: 403 });
    return ns.get(ns.idFromName(who.account.id)).handle(new Request(`${origin}${path}`, init), who);
  };
}

/** The organization's Docs object, as the suite's Docs tools call it (Docs.runMcpTool), as the caller. */
export function docsPort(env: McpContextEnv, caller: McpRequestCaller): DocsPort {
  const stub = () => env.DOCS.get(env.DOCS.idFromName(caller.orgId));
  return {
    pdf: !!env.BROWSER,
    call: (name, args) => stub().runMcpTool(caller, name, args),
    importFile: async (bytes, filename) => stub().mcpImportBytes(caller, bytes, filename),
  };
}

/** Everything the suite's server needs for one caller (suite.ts `handleSuiteMcp`). */
export async function mcpContexts(env: McpContextEnv, caller: McpRequestCaller): Promise<SuiteDeps> {
  const agent = { via: caller.via ?? null, invokedBy: caller.invokedBy ?? null };
  const who = accountCaller(env, caller.userId, caller.orgId, agent);
  // The subscriptions and wakes are the account's own, without the agent stamp, as they always were.
  const plain = accountCaller(env, caller.userId, caller.orgId);
  const { MAIL, CALENDAR, EVENTS, ORG } = env;

  const mail = MAIL ? accountFetch(MAIL as unknown as AccountObjects, 'Mail', caller.origin, who) : undefined;

  // As the routes do (calendar/forward.ts): a shared calendar's id reaches its owner's object, `/shared` the share index.
  const calendar = !CALENDAR
    ? undefined
    : !ORG
      ? accountFetch(CALENDAR as unknown as AccountObjects, 'Calendar', caller.origin, who)
      : async (path: string, init?: RequestInit): Promise<Response> => {
          const w = await who();
          if (!w?.account) return Response.json({ error: { code: 'no_account', message: 'join an organization to use Calendar' } }, { status: 403 });
          return calendarRequest({ CALENDAR, ORG }, new Request(`${caller.origin}${path}`, init), w as AccountCaller, caller.userId);
        };

  /** An address of an account in this organization (not suspended or removed), for share_calendar; null for anyone else. */
  const member = async (address: string) => {
    const a = await directory<AccountDTO | null>(env, 'accountByAddress', address).catch(() => null);
    return a && a.organizationId === caller.orgId && a.state !== 'suspended' && a.state !== 'removed' ? { accountId: a.id, name: a.displayName ?? address } : null;
  };

  let events: SubscriptionOps | undefined;
  let wakes: WakeOps | undefined;
  let alerts: AlertOps | undefined;
  let eventSearch: EventSearchOps | undefined;
  if (EVENTS && ORG) {
    // search_events as the caller's account, with the person who asked a shared agent (events/search.ts).
    eventSearch = {
      search: async (input) => {
        const w = await who();
        if (!w?.account) throw Object.assign(new Error('no account in this organization'), { status: 403 });
        return eventSearchAs(EVENTS.get(EVENTS.idFromName(caller.orgId)), ORG.get(ORG.idFromName(caller.orgId)), { accountId: w.account.id, invokedBy: agent.invokedBy ?? null }).search(input);
      },
    };
    // Alerts as the caller's account (shared/alerts.ts): the Org object picks who gets one, from the account and the
    // person the agent says it works for (`invokedBy`, which the directory checked).
    let alertOps: Promise<AlertOps> | null = null;
    const alertsGet = () => (alertOps ??= (async () => {
      const w = await who();
      if (!w?.account) throw Object.assign(new Error('no account in this organization'), { status: 403 });
      return alertsAs(EVENTS.get(EVENTS.idFromName(caller.orgId)), ORG.get(ORG.idFromName(caller.orgId)), { accountId: w.account.id, organizationId: caller.orgId, invokedBy: agent.invokedBy ?? null, via: agent.via ?? null });
    })());
    alerts = { show: async (x) => (await alertsGet()).show(x), open: async () => (await alertsGet()).open(), close: async (id) => (await alertsGet()).close(id) };
    events = lazySubscriptions(async () => {
      const w = await plain();
      if (!w?.account) throw Object.assign(new Error('no account in this organization'), { status: 403 });
      return subscriptionsAs(EVENTS.get(EVENTS.idFromName(caller.orgId)), ORG.get(ORG.idFromName(caller.orgId)), w.account.id, caller.userId, w.account.role, caller.orgId);
    });
    // An agent's wakes for itself (agent-self-wake.md): the account must be an agent's, which wakesAs checks on each call.
    let ops: Promise<WakeOps> | null = null;
    const get = () => (ops ??= (async () => {
      const w = await plain();
      if (!w?.account) throw Object.assign(new Error('no account in this organization'), { status: 403 });
      return wakesAs(EVENTS.get(EVENTS.idFromName(caller.orgId)), ORG.get(ORG.idFromName(caller.orgId)), { agentAccountId: w.account.id, organizationId: caller.orgId });
    })());
    wakes = { schedule: async (x) => (await get()).schedule(x), list: async () => (await get()).list(), cancel: async (id) => (await get()).cancel(id) };
  }

  const apps: Record<string, AppToolContext> = appToolContexts(env, who, caller.origin);
  const userAppTools = await userAppToolsOf(env, caller, who);
  return { docs: docsPort(env, caller), mail, calendar, events, wakes, alerts, eventSearch, member, chat: chatOf(env, caller), meet: meetOf(env, caller), apps, userAppTools };
}

/**
 * The organization's Chat as the caller's agent (docs/specs/suite-mcp.md §4.2): the personal agent the client acts through
 * (`via`, with its account, so the Org object can give it a member row the first time), or the shared agent itself. A
 * connection made before agents had kinds has no agent, and so no Chat.
 */
function chatOf(env: McpContextEnv, caller: McpRequestCaller): ChatToolContext | undefined {
  const { ORG } = env;
  const shared = caller.agentMode === 'shared';
  const agentUserId = shared ? caller.userId : caller.agentMode === 'personal' ? caller.via ?? null : null;
  if (!ORG || !agentUserId) return undefined;
  let account: Promise<AccountDTO | null> | null = null;
  const agentAccount = () => (account ??= caller.via ? directory<AccountDTO | null>(env, 'accountFor', caller.via, caller.orgId).catch(() => null) : Promise.resolve(null));
  return {
    chat: async (tool, input) =>
      ORG.get(ORG.idFromName(caller.orgId)).mcpChat({ agentUserId, agentAccount: await agentAccount(), tool, input, invokedBy: shared ? caller.invokedBy ?? null : null }),
  };
}

/**
 * The tools of the apps installed in the organization (docs/specs/user-apps.md §3.3), for a token granted `apps:use`: the
 * ones the caller's account holds the scopes of, and for a personal agent only the apps its person turned on (§5.2).
 */
async function userAppToolsOf(env: McpContextEnv, caller: McpRequestCaller, who: () => Promise<CallerContext | null>): Promise<DoorTool[]> {
  if (!env.ORG || !caller.scope.split(' ').includes(USER_APPS_SCOPE)) return [];
  const w = await who();
  if (!w?.account) return [];
  return appDoorTools({ ORG: env.ORG }, {
    organizationId: caller.orgId, account: w.account, userId: caller.userId, displayName: w.account.displayName, via: w.via ?? null, invokedBy: w.invokedBy ?? null,
  }, 'mcp');
}

/** The organization's Meet as the caller (docs/specs/suite-mcp.md §5): the person a personal agent acts for, or the shared agent. */
function meetOf(env: McpContextEnv, caller: McpRequestCaller): MeetToolContext | undefined {
  const { ORG } = env;
  if (!ORG) return undefined;
  return {
    meet: (tool, input) => ORG.get(ORG.idFromName(caller.orgId)).mcpMeet({ userId: caller.userId, tool, input, origin: caller.origin, via: caller.via ?? null, invokedBy: caller.invokedBy ?? null }),
  };
}
