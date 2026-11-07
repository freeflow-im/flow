// Provisioning's steps (platform.md §3.4, phase 5.3), without the Queue or the bindings: consumer.ts gives them the
// directory, the account's Mail and Calendar objects and the mail provider. Each step checks what is there first, so a
// message delivered again after a partial run picks up where that one stopped.
import type { AccountDTO } from '@flow/shared';
import type { ProvisioningMessage, ProvisioningTarget } from '../directory/core';
import { DEFAULT_DOMAIN_LIMITS, ProviderError, type MailProvider } from '../mailprovider/index';
import type { HostedMailbox } from '../imap/object';

export interface ProvisioningDeps {
  provider: MailProvider;
  directory: {
    target(accountId: string): Promise<ProvisioningTarget | null>;
    setState(accountId: string, state: AccountDTO['state'], statusMessage?: string | null): Promise<void>;
    setHosted(accountId: string, hosted: boolean): Promise<void>;
    setDomainAtProvider(domain: string): Promise<void>;
  };
  mail: {
    hosted(account: AccountDTO): Promise<{ id: string; email: string } | null>;
    put(account: AccountDTO, mailbox: HostedMailbox): Promise<void>;
    clear(account: AccountDTO): Promise<void>;
  };
  calendar: { ensureNative(account: AccountDTO): Promise<void> };
  /** Writes `<slug>.freeflow.im`'s MX, SPF and DMARC (directory/providers/cloudflareDns.ts). */
  publishPlatformDns(slug: string): Promise<void>;
  password?(): string;
}

const LOWER = 'abcdefghijkmnopqrstuvwxyz', UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ', DIGITS = '23456789';

/** 32 random letters and digits with at least one of each kind: inside any provider's rules (OpenSRS takes printable
 * ASCII), and nothing that needs quoting in a URL, JSON or an IMAP login. */
export function mailboxPassword(length = 32): string {
  const all = LOWER + UPPER + DIGITS;
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    const chars: string[] = [];
    // Rejection sampling keeps every character equally likely.
    for (const b of bytes) if (b < 256 - (256 % all.length) && chars.length < length) chars.push(all[b % all.length]!);
    const pw = chars.join('');
    if (pw.length === length && /[a-z]/.test(pw) && /[A-Z]/.test(pw) && /\d/.test(pw)) return pw;
  }
}

/** What the consumer does with a step's failure: `retry` later (the provider is busy or down), `stop` (it refused: the
 * account waits with the message, and the admins are told), or `throw` (anything else: the Queue's own retries). */
export function classify(err: unknown): 'retry' | 'stop' | 'throw' {
  if (!(err instanceof ProviderError)) return 'throw';
  return err.code === 'rate_limited' || err.code === 'unavailable' ? 'retry' : 'stop';
}

/** The account's mailbox at the provider and its row in the Mail object; the domain made first. */
async function mailboxStep(t: ProvisioningTarget, deps: ProvisioningDeps): Promise<void> {
  const { account, domain } = t;
  if (!domain) throw new ProviderError('bad_request', `the domain of ${account.address} is not one of the organization's`);
  if (!domain.verified) throw new ProviderError('bad_request', `the domain ${domain.domain} is not verified yet`);
  if (!t.domainAtProvider) {
    await deps.provider.createDomain(domain.domain, DEFAULT_DOMAIN_LIMITS);
    if (domain.kind === 'platform') await deps.publishPlatformDns(t.slug);
    await deps.directory.setDomainAtProvider(domain.domain);
  }
  const [row, box] = await Promise.all([deps.mail.hosted(account), deps.provider.getMailbox(account.address)]);
  if (!row || !box.exists) {
    // The password lives only sealed in the Mail object: a mailbox made by a run that stopped before writing it gets a new one.
    const password = (deps.password ?? mailboxPassword)();
    if (box.exists) await deps.provider.setPassword(account.address, password);
    else await deps.provider.createMailbox({ address: account.address, displayName: account.displayName, password, quotaBytes: DEFAULT_DOMAIN_LIMITS.quotaBytes });
    const settings = deps.provider.mailSettings(account.address);
    await deps.mail.put(account, { email: account.address, displayName: account.displayName, imap: settings.imap, smtp: settings.smtp, password });
  }
  await deps.directory.setHosted(account.id, true);
}

/**
 * One message's work. `provision` runs the account from the state it is in to `active` (requested → mailbox_ready →
 * calendars_ready → active), each state written as its step ends; an active account without a mailbox (one from before
 * provisioning) gets its mailbox and calendar and stays active. `suspend`, `resume` and `delete` change the mailbox at
 * the provider; a mailbox the provider does not have counts as done. Provider errors are thrown for the consumer.
 */
export async function runMessage(msg: ProvisioningMessage, deps: ProvisioningDeps): Promise<void> {
  const t = await deps.directory.target(msg.accountId);
  if (!t) return;
  const { account } = t;
  const missing = (err: unknown) => { if (!(err instanceof ProviderError && err.code === 'not_found')) throw err; };
  if (msg.kind === 'suspend') return deps.provider.setMailboxState(account.address, 'suspended').catch(missing);
  if (msg.kind === 'resume') return deps.provider.setMailboxState(account.address, 'enabled').catch(missing);
  if (msg.kind === 'delete') {
    if (account.state !== 'removed') return;
    await deps.provider.deleteMailbox(account.address).catch(missing);
    await deps.mail.clear(account);
    await deps.directory.setHosted(account.id, false);
    return;
  }
  if (account.state === 'removed' || account.state === 'suspended') return;
  if (account.state === 'active' && t.hosted) return;
  if (account.state === 'requested' || !t.hosted) {
    await mailboxStep(t, deps);
    if (account.state === 'requested') await deps.directory.setState(account.id, 'mailbox_ready');
  }
  await deps.calendar.ensureNative(account);
  if (account.state !== 'active') {
    await deps.directory.setState(account.id, 'calendars_ready');
    await deps.directory.setState(account.id, 'active');
  } else if (account.statusMessage) await deps.directory.setState(account.id, 'active');
}

/** The admins' notice when a mailbox could not be made. */
export const failureNotice = (address: string, message: string) => `Could not set up a mailbox for ${address}: ${message}`;
