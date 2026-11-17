// New inbox mail as events (platform.md §5.2): one `mail.received` per message, for the account's own eyes. A person's
// assistant's mailbox screens first (agents.md §1.1): only what its sponsor's allowlist lets in is published, so only that
// can wake the assistant (assistant/mailWake.ts); the rest leaves the inbox for the Refused folder. The Mail object does the
// IMAP around these (imap/object.ts publishReceived, screenForAssistant).
import type { PublishInput } from '../events/core';
import type { screenReason } from './allowlist';

export type ScreenReason = ReturnType<typeof screenReason>;

/** The messages that stay (and are published) and the ones refused, with why, by each one's reason (`ok` stays). */
export async function screenMessages<M extends { uid: number }>(messages: M[], reasonOf: (m: M) => Promise<ScreenReason>): Promise<{ keep: M[]; refused: { message: M; reason: Exclude<ScreenReason, 'ok'> }[] }> {
  const keep: M[] = [];
  const refused: { message: M; reason: Exclude<ScreenReason, 'ok'> }[] = [];
  for (const m of messages) {
    const reason = await reasonOf(m);
    if (reason === 'ok') keep.push(m);
    else refused.push({ message: m, reason });
  }
  return { keep, refused };
}

/** A message's summary as its event's data carries it: no body (reading it takes the mail tools, as the account). */
export interface ReceivedSummary { uid: number; from?: unknown; subject?: unknown; date?: unknown }

/** The `mail.received` events of new INBOX messages, oldest first, on the account `owner` alone. */
export function mailReceivedEvents(p: { organizationId: string; owner: string; accountId: string; folder: string; summaries: ReceivedSummary[]; ts?: string }): PublishInput[] {
  const ts = p.ts ?? new Date().toISOString();
  return [...p.summaries].sort((a, b) => a.uid - b.uid).map((m) => ({
    type: 'mail.received', organizationId: p.organizationId, actor: null, audience: `account:${p.owner}` as const,
    ref: { organizationId: p.organizationId, app: 'mail', kind: 'message', id: `${p.accountId}:${p.folder}:${m.uid}` },
    ts,
    data: { accountId: p.accountId, folder: p.folder, uid: m.uid, from: m.from, subject: m.subject, date: m.date },
  }));
}
