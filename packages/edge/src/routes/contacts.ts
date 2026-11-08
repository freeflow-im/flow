// FreeFlow Contacts' API, /v1/contacts/* (platform.md §11, phase 6.5): the caller is authenticated here, then the request goes
// to the Contacts object of their account in the organization named (src/contacts/object.ts), which answers all of it:
//   GET    /v1/contacts?q=          the merged list: own, the organization's members, lists shared with it, people written to
//   GET    /v1/contacts/search?q=   the same, searched (q required)
//   POST   /v1/contacts             { name, emails?, phone?, orgName?, notes? } → 201 { contact }
//   PATCH  /v1/contacts/:id         the same fields → { contact }
//   DELETE /v1/contacts/:id         → { ok: true }
//   GET    /v1/contacts/share       → { org }
//   PUT    /v1/contacts/share       { org: true | false }: the list shared with the organization as viewer, or not
import { Hono } from 'hono';
import type { Contacts } from '../contacts/object';
import { resolveAccountCaller, type AuthEnv } from './auth';

export interface ContactsRouteEnv extends AuthEnv { CONTACTS: DurableObjectNamespace<Contacts> }

export const contactsRoutes = new Hono<{ Bindings: ContactsRouteEnv }>();

const forward = async (c: import('hono').Context<{ Bindings: ContactsRouteEnv }>) => {
  const who = await resolveAccountCaller(c, 'Contacts');
  const res = await c.env.CONTACTS.get(c.env.CONTACTS.idFromName(who.account.id)).handle(c.req.raw, who);
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', 'no-store');
  return out;
};

contactsRoutes.all('/v1/contacts', forward);
contactsRoutes.all('/v1/contacts/*', forward);
