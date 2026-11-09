// Account kinds (platform.md §3.3): an owner or admin makes an account native (an address, a mailbox, a native calendar)
// or a guest (none of them), one at a time or every member at once. The directory keeps the kind; the Org object's
// member rows follow its address. Mounted before routes/org.ts, whose catch-all would send these to the Org object.
import { Hono, type Context } from 'hono';
import type { ZodTypeAny, z } from 'zod';
import { BulkAccountKindBody, SetAccountKindBody, type AccountDTO, type AccountKindResult, type BulkAccountKindResult } from '@flow/shared';
import { badRequest } from '../errors';
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

accountRoutes.patch('/v1/workspaces/:id/accounts/:accountId/kind', async (c) => {
  const id = await adminOf(c as never, 'change account kinds');
  const body = await bodyOf(c, SetAccountKindBody);
  const before = (await directory(c, 'accountById', c.req.param('accountId')))?.kind;
  const account = await directory(c, 'setAccountKind', id, c.req.param('accountId'), body.kind);
  if (before !== account.kind) await followAddresses(c, id, [account]);
  return c.json({ account } satisfies AccountKindResult);
});

accountRoutes.post('/v1/workspaces/:id/accounts/kind', async (c) => {
  const id = await adminOf(c as never, 'change account kinds');
  await bodyOf(c, BulkAccountKindBody);
  const out = await directory(c, 'makeMembersGuests', id);
  await followAddresses(c, id, out.changed);
  return c.json({ changed: out.changed.length, unchanged: out.unchanged } satisfies BulkAccountKindResult);
});
