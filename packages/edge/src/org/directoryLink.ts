// What the services ask of the directory while handling a request. The object provides it, as it does the sockets.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AccountDTO, AccountKind, MemberRole, UserDTO } from '@flow/shared';

export interface DirectoryLink {
  /** The joiner's account in this organization, made or reactivated with this role, and, when made, of this kind
   * (DirectoryCore.ensureAccount; an invitation's, docs/specs/workspace-admin.md §6.5). */
  ensureAccount(organizationId: string, userId: string, role: MemberRole, displayName: string, kind?: AccountKind): Promise<AccountDTO>;
  /** A principal's account in an organization, any state, or null (DirectoryCore.accountFor). */
  accountFor?(organizationId: string, userId: string): Promise<AccountDTO | null>;
  /** A personal agent for the bridge (agents.md §1, DirectoryCore.createPersonalAgent): not a member here; its token acts as the sponsor. */
  createPersonalAgent?(organizationId: string, sponsorId: string, p: { name: string; username: string; keyHash: string; description?: string }): Promise<{ agentToken: string; user: UserDTO; sponsor: UserDTO }>;
}
export const directoryLink = new AsyncLocalStorage<DirectoryLink>();

/** Null where no directory is attached (tests); the outbox's join and the object's backfill still give the address. */
export const ensureAccount = (organizationId: string, userId: string, role: MemberRole, displayName: string, kind: AccountKind = 'native'): Promise<AccountDTO | null> =>
  directoryLink.getStore()?.ensureAccount(organizationId, userId, role, displayName, kind) ?? Promise.resolve(null);

/** A personal agent made in the directory; null where no directory is attached (tests). */
export const createPersonalAgent = (organizationId: string, sponsorId: string, p: { name: string; username: string; keyHash: string; description?: string }): Promise<{ agentToken: string; user: UserDTO; sponsor: UserDTO } | null> =>
  directoryLink.getStore()?.createPersonalAgent?.(organizationId, sponsorId, p) ?? Promise.resolve(null);

/** The account, or undefined where no directory is attached (tests), which callers must not read as "no account". */
export const accountFor = (organizationId: string, userId: string): Promise<AccountDTO | null | undefined> =>
  directoryLink.getStore()?.accountFor?.(organizationId, userId) ?? Promise.resolve(undefined);
