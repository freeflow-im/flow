// The apps' objects as the kernel reaches them from the manifests alone (docs/specs/platform.md §6.1, phase 6.5), so that an
// app added by manifest needs no line in the doors or the reference resolver: its binding is its object's class name in
// capitals (ORG, DOCS, MAIL, CALENDAR, EVENTS, ASSISTANT, …, as wrangler.toml names them), an account-scoped app's object is
// `idFromName(accountId)` and an organization-scoped one's `idFromName(organizationId)`.
//
//   - Tools: an account-scoped app's server tools run with `ctx.apps[<app>]` (an AppToolContext), its object's HTTP API as
//     the caller's account, at /mcp (the Docs object, docs/plugin/server/worker.ts) and in the assistant (assistant/object.ts).
//     Mail's and Calendar's tools keep the contexts of their own they had before the manifests.
//   - References: a kind that resolves `app` is asked of the object's `describe(caller, channelIds, kind, id)`; for an
//     account-scoped app, the object of the account its id begins with (`<accountId>:<rest>`), else the reader's own.
import type { AppManifest, Reference } from '@flow/shared';
import { APP_MANIFESTS } from '@flow/shared/manifests';
import type { CallerContext } from './org/routes/compat';
import type { AppDescription } from './references';

/** An app object as the kernel calls it: its HTTP API for a caller, and what it says of one of its objects for a reader. */
export interface AppObject {
  handle(request: Request, caller: CallerContext): Promise<Response>;
  describe(caller: CallerContext, channelIds: string[], kind: string, id: string): Promise<AppDescription | null> | AppDescription | null;
}
interface AppNamespace { idFromName(name: string): DurableObjectId; get(id: DurableObjectId): AppObject }

/** What an app's server tools are given (`ctx.apps[<app>]`): its object's HTTP API as the caller's account, and the public origin. */
export interface AppToolContext {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  origin: string;
}

/** The apps whose tools take a context of their own (mailTools.ts, calendarTools.ts), not an AppToolContext. */
const OWN_CONTEXT = new Set(['mail', 'calendar']);

export const manifestOf = (app: string): AppManifest | undefined => APP_MANIFESTS.find((m) => m.name === app);

/** The Worker binding of an app's object: its class name in capitals. */
export const bindingOf = (m: AppManifest): string | null => (m.object ? m.object.className.toUpperCase() : null);

/** An app's object namespace in this environment, or undefined where the Worker has none. */
export function namespaceOf(env: object, m: AppManifest): AppNamespace | undefined {
  const name = bindingOf(m);
  return name ? ((env as Record<string, unknown>)[name] as AppNamespace | undefined) : undefined;
}

/** The account an id of an account-scoped app's object names (`<accountId>:<rest>`), or null. */
export const ownerOfId = (id: string): string | null => /^([A-Za-z0-9-]+):./.exec(id)?.[1] ?? null;

/**
 * The tool contexts of the account-scoped apps with tools (Mail and Calendar aside), by app name, for the caller `who`
 * resolves to (null: no account here, and each call answers 403 `no_account`). Apps the Worker has no binding for are left
 * out, so /mcp leaves their tools out (a runner's `needs`).
 */
export function appToolContexts(env: object, who: () => Promise<CallerContext | null>, origin: string): Record<string, AppToolContext> {
  const out: Record<string, AppToolContext> = {};
  for (const m of APP_MANIFESTS) {
    if (m.scope !== 'account' || !m.tools?.length || OWN_CONTEXT.has(m.name)) continue;
    const ns = namespaceOf(env, m);
    if (!ns) continue;
    out[m.name] = {
      origin,
      fetch: async (path, init) => {
        const caller = await who();
        if (!caller?.account) return Response.json({ error: { code: 'no_account', message: `join an organization to use ${m.tab?.label ?? m.name.charAt(0).toUpperCase() + m.name.slice(1)}` } }, { status: 403 });
        return ns.get(ns.idFromName(caller.account.id)).handle(new Request(`${origin}${path}`, init), caller);
      },
    };
  }
  return out;
}

/** One of an app's objects described for a reader, by the object that owns it (GET /v1/references); null for nothing to see. */
export async function describeInApp(env: object, ref: Reference, reader: CallerContext, channelIds: string[]): Promise<AppDescription | null> {
  const m = manifestOf(ref.app);
  const ns = m ? namespaceOf(env, m) : undefined;
  if (!m || !ns || !reader.account) return null;
  const name = m.scope === 'account' ? (ownerOfId(ref.id) ?? reader.account.id) : ref.organizationId;
  return (await ns.get(ns.idFromName(name)).describe(reader, channelIds, ref.kind, ref.id)) ?? null;
}
