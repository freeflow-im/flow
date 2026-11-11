// Account kinds (platform.md §3.3): an owner or admin makes an account native (an address, a mailbox, a native calendar)
// or a guest (none of them), one at a time or every member at once. The directory keeps the kind; the Org object's
// member rows follow its address. Mounted before routes/org.ts, whose catch-all would send these to the Org object.
import { Hono, type Context } from 'hono';
import type { ZodTypeAny, z } from 'zod';
import { BulkAccountKindBody, SetAccountKindBody, type AccountDTO, type AccountKindResult, type BulkAccountKindResult } from '@flow/shared';
import { ApiError, badRequest } from '../errors';
import { directory, type AuthEnv } from './auth';
import { adminOf } from './domains';

type C = Context<{ Bindings: AuthEnv }>;

export const accountRoutes = new Hono<{ Bindings: AuthEnv }>();

async function bodyOf<S extends ZodTypeAny>(c: C, schema: S): Promise<z.output<S>> {
  const r = schema.safeParse(await c.req.json().catch(() => undefined));
  if (!r.success) throw badRequest('validation', r.error.issues[0]?.message ?? 'invalid request');
  return r.data;
}

/** The member rows of the accounts that changed take their new address (null for a guest). */
async function followAddresses(c: C, organizationId: string, accounts: AccountDTO[]): Promise<void> {
  if (!accounts.length) return;
  await c.env.ORG.get(c.env.ORG.idFromName(organizationId)).accountAddresses(accounts.map((a) => ({ userId: a.principalId, address: a.address })));
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
  const before = (await directory(c, 'accountById', c.req.param('accountId')))?.kind;
  const account = await directory(c, 'setAccountKind', id, c.req.param('accountId'), body.kind);
  if (before !== account.kind) await followAddresses(c, id, [account]);
  return c.json({ account } satisfies AccountKindResult);
});

/** An admin removes a personal agent (docs/specs/agents.md §2): its account, and every delegation it acted through. Only a
 * `personal_agent` account; a member's account goes through DELETE /members/:userId, a shared agent's through /agents. */
accountRoutes.delete('/v1/workspaces/:id/accounts/:accountId', async (c) => {
  const id = await adminOf(c as never, 'remove agents');
  const account = await directory(c, 'removePersonalAgent', id, c.req.param('accountId'));
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
  const out = await directory(c, 'makeMembersGuests', id);
  await followAddresses(c, id, out.changed);
  return c.json({ changed: out.changed.length, unchanged: out.unchanged } satisfies BulkAccountKindResult);
});
