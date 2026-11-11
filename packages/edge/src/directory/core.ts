// Identity: accounts, sessions and sign-in. Ported from packages/server/src/services/auth.ts and oauthAccounts.ts, with
// the same rules and the same mail. It runs over any `SqlStorage`-shaped database, so tests can use node:sqlite.
import type { AccountDTO, AccountKind, AgentMode, AccountRole, AccountState, AuthResponse, DnsRecordDTO, DomainDTO, DomainKind, OAuthIdentityDTO, RegisterResponse, UserDTO } from '@flow/shared';
import { ApiError, badRequest, conflict, forbidden, notFound, unauthorized } from '../errors';
import { hashPassword, verifyPassword } from './passwords';
import { DIRECTORY_MIGRATIONS } from './schema';
import { newId } from './ids';
import { personalAgentFor, revokePersonalAgent } from './agents';
import { PLATFORM_DOMAIN, localPart, organizationDomain, uniqueAddress } from './addresses';
import { checkDomain, checkRecords, dohResolver, normalizeDomain, recordsFor, type Resolve } from './dns';
import { DEFAULT_DOMAIN_LIMITS, ProviderError, noneMailProvider, type DkimRecord, type MailProvider } from '../mailprovider/index';
import { generateDkimKey } from '../mailprovider/dkim';
import { encryptBlob } from '../org/crypto/index';
import { HandoffApprove, HandoffExchange, HandoffStart, parseBody, pkceChallenge, validateContext, type HandoffContext, type HandoffPolicy } from './authHandoff';

export interface Sql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

export interface Mail { to: string; subject: string; text: string }

export interface DirectoryDeps {
  webUrlBase: string;
  registrationEnabled: boolean;
  send(mail: Mail): Promise<void>;
  /** FLOW_HANDOFF_RETURN_URLS and FLOW_ALLOWED_WEB_ORIGINS, for the web-to-app handoff. Without return URLs it is off. */
  handoffReturnUrls?: string[];
  allowedWebOrigins?: string[];
  /** DNS lookups for domain verification and the records checker (dns.ts). Cloudflare's DNS over HTTPS by default. */
  resolve?: Resolve;
  /** The hosted mail provider (mailprovider/index.ts `mailProviderFor`); `none`, with placeholder records, when unset. */
  mailProvider?: MailProvider;
  /** A provider and the `flow-provisioning` Queue are there: new accounts start `requested` and get a mailbox (§3.4). */
  provisioning?: boolean;
}

/** A message to the `flow-provisioning` Queue (provisioning/consumer.ts): make, suspend, resume or delete an account's
 * hosted mailbox (and, for `provision`, its native calendars). */
export type ProvisioningKind = 'provision' | 'suspend' | 'resume' | 'delete';
export interface ProvisioningMessage { kind: ProvisioningKind; organizationId: string; accountId: string }

/** What a provisioning run needs to know about an account: the account, its domain's row, and whether it has its mailbox. */
export interface ProvisioningTarget {
  account: AccountDTO;
  domain: DomainRow | null;
  /** Whether the domain was made at the provider already (with its platform DNS). */
  domainAtProvider: boolean;
  slug: string;
  hosted: boolean;
  removedAt: string | null;
  /** The hosted mailbox's address: the account's own, or, for a guest, the one it had when it became a guest (null once
   * the mailbox is deleted). Suspend, resume and delete go by it. */
  mailboxAddress: string | null;
}

/** One of an organization's domains, as the directory keeps it. */
export interface DomainRow {
  domain: string;
  organizationId: string;
  kind: DomainKind;
  verifyToken: string | null;
  verified: boolean;
  primary: boolean;
  /** When the domain was made at the mail provider (`setDomainAtProvider`), or null. */
  providerAt: string | null;
  createdAt: string;
}

export type AuthKind = 'session' | 'agent';
export type OAuthProvider = 'google' | 'apple';
export interface OAuthProfile { provider: OAuthProvider; sub: string; email: string; hostedDomain: string | null; name?: string | undefined }

const DAY = 86_400_000;
const SESSION_TTL_DAYS = 30;
const VERIFY_TTL_HOURS = 48;
const RESET_TTL_MINUTES = 60;
const SIGNIN_TTL_MINUTES = 15;
const APP_LINK_TTL = 2 * 60_000;
const DESKTOP_HANDOFF_TTL = 10 * 60_000;
/** How long the ChatGPT plugin's server has to trade a cross-host sign-in key (routes/crossHost.ts): one redirect's worth. */
const CROSS_HOST_HANDOFF_TTL = 2 * 60_000;
const AGENT_TOUCH = 60_000;
const HANDOFF_TTL = 10 * 60_000;
const HANDOFF_CODE_TTL = 60_000;
const HANDOFF_RATE_WINDOW = 10 * 60_000;
/** How long a domain's records check is reused: the admin page reloads, and every load would otherwise be lookups. */
const DOMAIN_STATUS_TTL = 60_000;
/** "Check again" skips the cache, but not for a check younger than this. */
const DOMAIN_STATUS_MIN_AGE = 5_000;
/** An unverified domain older than this no longer holds its name against another organization (platform.md §3.2). */
const DOMAIN_CLAIM_TTL = 7 * DAY;

/** A provider's failure as the API's: its code under `mail_provider_`, its message (never a credential). */
function providerFailure(err: unknown): never {
  if (!(err instanceof ProviderError)) throw err;
  const status = err.code === 'rate_limited' ? 429 : err.code === 'unavailable' ? 503 : err.code === 'conflict' || err.code === 'pending' ? 409 : 502;
  throw new ApiError(status, `mail_provider_${err.code}`, err.message);
}

type Row = Record<string, unknown>;

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Buffer.from(digest).toString('hex');
}
export const newToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');

export { newId } from './ids';

const iso = (ms: unknown) => new Date(ms as number).toISOString();

/** A privacy-mode address goes out as '': the native clients decode `email` as a non-optional string. */
export function toUserDTO(u: Row, viewerId?: string): UserDTO {
  return {
    id: u.id as string,
    email: u.privacy_mode && u.id !== viewerId ? '' : (u.email as string),
    privacyMode: !!u.privacy_mode,
    displayName: u.display_name as string,
    avatarUrl: (u.avatar_url as string | null) ?? null,
    timezone: u.timezone as string,
    statusEmoji: u.status_emoji as string,
    statusText: u.status_text as string,
    website: u.website as string,
    bio: u.bio as string,
    title: u.title as string,
    isAgent: !!u.is_agent,
    sponsorId: u.is_agent ? ((u.sponsor_user_id as string | null) ?? null) : null,
    agentMode: u.is_agent ? ((u.mode as AgentMode | null) ?? null) : null,
    notificationPrefs: JSON.parse(u.notification_prefs as string),
    statusSuppressAlerts: !!u.status_suppress_alerts,
    createdAt: iso(u.created_at),
  } as UserDTO;
}

/**
 * Whether an account may act in its organization (platform.md §3.6): a refusal for a suspended or removed one, else null.
 * No account is not refused here: the route decides whether a caller from outside the organization may go on.
 */
export function accountGate(account: Pick<AccountDTO, 'state'> | null): ApiError | null {
  if (account?.state === 'suspended') return new ApiError(403, 'account_inactive', 'your account in this organization is suspended');
  if (account?.state === 'removed') return new ApiError(403, 'account_inactive', 'your account in this organization was removed');
  return null;
}

export class DirectoryCore {
  private readonly domainStatus = new Map<string, { at: number; status: { record: 'present' | 'missing' }[] }>();
  /** Provisioning messages made by the last call, which the object sends to the Queue after it (directory/object.ts). */
  private provisioningOutbox: ProvisioningMessage[] = [];

  constructor(private readonly sql: Sql, private readonly deps: DirectoryDeps) {
    this.sql.exec('CREATE TABLE IF NOT EXISTS _migrations (n INTEGER PRIMARY KEY)');
    const done = (this.sql.exec('SELECT COALESCE(MAX(n), -1) AS n FROM _migrations').toArray()[0]!.n as number) + 1;
    DIRECTORY_MIGRATIONS.slice(done).forEach((m, i) => {
      this.sql.exec(m);
      this.sql.exec('INSERT INTO _migrations (n) VALUES (?)', done + i);
    });
    if (!this.rows('SELECT 1 FROM accounts LIMIT 1').length && this.rows('SELECT 1 FROM memberships LIMIT 1').length) this.backfillAccounts();
    if (this.rows('SELECT 1 FROM users WHERE is_agent = 1 AND mode IS NULL AND deleted_at IS NULL LIMIT 1').length
      || this.rows("SELECT 1 FROM oauth_connections c WHERE c.agent_id IS NULL AND EXISTS (SELECT 1 FROM accounts a WHERE a.user_id = c.user_id AND a.organization_id = c.org_id AND a.state <> 'removed') LIMIT 1").length) this.backfillAgents();
  }

  /**
   * Agents made before they had kinds (docs/specs/agents.md phase A), retired once: every account removed (a hosted
   * mailbox suspended, then deleted after retention), every token revoked, the principal marked deleted. The operator's
   * ruling (decision_log 2026-11-11) was to start over rather than place them: an agent in several organizations has no
   * one home to pick, and each is connected again with an invite code, which makes a new principal of a known kind. The
   * Org objects drop them from their rosters at their next start (Org.retireRemovedAgents). Every /mcp connection gets its
   * personal agent, one per sponsor, client and organization. Safe to run twice.
   */
  backfillAgents(): void {
    const now = Date.now();
    for (const u of this.rows('SELECT id, display_name FROM users WHERE is_agent = 1 AND mode IS NULL AND deleted_at IS NULL')) {
      const orgs = this.rows("SELECT organization_id FROM accounts WHERE user_id = ? AND state <> 'removed'", u.id).map((a) => a.organization_id as string);
      console.log(`[agents] ${u.display_name as string} (${u.id as string}) made before agents had kinds is retired from ${orgs.length ? orgs.join(', ') : 'no organization'}; connect it again with an invite code`);
      this.sql.exec('UPDATE agent_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', now, u.id);
      this.removeAccounts('user_id = ?', u.id);
      this.sql.exec("UPDATE accounts SET status_message = 'retired when agents gained kinds; connect the agent again with an invite code' WHERE user_id = ?", u.id);
      this.sql.exec("UPDATE users SET mode = 'shared', deleted_at = ? WHERE id = ?", now, u.id);
    }
    const connections = this.rows(
      "SELECT DISTINCT c.user_id, c.org_id, c.client_name FROM oauth_connections c WHERE c.agent_id IS NULL AND EXISTS (SELECT 1 FROM accounts a WHERE a.user_id = c.user_id AND a.organization_id = c.org_id AND a.state <> 'removed')");
    for (const c of connections) {
      try {
        const agentId = personalAgentFor(this.sql, c.user_id as string, c.org_id as string, c.client_name as string);
        this.sql.exec('UPDATE oauth_connections SET agent_id = ? WHERE user_id = ? AND org_id = ? AND client_name = ? AND agent_id IS NULL', agentId, c.user_id, c.org_id, c.client_name);
      } catch (err) {
        console.error(`[agents] no personal agent for ${c.client_name as string} of ${c.user_id as string} in ${c.org_id as string}: ${(err as Error).message}`);
      }
    }
  }

  /** An account for every membership that has none, with its address. Safe to run twice; the constructor runs it the
   * first time it sees the accounts migration; an import that adds memberships later may call it again. */
  backfillAccounts(): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO organizations (id, slug, owner_user_id, created_at)
       SELECT s.organization_id, MIN(s.slug),
         (SELECT MIN(m.user_id) FROM memberships m WHERE m.organization_id = s.organization_id AND m.role = 'owner'), ?
       FROM organization_slugs s GROUP BY s.organization_id`, Date.now());
    for (const o of this.rows('SELECT id FROM organizations')) this.ensurePlatformDomain(o.id as string);
    const missing = this.rows(
      `SELECT m.user_id, m.organization_id, m.role FROM memberships m
       LEFT JOIN accounts a ON a.user_id = m.user_id AND a.organization_id = m.organization_id
       WHERE a.id IS NULL ORDER BY m.organization_id, m.user_id`);
    // Existing members stay active and native; POST /v1/workspaces/:id/provision gives them their mailboxes.
    for (const m of missing) this.createAccount(m.user_id as string, m.organization_id as string, m.role as string, undefined, false, 'native');
  }

  /** The provisioning messages the calls since the last take made, once. */
  takeProvisioning(): ProvisioningMessage[] {
    const out = this.provisioningOutbox;
    this.provisioningOutbox = [];
    return out;
  }

  private enqueue(kind: ProvisioningKind, organizationId: string, accountId: string): void {
    if (this.deps.provisioning) this.provisioningOutbox.push({ kind, organizationId, accountId });
  }

  /** The domain label of an organization's addresses: its slug, or its id when it was made without one. */
  private organizationSlug(organizationId: string): string {
    return (this.rows('SELECT slug FROM organizations WHERE id = ?', organizationId)[0]?.slug as string | undefined)
      ?? (this.rows('SELECT MIN(slug) AS slug FROM organization_slugs WHERE organization_id = ?', organizationId)[0]?.slug as string | null | undefined)
      ?? organizationId;
  }

  /** Whether an address is held: by an account, or by a mailbox kept after its account became a guest (whose mail must
   * not go to whoever got the address next). */
  private addressTaken(address: string): boolean {
    return this.rows('SELECT 1 FROM addresses WHERE address = ? UNION ALL SELECT 1 FROM accounts WHERE mailbox_address = ? LIMIT 1', address, address).length > 0;
  }

  /** A new address for a principal in an organization, on the primary domain as it is now. Making another domain
   * primary later does not move existing addresses. */
  private newAddress(user: Row, name: string, organizationId: string): string {
    const local = localPart(user.is_agent && user.agent_username ? (user.agent_username as string) : name);
    return uniqueAddress(local, this.primaryDomainOf(organizationId), (a) => this.addressTaken(a));
  }

  /** What a new account is (platform.md §3.3): what the join asked for (an invitation's kind, docs/specs/workspace-admin.md
   * §6.5), else `native`. An owner is always native, and so is an agent: an agent is brought in to work, and its mailbox and
   * calendar are part of that (operator rulings, decision_log 2026-11-09). */
  private defaultKind(_organizationId: string, role: string, user: Row, asked?: AccountKind): AccountKind {
    // A personal agent's account holds nothing (agents.md §2, rule 4); a shared agent is always native.
    if (user.is_agent) return user.mode === 'personal' ? 'personal_agent' : 'native';
    if (role === 'owner') return 'native';
    return asked === 'personal_agent' ? 'native' : (asked ?? 'native');
  }

  private createAccount(userId: string, organizationId: string, role: string, displayName?: string, provision = true, kind?: AccountKind): void {
    const user = this.userById(userId);
    if (!user) return;
    const name = displayName || (user.display_name as string);
    const accountKind = this.defaultKind(organizationId, role, user, kind);
    // A guest has no address (§3.3): an address with no mailbox behind it bounces. Nor has a personal agent (agents.md §2).
    const address = accountKind === 'guest' || accountKind === 'personal_agent' ? null : this.newAddress(user, name, organizationId);
    const id = newId();
    // With a provider, a native account starts at the head of the state machine (§3.4); Chat and Docs work from there.
    // A guest has nothing to provision and starts active.
    const requested = provision && !!this.deps.provisioning && accountKind === 'native';
    // An agent's sponsor here starts as its principal's; the member row's own sponsor follows on the join (applyOrgChanges).
    this.sql.exec('INSERT INTO accounts (id, user_id, organization_id, address, display_name, role, kind, sponsor_user_id, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, userId, organizationId, address, name, role, accountKind, user.is_agent ? ((user.sponsor_user_id as string | null) ?? null) : null, requested ? 'requested' : 'active', Date.now());
    if (address) this.sql.exec('INSERT INTO addresses (address, account_id) VALUES (?, ?)', address, id);
    if (requested) this.enqueue('provision', organizationId, id);
  }

  /** Marks accounts removed (those not already), starting their retention clock; each hosted mailbox is suspended. */
  private removeAccounts(where: string, ...args: unknown[]): void {
    const gone = this.rows(`UPDATE accounts SET state = 'removed', removed_at = ? WHERE ${where} AND state <> 'removed' RETURNING id, organization_id, hosted_at`, Date.now(), ...args);
    for (const a of gone) if (a.hosted_at != null) this.enqueue('suspend', a.organization_id as string, a.id as string);
  }

  private accountRow(where: string, ...args: unknown[]): AccountDTO[] {
    // An agent's mode rides along (agents.md §2) by subquery: a join would make `organization_id` ambiguous in `where`.
    return this.rows(`SELECT *, (SELECT u.mode FROM users u WHERE u.id = accounts.user_id AND u.is_agent = 1) AS agent_mode FROM accounts WHERE ${where} ORDER BY created_at, id`, ...args).map((a) => ({
      id: a.id as string,
      principalId: a.user_id as string,
      organizationId: a.organization_id as string,
      address: (a.address as string | null) ?? null,
      displayName: a.display_name as string,
      role: a.role as AccountRole,
      kind: a.kind as AccountKind,
      state: a.state as AccountState,
      statusMessage: (a.status_message as string | null) ?? null,
      hosted: a.hosted_at != null,
      ...(a.sponsor_user_id || a.agent_mode ? { sponsorId: (a.sponsor_user_id as string | null) ?? null, agentMode: (a.agent_mode as AgentMode | null) ?? null } : {}),
      createdAt: iso(a.created_at),
    }));
  }

  /** Every account a principal holds, removed ones included: the state says which. */
  accountsOf(userId: string): AccountDTO[] {
    return this.accountRow('user_id = ?', userId);
  }

  accountFor(userId: string, organizationId: string): AccountDTO | null {
    return this.accountRow('user_id = ? AND organization_id = ?', userId, organizationId)[0] ?? null;
  }

  /** Every principal with its accounts, removed ones included (in order made): the move of Mail and Calendar to the
   * per-account objects (routes/admin.ts) walks them. */
  principalsWithAccounts(): { userId: string; accounts: AccountDTO[] }[] {
    const byUser = new Map<string, AccountDTO[]>(this.rows('SELECT id FROM users ORDER BY id').map((u) => [u.id as string, []]));
    for (const a of this.accountRow('1 = 1')) byUser.set(a.principalId, [...(byUser.get(a.principalId) ?? []), a]);
    return [...byUser].map(([userId, accounts]) => ({ userId, accounts }));
  }

  /** Every account in an organization, removed ones included. */
  accountsOfOrganization(organizationId: string): AccountDTO[] {
    return this.accountRow('organization_id = ?', organizationId);
  }

  /** A joiner's account, asked for by the Org object before it writes the member row so the row can carry the address:
   * made when missing, reactivated when removed, its role set otherwise. The outbox's `join` repeats this later and
   * changes nothing. A principal the directory does not know is a 404. */
  ensureAccount(userId: string, organizationId: string, role: string, displayName?: string, kind?: AccountKind): AccountDTO {
    if (!this.userById(userId)) throw notFound('user not found');
    this.joinAccount(userId, organizationId, role, displayName, kind);
    return this.accountFor(userId, organizationId)!;
  }

  accountById(id: string): AccountDTO | null {
    return this.accountRow('id = ?', id)[0] ?? null;
  }

  // ---- provisioning (platform.md §3.4, provisioning/consumer.ts) -----------------------------------------------

  /** The account a provisioning message names, with its domain, or null when it is gone. */
  provisioningTarget(accountId: string): ProvisioningTarget | null {
    const row = this.rows('SELECT * FROM accounts WHERE id = ?', accountId)[0];
    const account = this.accountById(accountId);
    if (!row || !account) return null;
    const mailboxAddress = account.address ?? (row.mailbox_address as string | null) ?? null;
    const domainName = mailboxAddress ? mailboxAddress.slice(mailboxAddress.lastIndexOf('@') + 1) : null;
    const domain = domainName ? this.domainRow('domain = ? AND organization_id = ?', domainName, account.organizationId)[0] ?? null : null;
    const atProvider = domain ? this.rows('SELECT provider_at FROM domains WHERE domain = ?', domain.domain)[0]?.provider_at != null : false;
    return {
      account, domain, domainAtProvider: atProvider, slug: this.organizationSlug(account.organizationId),
      hosted: row.hosted_at != null, removedAt: row.removed_at != null ? iso(row.removed_at) : null, mailboxAddress,
    };
  }

  /** Moves an account along the state machine, with why it stopped (null clears it). A removed account stays removed. */
  setAccountState(accountId: string, state: AccountState, statusMessage: string | null = null): void {
    this.sql.exec("UPDATE accounts SET state = CASE WHEN state = 'removed' THEN state ELSE ? END, status_message = ? WHERE id = ?", state, statusMessage, accountId);
  }

  /** Whether the account's hosted mailbox exists (made, or deleted after the retention period). A guest's deleted
   * mailbox lets go of its address. */
  setHosted(accountId: string, hosted: boolean): void {
    if (hosted) this.sql.exec('UPDATE accounts SET hosted_at = ? WHERE id = ?', Date.now(), accountId);
    else this.sql.exec('UPDATE accounts SET hosted_at = NULL, mailbox_address = NULL WHERE id = ?', accountId);
  }

  /** The domain is made at the provider, with its platform DNS written. */
  setDomainAtProvider(domain: string): void {
    this.sql.exec('UPDATE domains SET provider_at = COALESCE(provider_at, ?) WHERE domain = ?', Date.now(), domain);
  }

  /** Every native account of the organization with no hosted mailbox, neither removed nor suspended, sent to be
   * provisioned (existing members, and any whose run stopped). Guests have no mailbox to make. Returns how many. */
  provisionMissing(organizationId: string): number {
    if (!this.deps.provisioning) throw conflict('hosted_mail_off', 'no mail provider is configured');
    const missing = this.rows("SELECT id FROM accounts WHERE organization_id = ? AND kind = 'native' AND hosted_at IS NULL AND state NOT IN ('removed', 'suspended') ORDER BY created_at, id", organizationId);
    for (const a of missing) this.enqueue('provision', organizationId, a.id as string);
    return missing.length;
  }

  /** One account sent to be provisioned (the operator's route): it must be native, have no mailbox yet and not be
   * removed or suspended. Returns whether it was sent. */
  provisionAccount(accountId: string): boolean {
    if (!this.deps.provisioning) throw conflict('hosted_mail_off', 'no mail provider is configured');
    const a = this.rows("SELECT id, organization_id FROM accounts WHERE id = ? AND kind = 'native' AND hosted_at IS NULL AND state NOT IN ('removed', 'suspended')", accountId)[0];
    if (!a) return false;
    this.enqueue('provision', a.organization_id as string, a.id as string);
    return true;
  }

  /** The daily sweep (the Org object's alarm): mailboxes that have outlived the retention period, sent to be deleted —
   * a removed account's since its removal, a guest's since it became a guest. Returns how many. */
  sweepRemoved(organizationId: string, retentionDays: number): number {
    const before = Date.now() - retentionDays * DAY;
    const due = this.rows(
      `SELECT id FROM accounts WHERE organization_id = ? AND hosted_at IS NOT NULL AND (
         (state = 'removed' AND removed_at IS NOT NULL AND removed_at < ?)
         OR (state <> 'removed' AND kind = 'guest' AND kind_changed_at IS NOT NULL AND kind_changed_at < ?))`,
      organizationId, before, before);
    for (const a of due) this.enqueue('delete', organizationId, a.id as string);
    return due.length;
  }

  accountByAddress(address: string): AccountDTO | null {
    return this.accountRow('address = ?', address)[0] ?? null;
  }

  organization(id: string): { id: string; slug: string; ownerUserId: string | null; policies: Record<string, unknown> } | null {
    const o = this.rows('SELECT * FROM organizations WHERE id = ?', id)[0];
    return o ? { id: o.id as string, slug: o.slug as string, ownerUserId: (o.owner_user_id as string | null) ?? null, policies: JSON.parse(o.policies as string) } : null;
  }

  setOwner(organizationId: string, userId: string): void {
    this.sql.exec('UPDATE organizations SET owner_user_id = ? WHERE id = ?', userId, organizationId);
  }

  setPolicies(organizationId: string, policies: Record<string, unknown>): void {
    this.sql.exec('UPDATE organizations SET policies = ? WHERE id = ?', JSON.stringify(policies), organizationId);
  }

  /**
   * Makes an account native or a guest (platform.md §3.3), for its organization's owner or admin (routes/accounts.ts).
   * To a guest: its address is let go and it has none; a hosted mailbox is suspended now and deleted by the daily sweep
   * after the retention period, its address held until then. To native: the address it had comes back while its mailbox
   * is kept (and the mailbox is resumed), else it gets a new one on the primary domain and is sent to be provisioned.
   * An owner cannot be a guest. Returns the account as it is now.
   */
  setAccountKind(organizationId: string, accountId: string, kind: AccountKind): AccountDTO {
    const row = this.rows('SELECT * FROM accounts WHERE id = ? AND organization_id = ?', accountId, organizationId)[0];
    if (!row) throw notFound('account not found');
    if (row.kind === 'personal_agent' || kind === 'personal_agent') throw conflict('personal_agent', "a personal agent's account never changes kind");
    if (row.kind !== kind) {
      if (kind === 'guest') this.makeGuest(row);
      else this.makeNative(row);
    }
    return this.accountById(accountId)!;
  }

  /** Every person whose role is `member` made a guest; owners, admins and agents keep their kind. Removed accounts are
   * left. Returns the accounts that changed, and how many were guests already. */
  makeMembersGuests(organizationId: string): { changed: AccountDTO[]; unchanged: number } {
    const members = this.rows("SELECT a.* FROM accounts a JOIN users u ON u.id = a.user_id WHERE a.organization_id = ? AND a.role = 'member' AND a.state <> 'removed' AND u.is_agent = 0 ORDER BY a.created_at, a.id", organizationId);
    const changed: AccountDTO[] = [];
    for (const row of members) {
      if (row.kind === 'guest') continue;
      this.makeGuest(row);
      changed.push(this.accountById(row.id as string)!);
    }
    return { changed, unchanged: members.length - changed.length };
  }

  private makeGuest(row: Row): void {
    if (row.role === 'owner') throw conflict('owner_not_guest', 'the owner cannot be a guest');
    const hosted = row.hosted_at != null;
    // A run part way through the provisioning states has nothing left to do for a guest: it is active.
    this.sql.exec(
      `UPDATE accounts SET kind = 'guest', address = NULL, mailbox_address = ?, kind_changed_at = ?, status_message = NULL,
         state = CASE WHEN state IN ('requested', 'mailbox_ready', 'calendars_ready') THEN 'active' ELSE state END
       WHERE id = ?`,
      hosted ? row.address : null, Date.now(), row.id);
    this.sql.exec('DELETE FROM addresses WHERE account_id = ?', row.id);
    // A removed account's mailbox is suspended already.
    if (hosted && row.state !== 'removed') this.enqueue('suspend', row.organization_id as string, row.id as string);
  }

  private makeNative(row: Row): void {
    const id = row.id as string, organizationId = row.organization_id as string;
    const kept = row.hosted_at != null && row.mailbox_address ? (row.mailbox_address as string) : null;
    let address = kept;
    if (!address) {
      const user = this.userById(row.user_id as string);
      if (!user) throw notFound('user not found');
      address = this.newAddress(user, row.display_name as string, organizationId);
    }
    this.sql.exec("UPDATE accounts SET kind = 'native', address = ?, mailbox_address = NULL, kind_changed_at = ? WHERE id = ?", address, Date.now(), id);
    this.sql.exec('INSERT OR REPLACE INTO addresses (address, account_id) VALUES (?, ?)', address, id);
    if (row.state === 'removed' || row.state === 'suspended') return;
    // An active account with no mailbox is given one and its calendar, and stays active (provisioning/steps.ts).
    this.enqueue(kept ? 'resume' : 'provision', organizationId, id);
  }

  /** A join's account: made when missing, reactivated with the new role when removed, its role updated otherwise. */
  private joinAccount(userId: string, organizationId: string, role: string, displayName?: string, kind?: AccountKind): void {
    this.placeAgent(userId, organizationId);
    this.sql.exec('INSERT OR IGNORE INTO organizations (id, slug, created_at) VALUES (?, ?, ?)', organizationId, this.organizationSlug(organizationId), Date.now());
    this.ensurePlatformDomain(organizationId);
    if (role === 'owner') this.sql.exec('UPDATE organizations SET owner_user_id = ? WHERE id = ? AND owner_user_id IS NULL', userId, organizationId);
    const existing = this.rows('SELECT * FROM accounts WHERE user_id = ? AND organization_id = ?', userId, organizationId)[0];
    if (!existing) return this.createAccount(userId, organizationId, role, displayName, true, kind);
    this.sql.exec('UPDATE accounts SET role = ? WHERE id = ?', role, existing.id);
    // An owner is never a guest (§3.3): a guest made owner (not by the transfer route, which refuses) becomes native.
    if (role === 'owner' && existing.kind === 'guest') this.makeNative({ ...existing, role });
    if (existing.state !== 'removed') return;
    if (existing.kind === 'guest' && role !== 'owner') {
      // A guest back in has no mailbox to make or resume.
      this.sql.exec("UPDATE accounts SET state = 'active', removed_at = NULL, status_message = NULL WHERE id = ?", existing.id);
      return;
    }
    // Back in (§3.4): a kept mailbox is resumed; one deleted after the retention period (or never made) is made again.
    const id = existing.id as string;
    const remake = !!this.deps.provisioning && existing.hosted_at == null;
    this.sql.exec('UPDATE accounts SET state = ?, removed_at = NULL, status_message = NULL WHERE id = ?', remake ? 'requested' : 'active', id);
    if (remake) this.enqueue('provision', organizationId, id);
    else if (existing.hosted_at != null) this.enqueue('resume', organizationId, id);
  }

  /**
   * An agent belongs to one organization (agents.md §1): the first it joins places it (a bridge agent, as `shared`), and a
   * join anywhere else is refused, so the agent never quietly gains access. A person is not placed. The Org object gets
   * the refusal at redeem, before any member row is written.
   */
  private placeAgent(userId: string, organizationId: string): void {
    const u = this.userById(userId);
    if (!u?.is_agent) return;
    if (!u.organization_id) {
      this.sql.exec("UPDATE users SET organization_id = ?, mode = COALESCE(mode, 'shared') WHERE id = ?", organizationId, userId);
      return;
    }
    if (u.organization_id !== organizationId) throw forbidden('this agent belongs to another organization; connect it here with a new name and key');
  }

  private rows(query: string, ...args: unknown[]): Row[] {
    return this.sql.exec(query, ...args).toArray();
  }
  private userById(id: string): Row | undefined {
    return this.rows('SELECT * FROM users WHERE id = ?', id)[0];
  }
  private userByEmail(email: string): Row | undefined {
    return this.rows('SELECT * FROM users WHERE email = ?', email)[0];
  }
  private insertUser(v: { email: string; passwordHash: string; displayName: string }): Row | undefined {
    const now = Date.now();
    return this.rows(
      `INSERT INTO users (id, email, password_hash, display_name, email_verified_at, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (email) DO NOTHING RETURNING *`,
      newId(), v.email, v.passwordHash, v.displayName, now, now,
    )[0];
  }

  /** Every sign-in path ends here, so they all yield the same session. */
  async issueSession(userId: string, clientInfo?: string): Promise<string> {
    const token = newToken();
    const now = Date.now();
    this.sql.exec('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, client_info) VALUES (?, ?, ?, ?, ?)',
      await hashToken(token), userId, now, now + SESSION_TTL_DAYS * DAY, clientInfo ?? null);
    return token;
  }

  private async mintEmailToken(userId: string, purpose: string, ttl: number): Promise<string> {
    const now = Date.now();
    this.sql.exec('DELETE FROM email_tokens WHERE expires_at < ?', now);
    this.sql.exec('DELETE FROM email_tokens WHERE user_id = ? AND purpose = ?', userId, purpose);
    const token = newToken();
    this.sql.exec('INSERT INTO email_tokens (token_hash, user_id, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      await hashToken(token), userId, purpose, now, now + ttl);
    return token;
  }

  private async consumeEmailToken(token: string, purpose: string): Promise<Row | undefined> {
    const used = this.rows('DELETE FROM email_tokens WHERE token_hash = ? AND purpose = ? AND expires_at > ? RETURNING user_id',
      await hashToken(token), purpose, Date.now())[0];
    return used ? this.userById(used.user_id as string) : undefined;
  }

  async register(email: string): Promise<RegisterResponse> {
    if (!this.deps.registrationEnabled) throw new ApiError(403, 'registration_disabled', 'Account registration is disabled on this server');
    const existing = this.userByEmail(email);
    if (existing && !existing.is_bot) {
      await this.deps.send({
        to: email,
        subject: 'You already have a Flow account',
        text: `Hi ${existing.display_name},\n\nSomeone (hopefully you) tried to create a Flow account with this address, but it already has one. You can sign in here:\n\n${this.deps.webUrlBase}/\n\nForgot your password? Use "Forgot password?" on the sign-in screen.\n`,
      });
    } else if (!existing) {
      const now = Date.now();
      this.sql.exec('DELETE FROM pending_signups WHERE expires_at < ?', now);
      this.sql.exec('DELETE FROM pending_signups WHERE email = ?', email);
      const token = newToken();
      this.sql.exec('INSERT INTO pending_signups (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)',
        await hashToken(token), email, now, now + VERIFY_TTL_HOURS * 3_600_000);
      await this.deps.send({
        to: email,
        subject: 'Finish creating your Flow account',
        text: `Welcome to Flow!\n\nConfirm your email address and finish setting up your account:\n\n${this.deps.webUrlBase}/?signup=${token}\n\nThis link expires in ${VERIFY_TTL_HOURS} hours. If you didn't request a Flow account, you can ignore this email.\n`,
      });
    }
    return { requiresVerification: true, email };
  }

  async completeSignup(token: string, displayName: string, password: string, clientInfo?: string): Promise<AuthResponse> {
    if (!this.deps.registrationEnabled) throw new ApiError(403, 'registration_disabled', 'Account registration is disabled on this server');
    const used = this.rows('DELETE FROM pending_signups WHERE token_hash = ? AND expires_at > ? RETURNING email', await hashToken(token), Date.now())[0];
    if (!used) throw unauthorized('invalid or expired signup link');
    const user = this.insertUser({ email: used.email as string, passwordHash: hashPassword(password), displayName });
    if (!user) throw conflict('email_taken', 'an account with this email already exists');
    return { token: await this.issueSession(user.id as string, clientInfo), user: toUserDTO(user, user.id as string) };
  }

  async login(email: string, password: string, clientInfo?: string): Promise<AuthResponse> {
    const user = this.userByEmail(email);
    if (!user || !(await verifyPassword(user.password_hash as string, password))) throw unauthorized('invalid email or password');
    if ((user.password_hash as string).startsWith('scrypt$')) this.sql.exec('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), user.id);
    if (!user.email_verified_at && !user.is_bot) {
      throw new ApiError(403, 'email_not_verified', 'this email is unverified — use "Forgot password?" to verify it');
    }
    return { token: await this.issueSession(user.id as string, clientInfo), user: toUserDTO(user, user.id as string) };
  }

  async forgotPassword(email: string): Promise<void> {
    const user = this.userByEmail(email);
    if (!user || user.is_bot) return;
    const token = await this.mintEmailToken(user.id as string, 'password_reset', RESET_TTL_MINUTES * 60_000);
    await this.deps.send({
      to: user.email as string,
      subject: 'Reset your Flow password',
      text: `Hi ${user.display_name},\n\nSomeone (hopefully you) asked to reset the password for this Flow account.\n\n${this.deps.webUrlBase}/?reset=${token}\n\nThis link expires in ${RESET_TTL_MINUTES} minutes and can be used once. If you didn't ask for this, you can ignore this email — your password is unchanged.\n`,
    });
  }

  /** Sets the password, ends every existing session and signs in fresh. The link proves the address, so it verifies too. */
  async resetPassword(token: string, password: string, clientInfo?: string): Promise<AuthResponse> {
    const user = await this.consumeEmailToken(token, 'password_reset');
    if (!user) throw unauthorized('invalid or expired reset link');
    this.sql.exec('UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?', hashPassword(password), Date.now(), user.id);
    this.sql.exec('DELETE FROM sessions WHERE user_id = ?', user.id);
    return { token: await this.issueSession(user.id as string, clientInfo), user: toUserDTO(user, user.id as string) };
  }

  async sendSigninLink(email: string): Promise<void> {
    const user = this.userByEmail(email);
    if (!user || user.is_bot) return;
    const token = await this.mintEmailToken(user.id as string, 'signin', SIGNIN_TTL_MINUTES * 60_000);
    await this.deps.send({
      to: user.email as string,
      subject: 'Your Flow sign-in link',
      text: `Hi ${user.display_name},\n\nSomeone (hopefully you) asked to sign in to Flow with this email.\n\n${this.deps.webUrlBase}/?signin=${token}\n\nThis link expires in ${SIGNIN_TTL_MINUTES} minutes and can be used once. If you didn't ask for this, you can ignore this email — no one can sign in without it.\n`,
    });
  }

  async consumeSigninLink(token: string, clientInfo?: string): Promise<AuthResponse> {
    const user = await this.consumeEmailToken(token, 'signin');
    if (!user) throw unauthorized('invalid or expired sign-in link');
    if (!user.email_verified_at) this.sql.exec('UPDATE users SET email_verified_at = ? WHERE id = ?', Date.now(), user.id);
    return { token: await this.issueSession(user.id as string, clientInfo), user: toUserDTO(user, user.id as string) };
  }

  async logout(token: string): Promise<void> {
    this.sql.exec('DELETE FROM sessions WHERE token_hash = ?', await hashToken(token));
  }

  /** Sessions first, with a sliding expiry written at most daily; then agent tokens, which do not expire but can be revoked. */
  /**
   * A token's principal and, when an organization is named, its account there: the caller context in one call (§3.6).
   * `invokedBy` is an agent's claim of who asked for its turn (agents.md §3): it comes back only when the caller is an agent
   * and the account named is another account of the organization that was not removed, so every object may carry it.
   */
  async authenticateIn(token: string, organizationId: string | null, invokedBy: string | null = null): Promise<{ user: UserDTO; kind: AuthKind; account: AccountDTO | null; invokedBy: string | null }> {
    const { user, kind } = await this.authenticate(token);
    const account = organizationId ? this.accountFor(user.id, organizationId) : null;
    let asker: string | null = null;
    if (invokedBy && kind === 'agent' && organizationId && account && invokedBy !== account.id) {
      const who = this.rows("SELECT 1 AS x FROM accounts WHERE id = ? AND organization_id = ? AND state <> 'removed'", invokedBy, organizationId);
      if (who.length) asker = invokedBy;
    }
    return { user, kind, account, invokedBy: asker };
  }

  async authenticate(token: string): Promise<{ user: UserDTO; kind: AuthKind }> {
    const hash = await hashToken(token);
    const now = Date.now();
    const session = this.rows('SELECT user_id, expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?', hash, now)[0];
    if (session) {
      const user = this.userById(session.user_id as string);
      if (!user || user.deleted_at) throw unauthorized();
      if ((session.expires_at as number) < now + (SESSION_TTL_DAYS - 1) * DAY) {
        this.sql.exec('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', now + SESSION_TTL_DAYS * DAY, hash);
      }
      return { user: toUserDTO(user, user.id as string), kind: 'session' };
    }
    const agent = this.rows('SELECT user_id, last_used_at FROM agent_tokens WHERE token_hash = ? AND revoked_at IS NULL', hash)[0];
    const user = agent && this.userById(agent.user_id as string);
    if (!agent || !user) throw unauthorized();
    if (!agent.last_used_at || now - (agent.last_used_at as number) > AGENT_TOUCH) {
      this.sql.exec('UPDATE agent_tokens SET last_used_at = ? WHERE token_hash = ?', now, hash);
    }
    return { user: toUserDTO(user, user.id as string), kind: 'agent' };
  }

  async createAppLink(userId: string): Promise<{ code: string; expiresAt: string }> {
    const now = Date.now();
    this.sql.exec('DELETE FROM app_link_codes WHERE expires_at < ?', now);
    const code = newToken();
    this.sql.exec('INSERT INTO app_link_codes (code_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', await hashToken(code), userId, now, now + APP_LINK_TTL);
    return { code, expiresAt: iso(now + APP_LINK_TTL) };
  }

  async exchangeAppLink(code: string, clientInfo?: string): Promise<AuthResponse> {
    const used = this.rows('DELETE FROM app_link_codes WHERE code_hash = ? AND expires_at > ? RETURNING user_id', await hashToken(code), Date.now())[0];
    const user = used && this.userById(used.user_id as string);
    if (!user) throw unauthorized('invalid or expired app link code');
    return { token: await this.issueSession(user.id as string, clientInfo), user: toUserDTO(user, user.id as string) };
  }

  /**
   * The MCP Docs desktop app's sign-in (routes/handoff.ts): the person, signed in in their browser, approves the key
   * the app made; the app, asking after it, trades it once for a session of its own.
   */
  async approveDesktopHandoff(key: string, userId: string): Promise<void> {
    const now = Date.now();
    this.sql.exec('DELETE FROM desktop_handoffs WHERE expires_at < ?', now);
    this.sql.exec('INSERT OR REPLACE INTO desktop_handoffs (key_hash, user_id, expires_at) VALUES (?, ?, ?)', await hashToken(key), userId, now + DESKTOP_HANDOFF_TTL);
  }

  async desktopHandoffReady(key: string): Promise<boolean> {
    return this.rows('SELECT 1 FROM desktop_handoffs WHERE key_hash = ? AND expires_at > ?', await hashToken(key), Date.now()).length > 0;
  }

  async exchangeDesktopHandoff(key: string, clientInfo?: string): Promise<string> {
    const used = this.rows('DELETE FROM desktop_handoffs WHERE key_hash = ? AND expires_at > ? RETURNING user_id', await hashToken(key), Date.now())[0];
    const user = used && this.userById(used.user_id as string);
    if (!user || user.deleted_at) throw unauthorized('invalid or expired sign-in key');
    return this.issueSession(user.id as string, clientInfo);
  }

  /**
   * The ChatGPT plugin's sign-in on its own hosts (routes/crossHost.ts): a key for the person signed in here, which the
   * plugin's server trades once, server to server, for who they are, and signs them in on its host. The desktop
   * handoff's table, with a shorter life.
   */
  async createCrossHostHandoff(userId: string): Promise<string> {
    const key = newToken();
    const now = Date.now();
    this.sql.exec('DELETE FROM desktop_handoffs WHERE expires_at < ?', now);
    this.sql.exec('INSERT INTO desktop_handoffs (key_hash, user_id, expires_at) VALUES (?, ?, ?)', await hashToken(key), userId, now + CROSS_HOST_HANDOFF_TTL);
    return key;
  }

  async redeemCrossHostHandoff(key: string): Promise<UserDTO> {
    const used = this.rows('DELETE FROM desktop_handoffs WHERE key_hash = ? AND expires_at > ? RETURNING user_id', await hashToken(key), Date.now())[0];
    const user = used && this.userById(used.user_id as string);
    if (!user || user.deleted_at) throw unauthorized('invalid or expired sign-in key');
    return toUserDTO(user, user.id as string);
  }

  /** The server's `rateAllowDb`: a fixed window per key. True when the call is allowed. */
  private rateAllow(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const count = this.rows(
      `INSERT INTO rate_limit_windows (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
         window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END
       RETURNING count`,
      key, now, now - windowMs, now - windowMs, now)[0]?.count as number | undefined;
    return count === undefined || count <= limit;
  }

  private handoffPolicy(): HandoffPolicy {
    return { webUrlBase: this.deps.webUrlBase, returnUrls: this.deps.handoffReturnUrls ?? [], allowedWebOrigins: this.deps.allowedWebOrigins ?? [] };
  }

  /** The row an approval or exchange names: every part of the context it started with, unexpired. */
  private handoffBinding(body: HandoffContext, requestHash: string): [string, unknown[]] {
    const client = body.clientOrigin === null ? [] : [body.clientOrigin];
    return [
      `request_hash = ? AND connection_id = ? AND operation_id = ? AND state = ? AND server_origin = ? AND
       ${body.clientOrigin === null ? 'client_origin IS NULL' : 'client_origin = ?'} AND return_url = ? AND expires_at > ?`,
      [requestHash, body.connectionId, body.operationId, body.state, body.serverOrigin, ...client, body.returnUrl, Date.now()],
    ];
  }

  /**
   * The web-to-app sign-in handoff (authHandoff.ts), the server's services/handoff.ts. A client with no session starts
   * an operation with its PKCE challenge; `origin` is the request's Origin header and `ip` the caller's address.
   */
  async startHandoff(raw: unknown, origin: string | undefined, ip: string): Promise<{ requestId: string; expiresAt: string }> {
    if (!this.rateAllow(`handoff-start:${ip}`, 30, HANDOFF_RATE_WINDOW)) throw new ApiError(429, 'rate_limited', 'Too many handoff attempts');
    const body = parseBody(HandoffStart, raw);
    validateContext(body, origin, true, this.handoffPolicy());
    const now = Date.now();
    this.sql.exec('DELETE FROM auth_handoffs WHERE expires_at < ?', now);
    this.sql.exec('DELETE FROM rate_limit_windows WHERE window_start < ?', now - DAY);
    const requestId = newToken();
    const expiresAt = now + HANDOFF_TTL;
    this.sql.exec(
      `INSERT INTO auth_handoffs (request_hash, connection_id, operation_id, state, server_origin, client_origin, return_url, code_challenge, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      await hashToken(requestId), body.connectionId, body.operationId, body.state, body.serverOrigin, body.clientOrigin, body.returnUrl, body.codeChallenge, expiresAt);
    return { requestId, expiresAt: iso(expiresAt) };
  }

  /** The person, signed in on the web, approves it: a one-minute code, sent back to the client in its return URL. */
  async approveHandoff(userId: string, raw: unknown): Promise<{ callbackUrl: string; expiresAt: string }> {
    const body = parseBody(HandoffApprove, raw);
    validateContext(body, undefined, false, this.handoffPolicy());
    const code = newToken();
    const codeHash = await hashToken(code);
    const [where, args] = this.handoffBinding(body, await hashToken(body.requestId));
    const expiresAt = Date.now() + HANDOFF_CODE_TTL;
    const row = this.rows(`UPDATE auth_handoffs SET user_id = ?, code_hash = ?, expires_at = ? WHERE ${where} AND code_hash IS NULL RETURNING *`,
      userId, codeHash, expiresAt, ...args)[0];
    if (!row) throw unauthorized('Unknown, expired, or already approved handoff operation');
    const callback = new URL(row.return_url as string);
    // No backend URL or session credential in the callback. The client resolves its pending operation.
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', row.state as string);
    callback.searchParams.set('operationId', row.operation_id as string);
    return { callbackUrl: callback.href, expiresAt: iso(expiresAt) };
  }

  /** The client trades the code and its PKCE verifier, once, for a session of the person who approved. */
  async exchangeHandoff(raw: unknown, origin: string | undefined, ip: string, clientInfo?: string): Promise<AuthResponse> {
    if (!this.rateAllow(`handoff-exchange:${ip}`, 60, HANDOFF_RATE_WINDOW)) throw new ApiError(429, 'rate_limited', 'Too many handoff attempts');
    const body = parseBody(HandoffExchange, raw);
    validateContext(body, origin, true, this.handoffPolicy());
    const [where, args] = this.handoffBinding(body, await hashToken(body.requestId));
    const codeHash = await hashToken(body.code);
    const challenge = await pkceChallenge(body.codeVerifier);
    // Found, checked and used up with no await between: as the server's transaction, a refused person leaves the row.
    const row = this.rows(`SELECT * FROM auth_handoffs WHERE ${where} AND code_hash = ? AND code_challenge = ?`, ...args, codeHash, challenge)[0];
    if (!row?.user_id) throw unauthorized('Invalid, expired, or mismatched handoff');
    const user = this.userById(row.user_id as string);
    if (!user || user.deleted_at || user.is_bot || user.is_agent) throw unauthorized();
    this.sql.exec('DELETE FROM auth_handoffs WHERE request_hash = ?', row.request_hash);
    return { token: await this.issueSession(user.id as string, clientInfo), user: toUserDTO(user, user.id as string) };
  }

  /** Match by (provider, sub), then by verified email, else create a provider-first account. */
  resolveOAuthUser(p: OAuthProfile): string {
    const known = this.rows('SELECT user_id FROM oauth_identities WHERE provider = ? AND provider_subject = ?', p.provider, p.sub)[0];
    if (known) {
      this.sql.exec('UPDATE oauth_identities SET email = ?, hosted_domain = ? WHERE provider = ? AND provider_subject = ?', p.email, p.hostedDomain, p.provider, p.sub);
      return known.user_id as string;
    }
    const link = (userId: string) => this.sql.exec(
      'INSERT INTO oauth_identities (provider, provider_subject, user_id, email, hosted_domain, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      p.provider, p.sub, userId, p.email, p.hostedDomain, Date.now());
    const existing = this.userByEmail(p.email);
    if (existing) {
      if (existing.is_bot || existing.is_agent) throw conflict('email_reserved', 'that email belongs to a bot or agent account');
      if (existing.deleted_at) throw conflict('email_reserved', 'that account has been removed');
      link(existing.id as string);
      if (!existing.email_verified_at) this.sql.exec('UPDATE users SET email_verified_at = ? WHERE id = ?', Date.now(), existing.id);
      return existing.id as string;
    }
    if (!this.deps.registrationEnabled) throw new ApiError(403, 'registration_disabled', 'Account registration is disabled on this server');
    const user = this.insertUser({ email: p.email, passwordHash: `!${p.provider}:${newToken()}`, displayName: p.name?.trim() || p.email.split('@')[0]! });
    if (!user) throw conflict('email_taken', 'an account with this email already exists');
    link(user.id as string);
    return user.id as string;
  }

  async signInWithOAuth(p: OAuthProfile, clientInfo?: string): Promise<AuthResponse> {
    const userId = this.resolveOAuthUser(p);
    const user = this.userById(userId);
    if (!user) throw new ApiError(500, 'internal', 'user vanished during sign-in');
    return { token: await this.issueSession(userId, clientInfo), user: toUserDTO(user, userId) };
  }

  listIdentities(userId: string): OAuthIdentityDTO[] {
    return this.rows('SELECT * FROM oauth_identities WHERE user_id = ?', userId).map((r) => ({
      provider: r.provider as OAuthProvider,
      email: r.email as string,
      hostedDomain: (r.hosted_domain as string | null) ?? null,
      linkedAt: iso(r.created_at),
    })) as OAuthIdentityDTO[];
  }

  /** New ids and membership changes, reported by an organization's object (org/object.ts). Safe to apply twice. */
  async applyOrgChanges(organizationId: string, changes: { kind: string; id: string; user_id: string | null; role: string | null; payload: string | null }[]): Promise<void> {
    for (const c of changes) {
      if (c.kind === 'agent_user') {
        const a = JSON.parse(c.payload!) as { username: string | null; keyHash: string | null; passwordHash: string; email: string; displayName: string; sponsorId: string | null; createdAt: number };
        // Born in an organization's object, so this is its organization, as a shared agent (agents.md §1). A second
        // organization's object reporting the same id is a join elsewhere: skipped, never refused, since this is a report
        // of what that object already wrote, and a refusal would hold up every change behind it in its outbox.
        const known = this.userById(c.id);
        if (known?.is_agent && known.organization_id && known.organization_id !== organizationId) { console.error(`[agents] ${c.id} belongs to ${known.organization_id as string}; its principal reported by ${organizationId} is skipped`); continue; }
        this.sql.exec(
          `INSERT INTO users (id, email, password_hash, display_name, is_agent, sponsor_user_id, agent_username, agent_key_hash, organization_id, mode, email_verified_at, created_at)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 'shared', ?, ?)
           ON CONFLICT (id) DO UPDATE SET display_name = excluded.display_name, agent_username = excluded.agent_username, agent_key_hash = excluded.agent_key_hash,
             organization_id = COALESCE(users.organization_id, excluded.organization_id), mode = COALESCE(users.mode, excluded.mode)`,
          c.id, a.email, a.passwordHash, a.displayName, a.sponsorId, a.username, a.keyHash, organizationId, a.createdAt, a.createdAt);
      } else if (c.kind === 'agent_token') {
        // An agent holds a delegation or a token, never both (agents.md §1): a personal agent gets no token.
        if (this.userById(c.user_id!)?.mode === 'personal') { console.error(`[agents] token for personal agent ${c.user_id!} refused`); continue; }
        this.sql.exec('INSERT OR IGNORE INTO agent_tokens (id, token_hash, user_id, created_at) VALUES (?, ?, ?, ?)', c.id, c.payload, c.user_id, Date.now());
      } else if (c.kind === 'agent_revoke') {
        this.sql.exec('UPDATE agent_tokens SET revoked_at = ? WHERE id = ?', Date.now(), c.id);
      } else if (c.kind === 'domain') {
        if (c.payload) this.sql.exec('INSERT OR REPLACE INTO organization_domains (organization_id, domain) VALUES (?, ?)', organizationId, c.payload);
        else this.sql.exec('DELETE FROM organization_domains WHERE organization_id = ?', organizationId);
      } else if (c.kind === 'token') this.sql.exec('INSERT OR IGNORE INTO id_index (id, organization_id) VALUES (?, ?)', await hashToken(c.id), organizationId);
      else if (c.kind === 'index') this.sql.exec('INSERT OR IGNORE INTO id_index (id, organization_id) VALUES (?, ?)', c.id, organizationId);
      else if (c.kind === 'join') {
        // `memberships` is written for one more release and read by nothing; it is retired in phase 7.
        this.sql.exec('INSERT OR REPLACE INTO memberships (user_id, organization_id, role) VALUES (?, ?, ?)', c.user_id, organizationId, c.role);
        // An agent that belongs elsewhere gets no account here (agents.md §1); the join is skipped, not refused, for the
        // same reason as above. The sync path (ensureAccount, which redeem asks first) is where the refusal reaches the agent.
        try {
          this.joinAccount(c.user_id!, organizationId, c.role!);
        } catch (err) {
          if (!(err instanceof ApiError && err.code === 'forbidden')) throw err;
          console.error(`[agents] join of ${c.user_id!} in ${organizationId} skipped: ${err.message}`);
          continue;
        }
        // A member row's sponsor (an agent's, in this organization) rides on its join.
        if (c.payload) this.sql.exec('UPDATE accounts SET sponsor_user_id = ? WHERE user_id = ? AND organization_id = ?', c.payload, c.user_id, organizationId);
      } else if (c.kind === 'owner') {
        this.setOwner(organizationId, c.user_id!);
      } else if (c.kind === 'policies') {
        this.setPolicies(organizationId, JSON.parse(c.payload ?? '{}') as Record<string, unknown>);
      } else if (c.kind === 'leave') {
        this.sql.exec('DELETE FROM memberships WHERE user_id = ? AND organization_id = ?', c.user_id, organizationId);
        // The organization keeps the account and its address (§3.3), and its mailbox, suspended, for the retention period.
        this.removeAccounts('user_id = ? AND organization_id = ?', c.user_id, organizationId);
        // The agents they sponsor here follow them out (§3.3, rule 2). The Org object removes their member rows first,
        // so this normally finds them gone already; it holds when it does not. Suspension would follow the same way,
        // but nothing suspends an account yet.
        this.removeSponsored(c.user_id!, organizationId);
      }
    }
  }

  /**
   * An admin removes a personal agent (agents.md §2): its account is marked removed, every delegation it acted through is
   * revoked, and its principal tombstoned. The sponsor's own account is untouched. Only a `personal_agent` account here.
   */
  removePersonalAgent(organizationId: string, accountId: string): AccountDTO {
    const a = this.rows("SELECT * FROM accounts WHERE id = ? AND organization_id = ? AND kind = 'personal_agent'", accountId, organizationId)[0];
    if (!a) throw notFound('personal agent not found');
    revokePersonalAgent(this.sql, a.user_id as string);
    this.removeAccounts('id = ?', accountId);
    return this.accountById(accountId)!;
  }

  /** The accounts of the agents a person sponsors, in one organization or (null) in all of them, marked removed. */
  private removeSponsored(sponsorId: string, organizationId: string | null): void {
    const where = organizationId ? 'AND organization_id = ?' : '';
    const args = organizationId ? [sponsorId, organizationId] : [sponsorId];
    for (const a of this.rows(`SELECT user_id, organization_id, kind FROM accounts WHERE sponsor_user_id = ? ${where} AND state <> 'removed'`, ...args)) {
      this.sql.exec('DELETE FROM memberships WHERE user_id = ? AND organization_id = ?', a.user_id, a.organization_id);
      // A personal agent acted as the sponsor who is gone: nothing may act through its delegations now (agents.md §2).
      if (a.kind === 'personal_agent') revokePersonalAgent(this.sql, a.user_id as string);
      this.removeAccounts('user_id = ? AND organization_id = ?', a.user_id, a.organization_id);
    }
  }

  /** A workspace's slug is unique across every organization, which no single object can check. */
  reserveSlug(slug: string, organizationId: string): void {
    const taken = this.rows('INSERT INTO organization_slugs (slug, organization_id) VALUES (?, ?) ON CONFLICT (slug) DO NOTHING RETURNING slug', slug, organizationId);
    if (!taken.length) throw conflict('slug_taken', 'that URL is already taken');
    this.sql.exec('INSERT OR IGNORE INTO organizations (id, slug, created_at) VALUES (?, ?, ?)', organizationId, slug, Date.now());
    this.ensurePlatformDomain(organizationId);
  }

  releaseSlug(slug: string, organizationId: string): void {
    this.sql.exec('DELETE FROM organization_slugs WHERE slug = ? AND organization_id = ?', slug, organizationId);
    const gone = this.rows('DELETE FROM organizations WHERE id = ? AND slug = ? AND NOT EXISTS (SELECT 1 FROM accounts WHERE organization_id = ?) RETURNING id', organizationId, slug, organizationId);
    if (gone.length) {
      this.sql.exec('DELETE FROM domain_keys WHERE domain IN (SELECT domain FROM domains WHERE organization_id = ?)', organizationId);
      this.sql.exec('DELETE FROM domains WHERE organization_id = ?', organizationId);
    }
  }

  // ---- domains (platform.md §3.2) ----------------------------------------------

  /** The organization's `<slug>.freeflow.im`, verified from the start, primary when it has no other. Safe to run twice. */
  private ensurePlatformDomain(organizationId: string): void {
    const now = Date.now();
    this.sql.exec(
      `INSERT OR IGNORE INTO domains (domain, organization_id, kind, verified_at, is_primary, created_at)
       SELECT ?, ?, 'platform', ?, NOT EXISTS (SELECT 1 FROM domains WHERE organization_id = ? AND is_primary = 1), ?
       WHERE NOT EXISTS (SELECT 1 FROM domains WHERE organization_id = ? AND kind = 'platform')`,
      organizationDomain(this.organizationSlug(organizationId)), organizationId, now, organizationId, now, organizationId);
  }

  private domainRow(where: string, ...args: unknown[]): DomainRow[] {
    // The platform domain first, then the organization's own in the order they were added.
    return this.rows(`SELECT * FROM domains WHERE ${where} ORDER BY kind = 'own', created_at, domain`, ...args).map((d) => ({
      domain: d.domain as string,
      organizationId: d.organization_id as string,
      kind: d.kind as DomainKind,
      verifyToken: (d.verify_token as string | null) ?? null,
      verified: d.verified_at != null,
      primary: !!d.is_primary,
      providerAt: d.provider_at != null ? iso(d.provider_at) : null,
      createdAt: iso(d.created_at),
    }));
  }

  domainsOf(organizationId: string): DomainRow[] {
    return this.domainRow('organization_id = ?', organizationId);
  }

  private ownDomain(organizationId: string, domain: string): DomainRow {
    const row = this.domainRow('domain = ? AND organization_id = ?', domain.trim().replace(/\.$/, ''), organizationId)[0];
    if (!row) throw notFound('domain not found');
    return row;
  }

  /** The domain new addresses are made on: the primary one, else the platform one, else what it would be. */
  primaryDomainOf(organizationId: string): string {
    return (this.rows('SELECT domain FROM domains WHERE organization_id = ? ORDER BY is_primary DESC, kind = \'own\' LIMIT 1', organizationId)[0]?.domain as string | undefined)
      ?? organizationDomain(this.organizationSlug(organizationId));
  }

  /** Registers a domain for the organization to verify, with a fresh token. A domain belongs to one organization;
   * adding one the organization already has gives it back as it is. Another organization's claim lapses when it is still
   * unverified after a week: the domain moves to this one with a new token, so nobody can squat a name by adding it. */
  addDomain(organizationId: string, raw: string): DomainRow {
    const domain = normalizeDomain(raw);
    if (!domain) throw badRequest('invalid_domain', 'that is not a domain name');
    if (domain === PLATFORM_DOMAIN || domain.endsWith(`.${PLATFORM_DOMAIN}`)) throw badRequest('domain_reserved', `${PLATFORM_DOMAIN} and its subdomains are the platform's`);
    const held = this.domainRow('domain = ?', domain)[0];
    if (held && held.organizationId !== organizationId) {
      const lapsed = held.kind === 'own' && !held.verified && Date.now() - Date.parse(held.createdAt) > DOMAIN_CLAIM_TTL;
      if (!lapsed) throw conflict('domain_taken', 'another organization has registered that domain');
      this.forgetDomain(domain);
    } else if (held) return held;
    const token = `freeflow-verify=${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex')}`;
    this.sql.exec("INSERT INTO domains (domain, organization_id, kind, verify_token, created_at) VALUES (?, ?, 'own', ?, ?)", domain, organizationId, token, Date.now());
    return this.ownDomain(organizationId, domain);
  }

  /** Looks up the verification TXT and, when it carries the token, marks the domain verified. A verified domain stays so. */
  async verifyDomain(organizationId: string, domain: string): Promise<{ verified: boolean; found: string[] }> {
    const row = this.ownDomain(organizationId, domain);
    if (row.kind === 'platform') return { verified: true, found: [] };
    const check = await checkDomain(row.domain, row.verifyToken ?? '', this.resolver());
    if (check.verified && !row.verified) this.sql.exec('UPDATE domains SET verified_at = ? WHERE domain = ?', Date.now(), row.domain);
    this.domainStatus.delete(row.domain);
    return { verified: check.verified || row.verified, found: check.found };
  }

  /** Makes a verified domain the one new addresses are made on. Existing addresses stay where they are. */
  setPrimaryDomain(organizationId: string, domain: string): DomainRow {
    const row = this.ownDomain(organizationId, domain);
    if (!row.verified) throw conflict('domain_unverified', 'verify the domain before making it primary');
    this.sql.exec('UPDATE domains SET is_primary = (domain = ?) WHERE organization_id = ?', row.domain, organizationId);
    return this.ownDomain(organizationId, row.domain);
  }

  /** Removes one of the organization's own domains, unless it is primary or an account's address is on it. */
  removeDomain(organizationId: string, domain: string): void {
    const row = this.ownDomain(organizationId, domain);
    if (row.kind === 'platform') throw conflict('domain_platform', 'the platform domain cannot be removed');
    if (row.primary) throw conflict('domain_primary', 'make another domain primary first');
    // Removed accounts count: the organization keeps their addresses (§3.3); so do guests' kept mailboxes.
    if (this.rows('SELECT 1 FROM accounts WHERE address LIKE ? OR mailbox_address LIKE ? LIMIT 1', `%@${row.domain}`, `%@${row.domain}`).length) {
      throw conflict('domain_in_use', 'accounts have addresses on this domain');
    }
    this.forgetDomain(row.domain);
  }

  private forgetDomain(domain: string): void {
    this.sql.exec('DELETE FROM domain_keys WHERE domain = ?', domain);
    this.sql.exec('DELETE FROM domains WHERE domain = ?', domain);
    this.domainStatus.delete(domain);
  }

  /** The DKIM key in use on a domain, as its TXT record's selector and value. */
  private dkimOf(domain: string): DkimRecord | null {
    const k = this.rows('SELECT k.selector, k.public_txt FROM domain_keys k JOIN domains d ON d.domain = k.domain AND d.dkim_selector = k.selector WHERE k.domain = ?', domain)[0];
    return k ? { selector: k.selector as string, value: k.public_txt as string } : null;
  }

  private mailProvider(): MailProvider {
    return this.deps.mailProvider ?? noneMailProvider;
  }

  /**
   * Makes a verified domain's DKIM key and gives it to the mail provider (making the domain there first, with the default
   * limits until provisioning sets the plan's), then keeps the key sealed and returns the TXT record to publish. Run again,
   * it replaces the key. With a provider that manages DKIM itself (MXRoute), the domain is made there and the provider's
   * own record is returned; nothing is kept here, since `records` carries it from then on.
   */
  async setDomainDkim(organizationId: string, domain: string): Promise<{ domain: string; kind: DomainKind; selector: string; record: DnsRecordDTO }> {
    const row = this.ownDomain(organizationId, domain);
    if (!row.verified) throw conflict('domain_unverified', 'verify the domain before setting up DKIM');
    const provider = this.mailProvider();
    if (provider.managesDkim) {
      let records: DnsRecordDTO[];
      try {
        await provider.createDomain(row.domain, DEFAULT_DOMAIN_LIMITS);
        this.setDomainAtProvider(row.domain);
        records = recordsFor(row.domain, await provider.records(row.domain));
      } catch (err) {
        providerFailure(err);
      }
      this.domainStatus.delete(row.domain);
      const record = records.find((r) => r.purpose === 'dkim');
      if (!record) throw conflict('dkim_pending', 'the mail provider has not made the domain\'s DKIM key yet; try again in a minute');
      return { domain: row.domain, kind: row.kind, selector: record.name.split('.')[0]!, record };
    }
    const key = await generateDkimKey();
    try {
      await provider.createDomain(row.domain, DEFAULT_DOMAIN_LIMITS);
      this.setDomainAtProvider(row.domain);
      await provider.setDkim(row.domain, key.selector, key.privateKeyPem);
    } catch (err) {
      providerFailure(err);
    }
    const sealed = encryptBlob(Buffer.from(key.privateKeyPem, 'utf8'));
    this.sql.exec('INSERT OR REPLACE INTO domain_keys (domain, selector, public_txt, key_sealed, key_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      row.domain, key.selector, key.publicTxt, sealed.blob, sealed.encKeyId, Date.now());
    this.sql.exec('UPDATE domains SET dkim_selector = ? WHERE domain = ?', key.selector, row.domain);
    this.domainStatus.delete(row.domain);
    const record = recordsFor(row.domain, await provider.records(row.domain, { selector: key.selector, value: key.publicTxt })).find((r) => r.purpose === 'dkim')!;
    return { domain: row.domain, kind: row.kind, selector: key.selector, record };
  }

  /** The organization's domains with the records to publish and, for its own, whether DNS has them, each domain's check
   * reused for a minute. `fresh` ("Check again") looks again unless the last check is only seconds old. */
  async describeDomains(organizationId: string, fresh = false): Promise<DomainDTO[]> {
    const provider = this.mailProvider();
    return Promise.all(this.domainsOf(organizationId).map(async (d) => {
      const records = recordsFor(d.domain, await provider.records(d.domain, this.dkimOf(d.domain)).catch(providerFailure), d.kind === 'own' ? d.verifyToken : null);
      let status: DomainDTO['status'] = [];
      if (d.kind === 'own') {
        const cached = this.domainStatus.get(d.domain);
        const age = cached ? Date.now() - cached.at : Infinity;
        if (cached && age < (fresh ? DOMAIN_STATUS_MIN_AGE : DOMAIN_STATUS_TTL) && cached.status.length === records.length) status = cached.status;
        else {
          status = await checkRecords(records, this.resolver());
          this.domainStatus.set(d.domain, { at: Date.now(), status });
        }
      }
      return { domain: d.domain, kind: d.kind, verified: d.verified, primary: d.primary, records, status, atProvider: d.providerAt != null, createdAt: d.createdAt };
    }));
  }

  private resolver(): Resolve {
    return this.deps.resolve ?? dohResolver('https://cloudflare-dns.com/dns-query');
  }

  /** The one place a person's profile is written. The Worker then copies it to their organizations. */
  patchUser(userId: string, patch: Record<string, unknown>): UserDTO {
    const user = this.userById(userId);
    if (!user) throw notFound('user not found');
    const columns: Record<string, string> = {
      displayName: 'display_name', timezone: 'timezone', statusEmoji: 'status_emoji', statusText: 'status_text', website: 'website',
      bio: 'bio', title: 'title', statusSuppressAlerts: 'status_suppress_alerts', unfurlOwnLinks: 'unfurl_own_links', privacyMode: 'privacy_mode', avatarUrl: 'avatar_url',
    };
    for (const [key, column] of Object.entries(columns)) {
      const value = patch[key];
      if (value !== undefined) this.sql.exec(`UPDATE users SET ${column} = ? WHERE id = ?`, typeof value === 'boolean' ? Number(value) : value, userId);
    }
    if (patch.notificationPrefs !== undefined) {
      this.sql.exec('UPDATE users SET notification_prefs = json_patch(notification_prefs, ?) WHERE id = ?', JSON.stringify(patch.notificationPrefs), userId);
    }
    return toUserDTO(this.userById(userId)!, userId);
  }

  /** Username and key to a fresh token, which ends every earlier one. The "lost agent.json" path. */
  async agentLogin(username: string, key: string): Promise<{ agentToken: string; user: UserDTO }> {
    for (const user of this.rows('SELECT * FROM users WHERE agent_username = ? AND is_agent = 1', username)) {
      if (!user.agent_key_hash || !(await verifyPassword(user.agent_key_hash as string, key))) continue;
      const now = Date.now();
      this.sql.exec('UPDATE agent_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', now, user.id);
      const agentToken = `flow-agent-token-${newToken()}`;
      this.sql.exec('INSERT INTO agent_tokens (id, token_hash, user_id, created_at) VALUES (?, ?, ?, ?)', newId(), await hashToken(agentToken), user.id, now);
      return { agentToken, user: toUserDTO(user, user.id as string) };
    }
    throw unauthorized('invalid agent credentials');
  }

  organizationsForDomain(domain: string): string[] {
    return this.rows('SELECT organization_id FROM organization_domains WHERE domain = ?', domain).map((r) => r.organization_id as string);
  }

  /** The directory's half of deleting an account. The row stays for authorship; the address is freed. */
  tombstoneUser(userId: string): void {
    this.sql.exec('DELETE FROM sessions WHERE user_id = ?', userId);
    this.sql.exec('DELETE FROM oauth_identities WHERE user_id = ?', userId);
    this.sql.exec('DELETE FROM memberships WHERE user_id = ?', userId);
    this.removeAccounts('user_id = ?', userId);
    // The agents they sponsor follow them out of every organization (§3.3, rule 2).
    this.removeSponsored(userId, null);
    revokePersonalAgent(this.sql, userId);
    this.sql.exec("UPDATE users SET deleted_at = ?, email = 'deleted-' || id || '@deleted.invalid', password_hash = '!deleted', display_name = 'Deleted user', avatar_url = NULL WHERE id = ?", Date.now(), userId);
  }

  /** The organizations where the principal holds an account that was not removed. */
  organizationsOf(userId: string): string[] {
    return this.rows("SELECT organization_id FROM accounts WHERE user_id = ? AND state <> 'removed' ORDER BY created_at, id", userId).map((r) => r.organization_id as string);
  }

  /** Whether an organization exists (it has members): a socket for any other id is refused before an object is woken. */
  organizationKnown(organizationId: string): boolean {
    return this.rows("SELECT 1 FROM accounts WHERE organization_id = ? AND state <> 'removed' LIMIT 1", organizationId).length > 0;
  }

  /**
   * Ids (Docs file ids, link tokens) now kept by another organization's object: a person's files moved there
   * (POST /v1/admin/accounts/move). Unlike the `index` change, which keeps the first organization an id was made in.
   */
  reindexIds(ids: string[], organizationId: string): number {
    for (const id of ids) this.sql.exec('INSERT OR REPLACE INTO id_index (id, organization_id) VALUES (?, ?)', id, organizationId);
    return ids.length;
  }

  organizationOfId(id: string): string | null {
    return (this.rows('SELECT organization_id FROM id_index WHERE id = ?', id)[0]?.organization_id as string | undefined) ?? null;
  }

  getUser(id: string, viewerId: string): UserDTO {
    const user = this.userById(id);
    if (!user) throw notFound('user not found');
    if (id !== viewerId) {
      const shared = this.rows(
        "SELECT 1 FROM accounts a JOIN accounts b ON a.organization_id = b.organization_id WHERE a.user_id = ? AND b.user_id = ? AND a.state <> 'removed' AND b.state <> 'removed' LIMIT 1",
        id, viewerId);
      if (!shared.length) throw notFound('user not found');
    }
    return toUserDTO(user, viewerId);
  }
}
