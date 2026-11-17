// Email an agent asks to send (decision_log 2026-11-17, "Email needs the person's click"): the send_email tool composes
// the message as Mail would send it and keeps it here, waiting; only the person, signed in (a session, never an agent's
// or an app's token), sends it with Send message, or discards it. Every personal agent of a person keeps its emails in
// the person's own Assistant object (`idFromName(accountId)`), so they have one list, whichever agent wrote them.
import type { MailApprovalDTO, MailApprovalState } from '@flow/shared';
import type { PreparedMail } from '../imap/mailTools';

export const MAIL_APPROVALS_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS mail_approvals (id TEXT PRIMARY KEY, state TEXT NOT NULL, agent_name TEXT NOT NULL, account_id TEXT NOT NULL,
    from_address TEXT NOT NULL, from_agent INTEGER NOT NULL, recipients TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, quotes TEXT,
    payload TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT, error TEXT)`,
  'CREATE INDEX IF NOT EXISTS mail_approvals_state ON mail_approvals(state, created_at)',
];

/** How long an email may wait; after that it is discarded unread (the agent can write it again). */
export const WAIT_DAYS = 14;
/** At most this many wait at once: a loop that keeps asking stops here. */
export const MAX_WAITING = 50;

interface Sql { exec(query: string, ...args: unknown[]): { toArray(): Record<string, unknown>[] } }

/** What send_email hands the store: the prepared email, who wrote it, and the agent's own words. */
export interface NewApproval { agentName: string; prepared: PreparedMail; fromAgent: boolean; body: string; quotes: 'reply' | 'forward' | null; /** Already sent (to the person themself): kept for the record. */ sent?: boolean }

export class MailApprovals {
  constructor(private readonly sql: Sql) {}

  add(a: NewApproval): MailApprovalDTO {
    this.expire();
    const waiting = a.sent ? 0 : Number(this.sql.exec("SELECT COUNT(*) AS n FROM mail_approvals WHERE state = 'waiting'").toArray()[0]?.n ?? 0);
    if (waiting >= MAX_WAITING) throw new Error(`${MAX_WAITING} emails are already waiting for the user's approval; ask them to send or discard some first.`);
    const id = crypto.randomUUID();
    const p = a.prepared;
    this.sql.exec(
      `INSERT INTO mail_approvals (id, state, agent_name, account_id, from_address, from_agent, recipients, subject, body, quotes, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, a.sent ? 'sent' : 'waiting', a.agentName, p.account.id, p.account.email, a.fromAgent ? 1 : 0, JSON.stringify({ to: p.to, cc: p.cc, bcc: p.bcc }), p.subject, a.body,
      a.quotes, JSON.stringify(p.body), new Date().toISOString(),
    );
    if (a.sent) this.decide(id, 'sent');
    return this.get(id)!;
  }

  get(id: string): MailApprovalDTO | null {
    const r = this.sql.exec('SELECT * FROM mail_approvals WHERE id = ?', id).toArray()[0];
    return r ? toDTO(r) : null;
  }

  /** The emails waiting, oldest first. */
  waiting(): MailApprovalDTO[] {
    this.expire();
    return this.sql.exec("SELECT * FROM mail_approvals WHERE state = 'waiting' ORDER BY created_at, id").toArray().map(toDTO);
  }

  /** The waiting email's account and body, claimed for sending (so a second click sends nothing); null when it is not waiting. */
  claim(id: string): Pick<PreparedMail, 'account' | 'body'> | null {
    const r = this.sql.exec("SELECT account_id, from_address, payload FROM mail_approvals WHERE id = ? AND state = 'waiting'", id).toArray()[0];
    if (!r) return null;
    this.decide(id, 'sent');
    return { account: { id: r.account_id as string, email: r.from_address as string }, body: JSON.parse(r.payload as string) as Record<string, unknown> };
  }

  decide(id: string, state: Exclude<MailApprovalState, 'waiting'>, error: string | null = null): void {
    this.sql.exec('UPDATE mail_approvals SET state = ?, decided_at = ?, error = ? WHERE id = ?', state, new Date().toISOString(), error, id);
  }

  /** A claimed email that could not be sent: waiting again, with why. */
  release(id: string, error: string): void {
    this.sql.exec("UPDATE mail_approvals SET state = 'waiting', decided_at = NULL, error = ? WHERE id = ?", error, id);
  }

  /** Discards a waiting email; false when it was not waiting. */
  discard(id: string): boolean {
    if (!this.sql.exec("SELECT 1 FROM mail_approvals WHERE id = ? AND state = 'waiting'", id).toArray().length) return false;
    this.decide(id, 'discarded');
    return true;
  }

  private expire(): void {
    const before = new Date(Date.now() - WAIT_DAYS * 86_400_000).toISOString();
    this.sql.exec("UPDATE mail_approvals SET state = 'discarded', decided_at = ?, error = 'waited too long' WHERE state = 'waiting' AND created_at < ?", new Date().toISOString(), before);
  }
}

function toDTO(r: Record<string, unknown>): MailApprovalDTO {
  const rc = JSON.parse(r.recipients as string) as { to: string[]; cc: string[]; bcc: string[] };
  return {
    id: r.id as string, state: r.state as MailApprovalState, agentName: r.agent_name as string,
    from: r.from_address as string, fromAgent: Number(r.from_agent) === 1, to: rc.to, cc: rc.cc, bcc: rc.bcc,
    subject: r.subject as string, body: r.body as string, quotes: (r.quotes as 'reply' | 'forward' | null) ?? null,
    createdAt: r.created_at as string, decidedAt: (r.decided_at as string | null) ?? null, error: (r.error as string | null) ?? null,
  };
}
