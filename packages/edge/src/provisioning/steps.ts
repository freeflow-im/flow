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

/** What the consumer does with a step's failure: `retry` later (the provider is busy or down, or waiting on DNS), `stop`
 * (it refused: the account waits with the message, and the admins are told), or `throw` (anything else: the Queue's own retries). */
export function classify(err: unknown): 'retry' | 'stop' | 'throw' {
  if (!(err instanceof ProviderError)) return 'throw';
  return err.code === 'rate_limited' || err.code === 'unavailable' || err.code === 'pending' ? 'retry' : 'stop';
}

/** The account's mailbox at the provider and its row in the Mail object; the domain made first. */
async function mailboxStep(t: ProvisioningTarget, deps: ProvisioningDeps): Promise<void> {
  const { account, domain } = t;
  const address = account.address;
  if (!address) throw new ProviderError('bad_request', `${account.displayName} has no address`);
  if (!domain) throw new ProviderError('bad_request', `the domain of ${address} is not one of the organization's`);
  if (!domain.verified) throw new ProviderError('bad_request', `the domain ${domain.domain} is not verified yet`);
  if (!t.domainAtProvider) {
    // Our zone first: a provider that wants its own ownership TXT (MXRoute) finds it there when the domain is made.
    if (domain.kind === 'platform') await deps.publishPlatformDns(t.slug);
    try {
      await deps.provider.createDomain(domain.domain, DEFAULT_DOMAIN_LIMITS);
    } catch (err) {
      // On the organization's own domain the admin must publish the record: a stop with the message, not a retry.
      if (err instanceof ProviderError && err.code === 'pending' && domain.kind === 'own') throw new ProviderError('bad_request', err.message);
      throw err;
    }
    // And again once the provider has the domain: a provider that makes the DKIM key itself (MXRoute) has it only now,
    // and its record goes in our zone with the rest.
    if (domain.kind === 'platform' && deps.provider.managesDkim) await deps.publishPlatformDns(t.slug);
    await deps.directory.setDomainAtProvider(domain.domain);
  }
  const [row, box] = await Promise.all([deps.mail.hosted(account), deps.provider.getMailbox(address)]);
  if (!row || !box.exists) {
    // The password lives only sealed in the Mail object: a mailbox made by a run that stopped before writing it gets a new one.
    const password = (deps.password ?? mailboxPassword)();
    if (box.exists) await deps.provider.setPassword(address, password);
    else await deps.provider.createMailbox({ address, displayName: account.displayName, password, quotaBytes: DEFAULT_DOMAIN_LIMITS.quotaBytes });
    const settings = deps.provider.mailSettings(address);
    await deps.mail.put(account, { email: address, displayName: account.displayName, imap: settings.imap, smtp: settings.smtp, password });
  }
  await deps.directory.setHosted(account.id, true);
}

/**
 * One message's work. `provision` runs the account from the state it is in to `active` (requested → mailbox_ready →
 * calendars_ready → active), each state written as its step ends; an active account without a mailbox (one from before
 * provisioning) gets its mailbox and calendar and stays active. `suspend`, `resume` and `delete` change the mailbox at
 * the provider, by the address it was made with (a guest's is the one it had); a mailbox the provider does not have
 * counts as done. A guest is never provisioned or resumed (§3.3). Provider errors are thrown for the consumer.
 */
export async function runMessage(msg: ProvisioningMessage, deps: ProvisioningDeps): Promise<void> {
  const t = await deps.directory.target(msg.accountId);
  if (!t) return;
  const { account } = t;
  const mailbox = t.mailboxAddress;
  const missing = (err: unknown) => { if (!(err instanceof ProviderError && err.code === 'not_found')) throw err; };
  if (msg.kind === 'suspend') return mailbox ? deps.provider.setMailboxState(mailbox, 'suspended').catch(missing) : undefined;
  if (msg.kind === 'resume') {
    if (!mailbox || account.kind === 'guest') return;
    try {
      await deps.provider.setMailboxState(mailbox, 'enabled');
    } catch (err) { missing(err); return; }
    // A provider that suspends by taking the password away: the mailbox gets a fresh one, written where the Mail object reads it.
    if (deps.provider.suspendsByPassword && (await deps.mail.hosted(account))) {
      const password = (deps.password ?? mailboxPassword)();
      await deps.provider.setPassword(mailbox, password);
      const settings = deps.provider.mailSettings(mailbox);
      await deps.mail.put(account, { email: mailbox, displayName: account.displayName, imap: settings.imap, smtp: settings.smtp, password });
    }
    return;
  }
  if (msg.kind === 'delete') {
    // A removed account's mailbox, or a guest's kept one, past the retention period.
    if (account.state !== 'removed' && account.kind !== 'guest') return;
    if (mailbox) await deps.provider.deleteMailbox(mailbox).catch(missing);
    await deps.mail.clear(account);
    await deps.directory.setHosted(account.id, false);
    return;
  }
  if (account.kind === 'guest') return;
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
export const failureNotice = (address: string | null, message: string) => `Could not set up a mailbox for ${address ?? 'an account with no address'}: ${message}`;
