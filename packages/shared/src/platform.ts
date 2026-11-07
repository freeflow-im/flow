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
 * outside, a system event); `causedBy` is the job id that caused it. */
export interface PlatformEvent<T = unknown> {
  id: string;
  seq: number;
  type: string;
  organizationId: string;
  actor: string | null;
  ref?: Reference;
  channelId?: string;
  causedBy?: string;
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

/** How a subscription is told of a match (§5.2, "Delivery modes"). */
export const DELIVERY_MODES = ['pull', 'socket', 'webhook', 'wake'] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

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

/** A person or an agent: how someone signs in and nothing more (§2.1).
 * `sponsorId` is required for an agent and names a person principal. */
export interface PrincipalDTO {
  id: string;
  kind: PrincipalKind;
  loginEmail: string;
  displayName: string;
  sponsorId?: string;
  status: PrincipalStatus;
  createdAt: string;
}

// ---- organizations and accounts (§3.3) --------------------------------------

export const ACCOUNT_ROLES = ['owner', 'admin', 'member'] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

/** `native` has a mailbox; `guest` is reserved (§3.3, §9). */
export const ACCOUNT_KINDS = ['native', 'guest'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

/** The provisioning states (§3.4), then active, suspended, removed. */
export const ACCOUNT_STATES = ['requested', 'mailbox_ready', 'calendars_ready', 'active', 'suspended', 'removed'] as const;
export type AccountState = (typeof ACCOUNT_STATES)[number];

/** One principal in one organization (§3.3). Mail and Calendar are keyed by `id`. */
export interface AccountDTO {
  id: string;
  principalId: string;
  organizationId: string;
  address: string;
  displayName: string;
  role: AccountRole;
  kind: AccountKind;
  state: AccountState;
  createdAt: string;
}

// ---- apps (§6.1) ------------------------------------------------------------

/** One object per organization, or one per account (§6.1). */
export const APP_SCOPES = ['organization', 'account'] as const;
export type AppScope = (typeof APP_SCOPES)[number];

/** One declaration per app, read by the shell, the registry and the consent
 * page (§6.1). `events` lists the types it publishes into the organization's log. */
export interface AppManifest {
  name: string;
  path: string;
  scope: AppScope;
  object?: { className: string; migrationTag: string };
  kinds: { kind: string; container?: boolean }[];
  tools?: string[];
  scopes?: string[];
  tab?: { label: string; shortcut?: string };
  client?: { dist: string; basePath: string };
  events: string[];
}
