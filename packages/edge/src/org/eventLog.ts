// What of a Chat socket event goes into the organization's event log (platform.md §5.2), and who may read it there: the
// same rule `Org.broadcast` applies to sockets. Presence and typing stay on the sockets.
import type { Event } from '@flow/shared';
import type { Audience, PublishInput } from '../events/core';

interface Sql { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } }

const USER_SUBJECT = /(?:^|\.)user\.([0-9a-f-]{36})(?:\.|$)/;
const NOT_LOGGED = new Set(['typing', 'presence']);

const accountOf = (sql: Sql, workspaceId: string, userId: string): string | null =>
  (sql.exec('SELECT account_id FROM workspace_members WHERE workspace_id = ? AND user_id = ?', workspaceId, userId).toArray()[0]?.account_id as string | null | undefined) ?? null;

/** The user an event names as acting: a message's or reaction's `userId`, a channel's `createdBy`. */
function actingUser(data: unknown): string | null {
  const d = data as { userId?: unknown; createdBy?: unknown } | null;
  const id = typeof d?.userId === 'string' ? d.userId : typeof d?.createdBy === 'string' ? d.createdBy : null;
  return id || null;
}

/** A caller's agent fields for the events its request publishes (agents.md §3), as far as this object can vouch for them. */
export interface AgentStamp { via?: string; invokedBy?: string }

/**
 * `via` is taken as the Worker resolved it from a delegation. `invokedBy` is an agent's own claim of who asked for its turn,
 * so it is kept only when the caller is an agent and the account named is a member of the organization other than the agent.
 */
export function agentStampFor(sql: Sql, workspaceId: string, caller: { user: { isAgent?: boolean } | null; account: { id: string } | null; via?: string | null; invokedBy?: string | null }): AgentStamp {
  const out: AgentStamp = {};
  if (caller.via) out.via = caller.via;
  if (caller.invokedBy && caller.user?.isAgent && caller.account && caller.invokedBy !== caller.account.id) {
    const known = sql.exec('SELECT 1 AS x FROM workspace_members WHERE workspace_id = ? AND account_id = ?', workspaceId, caller.invokedBy).toArray().length > 0;
    if (known) out.invokedBy = caller.invokedBy;
  }
  return out;
}

/**
 * The log entry for one socket event, or null when it is not logged: `chat.<type>`, the acting user's account as
 * `actor`, and the audience: a user's own subject goes to that user's account (none known: not logged), a private
 * channel's event to its members, the rest to the organization.
 */
export function logEntryFor(sql: Sql, subject: string, event: Event): PublishInput | null {
  if (NOT_LOGGED.has(event.type)) return null;
  const onlyUser = USER_SUBJECT.exec(subject)?.[1];
  let audience: Audience = 'org';
  if (onlyUser) {
    const account = accountOf(sql, event.workspaceId, onlyUser);
    if (!account) return null;
    audience = `account:${account}`;
  } else if (event.channelId) {
    const chan = sql.exec('SELECT is_private FROM channels WHERE id = ?', event.channelId).toArray()[0];
    if (chan?.is_private) audience = `channel:${event.channelId}`;
  }
  const user = actingUser(event.data);
  return {
    type: `chat.${event.type}`,
    organizationId: event.workspaceId,
    actor: user ? accountOf(sql, event.workspaceId, user) : null,
    ...(event.channelId ? { channelId: event.channelId } : {}),
    audience,
    ts: event.ts,
    data: event.data,
  };
}
