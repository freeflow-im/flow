// The tests' and the e2e's mail provider (MAIL_PROVIDER=fake): domains and mailboxes in memory, every call recorded, and
// servers that are the local GreenMail (packages/infra, IMAP 3143 and SMTP 3025 in the clear, which the Mail object allows
// with MAIL_ALLOW_INSECURE=1). With GREENMAIL_API_URL, a mailbox made here is also a GreenMail user (its REST API,
// `POST /api/user`), so an e2e can read a provisioned mailbox's mail through the Mail object; without it, the fake only records.
import { ProviderError, type DkimRecord, type MailProvider, type MailboxState } from './provider';
import type { ProviderRecords } from '../directory/dns';

export interface FakeCall { method: string; args: unknown[] }

const MX = 'mx.fake-mail.test';
const SPF = '_spf.fake-mail.test';

const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1).toLowerCase();

export class FakeMailProvider implements MailProvider {
  readonly name = 'fake';
  /** Every call in order; passwords and keys as `[redacted]`. */
  readonly calls: FakeCall[] = [];
  readonly domains = new Map<string, { quotaBytes: number; maxUsers: number; dkim?: { selector: string; privateKeyPem: string } }>();
  readonly mailboxes = new Map<string, { displayName: string; password: string; quotaBytes: number; state: MailboxState }>();

  constructor(private readonly opts: { greenmailApiUrl?: string | undefined; imapPort?: number | undefined; smtpPort?: number | undefined; fetch?: typeof fetch } = {}) {}

  private record(method: string, ...args: unknown[]) { this.calls.push({ method, args }); }

  async records(_domain: string, dkim?: DkimRecord | null): Promise<ProviderRecords> {
    return { mx: [{ host: MX, priority: 10 }], spfInclude: SPF, dmarcPolicy: 'v=DMARC1; p=none', placeholder: true, ...(dkim ? { dkim } : {}) };
  }

  mailSettings(address: string) {
    return {
      imap: { host: '127.0.0.1', port: this.opts.imapPort ?? 3143, security: 'none' as const, username: address },
      smtp: { host: '127.0.0.1', port: this.opts.smtpPort ?? 3025, security: 'none' as const, username: address },
    };
  }

  async createDomain(domain: string, opts: { quotaBytes: number; maxUsers: number }) {
    this.record('createDomain', domain, opts);
    if (!this.domains.has(domain)) this.domains.set(domain, { ...opts });
  }

  async deleteDomain(domain: string) {
    this.record('deleteDomain', domain);
    if ([...this.mailboxes.keys()].some((a) => domainOf(a) === domain)) throw new ProviderError('conflict', `domain ${domain} still has users`);
    this.domains.delete(domain);
  }

  async setDkim(domain: string, selector: string, privateKeyPem: string) {
    this.record('setDkim', domain, selector, '[redacted]');
    const d = this.domains.get(domain);
    if (!d) throw new ProviderError('not_found', `no domain ${domain}`);
    d.dkim = { selector, privateKeyPem };
  }

  async createMailbox(m: { address: string; displayName: string; password: string; quotaBytes: number }) {
    this.record('createMailbox', { ...m, password: '[redacted]' });
    const address = m.address.toLowerCase();
    if (!this.domains.has(domainOf(address))) throw new ProviderError('not_found', `no domain ${domainOf(address)}`);
    if (this.mailboxes.has(address)) return;
    // GreenMail answers 400 "already exists" for a user it has (this isolate's memory is newer than GreenMail's).
    if (this.opts.greenmailApiUrl) await this.greenmail('POST', '/api/user', { email: address, login: address, password: m.password }, /already exists/);
    this.mailboxes.set(address, { displayName: m.displayName, password: m.password, quotaBytes: m.quotaBytes, state: 'enabled' });
  }

  async setPassword(address: string, password: string) {
    this.record('setPassword', address, '[redacted]');
    this.mailbox(address).password = password;
  }

  async setMailboxState(address: string, state: MailboxState) {
    this.record('setMailboxState', address, state);
    this.mailbox(address).state = state;
  }

  async deleteMailbox(address: string) {
    this.record('deleteMailbox', address);
    const key = address.toLowerCase();
    if (this.mailboxes.has(key) && this.opts.greenmailApiUrl) await this.greenmail('DELETE', `/api/user/${encodeURIComponent(key)}`);
    this.mailboxes.delete(key);
  }

  async getMailbox(address: string) {
    this.record('getMailbox', address);
    const m = this.mailboxes.get(address.toLowerCase());
    return m ? { exists: true, state: m.state, quotaBytes: m.quotaBytes } : { exists: false };
  }

  private mailbox(address: string) {
    const m = this.mailboxes.get(address.toLowerCase());
    if (!m) throw new ProviderError('not_found', `no mailbox ${address}`);
    return m;
  }

  private async greenmail(method: string, path: string, body?: unknown, alreadyDone?: RegExp) {
    const res = await (this.opts.fetch ?? fetch)(`${this.opts.greenmailApiUrl!.replace(/\/$/, '')}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
    }).catch((err: Error) => { throw new ProviderError('unavailable', `greenmail ${method} ${path}: ${err.message}`); });
    if (!res.ok && alreadyDone && res.status === 400 && alreadyDone.test(await res.text().catch(() => ''))) return;
    if (!res.ok) throw new ProviderError(res.status >= 500 ? 'unavailable' : 'bad_request', `greenmail ${method} ${path}: ${res.status}`);
  }
}
