// A person's assistant takes mail only from its sponsor's allowlist (agents.md §1.1, decision_log 2026-11-11): by default
// the sponsor's own addresses, plus the senders they add. A From line is easy to forge, so a sender counts only when the
// receiving server's Authentication-Results say the message really comes from the From domain: DMARC passed, or DKIM or
// SPF passed for that domain (or a parent of it).

const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1).toLowerCase();

/** `sub` is `parent` or under it (alignment, relaxed as DMARC's default is). */
const aligned = (sub: string, parent: string) => sub === parent || sub.endsWith(`.${parent}`) || parent.endsWith(`.${sub}`);

/** A header value without its `( … )` comments (RFC 5322 CFWS, nested), which may hold a `;` of their own. */
export function stripComments(value: string): string {
  let out = '', depth = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === '\\' && depth > 0) { i++; continue; }
    if (ch === '(') { depth++; continue; }
    if (ch === ')' && depth > 0) { depth--; continue; }
    if (depth === 0) out += ch;
  }
  return out;
}

/** Whether the Authentication-Results headers vouch for `from`'s domain. */
export function authPasses(from: string, authResults: string[]): boolean {
  const fromDomain = domainOf(from);
  if (!fromDomain) return false;
  for (const header of authResults) {
    for (const clause of stripComments(header).split(';').map((c) => c.trim().toLowerCase())) {
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
  return screenReason(from, authResults, allowed, trustFrom) === 'ok';
}

/** Why a message is taken or refused: `ok`, its sender is `not_on_list`, or the receiving server did not vouch for it (`unauthenticated`). */
export function screenReason(from: string | null | undefined, authResults: string[], allowed: Set<string>, trustFrom = false): 'ok' | 'not_on_list' | 'unauthenticated' {
  const address = (from ?? '').trim().toLowerCase();
  if (!address || !allowed.has(address)) return 'not_on_list';
  return trustFrom || authPasses(address, authResults) ? 'ok' : 'unauthenticated';
}

/** An allowlist as the sponsor typed it: addresses, trimmed, lower-cased, deduplicated, invalid ones dropped. */
export function cleanAllowlist(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const ok = list.filter((x): x is string => typeof x === 'string').map((x) => x.trim().toLowerCase()).filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));
  return [...new Set(ok)].slice(0, 200);
}
