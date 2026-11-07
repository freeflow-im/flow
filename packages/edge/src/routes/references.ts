// GET /v1/references?refs=<ref>,<ref>&workspace=<id> → { references: [{ ref, kind, app, title, url, icon, summary?, role? }
// | { ref, denied: true }] } (docs/specs/platform.md §5.3, phase 6.4): each reference resolved for the caller, by the Org
// object and the app objects the manifests name (src/references.ts). Chat's chips ask this, once per message list.
import { Hono } from 'hono';
import type { Calendar } from '../calendar/object';
import { nativeOwnerOf } from '../calendar/rules';
import type { Docs } from '../docs/object';
import { ApiError, badRequest } from '../errors';
import { MAX_REFERENCES, resolveReferences, type AppDescription } from '../references';
import { resolveCaller, type AuthEnv } from './auth';

export interface ReferenceRouteEnv extends AuthEnv {
  DOCS?: DurableObjectNamespace<Docs>;
  CALENDAR?: DurableObjectNamespace<Calendar>;
}

export const referenceRoutes = new Hono<{ Bindings: ReferenceRouteEnv }>();

referenceRoutes.get('/v1/references', async (c) => {
  const org = c.req.query('workspace') || c.req.query('org');
  if (!org) throw badRequest('organization_required', 'name an organization: ?workspace=<id>');
  const who = await resolveCaller(c, org);
  if (!who.user) throw new ApiError(401, 'unauthorized', 'missing bearer token');
  if (!who.account) throw new ApiError(403, 'no_account', 'not a member of this organization');
  const refs = (c.req.query('refs') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (refs.length > MAX_REFERENCES) throw badRequest('too_many', `at most ${MAX_REFERENCES} references`);
  const user = who.user, account = who.account;
  const orgObject = c.env.ORG.get(c.env.ORG.idFromName(org));
  let channels: Promise<string[]> | null = null;
  const channelIds = () => (channels ??= orgObject.channelIdsOf(user.id));
  const origin = new URL(c.req.url).origin;
  const references = await resolveReferences(refs, {
    org: (asked) => orgObject.resolveReferences(user.id, org, asked),
    docs: async (ref) => {
      const ns = c.env.DOCS;
      if (!ns || (ref.kind !== 'sheet' && ref.kind !== 'file')) return null;
      const res = await ns.get(ns.idFromName(org)).handle(new Request(`${origin}/api/places/${encodeURIComponent(ref.id)}?workspace=${encodeURIComponent(org)}`),
        { userId: user.id, email: user.email, token: who.token, ip: who.ip, accountId: account.id, channelIds: await channelIds() }, org);
      if (!res.ok) return null;
      const place = (await res.json()) as { title?: string; kind?: string; role?: AppDescription['role'] };
      return place.title ? { title: place.title, ...(place.kind ? { fileKind: place.kind } : {}), ...(place.role ? { role: place.role } : {}) } : null;
    },
    calendar: async (ref) => {
      const ns = c.env.CALENDAR;
      if (!ns || (ref.kind !== 'calendar' && ref.kind !== 'event')) return null;
      // A native calendar's id names its owner's account; any other calendar is the caller's own.
      const owner = nativeOwnerOf((ref.kind === 'event' ? ref.id.split(':')[0] : ref.id) ?? '') ?? account.id;
      return ns.get(ns.idFromName(owner)).describe({ ...who, account }, await channelIds(), ref.kind, ref.id);
    },
  });
  c.header('Cache-Control', 'no-store');
  return c.json({ references });
});
