// An account's address (docs/specs/platform.md §3.2): `<local>@<domain>`, unique across the platform. Until an
// organization has a domain of its own, the domain is `<slug>.freeflow.im`.

export const PLATFORM_DOMAIN = 'freeflow.im';

/** The domain of an organization with no domain of its own. */
export const organizationDomain = (slug: string) => `${slug.toLowerCase()}.${PLATFORM_DOMAIN}`;

/** The local part a name yields: ASCII-folded, lower-case, letters, digits and dots, words joined by a dot, no leading,
 * trailing or doubled dots, and `user` when nothing is left. An apostrophe joins rather than splits (`O'Brien` → `obrien`).
 * An agent passes its `agent_username`, a person their display name. */
export function localPart(name: string): string {
  const folded = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’]/g, '');
  const local = folded.split(/[^a-z0-9.]+/).filter(Boolean).join('.').replace(/\.{2,}/g, '.').replace(/^\.+|\.+$/g, '');
  return local || 'user';
}

/** The first of `local`, `local2`, `local3`, … at `domain` that `taken` does not claim. */
export function uniqueAddress(local: string, domain: string, taken: (address: string) => boolean): string {
  for (let n = 1; ; n++) {
    const address = `${n === 1 ? local : `${local}${n}`}@${domain}`;
    if (!taken(address)) return address;
  }
}
