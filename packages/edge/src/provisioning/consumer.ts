// The `flow-provisioning` Queue's consumer and its dead-letter queue's (platform.md §3.4, phase 5.3), which the Worker's
// default export hands each batch (index.ts). The Directory object sends the messages (directory/core.ts `enqueue`): a
// new account, a removal, a rejoin, the admin's "set up mailboxes for everyone", the Org object's daily sweep.
import type { AccountDTO } from '@flow/shared';
import type { Directory } from '../directory/object';
import type { DirectoryCore, ProvisioningMessage } from '../directory/core';
import type { Mail } from '../imap/object';
import type { Calendar } from '../calendar/object';
import type { Org } from '../org/object';
import { publishPlatformDomain, type PlatformDnsEnv } from '../directory/providers/cloudflareDns';
import { organizationDomain } from '../directory/addresses';
import { mailProviderFor, type MailProviderEnv } from '../mailprovider/index';
import { classify, failureNotice, runMessage, type ProvisioningDeps } from './steps';

export interface ProvisioningEnv extends MailProviderEnv, PlatformDnsEnv {
  DIRECTORY: DurableObjectNamespace<Directory>;
  MAIL: DurableObjectNamespace<Mail>;
  CALENDAR: DurableObjectNamespace<Calendar>;
  ORG: DurableObjectNamespace<Org>;
}

/** Seconds before a busy or unavailable provider is asked again, per attempt. */
const RETRY_STEP_SECONDS = 60;

async function directoryCall<M extends keyof DirectoryCore>(env: ProvisioningEnv, method: M, ...args: unknown[]): Promise<unknown> {
  const answer = await env.DIRECTORY.get(env.DIRECTORY.idFromName('directory')).call(method as never, args as never) as { ok: boolean; value?: unknown; message?: string };
  if (!answer.ok) throw new Error(`directory ${method}: ${answer.message}`);
  return answer.value;
}

/** The steps' bindings: the directory, the account's own Mail and Calendar objects, the provider, the platform DNS. */
export function deps(env: ProvisioningEnv): ProvisioningDeps {
  const provider = mailProviderFor(env);
  const mail = (a: AccountDTO) => env.MAIL.get(env.MAIL.idFromName(a.id));
  return {
    provider,
    directory: {
      target: async (id) => (await directoryCall(env, 'provisioningTarget', id)) as never,
      setState: async (id, state, message = null) => void (await directoryCall(env, 'setAccountState', id, state, message)),
      setHosted: async (id, hosted) => void (await directoryCall(env, 'setHosted', id, hosted)),
      setDomainAtProvider: async (domain) => void (await directoryCall(env, 'setDomainAtProvider', domain)),
    },
    mail: {
      hosted: (a) => mail(a).hostedAccount(a),
      put: async (a, m) => void (await mail(a).putHosted(a, m)),
      clear: (a) => mail(a).clearHosted(a),
    },
    calendar: {
      ensureNative: async (a) => {
        const out = await env.CALENDAR.get(env.CALENDAR.idFromName(a.id)).provisionNative(a);
        if (!out.ok) throw new Error(out.message);
      },
    },
    publishPlatformDns: (slug) => publishPlatformDomain(env, slug, provider.records(organizationDomain(slug))),
  };
}

/** The account keeps its state, with why, and the organization's owners and admins are told. */
async function stopped(env: ProvisioningEnv, d: ProvisioningDeps, msg: ProvisioningMessage, message: string): Promise<void> {
  const t = await d.directory.target(msg.accountId);
  if (!t) return;
  await d.directory.setState(t.account.id, t.account.state, message);
  await env.ORG.get(env.ORG.idFromName(msg.organizationId)).provisioningNotice({ accountId: t.account.id, text: failureNotice(t.account.address, message) })
    .catch((err: Error) => console.error(`[provisioning] notice for ${t.account.address}: ${err.message}`));
}

const isMessage = (b: unknown): b is ProvisioningMessage => {
  const m = b as ProvisioningMessage | null;
  return !!m && ['provision', 'suspend', 'resume', 'delete'].includes(m.kind) && typeof m.accountId === 'string' && typeof m.organizationId === 'string';
};

/**
 * Each message runs its account's next steps (steps.ts). A busy or unavailable provider: retried after 60 s × attempts.
 * A refusal (`auth`, `bad_request`, …): acked, the account keeps its state with the provider's message, and the admins get
 * a notice. Anything else is retried by the Queue; past max_retries the message goes to flow-provisioning-dlq.
 */
export async function handleProvisioningBatch(batch: MessageBatch<ProvisioningMessage>, env: ProvisioningEnv): Promise<void> {
  const d = deps(env);
  for (const m of batch.messages) {
    if (!isMessage(m.body)) { m.ack(); continue; }
    try {
      await runMessage(m.body, d);
      m.ack();
    } catch (err) {
      const what = classify(err);
      console.error(`[provisioning] ${m.body.kind} ${m.body.accountId} (attempt ${m.attempts}): ${(err as Error).message}`);
      if (what === 'retry') m.retry({ delaySeconds: RETRY_STEP_SECONDS * m.attempts });
      else if (what === 'stop' && m.body.kind === 'provision') {
        await stopped(env, d, m.body, (err as Error).message).catch((e: Error) => console.error(`[provisioning] ${e.message}`));
        m.ack();
      } else if (what === 'stop') m.ack();
      else m.retry();
    }
  }
}

/** flow-provisioning-dlq: a message whose retries are spent. A provision's account keeps its state, and the admins are
 * told as for a refusal; the others are logged (look with `wrangler queues`). */
export async function handleProvisioningDeadLetters(batch: MessageBatch<ProvisioningMessage>, env: ProvisioningEnv): Promise<void> {
  const d = deps(env);
  for (const m of batch.messages) {
    if (isMessage(m.body) && m.body.kind === 'provision') {
      await stopped(env, d, m.body, 'the mail provider kept failing; try again later').catch((e: Error) => console.error(`[provisioning] dlq: ${e.message}`));
    } else console.error(`[provisioning] dead letter: ${JSON.stringify(m.body)}`);
    m.ack();
  }
}
