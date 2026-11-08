// The hosted mail provider behind the platform's mailboxes (platform.md §3.5, phase 5.2): an admin API that makes domains
// and mailboxes, sets their passwords, DKIM and state, and the records and servers that go with them. OpenSRS Hosted Email
// is the one in production (opensrs.ts); fake.ts is the tests' and the e2e's; index.ts picks one from the environment.
import type { ProviderRecords } from '../directory/dns';
import type { ServerSettings } from '../imap/rules';

export type { ServerSettings };

export type MailboxState = 'enabled' | 'suspended' | 'disabled';

/** A domain's DKIM public key as published: what `records` adds once a key is set (the directory keeps it). */
export interface DkimRecord { selector: string; value: string }

export interface MailProvider {
  readonly name: string;
  /** MX, the SPF include, the DMARC policy, and the DKIM TXT when `dkim` (the key the directory stored) is given. */
  records(domain: string, dkim?: DkimRecord | null): ProviderRecords;
  /** The servers the Mail object connects to for a mailbox. */
  mailSettings(address: string): { imap: ServerSettings; smtp: ServerSettings };
  /** Makes the domain; an existing one is left as it is. `quotaBytes` is each new mailbox's default storage. */
  createDomain(domain: string, opts: { quotaBytes: number; maxUsers: number }): Promise<void>;
  deleteDomain(domain: string): Promise<void>;
  setDkim(domain: string, selector: string, privateKeyPem: string): Promise<void>;
  /** Makes the mailbox; an existing one is left as it is. */
  createMailbox(m: { address: string; displayName: string; password: string; quotaBytes: number }): Promise<void>;
  setPassword(address: string, password: string): Promise<void>;
  setMailboxState(address: string, state: MailboxState): Promise<void>;
  deleteMailbox(address: string): Promise<void>;
  getMailbox(address: string): Promise<{ exists: boolean; state?: string; quotaBytes?: number }>;
}

export type ProviderErrorCode = 'auth' | 'not_found' | 'conflict' | 'rate_limited' | 'unavailable' | 'bad_request';

/** A provider's refusal or failure, with its own message. Never carries the credential. */
export class ProviderError extends Error {
  constructor(readonly code: ProviderErrorCode, message: string, readonly providerCode?: number) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** The domain limits used until provisioning (phase 5.3) sets them from the organization's plan. */
export const DEFAULT_DOMAIN_LIMITS = { quotaBytes: 5 * 1024 ** 3, maxUsers: 100 } as const;

export interface MailProviderEnv {
  /** `opensrs`, `fake` (tests and local dev), or unset for the placeholder `none`. A var. */
  MAIL_PROVIDER?: string;
  /** The OpenSRS Mail API's base, e.g. `https://admin.a.hostedemail.com/api` (test: admin.test). A secret. */
  OPENSRS_API_URL?: string;
  /** A company or domain administrator's user and password at OpenSRS. Secrets. */
  OPENSRS_USER?: string;
  OPENSRS_PASSWORD?: string;
  /** `a`, `b` or `test`: which cluster's MX and mail hosts; read from OPENSRS_API_URL when unset. A var. */
  OPENSRS_CLUSTER?: string;
  /** Overrides the IMAP and SMTP host the cluster implies. A var. */
  OPENSRS_MAIL_HOST?: string;
  /** `bytes` (the documentation) or `mb` (what get_user's example suggests); see opensrs.ts. A var. */
  OPENSRS_QUOTA_UNIT?: string;
  /** `pkcs1` (OpenSRS's sample key) or `pkcs8`, the PEM sent as `dkim_key`. A var. */
  OPENSRS_DKIM_KEY_FORMAT?: string;
  /** With the fake: GreenMail's REST API (`http://127.0.0.1:8080`), so a made mailbox is a real GreenMail user. A var. */
  GREENMAIL_API_URL?: string;
  /** With the fake: the GreenMail ports its mailboxes' settings name (default 3143 and 3025), for a second GreenMail. Vars. */
  GREENMAIL_IMAP_PORT?: string;
  GREENMAIL_SMTP_PORT?: string;
}
