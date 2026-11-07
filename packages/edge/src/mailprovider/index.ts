// The mail provider the environment calls for (provider.ts): OpenSRS with MAIL_PROVIDER=opensrs and its secrets, the fake
// with MAIL_PROVIDER=fake, else `none`, which has 5.1's placeholder records and refuses every change.
import { noneProvider } from '../directory/providers/none';
import { FakeMailProvider } from './fake';
import { OpenSrsMailProvider, type OpenSrsCluster } from './opensrs';
import { ProviderError, type MailProvider, type MailProviderEnv } from './provider';

export * from './provider';

const unconfigured = async (): Promise<never> => { throw new ProviderError('unavailable', 'no mail provider is configured'); };

export const noneMailProvider: MailProvider = {
  name: 'none',
  records: (_domain, dkim) => ({ ...noneProvider, ...(dkim ? { dkim } : {}) }),
  mailSettings: () => { throw new ProviderError('unavailable', 'no mail provider is configured'); },
  createDomain: unconfigured,
  deleteDomain: unconfigured,
  setDkim: unconfigured,
  createMailbox: unconfigured,
  setPassword: unconfigured,
  setMailboxState: unconfigured,
  deleteMailbox: unconfigured,
  getMailbox: unconfigured,
};

/** One fake per isolate and settings, so the Queue consumer, the routes and the dev log route see the same mailboxes. */
const fakes = new Map<string, FakeMailProvider>();

/** Whether accounts get hosted mailboxes: a provider is configured and the `flow-provisioning` Queue is bound. */
export const hostedMailEnabled = (env: MailProviderEnv & { PROVISIONING?: unknown }) => !!env.PROVISIONING && mailProviderFor(env).name !== 'none';

export function mailProviderFor(env: MailProviderEnv, fetchFn?: typeof fetch): MailProvider {
  const kind = (env.MAIL_PROVIDER ?? '').trim().toLowerCase();
  if (kind === 'fake') {
    const opts = {
      greenmailApiUrl: env.GREENMAIL_API_URL || undefined,
      imapPort: Number(env.GREENMAIL_IMAP_PORT) || undefined,
      smtpPort: Number(env.GREENMAIL_SMTP_PORT) || undefined,
    };
    if (fetchFn) return new FakeMailProvider({ ...opts, fetch: fetchFn });
    const key = JSON.stringify(opts);
    if (!fakes.has(key)) fakes.set(key, new FakeMailProvider(opts));
    return fakes.get(key)!;
  }
  if (kind === 'opensrs') {
    if (!env.OPENSRS_API_URL || !env.OPENSRS_USER || !env.OPENSRS_PASSWORD) {
      console.error('MAIL_PROVIDER=opensrs needs OPENSRS_API_URL, OPENSRS_USER and OPENSRS_PASSWORD; using none');
      return noneMailProvider;
    }
    const cluster = env.OPENSRS_CLUSTER?.trim().toLowerCase();
    return new OpenSrsMailProvider({
      apiUrl: env.OPENSRS_API_URL,
      user: env.OPENSRS_USER,
      password: env.OPENSRS_PASSWORD,
      ...(cluster === 'a' || cluster === 'b' || cluster === 'test' ? { cluster: cluster as OpenSrsCluster } : {}),
      ...(env.OPENSRS_MAIL_HOST ? { mailHost: env.OPENSRS_MAIL_HOST } : {}),
      ...(env.OPENSRS_QUOTA_UNIT === 'mb' ? { quotaUnit: 'mb' as const } : {}),
      ...(env.OPENSRS_DKIM_KEY_FORMAT === 'pkcs8' ? { dkimKeyFormat: 'pkcs8' as const } : {}),
      ...(fetchFn ? { fetch: fetchFn } : {}),
    });
  }
  return noneMailProvider;
}
