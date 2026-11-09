// MXRoute's REST API (https://api.mxroute.com, its OpenAPI document read on 2026-11-08) over fetch. Every request carries
// three headers: X-Server (the account's mail server, e.g. `sunfire.mxrouting.net`), X-Username (the DirectAdmin user) and
// X-API-Key (a key made at panel.mxroute.com). Answers are `{ success, data }` or `{ success: false, error: { code, message } }`,
// 204 for a deletion. Limits: 200 reads and 60 writes a minute, 429 with Retry-After past them.
//
// Three things differ from OpenSRS and shape the provider interface (provider.ts):
// - A domain is taken only once a TXT record proves it is ours: `GET /verification-key` gives the account's key, and
//   `<key>.<domain>` must carry `domain-verified` before `POST /domains`. So `records` lists that TXT (purpose `provider`)
//   beside ours, and `createDomain` looks it up first and answers `pending` while it is missing.
// - MXRoute makes and keeps each domain's DKIM key itself (DirectAdmin, selector `x` today): `managesDkim`. The record to
//   publish comes from `GET /domains/{domain}/dns` once the domain exists there, as do its exact MX hosts.
// - A mailbox cannot be suspended through the API (PATCH takes only password, quota and limit): `suspendsByPassword`.
import type { ProviderRecords, Resolve } from '../directory/dns';
import { ProviderError, type DkimRecord, type MailProvider, type MailboxState, type ProviderErrorCode } from './provider';

export interface MxRouteConfig {
  /** The mail server from the API Keys page, which is also the IMAP and SMTP host. */
  server: string;
  username: string;
  apiKey: string;
  /** Default `https://api.mxroute.com`. */
  apiUrl?: string;
  /** Overrides the IMAP and SMTP host. */
  mailHost?: string;
  /** Looks the ownership TXT up before a domain is added; without it the API's own refusal is relied on. */
  resolve?: Resolve;
  fetch?: typeof fetch;
}

export const MXROUTE_API_URL = 'https://api.mxroute.com';
/** The value MXRoute's ownership TXT carries (managing-domains, docs.mxroute.com). */
export const MXROUTE_VERIFIED = 'domain-verified';
/** The SPF include MXRoute's DNS info shows (`v=spf1 include:mxroute.com -all`); ours ends `~all` (dns.ts). */
const SPF_INCLUDE = 'mxroute.com';
const MIB = 1024 ** 2;
/** How long one domain's DNS info from the API is reused, so the Domains page does not spend the read limit. */
const DNS_INFO_TTL = 5 * 60_000;

/** The relay MX beside the server: `sunfire.mxrouting.net` → `sunfire-relay.mxrouting.net` (MXRoute's quick setup). */
export const relayHost = (server: string) => server.replace(/^([^.]+)/, '$1-relay');

/** A password MXRoute takes: 8 to 72 characters (POST and PATCH email-accounts). The server's own strength rules are its. */
const validPassword = (p: string) => p.length >= 8 && p.length <= 72;

const CODES: Record<string, ProviderErrorCode> = {
  UNAUTHORIZED: 'auth', FORBIDDEN: 'auth', NOT_FOUND: 'not_found', CONFLICT: 'conflict', RATE_LIMITED: 'rate_limited',
  SERVER_ERROR: 'unavailable', VALIDATION_ERROR: 'bad_request', BUSINESS_ERROR: 'bad_request',
};

interface Answer { success?: boolean; data?: unknown; error?: { code?: string; message?: string; field?: string } }
interface DnsInfo {
  mx_records?: { priority: number; hostname: string }[];
  spf?: { value?: string };
  dkim?: { name?: string; value?: string } | null;
  verification?: { name?: string; value?: string } | null;
}

/** What one account's API has told this isolate: its verification key, and each domain's DNS info for a while. */
interface Cache { key?: Promise<string>; dns: Map<string, { at: number; info: DnsInfo | null }> }
const caches = new Map<string, Cache>();

/** A 32-character password nobody keeps: what a suspended mailbox gets. */
function throwawayPassword(): string {
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return [...crypto.getRandomValues(new Uint8Array(32))].map((b) => chars[b % chars.length]!).join('');
}

const splitAddress = (address: string): { user: string; domain: string } => {
  const at = address.lastIndexOf('@');
  if (at < 1 || at === address.length - 1) throw new ProviderError('bad_request', `not an address: ${address}`);
  return { user: address.slice(0, at), domain: address.slice(at + 1).toLowerCase() };
};

export class MxRouteMailProvider implements MailProvider {
  readonly name = 'mxroute';
  readonly managesDkim = true;
  readonly suspendsByPassword = true;
  private readonly cache: Cache;

  constructor(private readonly cfg: MxRouteConfig) {
    const id = `${cfg.apiUrl ?? MXROUTE_API_URL}|${cfg.server}|${cfg.username}`;
    if (!caches.has(id)) caches.set(id, { dns: new Map() });
    this.cache = caches.get(id)!;
  }

  /**
   * Before the domain is at MXRoute: the server and its relay as MX (10 and 20), `include:mxroute.com`, no DKIM (MXRoute
   * has not made the key yet). Once it is: what `GET /domains/{domain}/dns` says, DKIM included. Always the ownership TXT,
   * so the platform zone keeps it and an admin sees it. The `dkim` given is the directory's own key, which MXRoute would
   * not sign with, so it is left out (`managesDkim`).
   */
  async records(domain: string, _dkim?: DkimRecord | null): Promise<ProviderRecords> {
    const [key, info] = await Promise.all([this.verificationKey(), this.dnsInfo(domain)]);
    const mx = info?.mx_records?.length
      ? info.mx_records.map((m) => ({ host: m.hostname.replace(/\.$/, ''), priority: Number(m.priority) }))
      : [{ host: this.cfg.server, priority: 10 }, { host: relayHost(this.cfg.server), priority: 20 }];
    const spfInclude = /include:(\S+)/.exec(info?.spf?.value ?? '')?.[1] ?? SPF_INCLUDE;
    const dkim = dkimOf(info?.dkim, domain);
    return {
      mx, spfInclude, dmarcPolicy: 'v=DMARC1; p=none',
      verification: { name: `${key}.${domain}`, value: MXROUTE_VERIFIED },
      ...(dkim ? { dkim } : {}),
    };
  }

  /** IMAP 993 and SMTP 465 over TLS on the account's server, the login the full address (quick setup, docs.mxroute.com). */
  mailSettings(address: string) {
    const host = this.cfg.mailHost ?? this.cfg.server;
    return {
      imap: { host, port: 993, security: 'tls' as const, username: address },
      smtp: { host, port: 465, security: 'tls' as const, username: address },
    };
  }

  /**
   * `POST /domains` once the ownership TXT is in DNS; a domain MXRoute has (GET 200, or 409) is left as it is. While the
   * TXT is missing the answer is `pending`, from our own lookup when a resolver is given, else from MXRoute's refusal. The
   * limits are the account's package at MXRoute, not the domain's, so `opts` has nothing to set.
   */
  async createDomain(domain: string, _opts: { quotaBytes: number; maxUsers: number }) {
    if (await this.dnsInfo(domain, true)) return;
    const key = await this.verificationKey();
    const name = `${key}.${domain}`;
    if (this.cfg.resolve) {
      const found = await this.cfg.resolve(name, 'TXT').catch(() => [] as string[]);
      if (!found.some((t) => t.trim() === MXROUTE_VERIFIED)) throw new ProviderError('pending', `the record TXT ${name} = ${MXROUTE_VERIFIED} is not in DNS yet`);
    }
    try {
      await this.call('POST', '/domains', { domain });
    } catch (err) {
      if (err instanceof ProviderError && err.code === 'conflict') return;
      if (err instanceof ProviderError && err.code === 'bad_request' && /verif|ownership|txt/i.test(err.message)) throw new ProviderError('pending', `MXRoute has not seen TXT ${name} = ${MXROUTE_VERIFIED} yet: ${err.message}`);
      throw err;
    } finally {
      this.cache.dns.delete(domain);
    }
  }

  /** `DELETE /domains/{domain}`. Gone already is done. */
  async deleteDomain(domain: string) {
    await this.ignoring('not_found', this.call('DELETE', `/domains/${enc(domain)}`));
    this.cache.dns.delete(domain);
  }

  /** Never called: `managesDkim`. The API has no way to give MXRoute a key. */
  async setDkim(_domain: string, _selector: string, _privateKeyPem: string): Promise<void> {
    throw new ProviderError('bad_request', 'MXRoute makes and keeps each domain\'s DKIM key itself; its record is in the domain\'s list once the domain is set up');
  }

  /** `POST /domains/{domain}/email-accounts` with the local part, the password and the quota in MB; the daily send limit
   * stays the default. There is no display name. An existing mailbox (409) is left as it is. */
  async createMailbox(m: { address: string; displayName: string; password: string; quotaBytes: number }) {
    this.checkPassword(m.password);
    const { user, domain } = splitAddress(m.address);
    await this.ignoring('conflict', this.call('POST', `/domains/${enc(domain)}/email-accounts`, { username: user, password: m.password, quota: Math.max(1, Math.floor(m.quotaBytes / MIB)) }));
  }

  /** `PATCH .../email-accounts/{user}` with the password only; PATCH does not create, so a missing mailbox is 404. */
  async setPassword(address: string, password: string) {
    this.checkPassword(password);
    const { user, domain } = splitAddress(address);
    await this.call('PATCH', `/domains/${enc(domain)}/email-accounts/${enc(user)}`, { password });
  }

  /** Suspended or disabled: a password nobody has, so nothing can log in while mail still arrives. Enabled: nothing here;
   * provisioning gives the mailbox a fresh password and writes it to the Mail object (`suspendsByPassword`). */
  async setMailboxState(address: string, state: MailboxState) {
    if (state === 'enabled') {
      const box = await this.getMailbox(address);
      if (!box.exists) throw new ProviderError('not_found', `no mailbox ${address}`);
      return;
    }
    await this.setPassword(address, throwawayPassword());
  }

  /** `DELETE .../email-accounts/{user}`. Gone already is done. */
  async deleteMailbox(address: string) {
    const { user, domain } = splitAddress(address);
    await this.ignoring('not_found', this.call('DELETE', `/domains/${enc(domain)}/email-accounts/${enc(user)}`));
  }

  /** `GET .../email-accounts/{user}`: `suspended` (MXRoute's own flag, not ours) and `quota` in MB, 0 being unlimited. */
  async getMailbox(address: string) {
    const { user, domain } = splitAddress(address);
    let data: { suspended?: boolean; quota?: number };
    try {
      data = (await this.call('GET', `/domains/${enc(domain)}/email-accounts/${enc(user)}`)).data as typeof data ?? {};
    } catch (err) {
      if (err instanceof ProviderError && err.code === 'not_found') return { exists: false };
      throw err;
    }
    const quota = Number(data.quota);
    return {
      exists: true,
      state: data.suspended ? 'suspended' : 'enabled',
      ...(Number.isFinite(quota) && quota > 0 ? { quotaBytes: quota * MIB } : {}),
    };
  }

  /** The account's verification key, asked once per isolate (`GET /verification-key`, `_da-verify-<32 hex>`). */
  private verificationKey(): Promise<string> {
    if (!this.cache.key) {
      this.cache.key = this.call('GET', '/verification-key').then((a) => {
        const key = (a.data as { key?: unknown } | undefined)?.key;
        if (typeof key !== 'string' || !key) throw new ProviderError('unavailable', 'mxroute GET /verification-key: no key in the answer');
        return key;
      });
      this.cache.key.catch(() => { this.cache.key = undefined; });
    }
    return this.cache.key;
  }

  /** `GET /domains/{domain}/dns`, null when MXRoute does not have the domain; reused for five minutes unless `fresh`. */
  private async dnsInfo(domain: string, fresh = false): Promise<DnsInfo | null> {
    const cached = this.cache.dns.get(domain);
    if (!fresh && cached && Date.now() - cached.at < DNS_INFO_TTL) return cached.info;
    let info: DnsInfo | null;
    try {
      info = ((await this.call('GET', `/domains/${enc(domain)}/dns`)).data as DnsInfo | undefined) ?? {};
    } catch (err) {
      if (!(err instanceof ProviderError && err.code === 'not_found')) throw err;
      info = null;
    }
    this.cache.dns.set(domain, { at: Date.now(), info });
    return info;
  }

  private checkPassword(password: string) {
    if (!validPassword(password)) throw new ProviderError('bad_request', 'a mailbox password is 8 to 72 characters');
  }

  private async ignoring(code: ProviderErrorCode, p: Promise<unknown>) {
    try { await p; } catch (err) { if (!(err instanceof ProviderError && err.code === code)) throw err; }
  }

  /** One request. Never puts the key in an error: the provider's text is scrubbed of it too. */
  private async call(method: string, path: string, body?: Record<string, unknown>): Promise<Answer> {
    const url = `${(this.cfg.apiUrl ?? MXROUTE_API_URL).replace(/\/+$/, '')}${path}`;
    const scrub = (s: string) => (this.cfg.apiKey ? s.split(this.cfg.apiKey).join('[redacted]') : s);
    let res: Response;
    try {
      res = await (this.cfg.fetch ?? fetch)(url, {
        method,
        headers: {
          'x-server': this.cfg.server, 'x-username': this.cfg.username, 'x-api-key': this.cfg.apiKey,
          accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new ProviderError('unavailable', scrub(`mxroute ${method} ${path}: ${(err as Error).message}`));
    }
    if (res.status === 204) return { success: true };
    const answer = (await res.json().catch(() => null)) as Answer | null;
    if (res.ok && answer && answer.success !== false) return answer;
    const text = scrub(answer?.error?.message ?? (res.ok ? 'unreadable answer' : res.statusText || `HTTP ${res.status}`));
    const retryAfter = Number(res.headers.get('retry-after'));
    throw new ProviderError(errorCode(res.status, answer), `mxroute ${method} ${path}: ${text}`, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
  }
}

const enc = (s: string) => encodeURIComponent(s);

/** The DKIM TXT from the DNS info as selector and value: the name may be `x`, `x._domainkey` or `x._domainkey.<domain>`. */
function dkimOf(d: DnsInfo['dkim'], domain: string): { selector: string; value: string } | null {
  if (!d?.value || !d.name) return null;
  const selector = d.name.replace(new RegExp(`\\.?${domain.replace(/\./g, '\\.')}\\.?$`, 'i'), '').replace(/\._domainkey$/i, '').replace(/\.$/, '');
  return selector ? { selector, value: d.value } : null;
}

function errorCode(status: number, answer: Answer | null): ProviderErrorCode {
  const known = answer?.error?.code ? CODES[answer.error.code.toUpperCase()] : undefined;
  if (known) return known;
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500 || (status >= 200 && status < 300 && !answer)) return 'unavailable';
  return 'bad_request';
}
