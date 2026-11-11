// Personal agents in the directory (docs/specs/agents.md §1, §2): the agent principal a /mcp delegation acts through, one
// per sponsor, client and organization, with its `personal_agent` account. Shared by the core (the backfill, removal) and
// the MCP authorization server (a new connection), which run over the same SQLite.
import type { AgentMode } from '@flow/shared';
import { forbidden } from '../errors';
import { newId } from './ids';

export interface AgentSql { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } }

const rows = (sql: AgentSql, q: string, ...args: unknown[]) => sql.exec(q, ...args).toArray();

/** A principal's agent mode, or null for a person or an agent the directory has not placed. */
export function agentModeOf(sql: AgentSql, userId: string): AgentMode | null {
  const u = rows(sql, 'SELECT is_agent, mode FROM users WHERE id = ?', userId)[0];
  return u?.is_agent ? ((u.mode as AgentMode | null) ?? null) : null;
}

/**
 * The personal agent through which `clientName` acts for `sponsorId` in `organizationId`: found by those three, or made,
 * with its `personal_agent` account (no address, nothing to provision). The sponsor must be a person with an account in
 * the organization that was not removed (agents.md §2, rule 1). Returns the agent's principal id.
 */
export function personalAgentFor(sql: AgentSql, sponsorId: string, organizationId: string, clientName: string, now = Date.now()): string {
  const sponsor = rows(sql, 'SELECT is_agent, deleted_at FROM users WHERE id = ?', sponsorId)[0];
  if (!sponsor || sponsor.deleted_at || sponsor.is_agent) throw forbidden('an agent cannot sponsor an agent');
  const sponsorAccount = rows(sql, "SELECT id FROM accounts WHERE user_id = ? AND organization_id = ? AND state <> 'removed'", sponsorId, organizationId)[0];
  if (!sponsorAccount) throw forbidden('an agent can only join an organization where its sponsor has an active account');
  const name = clientName.trim().slice(0, 80) || 'Agent';
  const found = rows(sql,
    "SELECT id FROM users WHERE is_agent = 1 AND mode = 'personal' AND sponsor_user_id = ? AND organization_id = ? AND display_name = ? AND deleted_at IS NULL ORDER BY created_at LIMIT 1",
    sponsorId, organizationId, name)[0];
  const id = (found?.id as string | undefined) ?? newId();
  if (!found) {
    // The same recipe as a bridge agent's principal: a synthetic unique email and a password hash nothing matches.
    sql.exec(
      `INSERT INTO users (id, email, password_hash, display_name, is_agent, sponsor_user_id, organization_id, mode, email_verified_at, created_at)
       VALUES (?, ?, '!agent', ?, 1, ?, ?, 'personal', ?, ?)`,
      id, `agent-${id}@agents.flow.local`, name, sponsorId, organizationId, now, now);
  }
  const account = rows(sql, 'SELECT id, state FROM accounts WHERE user_id = ? AND organization_id = ?', id, organizationId)[0];
  if (!account) {
    sql.exec(
      "INSERT INTO accounts (id, user_id, organization_id, address, display_name, role, kind, state, created_at, sponsor_user_id) VALUES (?, ?, ?, NULL, ?, 'member', 'personal_agent', 'active', ?, ?)",
      newId(), id, organizationId, name, now, sponsorId);
  } else if (account.state === 'removed') {
    sql.exec("UPDATE accounts SET state = 'active', removed_at = NULL, status_message = NULL WHERE id = ?", account.id);
  }
  return id;
}

/** The personal agent a connection acts through, by its token family; null for a connection made before agents had kinds. */
export function agentOfFamily(sql: AgentSql, family: string): string | null {
  return (rows(sql, 'SELECT agent_id FROM oauth_connections WHERE family = ?', family)[0]?.agent_id as string | null | undefined) ?? null;
}

/**
 * A personal agent whose last delegation is gone has nothing left to act through: its account is marked removed and
 * its principal tombstoned, so the organization's agent list does not keep a dead entry. No-op while a connection remains.
 */
export function retireIdlePersonalAgent(sql: AgentSql, agentId: string, now = Date.now()): boolean {
  if (rows(sql, 'SELECT 1 AS x FROM oauth_connections WHERE agent_id = ? LIMIT 1', agentId).length) return false;
  if (!rows(sql, "SELECT 1 AS x FROM users WHERE id = ? AND is_agent = 1 AND mode = 'personal'", agentId).length) return false;
  sql.exec("UPDATE accounts SET state = 'removed', removed_at = ? WHERE user_id = ? AND state <> 'removed'", now, agentId);
  sql.exec("UPDATE users SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL", now, agentId);
  return true;
}

/** Every delegation of a personal agent revoked and dropped (an admin's or the sponsor's removal), then the agent retired. */
export function revokePersonalAgent(sql: AgentSql, agentId: string, now = Date.now()): void {
  sql.exec('UPDATE oauth_tokens SET revoked_at = ? WHERE revoked_at IS NULL AND family IN (SELECT family FROM oauth_connections WHERE agent_id = ?)', now, agentId);
  sql.exec('DELETE FROM oauth_connections WHERE agent_id = ?', agentId);
  retireIdlePersonalAgent(sql, agentId, now);
}
