// The grants library (docs/specs/platform.md §4.3–§4.4, phase 3.1).
//
// One table, one resolve function and the principal strings, shared by every app object that owns shareable
// objects (Docs, Chat, Calendar). It is pure: no Node imports, no database handle. The SQL it produces is plain
// `?`-parameterised SQLite that runs on both dialects the repo has (a Durable Object's `sql.exec` and
// `node:sqlite`), and the resolve function runs in the browser too.
//
// The library never queries. The caller loads the object's container chain (the object first, then each container
// up to the root), fetches the chain's grants with `grantsForChainSql`, turns the rows into `Grant`s with
// `grantFromRow`, and asks `effectiveRole`. Writes are statements (`grantSql`, `revokeSql`, `revokeAllSql`) the
// caller executes, in its own transaction, beside its outbox row for the share index (§4.5).
//
// Timestamps: the `Grant` type carries ISO strings (§4.3's shared type); the table stores epoch milliseconds, so
// expiry compares as integers in SQL. `grantSql` and `grantFromRow` convert.
import type { Grant, GrantPrincipal, Role } from './platform.js';

export type { Grant, GrantPrincipal, Role };

/** A parameterised statement: run it as `exec(sql, ...params)` or `prepare(sql).run(...params)`. */
export interface SqlStatement {
  sql: string;
  params: (string | number | null)[];
}

// ---- the table --------------------------------------------------------------

/** The `grants` table and its indexes, as statements an app appends to its own migrations. Idempotent. */
export const GRANTS_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS grants (
  object_kind TEXT NOT NULL,
  object_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  role TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (object_kind, object_id, principal)
)`,
  `CREATE INDEX IF NOT EXISTS grants_principal ON grants (principal)`,
  `CREATE INDEX IF NOT EXISTS grants_object ON grants (object_kind, object_id)`,
];

/** A `grants` row as either SQLite driver returns it. */
export interface GrantRow {
  object_kind: string;
  object_id: string;
  principal: string;
  role: string;
  granted_by: string;
  granted_at: number;
  expires_at: number | null;
}

/** A row read back as a `Grant`, timestamps as ISO strings. */
export function grantFromRow(row: GrantRow): Grant {
  const g: Grant = {
    objectKind: row.object_kind,
    objectId: row.object_id,
    principal: row.principal as GrantPrincipal,
    role: row.role as Role,
    grantedBy: row.granted_by,
    grantedAt: new Date(Number(row.granted_at)).toISOString(),
  };
  if (row.expires_at != null) g.expiresAt = new Date(Number(row.expires_at)).toISOString();
  return g;
}

/** An ISO timestamp (or epoch-ms digits) as epoch milliseconds. Throws on anything else. */
function toMillis(t: string): number {
  const ms = /^\d+$/.test(t) ? Number(t) : Date.parse(t);
  if (!Number.isFinite(ms)) throw new Error(`grants: not a timestamp: ${t}`);
  return ms;
}

// ---- principals ---------------------------------------------------------------

export const ORG_PRINCIPAL = 'org' as const;
export const accountPrincipal = (accountId: string): GrantPrincipal => `account:${accountId}`;
export const channelPrincipal = (channelId: string): GrantPrincipal => `channel:${channelId}`;
export const linkPrincipal = (token: string): GrantPrincipal => `link:${token}`;

/** A grant principal's kind (not `PrincipalKind`, which is person or agent, §2.1). */
export type GrantPrincipalKind = 'account' | 'channel' | 'org' | 'link';

/** A principal string's kind and id (`org` has none). Throws on a string that is not a principal, so a bad row is
 * loud rather than silently matching nobody. */
export function parsePrincipal(p: string): { kind: GrantPrincipalKind; id?: string } {
  if (p === ORG_PRINCIPAL) return { kind: 'org' };
  const m = /^(account|channel|link):(.+)$/.exec(p);
  if (!m) throw new Error(`grants: not a principal: ${p}`);
  return { kind: m[1] as GrantPrincipalKind, id: m[2]! };
}

/** Who asks: the caller context's account id, the channels it is a member of, and any link tokens it presents.
 * Every reader is a member of the organization the object lives in (an object never serves another one). */
export interface GrantReader {
  accountId: string;
  channelIds: string[];
  linkTokens?: string[];
}

/** The principal strings that match a reader, in a stable order: the account, `org`, its channels sorted, then its
 * link tokens sorted, each once. */
export function principalsOf(reader: GrantReader): GrantPrincipal[] {
  const uniqSorted = (xs: readonly string[] = []) => [...new Set(xs)].sort();
  return [
    accountPrincipal(reader.accountId),
    ORG_PRINCIPAL,
    ...uniqSorted(reader.channelIds).map(channelPrincipal),
    ...uniqSorted(reader.linkTokens).map(linkPrincipal),
  ];
}

// ---- roles --------------------------------------------------------------------

export const ROLE_RANK: Readonly<Record<Role, number>> = { viewer: 1, editor: 2, manager: 3, owner: 4 };

/** Whether `role` allows what `needed` allows. A null role (no access) allows nothing. */
export const atLeast = (role: Role | null | undefined, needed: Role): boolean => !!role && ROLE_RANK[role] >= ROLE_RANK[needed];

/** The higher of two roles; null counts as none. */
export function maxRole(a: Role | null, b: Role | null): Role | null {
  if (!a) return b;
  if (!b) return a;
  return ROLE_RANK[b] > ROLE_RANK[a] ? b : a;
}

// ---- resolution -----------------------------------------------------------------

/** One link of a container chain and the grants loaded for it. */
export interface ChainLink {
  objectKind: string;
  objectId: string;
  grants: Grant[];
}

export interface EffectiveRoleInput {
  reader: GrantReader;
  /** The object's owner column (§4.3: the owner is a column, not a grant); null when it has none. */
  ownerAccountId: string | null;
  /** The object first, then each container up to the root, each with its grants. The caller loads it. */
  chain: ChainLink[];
  /** Epoch milliseconds to judge expiry by; defaults to `Date.now()`. */
  now?: number;
}

/**
 * The reader's role on an object (§4.4), or null for no access: `owner` when the reader is the owner column;
 * otherwise the highest role among the chain's grants (the object's own and every container's: access inherits
 * down the chain) whose principal is one of `principalsOf(reader)` and which has not expired. A grant expires at
 * `expiresAt` (it no longer applies from that instant). A grant's own object/kind fields are not checked: each
 * link's grants are taken as loaded.
 */
export function effectiveRole(input: EffectiveRoleInput): Role | null {
  const { reader, ownerAccountId, chain } = input;
  if (ownerAccountId != null && reader.accountId === ownerAccountId) return 'owner';
  const now = input.now ?? Date.now();
  const mine = new Set<string>(principalsOf(reader));
  let best: Role | null = null;
  for (const link of chain) {
    for (const g of link.grants) {
      if (!mine.has(g.principal)) continue;
      if (g.expiresAt != null && toMillis(g.expiresAt) <= now) continue;
      best = maxRole(best, g.role);
    }
  }
  return best;
}

// ---- queries --------------------------------------------------------------------

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');

/** Every grant on the chain's objects, in one query. Feed the rows to `grantFromRow` and group by object. An empty
 * chain is a query that returns nothing. */
export function grantsForChainSql(chain: readonly { objectKind: string; objectId: string }[]): SqlStatement {
  if (chain.length === 0) return { sql: 'SELECT * FROM grants WHERE 0', params: [] };
  const terms = chain.map(() => '(object_kind = ? AND object_id = ?)').join(' OR ');
  return {
    sql: `SELECT object_kind, object_id, principal, role, granted_by, granted_at, expires_at FROM grants WHERE ${terms}`,
    params: chain.flatMap(c => [c.objectKind, c.objectId]),
  };
}

/** The distinct `(object_kind, object_id)` pairs with a live grant to one of the reader's principals, for "Shared
 * with me"; narrowed to one kind when given. `org` is left out: an organization-wide grant is the organization's
 * root, not something shared with this reader. The caller drops the reader's own objects (the owner is a column of
 * its table) and resolves each role with `effectiveRole` if it shows one. */
export function objectsSharedWithSql(reader: GrantReader, objectKind?: string, now: number = Date.now()): SqlStatement {
  const principals = principalsOf(reader).filter(p => p !== ORG_PRINCIPAL);
  const params: (string | number)[] = [...principals];
  let sql = `SELECT DISTINCT object_kind, object_id FROM grants WHERE principal IN (${placeholders(principals.length)})`;
  if (objectKind !== undefined) { sql += ' AND object_kind = ?'; params.push(objectKind); }
  sql += ' AND (expires_at IS NULL OR expires_at > ?)';
  params.push(now);
  return { sql, params };
}

// ---- mutations --------------------------------------------------------------------

/** Grant (or change) one principal's role on one object: an upsert on the primary key. */
export function grantSql(grant: Grant): SqlStatement {
  return {
    sql: `INSERT INTO grants (object_kind, object_id, principal, role, granted_by, granted_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (object_kind, object_id, principal) DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by, granted_at = excluded.granted_at, expires_at = excluded.expires_at`,
    params: [
      grant.objectKind, grant.objectId, grant.principal, grant.role, grant.grantedBy,
      toMillis(grant.grantedAt), grant.expiresAt != null ? toMillis(grant.expiresAt) : null,
    ],
  };
}

/** Remove one principal's grant on one object. */
export function revokeSql(objectKind: string, objectId: string, principal: string): SqlStatement {
  return { sql: 'DELETE FROM grants WHERE object_kind = ? AND object_id = ? AND principal = ?', params: [objectKind, objectId, principal] };
}

/** Remove every grant on one object (it was deleted, or made private again). */
export function revokeAllSql(objectKind: string, objectId: string): SqlStatement {
  return { sql: 'DELETE FROM grants WHERE object_kind = ? AND object_id = ?', params: [objectKind, objectId] };
}
