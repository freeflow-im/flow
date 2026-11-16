// Account kinds (platform.md §3.3): an owner or admin makes an account native (an address, a mailbox, a native calendar)
// or a guest (none of them), one at a time or every member at once. The directory keeps the kind; the Org object's
// member rows follow its address. Mounted before routes/org.ts, whose catch-all would send these to the Org object.
import { Hono, type Context } from 'hono';
import type { ZodTypeAny, z } from 'zod';
import { AccountAddressBody, BulkAccountKindBody, CreateMemberBody, SetAccountKindBody, type AccountAddressesDTO, type AccountDTO, type AccountKindResult, type BulkAccountKindResult, type CreateMemberResultDTO, type PendingSetupDTO, type UserDTO } from '@flow/shared';
import { ApiError, badRequest } from '../errors';
import { directory, resolveCaller, type AuthEnv } from './auth';
import { adminCallerOf, adminOf } from './domains';
import type { Calendar } from '../calendar/object';
import type { Mail } from '../imap/object';

type C = Context<{ Bindings: AuthEnv }>;

export const accountRoutes = new Hono<{ Bindings: AuthEnv }>();

async function bodyOf<S extends ZodTypeAny>(c: C, schema: S): Promise<z.output<S>> {
  const r = schema.safeParse(await c.req.json().catch(() => undefined));
  if (!r.success) throw badRequest('validation', r.error.issues[0]?.message ?? 'invalid request');
  return r.data;
}

/** The organization's accounts that were not removed, with their kinds: the admin page's Kind column. */
accountRoutes.get('/v1/workspaces/:id/accounts', async (c) => {
  const id = await adminOf(c as never, 'see accounts');
  const accounts = (await directory(c, 'accountsOfOrganization', id)).filter((a) => a.state !== 'removed');
  return c.json({ accounts });
});

/** One account sent to be set up (docs/specs/workspace-admin.md §6.4): the Members section's Retry. A guest gets no
 * mailbox (409); an account with one already, or removed, is left alone (`queued: false`). */
accountRoutes.post('/v1/workspaces/:id/accounts/:accountId/provision', async (c) => {
  const id = await adminOf(c as never, 'set up mailboxes');
  const account = await directory(c, 'accountById', c.req.param('accountId'));
  if (!account || account.organizationId !== id) throw new ApiError(404, 'not_found', 'account not found');
  if (account.kind === 'guest') throw new ApiError(409, 'guest', 'a guest has no mailbox');
  const queued = await directory(c, 'provisionAccount', account.id);
  return c.json({ queued });
});

accountRoutes.patch('/v1/workspaces/:id/accounts/:accountId/kind', async (c) => {
  const id = await adminOf(c as never, 'change account kinds');
  const body = await bodyOf(c, SetAccountKindBody);
  // The organization's member list is the truth (decision_log 2026-11-11): its object changes the kind, and the
  // directory's account (address, mailbox) and the person's assistant follow.
  // An MCP client's personal agent may not be on the list yet (the Org takes them when an admin opens the full list).
  if ((await directory(c, 'accountById', c.req.param('accountId')))?.kind === 'personal_agent') throw new ApiError(409, 'personal_agent', "a personal agent's account never changes kind");
  const answer = await c.env.ORG.get(c.env.ORG.idFromName(id)).setMemberKind(c.req.param('accountId'), body.kind);
  if (!answer.ok) throw new ApiError(answer.status, answer.code, answer.message);
  return c.json({ account: answer.value } satisfies AccountKindResult);
});

// ---- an account's addresses (platform.md §3.2, decision_log 2026-11-16): owners and admins only ----------------------

type AddressEnv = AuthEnv & { MAIL: DurableObjectNamespace<Mail>; CALENDAR: DurableObjectNamespace<Calendar> };

/** The member list, the account's Mail and its Calendar take the address it now goes by. */
async function followAddress(c: C, account: AccountDTO): Promise<void> {
  const env = c.env as AddressEnv;
  await Promise.all([
    env.MAIL.get(env.MAIL.idFromName(account.id)).renameHosted(account, account.address!),
    env.CALENDAR.get(env.CALENDAR.idFromName(account.id)).renameNative(account).then((r) => { if (!r.ok) throw new Error(r.message); }),
  ]);
  await c.env.ORG.get(c.env.ORG.idFromName(account.organizationId)).syncAddresses();
}

accountRoutes.get('/v1/workspaces/:id/accounts/:accountId/addresses', async (c) => {
  const id = await adminOf(c as never, 'see addresses');
  const account = await directory(c, 'accountById', c.req.param('accountId'));
  if (!account || account.organizationId !== id) throw new ApiError(404, 'not_found', 'account not found');
  return c.json(await directory(c, 'addressesOf', account.id) satisfies AccountAddressesDTO);
});

/** An alias: another address that delivers to the account's mailbox. */
accountRoutes.post('/v1/workspaces/:id/accounts/:accountId/addresses', async (c) => {
  const id = await adminOf(c as never, 'add addresses');
  const body = await bodyOf(c, AccountAddressBody);
  return c.json(await directory(c, 'addAlias', id, c.req.param('accountId'), body.address) satisfies AccountAddressesDTO, 201);
});

accountRoutes.delete('/v1/workspaces/:id/accounts/:accountId/addresses/:address', async (c) => {
  const id = await adminOf(c as never, 'remove addresses');
  return c.json(await directory(c, 'removeAlias', id, c.req.param('accountId'), decodeURIComponent(c.req.param('address'))) satisfies AccountAddressesDTO);
});

/** The caller's own aliases (decision_log 2026-11-16): any member may list, add and remove theirs. Changing the address
 * they go by stays with owners and admins. */
async function myAccount(c: C): Promise<{ id: string; accountId: string }> {
  const id = c.req.param('id') ?? '';
  const who = await resolveCaller(c as never, id);
  if (!who.user) throw new ApiError(401, 'unauthorized', 'missing bearer token');
  if (!who.account) throw new ApiError(403, 'no_account', 'not a member of this organization');
  // People only: an agent's addresses are its sponsor's or an admin's to change.
  if (who.user.isAgent) throw new ApiError(403, 'forbidden', 'an agent cannot change its own addresses');
  return { id, accountId: who.account.id };
}

accountRoutes.get('/v1/workspaces/:id/me/addresses', async (c) => {
  const me = await myAccount(c);
  return c.json(await directory(c, 'addressesOf', me.accountId) satisfies AccountAddressesDTO);
});

accountRoutes.post('/v1/workspaces/:id/me/addresses', async (c) => {
  const me = await myAccount(c);
  const body = await bodyOf(c, AccountAddressBody);
  return c.json(await directory(c, 'addAlias', me.id, me.accountId, body.address) satisfies AccountAddressesDTO, 201);
});

accountRoutes.delete('/v1/workspaces/:id/me/addresses/:address', async (c) => {
  const me = await myAccount(c);
  return c.json(await directory(c, 'removeAlias', me.id, me.accountId, decodeURIComponent(c.req.param('address'))) satisfies AccountAddressesDTO);
});

/** A mailbox this small changes address by moving to a new mailbox; a bigger one gets a forwarder (platform.md §3.2). */
export const MOVE_MAX_MESSAGES = 200;
export const MOVE_MAX_BYTES = 50 * 2 ** 20;

/**
 * The address the account goes by: one of its others, or a new one. A small mailbox moves to a new mailbox at that
 * address (its mail copied, the old mailbox deleted, the old address forwarding to it); a bigger one keeps its mailbox
 * and the address becomes a forwarder that mail is sent as. `moved` says which, with the messages copied.
 */
accountRoutes.put('/v1/workspaces/:id/accounts/:accountId/address', async (c) => {
  const id = await adminOf(c as never, 'change addresses');
  const body = await bodyOf(c, AccountAddressBody);
  const accountId = c.req.param('accountId');
  const before = await directory(c, 'accountById', accountId);
  if (!before || before.organizationId !== id) throw new ApiError(404, 'not_found', 'account not found');
  const env = c.env as AddressEnv;
  const mail = env.MAIL.get(env.MAIL.idFromName(before.id));
  let account: AccountDTO | null = null;
  let moved: { messages: number } | null = null;
  const size = await mail.hostedSize(before).catch((err: Error) => { console.error(`address size ${before.id}: ${err.message}`); return null; });
  if (size && size.messages <= MOVE_MAX_MESSAGES && body.address !== before.address?.toLowerCase()) {
    const start = await directory(c, 'startMove', id, accountId, body.address);
    if (start) {
      const old = (await directory(c, 'addressesOf', accountId)).others.find((o) => !o.removable)?.address ?? before.address!;
      const out = await mail.moveHosted(before, start.mailbox, MOVE_MAX_BYTES);
      if (out.ok) {
        account = await directory(c, 'finishMove', id, accountId, start.address);
        moved = { messages: out.messages };
      } else {
        await directory(c, 'abortMove', accountId, start.address, start.wasAlias, old);
        if (out.reason !== 'too_big') throw new ApiError(502, 'move_failed', `Could not copy the mail to the new mailbox: ${out.message}`);
      }
    }
  }
  account ??= await directory(c, 'changeAddress', id, accountId, body.address);
  await followAddress(c, account);
  return c.json({ account, addresses: await directory(c, 'addressesOf', account.id), moved });
});

/** An admin removes a personal agent (docs/specs/agents.md §2): its account, and every delegation it acted through. Only a
 * `personal_agent` account; a member's account goes through DELETE /members/:userId, a shared agent's through /agents. */
accountRoutes.delete('/v1/workspaces/:id/accounts/:accountId', async (c) => {
  const id = await adminOf(c as never, 'remove agents');
  const before = await directory(c, 'accountById', c.req.param('accountId'));
  // A person's assistant comes and goes with them (agents.md §6): it is suspended, not removed, by an admin (later).
  if (before?.agentRuntime === 'hosted') throw new ApiError(409, 'assistant', "a person's assistant goes only with the person");
  const account = await directory(c, 'removePersonalAgent', id, c.req.param('accountId'));
  await c.env.ORG.get(c.env.ORG.idFromName(id)).dropPersonalAgent(account.principalId);
  return c.json({ account });
});

/** Accounts the directory still holds for people who are no longer members (POST …/accounts/reconcile): the organization's
 * member list is the truth, and an outbox that lost a leave left the account behind. `?apply=1` removes them; without it
 * the answer only lists them. */
accountRoutes.post('/v1/workspaces/:id/accounts/reconcile', async (c) => {
  const id = await adminOf(c as never, 'reconcile accounts');
  const apply = c.req.query('apply') === '1';
  return c.json(await c.env.ORG.get(c.env.ORG.idFromName(id)).reconcileAccounts(apply));
});

accountRoutes.post('/v1/workspaces/:id/accounts/kind', async (c) => {
  const id = await adminOf(c as never, 'change account kinds');
  await bodyOf(c, BulkAccountKindBody);
  const out = await c.env.ORG.get(c.env.ORG.idFromName(id)).makeMembersGuests();
  return c.json({ changed: out.changed.length, unchanged: out.unchanged } satisfies BulkAccountKindResult);
});

// Members an admin creates (Admin › Members › Create member): a native account at `username@domain` with no password,
// whose setup link goes to a backup email. The directory makes the principal and account (and with hosted mail sends it
// to be provisioned, as any native join); then the Org object writes the member row; then the link is mailed.
type OrgStub = { addCreatedMember(u: UserDTO): Promise<{ ok: true; value: { workspaceName: string } } | { ok: false; status: number; code: string; message: string }>; workspaceName(): Promise<string | null> };
const orgOf = (c: C, id: string) => c.env.ORG.get(c.env.ORG.idFromName(id)) as unknown as OrgStub;

accountRoutes.post('/v1/workspaces/:id/created-members', async (c) => {
  const { id, user: admin } = await adminCallerOf(c as never, 'create members');
  const body = await bodyOf(c, CreateMemberBody);
  const made = await directory(c, 'createMember', id, body);
  const joined = await orgOf(c, id).addCreatedMember(made.user).catch((err: Error) => ({ ok: false as const, status: 500, code: 'internal', message: err.message }));
  if (!joined.ok) {
    await directory(c, 'discardCreatedMember', id, made.user.id);
    throw new ApiError(joined.status, joined.code, joined.message);
  }
  let pending: PendingSetupDTO | null = null;
  try {
    pending = await directory(c, 'sendSetupLink', id, made.account.id, { workspaceName: joined.value.workspaceName, byName: admin.displayName });
  } catch (err) {
    // The member exists; the Pending list's Resend sends the link again.
    console.error(`setup link for ${made.account.id}: ${(err as Error).message}`);
  }
  const account = (await directory(c, 'accountById', made.account.id)) ?? made.account;
  return c.json({ account, pending, emailSent: !!pending } satisfies CreateMemberResultDTO, 201);
});

accountRoutes.get('/v1/workspaces/:id/created-members', async (c) => {
  const id = await adminOf(c as never, 'see pending members');
  return c.json({ pending: await directory(c, 'pendingSetups', id) });
});

/** "Resend setup link": a fresh week-long link, which replaces the last. Only while they have no password (409). */
accountRoutes.post('/v1/workspaces/:id/created-members/:accountId/setup-link', async (c) => {
  const { id, user: admin } = await adminCallerOf(c as never, 'send setup links');
  const workspaceName = (await orgOf(c, id).workspaceName().catch(() => null)) ?? undefined;
  const pending = await directory(c, 'sendSetupLink', id, c.req.param('accountId'), { workspaceName, byName: admin.displayName });
  return c.json({ pending });
});
