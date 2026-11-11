// A person's assistant takes mail only from its sponsor's allowlist (agents.md §1.1, decision_log 2026-11-11): by default
// the sponsor's own addresses, plus the senders they add. A From line is easy to forge, so a sender counts only when the
// receiving server's Authentication-Results say the message really comes from the From domain: DMARC passed, or DKIM or
// SPF passed for that domain (or a parent of it).

const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1).toLowerCase();

/** `sub` is `parent` or under it (alignment, relaxed as DMARC's default is). */
const aligned = (sub: string, parent: string) => sub === parent || sub.endsWith(`.${parent}`) || parent.endsWith(`.${sub}`);

/** Whether the Authentication-Results headers vouch for `from`'s domain. */
export function authPasses(from: string, authResults: string[]): boolean {
  const fromDomain = domainOf(from);
  if (!fromDomain) return false;
  for (const header of authResults) {
    for (const clause of header.split(';').map((c) => c.trim().toLowerCase())) {
      const m = /^(dmarc|dkim|spf)\s*=\s*(\w+)(.*)$/.exec(clause);
      if (!m || m[2] !== 'pass') continue;
      const rest = m[3]!;
      if (m[1] === 'dmarc') {
        const d = /header\.from\s*=\s*([^\s;]+)/.exec(rest)?.[1];
        if (!d || aligned(d, fromDomain)) return true;
      } else if (m[1] === 'dkim') {
        const d = /header\.(?:d|i)\s*=\s*@?([^\s;]+)/.exec(rest)?.[1];
        if (d && aligned(domainOf(`x@${d.replace(/^.*@/, '')}`), fromDomain)) return true;
      } else {
        const d = /smtp\.mailfrom\s*=\s*([^\s;]+)/.exec(rest)?.[1];
        if (d && aligned(domainOf(d.includes('@') ? d : `x@${d}`), fromDomain)) return true;
      }
    }
  }
  return false;
}

/**
 * Whether the assistant takes this message: its From address is on the allowlist and authenticated. `trustFrom` skips the
 * authentication check, for local development against a test server that adds no Authentication-Results.
 */
export function senderAllowed(from: string | null | undefined, authResults: string[], allowed: Set<string>, trustFrom = false): boolean {
  const address = (from ?? '').trim().toLowerCase();
  if (!address || !allowed.has(address)) return false;
  return trustFrom || authPasses(address, authResults);
}

/** An allowlist as the sponsor typed it: addresses, trimmed, lower-cased, deduplicated, invalid ones dropped. */
export function cleanAllowlist(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const ok = list.filter((x): x is string => typeof x === 'string').map((x) => x.trim().toLowerCase()).filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));
  return [...new Set(ok)].slice(0, 200);
}
