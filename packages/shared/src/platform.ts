// The FreeFlow platform's shared types (docs/specs/platform.md, phase 0).
//
// Principals and accounts (§2, §3), references and grants (§4), the event bus
// envelope and subscriptions (§5.2), and the app manifest (§6.1): types, and the
// two small reference helpers beside them. Later phases build on these exact
// names and shapes, so change them only together with the spec.

// ---- references (§4.1) ------------------------------------------------------

/** Names any object an app owns: `organization / app / kind / id` (§4.1). What a
 * grant names, the share index stores, a chip renders and an intent carries. */
export interface Reference {
  organizationId: string;
  app: string;
  kind: string;
  id: string;
}

/** A reference as one string, `organization/app/kind/id`: how the event log stores it. */
export function formatReference(r: Reference): string {
  return `${r.organizationId}/${r.app}/${r.kind}/${r.id}`;
}

/** The inverse of `formatReference`, or null. The id is everything after the third `/`, so it may hold more (a mail
 * folder such as `[Gmail]/Sent`); the other three parts are never empty. */
export function parseReference(s: string): Reference | null {
  const m = /^([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(s);
  return m ? { organizationId: m[1]!, app: m[2]!, kind: m[3]!, id: m[4]! } : null;
}

// ---- the event bus (§5.2) ---------------------------------------------------

/** One event in an organization's append-only log (§5.2, "The envelope").
 * `type` is `'<app>.<type>'`; `seq` is monotonic within the organization;
 * `actor` is the acting account's id, or null when no account acted (mail from
 * outside, a system event); `causedBy` is the job id that caused it. `via` is the personal agent acting as the actor
 * ("Ann, via her assistant"); `invokedBy` is the account that asked a shared agent for the turn the event came from
 * ("Omni, asked by Scott") (agents.md §3). */
export interface PlatformEvent<T = unknown> {
  id: string;
  seq: number;
  type: string;
  organizationId: string;
  actor: string | null;
  ref?: Reference;
  channelId?: string;
  causedBy?: string;
  via?: string;
  invokedBy?: string;
  depth: number;
  ts: string;
  data: T;
}

/** What a subscription matches (§5.2, "Subscriptions"). `types` are patterns
 * such as `calendar.*`; `self: true` keeps events about the consumer's own objects. */
export interface EventFilter {
  types?: string[];
  ref?: Reference;
  channelId?: string;
  actorKind?: 'person' | 'agent' | 'any';
  text?: string;
  self?: boolean;
}

/** How a subscription is told of a match (§5.2, "Delivery modes"). `wake` files a job for an agent; `post` posts a
 * message into a channel as the subscription's owner. Both carry an `action`. */
export const DELIVERY_MODES = ['pull', 'socket', 'webhook', 'wake', 'post'] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

/** Past this depth an event wakes no agent and posts nothing (§5.2, "Loop safety on the server"). */
export const MAX_EVENT_DEPTH = 4;

/** A `wake` subscription's action: the prompt (with `{{type}}`, `{{ref}}`, `{{channel}}`, `{{actor}}`, `{{data}}`)
 * run as a turn of the consumer agent, in `channelId` or a channel of its own. `includeSelf` lets events the agent
 * itself caused wake it too. */
export interface WakeAction { kind: 'wake'; prompt: string; channelId?: string; includeSelf?: boolean }
/** A `post` subscription's action: `body` (the same placeholders) posted into `channelId` as the owner. */
export interface PostAction { kind: 'post'; channelId: string; body: string; includeSelf?: boolean }
export type SubscriptionAction = WakeAction | PostAction;

/** When a schedule fires: `hourly`, `daily@HH:MM`, `weekly@DAY HH:MM` (MON..SUN) or `monthly@D HH:MM`, local to its timezone. */
export const SCHEDULE_EVERY = /^(hourly|daily@([01]\d|2[0-3]):[0-5]\d|weekly@(MON|TUE|WED|THU|FRI|SAT|SUN) ([01]\d|2[0-3]):[0-5]\d|monthly@([1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):[0-5]\d)$/i;
export interface ScheduleDTO { id: string; every: string; timezone: string; nextAt: string }

/** A wake job's states: `queued`, `delivered` (its `agent.job` event is out), `running` (acked, under a lease), then
 * `done` or `failed`; `parked` after three deliveries nobody took. */
export const JOB_STATES = ['queued', 'delivered', 'running', 'done', 'failed', 'parked'] as const;
export type JobState = (typeof JOB_STATES)[number];

/** One row of `agent_jobs` in the Events object (§5.2). `agent` is the consumer's account id. */
export interface AgentJobDTO {
  id: string;
  subscriptionId: string;
  agent: string;
  eventId: string;
  eventSeq: number;
  prompt: string;
  channelId?: string;
  state: JobState;
  attempts: number;
  leaseUntil?: string;
  note?: string;
  depth: number;
  createdAt: string;
  updatedAt: string;
}

/** The data of an `agent.job` event, on the agent's own account. */
export interface AgentJobEventData {
  jobId: string;
  subscriptionId: string;
  prompt: string;
  channelId?: string;
  event: { id: string; seq: number; type: string; ref?: string; channelId?: string };
}

/** The data of a `calendar.invited` event (phase 4.2), on the invited account alone: the event on its calendar, and who invited it. */
export interface CalendarInvitedEventData {
  calendarId: string;
  eventId: string;
  uid: string;
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  ownerAccountId: string;
  url: string;
  organizer: { email: string; name: string | null; accountId: string };
}

/** A durable consumer with a cursor in the Events object (§5.2). `consumer` and
 * `owner` are account ids; `parkedAt` is set after repeated delivery failure. */
export interface SubscriptionDTO {
  id: string;
  name: string;
  consumer: string;
  owner: string;
  filter: EventFilter;
  delivery: DeliveryMode;
  cursor: number;
  createdBy: string;
  createdAt: string;
  parkedAt?: string;
  /** For `wake` and `post`. */
  action?: SubscriptionAction;
  /** A schedule's subscription: its filter is `schedule.tick` on `<org>/events/schedule/<id>`. */
  schedule?: ScheduleDTO;
}

// ---- grants (§4.3) ----------------------------------------------------------

/** The roles every app maps to its own actions (§4.3). `owner` is a column on
 * the object, not a grant, but shares the name. */
export const ROLES = ['viewer', 'editor', 'manager', 'owner'] as const;
export type Role = (typeof ROLES)[number];

/** Who a grant names, all within one organization (§4.3): one account, a
 * channel's members, every member, or anyone with a link token. */
export type GrantPrincipal = `account:${string}` | `channel:${string}` | 'org' | `link:${string}`;

/** One row of `grants` in the owning app's object (§4.3). */
export interface Grant {
  objectKind: string;
  objectId: string;
  principal: GrantPrincipal;
  role: Role;
  grantedBy: string;
  grantedAt: string;
  expiresAt?: string;
}

// ---- identity: principals (§2.1) --------------------------------------------

export const PRINCIPAL_KINDS = ['person', 'agent'] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

export const PRINCIPAL_STATUSES = ['active', 'suspended', 'deleted'] as const;
export type PrincipalStatus = (typeof PRINCIPAL_STATUSES)[number];

/** An agent's kind (docs/specs/agents.md §1), set when it is made and never changed: a `personal` agent acts as its
 * sponsor through a delegation and only the sponsor may use it; a `shared` agent holds only its own grants and every
 * member of its organization may use it. `group` comes later. */
export const AGENT_MODES = ['personal', 'shared'] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

/** Where an agent's loop runs (agents.md §6): on its own machine (`external`: the bridge, a client on /mcp) or in the
 * platform's runtime object (`hosted`: the person's assistant, a hosted shared agent). `sandboxed` comes later. */
export const AGENT_RUNTIMES = ['external', 'hosted'] as const;
export type AgentRuntime = (typeof AGENT_RUNTIMES)[number];

/** An agent a person may talk to from the panel (agents.md §6): their own hosted assistant (`self`), or a hosted shared
 * agent of the organization. */
export interface UsableAgentDTO {
  id: string;
  accountId: string;
  displayName: string;
  /** Its picture (a preset's or an upload's address), or null. */
  avatarUrl?: string | null;
  mode: AgentMode;
  self: boolean;
}

/** A hosted agent's runtime, as the directory places it (agents.md §6): the object its loop runs in (`runtimeKey`: the agent's
 * own account for a shared agent, the sponsor's account for a personal one, where the assistant's conversations live), and
 * the identity its turns run as. */
export interface HostedRuntimeDTO {
  runtimeKey: string;
  agentId: string;
  agentAccountId: string;
  mode: AgentMode;
  organizationId: string;
  /** A personal agent's sponsor: the person whose account the agent acts as, marked `via`. */
  sponsorId: string | null;
  sponsorAccountId: string | null;
}

/** A hosted agent's definition (agents.md §6), kept by its runtime object: what the person or the admins set. */
export interface AgentDefinitionDTO {
  name: string;
  /** Lines added to the system prompt. */
  instructions: string;
  updatedAt: string | null;
}

/** A person or an agent: how someone signs in and nothing more (§2.1).
 * `sponsorId` is required for an agent and names a person principal; so are `organizationId` (the one organization
 * the agent belongs to, agents.md §1) and `mode`. */
export interface PrincipalDTO {
  id: string;
  kind: PrincipalKind;
  loginEmail: string;
  displayName: string;
  sponsorId?: string;
  organizationId?: string;
  mode?: AgentMode;
  status: PrincipalStatus;
  createdAt: string;
}

// ---- organizations and accounts (§3.3) --------------------------------------

export const ACCOUNT_ROLES = ['owner', 'admin', 'member'] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

/** `native` has an address, a mailbox and a native calendar; `guest` is a member with none of them (§3.3): the same
 * roles, channels, DMs, mentions and Docs, and no address, since an address that bounces is a trap. `personal_agent`
 * is a personal agent's account (agents.md §2): no address, mailbox, calendars, channels or grants; it exists so the
 * organization can see, suspend and remove the agent, and never changes kind. */
export const ACCOUNT_KINDS = ['native', 'guest', 'personal_agent'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];
/** The kinds a member (a person) can be: what an invitation or the Kind column may ask for. */
export type MemberKind = Exclude<AccountKind, 'personal_agent'>;

/** The provisioning states (§3.4), then active, suspended, removed. */
export const ACCOUNT_STATES = ['requested', 'mailbox_ready', 'calendars_ready', 'active', 'suspended', 'removed'] as const;
export type AccountState = (typeof ACCOUNT_STATES)[number];

/** One principal in one organization (§3.3). Mail and Calendar are keyed by `id`. */
export interface AccountDTO {
  id: string;
  principalId: string;
  organizationId: string;
  /** The account's email address; null for a guest, which has none (§3.3). */
  address: string | null;
  displayName: string;
  role: AccountRole;
  kind: AccountKind;
  state: AccountState;
  /** Why provisioning stopped (a provider's refusal), while the account waits in its state; null otherwise (§3.4). */
  statusMessage?: string | null;
  /** The account's hosted mailbox exists (provisioning's mailbox step is done). Absent where the directory did not say. */
  hosted?: boolean;
  /** An agent's account only (agents.md §2): the person responsible for it here, its kind, and where it runs. Absent for a person. */
  sponsorId?: string | null;
  agentMode?: AgentMode | null;
  agentRuntime?: AgentRuntime | null;
  createdAt: string;
}

/** PATCH /v1/workspaces/:id/accounts/:accountId/kind: the account, as it is now. */
export interface AccountKindResult { account: AccountDTO }

/** POST /v1/workspaces/:id/accounts/kind: how many accounts changed kind, and how many were that kind already. */
export interface BulkAccountKindResult { changed: number; unchanged: number }

// ---- domains (§3.2) ------------------------------------------------------------

/** `platform` is the organization's `<slug>.freeflow.im`, made with it; `own` is one its admin registered. */
export type DomainKind = 'own' | 'platform';

/** A DNS record the organization's admin publishes for a domain: the verification TXT and the mail provider's lines. */
export interface DnsRecordDTO {
  type: 'TXT' | 'MX';
  /** The fully qualified name, without a trailing dot. */
  name: string;
  /** TXT text, or an MX record's host. */
  value: string;
  /** MX only. */
  priority?: number;
  /** What the record is for: `verification` is ours (`_freeflow.<domain>`), `provider` the mail provider's own proof of ownership. */
  purpose: 'verification' | 'provider' | 'mx' | 'spf' | 'dmarc' | 'dkim';
}

/** One of an organization's domains, with the records it needs and whether DNS has them (GET /v1/workspaces/:id/domains). */
export interface DomainDTO {
  domain: string;
  kind: DomainKind;
  verified: boolean;
  primary: boolean;
  records: DnsRecordDTO[];
  /** Per record, in the order of `records`: what a DNS lookup found. Empty for the platform domain, which we publish. */
  status: { record: 'present' | 'missing' }[];
  /** The domain exists at the mail provider: step 4 of the setup (docs/specs/workspace-admin.md §4.1), done by
   * "Turn on mail" or by the first mailbox's provisioning. */
  atProvider: boolean;
  createdAt: string;
}

// ---- apps (§6.1) ------------------------------------------------------------

/** One object per organization, or one per account (§6.1). */
export const APP_SCOPES = ['organization', 'account'] as const;
export type AppScope = (typeof APP_SCOPES)[number];

/** A suite-bar tab's badge: Chat's unread count, Mail's (drawn only on Mail's own bar), or none (§6.1). Each bar keeps its own source for the number. */
export type AppTabBadge = 'chat-unread' | 'mail-unread' | 'none';

/**
 * One checkbox of the MCP consent page (§6.1): a group of the app's scopes, its title and what it lets an agent do,
 * on or off until the person changes it. `readOnly` is the text when the client asked for none of the group's
 * `:write` scopes.
 */
export interface AppScopeGroup {
  id: string;
  label: string;
  detail: string;
  scopes: string[];
  checkedByDefault: boolean;
  warning?: string;
  readOnly?: { label: string; detail: string };
}

/**
 * A page the Worker serves for one of the app's paths (a Hono pattern), from `_pages/<html>`. `signIn`: a stranger is
 * sent to sign in. `headers`: added to the page. `passFiles`: a name with an extension under it is a built file, not
 * the page, and falls through.
 */
export interface AppPage {
  path: string;
  html: string;
  signIn?: boolean;
  headers?: Record<string, string>;
  passFiles?: boolean;
}

/** One declaration per app, read by the shell, the registry and the consent
 * page (§6.1). `events` lists the types it publishes into the organization's log. */
export interface AppManifest {
  name: string;
  /** Where its client lives; none for an app without a page (Events). */
  path?: string;
  scope: AppScope;
  object?: { className: string; migrationTag: string };
  /** Its Hono module, `src/routes/<routes>.ts` in the Worker. */
  routes?: string;
  /**
   * The object and container kinds it owns, each with its reference resolver (§5.3, GET /v1/references): `org`, the Org
   * object answers (Chat's own kinds, and anything in the share index); `app`, this app's object is asked for what the
   * share index does not hold. A kind without one is not resolved for anyone (Mail's: mail is not shareable). An
   * account-scoped app's `app` kinds are asked of the object of the account their id begins with (`<accountId>:<rest>`),
   * else of the reader's own; the object answers `describe(caller, channelIds, kind, id)`.
   *
   * `address` is where one opens, a path with `{id}` (`/contacts/?contact={id}`), `icon` its chip's glyph and `label` what
   * a chip calls it: @flow/shared/addresses reads them for the kinds it has no entry of its own for.
   */
  kinds: { kind: string; container?: boolean; resolve?: 'org' | 'app'; address?: string; icon?: string; label?: string }[];
  /** Its tools, by name: their definitions are @flow/shared/tools' TOOL_DEFINITIONS (§5.4). */
  tools?: string[];
  /** The consent page's groups for its scopes, in the order the page lists them. */
  scopes?: AppScopeGroup[];
  /**
   * What it gives the assistant (§5.5): the `context.page` values its pages send with a turn. A turn from one of them is
   * offered this app's browser tools (the registry's), beside every server tool.
   */
  assistant?: { pages: string[] };
  /** The suite-bar entry; `shortcut` is the digit after ⌘. */
  tab?: { label: string; shortcut: string; badge?: AppTabBadge };
  /** The Vite build folder (from the repository's root) and the path it is served under. `optional`: a deploy may lack it. */
  client?: { dist: string; basePath: string; optional?: boolean };
  pages?: AppPage[];
  events: string[];
}
