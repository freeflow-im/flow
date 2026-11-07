// OpenSRS Hosted Email's Mail API (OMA) over fetch, read from its documentation on 2026-11-06 and 07. Where a value came
// from is beside it; where the documentation is silent the value is configurable and says so.
//
// Requests (https://email.opensrs.guide/docs/sending-requests): an HTTP POST of one JSON object to `<base>/<method>`, e.g.
// `https://admin.a.hostedemail.com/api/get_user`, the object carrying `credentials: { user, password }`. Every answer is one
// JSON object with `success`, and `error_number` and `error` when it is false. The bases (cluster A, B, test) are from
// third-party clients and OpenSRS's admin URLs, not a page of the guide: OPENSRS_API_URL says which.
import { pkcs8ToPkcs1Pem } from './dkim';
import { ProviderError, type DkimRecord, type MailProvider, type MailboxState, type ProviderErrorCode } from './provider';
import type { ProviderRecords } from '../directory/dns';

export type OpenSrsCluster = 'a' | 'b' | 'test';

export interface OpenSrsConfig {
  apiUrl: string;
  user: string;
  password: string;
  /** Which cluster's hosts; read from apiUrl (`admin.b.` is B, `admin.test.` is test, else A) when unset. */
  cluster?: OpenSrsCluster;
  /** Overrides the IMAP and SMTP host the cluster implies. */
  mailHost?: string;
  /**
   * The unit of `quota`. change_user and change_domain say bytes (https://email.opensrs.guide/docs/change_user,
   * /docs/change_domain), but get_user's example (/docs/get_user) shows `"quota": 5120` beside `bytes_max: 5368709120`,
   * which is megabytes. Bytes until a live account settles it.
   */
  quotaUnit?: 'bytes' | 'mb';
  /** The PEM sent as `dkim_key`. The DKIM article's sample is a `BEGIN RSA PRIVATE KEY` (PKCS#1) key; it does not say
   * whether PKCS#8 is accepted, so PKCS#1 by default. */
  dkimKeyFormat?: 'pkcs1' | 'pkcs8';
  fetch?: typeof fetch;
}

/** Error numbers the guide's examples show: 2 "The requested object does not exist" (/docs/get_user), 6 "One or more
 * attributes badly formatted" (/docs/change_user), 23 "Object already exists" (/docs/change_user, /docs/change_domain).
 * The guide lists no others (authentication failures included), so the rest are read from the HTTP status and the text. */
const ERROR_NUMBERS: Record<number, ProviderErrorCode> = { 2: 'not_found', 6: 'bad_request', 23: 'conflict' };

export function clusterOf(apiUrl: string): OpenSrsCluster {
  const host = (() => { try { return new URL(apiUrl).hostname; } catch { return ''; } })();
  return host.startsWith('admin.test.') ? 'test' : host.startsWith('admin.b.') ? 'b' : 'a';
}

/** A plain-text password OpenSRS takes: 1 to 54 characters, no spaces or double quotes (/docs/change_user). */
const validPassword = (p: string) => p.length >= 1 && p.length <= 54 && !/[\s"]/.test(p);

type Answer = Record<string, unknown> & { success?: boolean; error?: string; error_number?: number };

export class OpenSrsMailProvider implements MailProvider {
  readonly name = 'opensrs';
  private readonly cluster: OpenSrsCluster;

  constructor(private readonly cfg: OpenSrsConfig) {
    this.cluster = cfg.cluster ?? clusterOf(cfg.apiUrl);
  }

  /**
   * MX from "Configuring DNS for OpenSRS Hosted Email" (https://support.opensrs.com/support/solutions/articles/201000063458):
   * `MX 0 mx.<domain>.cust.<cluster>.hostedemail.com`, where cluster B adds `.b`, A nothing, and test is `.test`. The SPF
   * include from "Set Up SPF Records for OpenSRS Hosted Email" (https://support.opensrs.com/support/solutions/articles/201000063482):
   * `include:_spf.hostedemail.com`, both clusters. DMARC: OpenSRS names no policy, so `p=none`. DKIM at
   * `<selector>._domainkey.<domain>` (the DKIM article, articles/201000063124).
   */
  records(domain: string, dkim?: DkimRecord | null): ProviderRecords {
    const part = this.cluster === 'a' ? '' : `${this.cluster}.`;
    return {
      mx: [{ host: `mx.${domain}.cust.${part}hostedemail.com`, priority: 0 }],
      spfInclude: '_spf.hostedemail.com',
      dmarcPolicy: 'v=DMARC1; p=none',
      ...(dkim ? { dkim } : {}),
    };
  }

  /**
   * "Which Email Cluster Am I On?" (https://support.opensrs.com/support/solutions/articles/201000063484): IMAP and SMTP on
   * `mail.hostedemail.com` (A) or `mail.b.hostedemail.com` (B); IMAP 993 with SSL, SMTP 465 with SSL. The test cluster's
   * host is not documented: `mail.test.hostedemail.com` is a guess (OPENSRS_MAIL_HOST overrides). The login is the full
   * address (OpenSRS's client setup articles).
   */
  mailSettings(address: string) {
    const host = this.cfg.mailHost ?? (this.cluster === 'a' ? 'mail.hostedemail.com' : `mail.${this.cluster}.hostedemail.com`);
    return {
      imap: { host, port: 993, security: 'tls' as const, username: address },
      smtp: { host, port: 465, security: 'tls' as const, username: address },
    };
  }

  /**
   * change_domain with create_only (https://email.opensrs.guide/docs/change_domain): `quota` the default mailbox storage,
   * `limit_users`, `default_password_encoding: BCRYPT` (the page recommends it), and the services new users inherit: IMAP,
   * SMTP in and relay on, webmail off (platform.md §3.5: people use FreeFlow Mail), and POP3 and webmail relay off since
   * nothing uses them. An existing domain (error 23) is left as it is.
   */
  async createDomain(domain: string, opts: { quotaBytes: number; maxUsers: number }) {
    await this.ignoring('conflict', this.call('change_domain', {
      domain,
      create_only: true,
      attributes: {
        quota: this.quota(opts.quotaBytes),
        limit_users: opts.maxUsers,
        default_password_encoding: 'BCRYPT',
        service_imap4: 'enabled',
        service_smtpin: 'enabled',
        service_smtprelay: 'enabled',
        service_webmail: 'disabled',
        service_pop3: 'disabled',
        service_smtprelay_webmail: 'disabled',
      },
    }));
  }

  /** delete_domain (https://email.opensrs.guide/docs/delete_domain): the domain must have no users. Gone already is done. */
  async deleteDomain(domain: string) {
    await this.ignoring('not_found', this.call('delete_domain', { domain }));
  }

  /**
   * change_domain with `dkim_selector` and `dkim_key`, both together (articles/201000063124). The article asks for each line
   * break as `\n`, which is what JSON gives a PEM's newlines. Without create_only change_domain would make a missing domain
   * with default settings, so the domain is checked first.
   */
  async setDkim(domain: string, selector: string, privateKeyPem: string) {
    await this.call('get_domain', { domain });
    const key = (this.cfg.dkimKeyFormat ?? 'pkcs1') === 'pkcs1' && privateKeyPem.includes('BEGIN PRIVATE KEY') ? pkcs8ToPkcs1Pem(privateKeyPem) : privateKeyPem;
    await this.call('change_domain', { domain, attributes: { dkim_selector: selector, dkim_key: key.replace(/\r\n/g, '\n').trimEnd() } });
  }

  /** change_user with create_only (https://email.opensrs.guide/docs/change_user): `type: mailbox`, `name`, `password`,
   * `quota`. Services are inherited from the domain. An existing mailbox (error 23) is left as it is. */
  async createMailbox(m: { address: string; displayName: string; password: string; quotaBytes: number }) {
    this.checkPassword(m.password);
    await this.ignoring('conflict', this.call('change_user', {
      user: m.address,
      create_only: true,
      attributes: { type: 'mailbox', name: m.displayName, password: m.password, quota: this.quota(m.quotaBytes) },
    }));
  }

  /** change_user also creates, so a missing mailbox is refused by get_user first rather than made by a password change. */
  async setPassword(address: string, password: string) {
    this.checkPassword(password);
    await this.call('get_user', { user: address });
    await this.call('change_user', { user: address, attributes: { password } });
  }

  /** `enabled`, `suspended` or `disabled` on IMAP, SMTP relay and SMTP in (/docs/change_user's service attributes). */
  async setMailboxState(address: string, state: MailboxState) {
    await this.call('get_user', { user: address });
    await this.call('change_user', { user: address, attributes: { service_imap4: state, service_smtprelay: state, service_smtpin: state } });
  }

  /** delete_user (https://email.opensrs.guide/docs/delete_user). Gone already is done. */
  async deleteMailbox(address: string) {
    await this.ignoring('not_found', this.call('delete_user', { user: address }));
  }

  /** get_user (https://email.opensrs.guide/docs/get_user): error 2 is no such mailbox; the state is IMAP's service; the
   * quota is metadata's `bytes_max` when given, else the attribute in the configured unit. */
  async getMailbox(address: string) {
    let answer: Answer;
    try {
      answer = await this.call('get_user', { user: address });
    } catch (err) {
      if (err instanceof ProviderError && err.code === 'not_found') return { exists: false };
      throw err;
    }
    const attributes = (answer.attributes ?? {}) as Record<string, unknown>;
    const quota = ((answer.metadata ?? {}) as { quota?: { bytes_max?: unknown } }).quota?.bytes_max;
    const quotaBytes = quota != null ? Number(quota) : attributes.quota != null ? Number(attributes.quota) * (this.cfg.quotaUnit === 'mb' ? 1024 ** 2 : 1) : undefined;
    return {
      exists: true,
      ...(typeof attributes.service_imap4 === 'string' ? { state: attributes.service_imap4 } : {}),
      ...(quotaBytes != null && Number.isFinite(quotaBytes) ? { quotaBytes } : {}),
    };
  }

  private quota(bytes: number) {
    return this.cfg.quotaUnit === 'mb' ? Math.floor(bytes / 1024 ** 2) : bytes;
  }

  private checkPassword(password: string) {
    if (!validPassword(password)) throw new ProviderError('bad_request', 'a mailbox password is 1 to 54 characters with no spaces or double quotes');
  }

  private async ignoring(code: ProviderErrorCode, p: Promise<unknown>) {
    try { await p; } catch (err) { if (!(err instanceof ProviderError && err.code === code)) throw err; }
  }

  /** One request. Never puts the credential in an error: the provider's text is scrubbed of the password too. */
  private async call(method: string, body: Record<string, unknown>): Promise<Answer> {
    const url = `${this.cfg.apiUrl.replace(/\/+$/, '')}/${method}`;
    const scrub = (s: string) => (this.cfg.password ? s.split(this.cfg.password).join('[redacted]') : s);
    let res: Response;
    try {
      res = await (this.cfg.fetch ?? fetch)(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ credentials: { user: this.cfg.user, password: this.cfg.password }, ...body }),
      });
    } catch (err) {
      throw new ProviderError('unavailable', scrub(`opensrs ${method}: ${(err as Error).message}`));
    }
    const answer = (await res.json().catch(() => null)) as Answer | null;
    if (res.ok && answer?.success === true) return answer;
    const text = scrub(answer?.error ?? (res.ok ? 'unreadable answer' : res.statusText || 'error'));
    throw new ProviderError(errorCode(res.status, answer), `opensrs ${method}: ${text}`, answer?.error_number);
  }
}

function errorCode(status: number, answer: Answer | null): ProviderErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  if (status >= 500 || (status >= 200 && status < 300 && !answer)) return 'unavailable';
  const known = answer?.error_number != null ? ERROR_NUMBERS[answer.error_number] : undefined;
  if (known) return known;
  const text = answer?.error ?? '';
  if (/authenticat|credential|password|permission|not allowed|unauthori[sz]ed/i.test(text)) return 'auth';
  if (/rate|too many|throttl/i.test(text)) return 'rate_limited';
  if (status === 404) return 'not_found';
  return 'bad_request';
}
