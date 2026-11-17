// Incoming email is an event-based trigger like any other (decision_log 2026-11-17, R-B): the assistant's mailbox screens
// each new message against its sponsor's allowlist before it publishes `mail.received` (imap/received.ts), and the
// answering subscription (mailWake.ts) files a wake job for what was let in, and for nothing else.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { Events, type JobMessage } from '../events/object';
import { screenReason } from '../imap/allowlist';
import { mailReceivedEvents, screenMessages } from '../imap/received';
import { MAIL_WAKE_PROMPT, mailWakeSubscription } from './mailWake';

function sqlite() {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query: string, ...args: unknown[]) {
      const stmt = db.prepare(query);
      const rows = stmt.columns().length ? stmt.all(...(args as never[])) : (stmt.run(...(args as never[])), []);
      return { toArray: () => rows as Record<string, unknown>[] };
    },
  };
}

const ORG = 'org-1';
const ADA = 'acct-ada';
const ANN = 'acct-ann';

function harness() {
  const sent: JobMessage[] = [];
  const org = {
    privateChannelIdsOfAccounts: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, []])), agentAccountIds: async () => [ADA], pokeSubscription: async () => 0,
    personalAgentAccountsOf: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, id === ANN ? [ADA] : []])),
  };
  const env = { ORG: { idFromName: (n: string) => n, get: () => org }, JOBS: { send: async (body: JobMessage) => { sent.push(body); } } };
  const storage = { sql: sqlite(), transactionSync: <T>(fn: () => T) => fn(), getAlarm: async () => null, setAlarm: async () => undefined };
  return { o: new Events({ storage, waitUntil: () => undefined } as never, env as never), sent };
}

/** What Ada's mailbox does with new mail: screen it by the allowlist (no auth headers here: a trusted test server), publish what stays. */
async function deliver(o: Events, owner: string, mail: { uid: number; from: { address: string } }[], allowed: string[]) {
  const { keep, refused } = await screenMessages(mail, async (m) => screenReason(m.from.address, [], new Set(allowed), true));
  if (keep.length) await o.publishMany(mailReceivedEvents({ organizationId: ORG, owner, accountId: 'hosted-ada', folder: 'INBOX', summaries: keep.map((m) => ({ ...m, subject: `Hi ${m.uid}` })) }));
  await o.settled();
  return { keep, refused };
}

describe('the assistant answering its email (assistant/mailWake.ts)', () => {
  it('wakes the assistant for mail from an allowlisted sender, as a reply-by-mail job', async () => {
    const { o, sent } = harness();
    const sub = await o.createSubscription(mailWakeSubscription({ organizationId: ORG, agentAccountId: ADA, sponsorAccountId: ANN }));
    // Ann's automation, worked by Ada: it is in Ann's list (and Ada's), and matches Ada's own mailbox.
    expect(sub).toMatchObject({ consumer: ADA, owner: ANN, createdBy: ANN, delivery: 'wake', filter: { types: ['mail.received'], consumerOwn: true }, action: { kind: 'wake', reply: 'mail' } });
    expect(o.listSubscriptions(ANN).map((s) => s.id)).toContain(sub.id);
    await deliver(o, ADA, [{ uid: 4, from: { address: 'ann@acme.test' } }], ['ann@acme.test']);
    const jobs = o.listJobs(sub.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ agent: ADA, prompt: MAIL_WAKE_PROMPT, depth: 1 });
    expect(sent).toHaveLength(1);
    // The runtime finds the message the job answers from the trigger's reference: the mail tools' id in Ada's mailbox.
    expect(o.jobTrigger(jobs[0]!.id, ADA)).toMatchObject({ type: 'mail.received', ref: { app: 'mail', kind: 'message', id: 'hosted-ada:INBOX:4' } });
    expect(o.jobTrigger(jobs[0]!.id, ANN)).toBeNull();
  });

  it('does not wake it for a sender not on the allowlist, nor for mail to anyone else', async () => {
    const { o } = harness();
    const sub = await o.createSubscription(mailWakeSubscription({ organizationId: ORG, agentAccountId: ADA, sponsorAccountId: ANN }));
    const { keep, refused } = await deliver(o, ADA, [{ uid: 5, from: { address: 'mallory@evil.example' } }], ['ann@acme.test']);
    expect(keep).toEqual([]);
    expect(refused).toEqual([{ message: expect.objectContaining({ uid: 5 }), reason: 'not_on_list' }]);
    // Ann's own new mail is her account's event: Ada's subscription never sees it.
    await deliver(o, ANN, [{ uid: 6, from: { address: 'ann@acme.test' } }], ['ann@acme.test']);
    expect(o.listJobs(sub.id)).toEqual([]);
  });

  it('wakes nobody when the owner does not sponsor the agent whose mailbox it names', async () => {
    const { o } = harness();
    const BOB = 'acct-bob';
    const sub = await o.createSubscription(mailWakeSubscription({ organizationId: ORG, agentAccountId: ADA, sponsorAccountId: BOB }));
    await deliver(o, ADA, [{ uid: 7, from: { address: 'ann@acme.test' } }], ['ann@acme.test']);
    expect(o.listJobs(sub.id)).toEqual([]);
  });
});
