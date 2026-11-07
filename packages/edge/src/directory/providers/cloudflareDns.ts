// The platform subdomain's records (platform.md §3.2): `<slug>.freeflow.im` is in our own zone, so its MX, SPF and DMARC
// are written through the Cloudflare API v4 rather than shown to anyone. Idempotent: run when the organization is made
// and again by provisioning (phase 5.3). Without CLOUDFLARE_DNS_TOKEN and CLOUDFLARE_DNS_ZONE_ID, a dev driver logs
// what it would write.
import type { DnsRecordDTO } from '@flow/shared';
import { recordsFor, type ProviderRecords } from '../dns';
import { organizationDomain } from '../addresses';

export interface PlatformDnsEnv {
  /** A token with DNS edit on the freeflow.im zone. A secret. */
  CLOUDFLARE_DNS_TOKEN?: string;
  /** The freeflow.im zone's id. A secret. */
  CLOUDFLARE_DNS_ZONE_ID?: string;
}

export interface PlatformDns {
  /** Makes the zone hold exactly these records at their names, for the types and purposes given. */
  publish(records: DnsRecordDTO[]): Promise<void>;
}

const API = 'https://api.cloudflare.com/client/v4';

interface CfRecord { id: string; type: string; name: string; content: string; priority?: number }

const unquote = (s: string) => s.replace(/^"|"$/g, '');
/** The records at one name that a desired one may replace: every MX there, or the TXT of the same kind (SPF, DMARC). */
const sameKind = (r: DnsRecordDTO, c: CfRecord) =>
  c.type === r.type && (r.type === 'MX' || unquote(c.content).split(/[\s;]/)[0]!.toLowerCase() === r.value.split(/[\s;]/)[0]!.toLowerCase());

export function cloudflareDns(token: string, zoneId: string, fetchFn: typeof fetch = fetch): PlatformDns {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetchFn(`${API}/zones/${zoneId}/dns_records${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const answer = (await res.json().catch(() => ({}))) as { success?: boolean; result?: T; errors?: { message: string }[] };
    if (!res.ok || !answer.success) throw new Error(`cloudflare dns ${method} ${path}: ${res.status} ${answer.errors?.map((e) => e.message).join('; ') ?? ''}`);
    return answer.result as T;
  };
  const content = (r: DnsRecordDTO) => ({ type: r.type, name: r.name, content: r.value, ttl: 1, ...(r.type === 'MX' ? { priority: r.priority } : {}) });
  const same = (r: DnsRecordDTO, c: CfRecord) => unquote(c.content).toLowerCase() === r.value.toLowerCase() && (r.type !== 'MX' || c.priority === r.priority);

  return {
    async publish(records) {
      // One group per name and type: an MX group is replaced as a whole, a TXT one only for the kinds we write.
      const groups = new Map<string, DnsRecordDTO[]>();
      for (const r of records) groups.set(`${r.type} ${r.name}`, [...(groups.get(`${r.type} ${r.name}`) ?? []), r]);
      for (const group of groups.values()) {
        const { type, name } = group[0]!;
        const existing = (await call<CfRecord[]>('GET', `?type=${type}&name=${encodeURIComponent(name)}`)).filter((c) => group.some((r) => sameKind(r, c)));
        const unused = [...existing];
        const todo: DnsRecordDTO[] = [];
        for (const r of group) {
          const i = unused.findIndex((c) => same(r, c));
          if (i >= 0) unused.splice(i, 1);
          else todo.push(r);
        }
        for (const r of todo) {
          const reuse = unused.findIndex((c) => sameKind(r, c));
          if (reuse >= 0) await call('PATCH', `/${unused.splice(reuse, 1)[0]!.id}`, content(r));
          else await call('POST', '', content(r));
        }
        // What is left is stale: an old provider's MX, or a second SPF line that would make both invalid.
        for (const c of unused) await call('DELETE', `/${c.id}`);
      }
    },
  };
}

/** The dev driver: says what it would write. */
export const loggingDns = (log: (line: string) => void = console.log): PlatformDns => ({
  async publish(records) {
    for (const r of records) log(`platform dns (dev): ${r.type} ${r.name} ${r.priority ?? ''} ${r.value}`.replace(/\s+/g, ' '));
  },
});

/** The driver the environment calls for. A placeholder provider's records are only ever logged. */
export function platformDns(env: PlatformDnsEnv, provider: ProviderRecords, fetchFn: typeof fetch = fetch): PlatformDns {
  if (provider.placeholder || !env.CLOUDFLARE_DNS_TOKEN || !env.CLOUDFLARE_DNS_ZONE_ID) return loggingDns();
  return cloudflareDns(env.CLOUDFLARE_DNS_TOKEN, env.CLOUDFLARE_DNS_ZONE_ID, fetchFn);
}

/** The records `<slug>.freeflow.im` carries: the provider's MX, SPF and DMARC; no verification TXT, since it is ours. */
export const platformDomainRecords = (slug: string, provider: ProviderRecords) => recordsFor(organizationDomain(slug), provider);

/** Writes the platform subdomain's records. Safe to run again. */
export const publishPlatformDomain = (env: PlatformDnsEnv, slug: string, provider: ProviderRecords, fetchFn: typeof fetch = fetch) =>
  platformDns(env, provider, fetchFn).publish(platformDomainRecords(slug, provider));
