// References resolved for a reader (docs/specs/platform.md §5.3, phase 6.4): GET /v1/references (routes/references.ts).
// The Org object answers first (Chat's kinds, and anything in the share index shared with the reader); a reference it
// hands back as `ask` goes to the resolver its app's manifest declares for the kind (`resolve: 'app'`): Docs' object
// (`GET /api/places/:id`), the Calendar object that owns the calendar, or for an app added by manifest its object's
// `describe` (apps.ts). A kind with no resolver (Mail's) is denied, as
// is anything an app says the reader may not see. Nothing is cached: every answer is the reader's own.
import { parseReference, type Reference } from '@flow/shared';
import { addressOf, iconOf, type ResolvedReference } from '@flow/shared/addresses';
import type { Role } from '@flow/shared/grants';
import { APP_MANIFESTS } from '@flow/shared/manifests';
import type { OrgReferenceAnswer } from './org/services/references';

export { MAX_REFERENCES } from './org/services/references';

/** What an app's own object says of one of its objects, for this reader; null for nothing to see. */
export interface AppDescription { title: string; summary?: string; role?: Role; fileKind?: string }

/** Where the answers come from: the Org object, and each app object that resolves its own kinds. */
export interface ReferenceSources {
  org(refs: string[]): Promise<OrgReferenceAnswer[]>;
  /** Docs' object: a document's or a stored file's title, kind and the reader's role. */
  docs(ref: Reference): Promise<AppDescription | null>;
  /** The Calendar object owning the calendar: its name, or an event's title, and the reader's role. */
  calendar(ref: Reference): Promise<AppDescription | null>;
  /** Any other app's object, by its manifest (apps.ts `describeInApp`): an app added by manifest resolves its kinds here. */
  app?(ref: Reference): Promise<AppDescription | null>;
}

/** The app resolvers the manifests' `resolve: 'app'` kinds name, by app; any other app's are `app`'s. */
const APP_RESOLVERS: Record<string, keyof Omit<ReferenceSources, 'org'>> = { docs: 'docs', calendar: 'calendar' };

/** The resolver a manifest declares for a reference's kind, or none. */
export function resolverOf(ref: Pick<Reference, 'app' | 'kind'>): 'org' | 'app' | null {
  return APP_MANIFESTS.find((m) => m.name === ref.app)?.kinds.find((k) => k.kind === ref.kind)?.resolve ?? null;
}

/** The references, in the order asked and each once, resolved for the reader the sources were made for. */
export async function resolveReferences(refs: string[], sources: ReferenceSources): Promise<ResolvedReference[]> {
  const asked = [...new Set(refs)];
  if (asked.length === 0) return [];
  const first = await sources.org(asked);
  return Promise.all(first.map(async (a): Promise<ResolvedReference> => {
    if (!('ask' in a)) return a;
    const denied: ResolvedReference = { ref: a.ref, denied: true };
    const r = parseReference(a.ref);
    const source = r && resolverOf(r) === 'app' ? (APP_RESOLVERS[r.app] ?? 'app') : undefined;
    const resolve = source ? sources[source] : undefined;
    if (!r || !resolve) return denied;
    const d = await resolve.call(sources, r).catch((err: Error) => {
      console.error(`[references] ${r.app} for ${a.ref}: ${err.message}`);
      return null;
    });
    if (!d) return denied;
    return {
      ref: a.ref, app: r.app, kind: r.kind, title: d.title, icon: iconOf(r.app, r.kind, d.fileKind), url: addressOf(r, d.fileKind) ?? '',
      ...(d.summary ? { summary: d.summary } : {}), ...(d.role ? { role: d.role } : {}), ...(d.fileKind ? { fileKind: d.fileKind } : {}),
    };
  }));
}
