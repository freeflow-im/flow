// Incoming email to a person's assistant is an event-based trigger like any other (decision_log 2026-11-17, R-B): the
// assistant's Mail object publishes `mail.received` for each message its sponsor's allowlist lets in (the screen is at the
// publisher: imap/received.ts, with the DKIM check), and when the sponsor turns on "Agent always responds to incoming
// email" the runtime keeps one `wake` subscription on those events (Assistant.syncMailWake). Its job runs as any wake job
// does, a headless turn with every tool, and its output step mails the answer back to the sender (`reply: 'mail'`).
import type { NewSubscription } from '../events/core';

/** The subscription's name, as an automation's. */
export const MAIL_WAKE_NAME = 'Answer email to the assistant';

/** What the job's turn is told; the runtime adds the message itself (sender, subject, text) below it. */
export const MAIL_WAKE_PROMPT =
  'An email came to your own mailbox from a sender your user allows. Treat it as your user’s request and do what it asks with your tools. Your answer (what you write, not a tool) is mailed back to the sender as your reply.';

/**
 * The subscription: the agent's own `mail.received` (its mailbox's events are its account's alone, so the agent's account
 * is the consumer and the owner, whose visibility the Events object reads with), made by its sponsor's account.
 */
export function mailWakeSubscription(p: { organizationId: string; agentAccountId: string; sponsorAccountId: string }): NewSubscription {
  return {
    name: MAIL_WAKE_NAME,
    consumer: p.agentAccountId,
    owner: p.agentAccountId,
    createdBy: p.sponsorAccountId,
    delivery: 'wake',
    filter: { types: ['mail.received'], self: true },
    action: { kind: 'wake', prompt: MAIL_WAKE_PROMPT, reply: 'mail' },
    organizationId: p.organizationId,
  };
}
