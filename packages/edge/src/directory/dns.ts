// A domain's DNS, independent of the mail provider (platform.md §3.2, §3.5): the records an organization's admin
// publishes, and the lookups that check them, over DNS over HTTPS so the Worker needs no resolver of its own.
import type { DnsRecordDTO } from '@flow/shared';

/** What the mail provider asks of a domain (mailprovider/provider.ts `records`). */
export interface ProviderRecords {
  mx: { host: string; priority: number }[];
  /** The provider's SPF include, e.g. `_spf.provider.example`. */
  spfInclude: string;
  /** The DMARC policy line; `v=DMARC1; p=none` when the provider names none. */
  dmarcPolicy?: string;
  /** The DKIM public key's TXT, once a key is set (phase 5.2): at `<selector>._domainkey.<domain>`. */
  dkim?: { selector: string; value: string };
  /** The provider's own proof of ownership, when it asks for one before it takes the domain (MXRoute's
   * `_da-verify-<key>.<domain>` = `domain-verified`); published beside ours. */
  verification?: { name: string; value: string };
  /** Placeholder values (providers/none.ts, the fake): shown, never written to a real zone. */
  placeholder?: boolean;
}

/** Answers a name and type with the record data DNS has, TXT strings unquoted and joined, MX as `<priority> <host>`. */
export type Resolve = (name: string, type: 'TXT' | 'MX') => Promise<string[]>;

/** The name the verification TXT is published at. */
export const verificationName = (domain: string) => `_freeflow.${domain}`;

const DEFAULT_DMARC = 'v=DMARC1; p=none';

/** The records to publish for `domain`: the verification TXT when a token is given, the provider's own when it has one,
 * then MX, SPF, DMARC and DKIM. */
export function recordsFor(domain: string, provider: ProviderRecords, verifyToken?: string | null): DnsRecordDTO[] {
  return [
    ...(verifyToken ? [{ type: 'TXT' as const, name: verificationName(domain), value: verifyToken, purpose: 'verification' as const }] : []),
    ...(provider.verification ? [{ type: 'TXT' as const, name: provider.verification.name, value: provider.verification.value, purpose: 'provider' as const }] : []),
    ...provider.mx.map((m) => ({ type: 'MX' as const, name: domain, value: m.host, priority: m.priority, purpose: 'mx' as const })),
    { type: 'TXT', name: domain, value: `v=spf1 include:${provider.spfInclude} ~all`, purpose: 'spf' },
    { type: 'TXT', name: `_dmarc.${domain}`, value: provider.dmarcPolicy ?? DEFAULT_DMARC, purpose: 'dmarc' },
    ...(provider.dkim ? [{ type: 'TXT' as const, name: `${provider.dkim.selector}._domainkey.${domain}`, value: provider.dkim.value, purpose: 'dkim' as const }] : []),
  ];
}

/** A TXT answer's data as DoH JSON gives it, `"part one" "part two"`, back to its text. */
export function unquoteTxt(data: string): string {
  const parts = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!.replace(/\\(.)/g, '$1'));
  return parts.length ? parts.join('') : data;
}

const DNS_TYPES = { TXT: 16, MX: 15 } as const;

/** A resolver over DNS over HTTPS's JSON form (Cloudflare's, or the e2e's stub). NXDOMAIN and no answer are both []. */
export function dohResolver(url: string, fetchFn: typeof fetch = fetch): Resolve {
  return async (name, type) => {
    const res = await fetchFn(`${url}?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: 'application/dns-json' } });
    if (!res.ok) throw new Error(`DNS lookup of ${name} ${type}: ${res.status}`);
    const body = (await res.json()) as { Answer?: { type: number; data: string }[] };
    return (body.Answer ?? []).filter((a) => a.type === DNS_TYPES[type]).map((a) => (type === 'TXT' ? unquoteTxt(a.data) : a.data.trim()));
  };
}

/** Whether `_freeflow.<domain>` carries the token. A failed lookup is "not verified", with nothing found. */
export async function checkDomain(domain: string, token: string, resolve: Resolve): Promise<{ verified: boolean; found: string[] }> {
  const found = await resolve(verificationName(domain), 'TXT').catch(() => [] as string[]);
  return { verified: found.some((t) => t.trim() === token), found };
}

const host = (h: string) => h.trim().replace(/\.$/, '').toLowerCase();

/** Whether one found value satisfies an expected record. An SPF record may carry other includes beside the provider's,
 * and a DMARC record any policy: only their presence and the provider's include are required. */
function satisfies(expected: DnsRecordDTO, found: string): boolean {
  if (expected.type === 'MX') {
    const [priority, name] = found.trim().split(/\s+/);
    return !!name && host(name) === host(expected.value) && Number(priority) === expected.priority;
  }
  if (expected.purpose === 'spf') {
    const include = /include:(\S+)/.exec(expected.value)?.[1];
    return /^v=spf1\b/i.test(found) && (!include || found.split(/\s+/).includes(`include:${include}`));
  }
  if (expected.purpose === 'dmarc') return /^v=DMARC1\b/i.test(found.trim());
  return found.trim() === expected.value;
}

/** Each expected record, present or missing, in order. One lookup per name and type. */
export async function checkRecords(expected: DnsRecordDTO[], resolve: Resolve): Promise<{ record: 'present' | 'missing' }[]> {
  const lookups = new Map<string, Promise<string[]>>();
  const lookup = (name: string, type: 'TXT' | 'MX') => {
    const key = `${type} ${name.toLowerCase()}`;
    if (!lookups.has(key)) lookups.set(key, resolve(name, type).catch(() => []));
    return lookups.get(key)!;
  };
  return Promise.all(expected.map(async (r) => ({ record: (await lookup(r.name, r.type)).some((f) => satisfies(r, f)) ? 'present' as const : 'missing' as const })));
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** A domain as stored: lower-case, no trailing dot; null when it is not a hostname of two or more labels. */
export function normalizeDomain(raw: string): string | null {
  const d = raw.trim().toLowerCase().replace(/\.$/, '');
  if (d.length < 3 || d.length > 253) return null;
  const labels = d.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l)) || /^[0-9]+$/.test(labels.at(-1)!)) return null;
  return d;
}
