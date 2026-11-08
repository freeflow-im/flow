// References in messages (docs/specs/platform.md §5.3, phase 6.4): a FreeFlow address on this connection's server
// (`referenceOf`) in a message is a reference, drawn as a chip resolved for the reader — one batched
// GET /v1/references per message list — not as a fetched link preview (the server skips those, unfurl/index.ts).
import { createContext, useContext, useEffect, useState } from 'react';
import { formatReference, type MessageDTO } from '@flow/shared';
import { referenceOf, type AddressedReference, type ResolvedReference } from '@flow/suite-bar';

const URL_RE = /https?:\/\/[^\s<>()[\]"'`]+/g;

/** At most this many chips under one message, as link previews. */
export const MAX_CHIPS_PER_MESSAGE = 3;

/** A reference found in a message: the address as written and the reference (formatted) it names. */
export interface FoundReference { url: string; ref: string; reference: AddressedReference }

/** The references a message's text names, each once, in order: FreeFlow addresses on `origin`, in `organizationId`. */
export function referencesIn(body: string, origin: string, organizationId: string, limit = MAX_CHIPS_PER_MESSAGE): FoundReference[] {
  const out: FoundReference[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?)]+$/, '');
    const reference = referenceOf(url, { origin, organizationId });
    if (!reference) continue;
    const ref = formatReference(reference);
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push({ url, ref, reference });
    if (out.length >= limit) break;
  }
  return out;
}

/** Every reference in a list of messages (their text, and a share notice's address), each once. */
export function referencesOfMessages(messages: readonly Pick<MessageDTO, 'body' | 'deletedAt'>[], origin: string, organizationId: string | null): string[] {
  if (!organizationId) return [];
  const all = new Set<string>();
  for (const m of messages) if (!m.deletedAt) for (const f of referencesIn(m.body, origin, organizationId)) all.add(f.ref);
  return [...all].sort();
}

/** The resolved references a message list asked for, by formatted reference; and the address context they came from. */
export interface ReferenceLookup { origin: string; organizationId: string | null; get(ref: string): ResolvedReference | undefined }

export const ReferencesContext = createContext<ReferenceLookup | null>(null);
export const useReferenceLookup = () => useContext(ReferencesContext);

/** One GET /v1/references for the list's references, as the reader, again only when the set changes. What came back
 * stays while a newer set is asked for; nothing is shared across connections or readers; a failure leaves every chip a
 * plain link. */
export function useResolvedReferences(
  api: <T>(method: string, path: string) => Promise<T>,
  origin: string,
  organizationId: string | null,
  refs: string[],
): ReferenceLookup {
  const key = organizationId && refs.length ? `${origin}|${organizationId}|${refs.join(',')}` : '';
  const [known, setKnown] = useState<{ scope: string; byRef: Map<string, ResolvedReference> }>({ scope: '', byRef: new Map() });
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const scope = `${origin}|${organizationId}`;
    api<{ references: ResolvedReference[] }>('GET', `/v1/references?workspace=${encodeURIComponent(organizationId!)}&refs=${refs.map(encodeURIComponent).join(',')}`).then(
      (r) => alive && setKnown((k) => ({ scope, byRef: new Map([...(k.scope === scope ? k.byRef : []), ...r.references.map((x) => [x.ref, x] as const)]) })),
      () => {},
    );
    return () => { alive = false; };
    // The key is the request: the refs it names, for this connection and organization.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const byRef = known.scope === `${origin}|${organizationId}` ? known.byRef : new Map<string, ResolvedReference>();
  return { origin, organizationId, get: (ref) => byRef.get(ref) };
}
