// Where a /v1/calendar request goes (platform.md §4.4): the caller's own Calendar object, or, for a request naming another
// account's native calendar, that account's object as a reader (`handleShared`); and `GET /v1/calendar/shared`, answered
// from the organization's share index. The routes (routes/calendar.ts) and the Calendar tools (Docs' object builds their
// fetch on this) take the same path, so a tool reaches a shared calendar exactly as the client does.
import type { AccountDTO } from '@flow/shared';
import { parseReference } from '@flow/shared';
import type { CallerContext } from '../org/routes/compat';
import type { Calendar } from './object';
import { nativeOwnerOf } from './rules';

export interface CalendarForwardEnv {
  CALENDAR: DurableObjectNamespace<Calendar>;
  ORG: DurableObjectNamespace<import('../org/object').Org>;
}
export type AccountCaller = CallerContext & { account: AccountDTO };

/**
 * The owner of a native calendar (`n.<ownerAccountId>.<random>`, phase 4.1) that a request names, when it is another
 * account: in the path (`/events/<calendarId>:…`, `/calendars/<calendarId>…`), the `calendars` query, or a JSON body's
 * `calendarId`. Null when the request is about the caller's own calendars.
 */
export async function sharedOwnerOf(req: Request, self: string): Promise<string | null> {
  const url = new URL(req.url);
  const ids: string[] = [];
  const named = /^\/v1\/calendar\/(?:events|calendars)\/([^/]+)/.exec(url.pathname)?.[1];
  if (named) { try { ids.push(decodeURIComponent(named).split(':')[0]!); } catch { /* not an id */ } }
  ids.push(...(url.searchParams.get('calendars') ?? '').split(','));
  if ((req.method === 'POST' || req.method === 'PATCH') && (req.headers.get('content-type') ?? '').includes('json')) {
    const body = await req.clone().json().catch(() => null) as { calendarId?: unknown } | null;
    if (typeof body?.calendarId === 'string') ids.push(body.calendarId);
  }
  for (const id of ids) {
    const owner = nativeOwnerOf(id.trim());
    if (owner && owner !== self) return owner;
  }
  return null;
}

/**
 * The native calendars shared with the caller (`GET /v1/calendar/shared`): the organization's share index (one call), then
 * each owner's object for the calendars' names, colours and the caller's role there (which drops any since unshared).
 */
export async function sharedWithCaller(env: CalendarForwardEnv, who: AccountCaller, userId: string) {
  const org = who.account.organizationId;
  const orgObject = env.ORG.get(env.ORG.idFromName(org));
  const channelIds = await orgObject.channelIdsOf(userId);
  const byOwner = new Map<string, Map<string, { grantedBy: string; url: string }>>();
  for (const s of await orgObject.sharedWith({ accountId: who.account.id, channelIds })) {
    const ref = s.kind === 'calendar' ? parseReference(s.ref) : null;
    const owner = ref?.app === 'calendar' && ref.kind === 'calendar' && ref.organizationId === org ? nativeOwnerOf(ref.id) : null;
    if (!ref || !owner || owner === who.account.id) continue;
    if (!byOwner.has(owner)) byOwner.set(owner, new Map());
    byOwner.get(owner)!.set(ref.id, { grantedBy: s.grantedBy, url: s.url });
  }
  return (await Promise.all([...byOwner].map(async ([owner, items]) => {
    const found = await env.CALENDAR.get(env.CALENDAR.idFromName(owner)).sharedCalendars(who, channelIds, [...items.keys()]).catch(() => []);
    return found.map((x) => ({ ...x, ownerAccountId: owner, ...items.get(x.id)! }));
  }))).flat();
}

/** One /v1/calendar request as `who` (person `userId`): the shared list, a reader's request to an owner's object, or the caller's own. */
export async function calendarRequest(env: CalendarForwardEnv, request: Request, who: AccountCaller, userId: string): Promise<Response> {
  if (request.method === 'GET' && new URL(request.url).pathname === '/v1/calendar/shared') {
    return Response.json({ calendars: await sharedWithCaller(env, who, userId) }, { headers: { 'cache-control': 'no-store' } });
  }
  const owner = await sharedOwnerOf(request, who.account.id);
  return owner
    ? env.CALENDAR.get(env.CALENDAR.idFromName(owner)).handleShared(request, who, await env.ORG.get(env.ORG.idFromName(who.account.organizationId)).channelIdsOf(userId))
    : env.CALENDAR.get(env.CALENDAR.idFromName(who.account.id)).handle(request, who);
}
