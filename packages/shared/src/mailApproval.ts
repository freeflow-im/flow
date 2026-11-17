// An email an agent wrote and asked to send (decision_log 2026-11-17, "Email needs the person's click"): nothing goes out
// until its person clicks Send message, on the card in the assistant panel, in Home, or from the agent's DM in Chat.

export type MailApprovalState = 'waiting' | 'sent' | 'discarded' | 'failed';

export interface MailApprovalDTO {
  id: string;
  state: MailApprovalState;
  /** The agent that wrote it. */
  agentName: string;
  /** The address it goes from: the person's own account, or the agent's own mailbox (`fromAgent`). */
  from: string;
  fromAgent: boolean;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  /** What the agent wrote, in Markdown; a reply or forward also quotes the original below it (`quotes`). */
  body: string;
  quotes: 'reply' | 'forward' | null;
  createdAt: string;
  /** When it was sent, discarded or failed. */
  decidedAt: string | null;
  /** Why sending failed. */
  error: string | null;
}

/** Where a person approves one email outside the assistant panel (the link the agent's DM carries). */
export const mailApprovalPath = (id: string, organizationId: string): string => `/home/?email-approval=${encodeURIComponent(id)}&workspace=${encodeURIComponent(organizationId)}`;
