// What Reply, Reply all and Forward put in a new message: the recipients, "Re:"/"Fwd:", the original quoted, and the
// headers that thread it (In-Reply-To and References). And a saved draft (one an agent wrote, say) opened to edit.
import { attachmentUrl, type Address, type MessageDetail, type OutgoingMessage } from '../api';
import { formatAddress, uniqueAddresses } from './addresses';
import { escapeHtml, sanitizeEmailHtml, textToHtml } from './sanitize';

export type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward' | 'draft';
/** The three ways of answering a message (the inline composer's menu switches between them). */
export type AnswerMode = Exclude<ComposeMode, 'new' | 'draft'>;

export interface ComposeDraft {
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  /** The editor's starting content. */
  html: string;
  inReplyTo?: string;
  references?: string[];
  /** For a forward: the original's attachments to fetch and send again. */
  forwardAttachments?: { index: number; filename: string; mimeType: string; size: number }[];
}

export const emptyDraft = (to: Address[] = []): ComposeDraft => ({ to, cc: [], bcc: [], subject: '', html: '' });

/** "Re: Lunch", without stacking another "Re:" on one already there (or on a "Fwd:" chain's "RE:"). */
export function replySubject(subject: string): string {
  const s = subject.trim();
  return /^re\s*:/i.test(s) ? s : `Re: ${s}`;
}

export function forwardSubject(subject: string): string {
  const s = subject.trim();
  return /^(fwd?|fw)\s*:/i.test(s) ? s : `Fwd: ${s}`;
}

function longDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const list = (as: Address[]) => as.map((a) => escapeHtml(formatAddress(a))).join(', ');

/** Where a message's cid: picture is read from (its attachment URL), by its Content-ID. */
export type CidUrl = (contentId: string) => string | null;

/** A message's cid: pictures, read from its attachments, for the composer (a quote, a draft). */
export const cidUrlOf = (accountId: string, m: MessageDetail): CidUrl => (contentId) => {
  const a = m.attachments.find((x) => x.contentId === contentId);
  return a ? attachmentUrl(accountId, m.folder, m.uid, a.index, true) : null;
};

/** The original's body as HTML to quote: cleaned, with nothing remote, its own pictures from their attachments, and plain text kept readable. */
function originalBody(m: MessageDetail, cidUrl?: CidUrl): string {
  if (m.html) return sanitizeEmailHtml(m.html, { allowRemote: false, ...(cidUrl ? { cidUrl } : {}) }).html;
  return textToHtml(m.text ?? '');
}

/** A saved draft, opened to edit and send: as it was saved, its own attachments carried over. */
export function fromDraft(m: MessageDetail, cidUrl?: CidUrl): ComposeDraft {
  return {
    to: m.to,
    cc: m.cc,
    bcc: m.bcc,
    subject: m.subject,
    html: originalBody(m, cidUrl),
    ...(m.inReplyTo ? { inReplyTo: m.inReplyTo } : {}),
    ...(m.references.length ? { references: m.references } : {}),
    forwardAttachments: m.attachments.filter((a) => !a.inline).map(({ index, filename, mimeType, size }) => ({ index, filename, mimeType, size })),
  };
}

/** The new message for replying to, replying to everyone on, or forwarding `m`, sent from `me`. */
export function prefill(mode: AnswerMode, m: MessageDetail, me: string, cidUrl?: CidUrl): ComposeDraft {
  const references = [...m.references, ...(m.messageId ? [m.messageId] : [])].filter((r, i, all) => all.indexOf(r) === i);
  const threading = m.messageId ? { inReplyTo: m.messageId, references } : {};
  if (mode === 'forward') {
    const header = [
      '---------- Forwarded message ---------',
      `From: ${m.from ? escapeHtml(formatAddress(m.from)) : ''}`,
      `Date: ${escapeHtml(longDate(m.date))}`,
      `Subject: ${escapeHtml(m.subject)}`,
      `To: ${list(m.to)}`,
      ...(m.cc.length ? [`Cc: ${list(m.cc)}`] : []),
    ].join('<br>');
    return {
      to: [],
      cc: [],
      bcc: [],
      subject: forwardSubject(m.subject),
      html: `<p></p><p>${header}</p>${originalBody(m, cidUrl)}`,
      forwardAttachments: m.attachments.filter((a) => !a.inline).map(({ index, filename, mimeType, size }) => ({ index, filename, mimeType, size })),
    };
  }
  const sender = m.replyTo.length ? m.replyTo : m.from ? [m.from] : [];
  // Replying to your own message goes to the people it went to, as mail apps do.
  const fromMe = m.from?.address.toLowerCase() === me.toLowerCase();
  const to = fromMe && m.replyTo.length === 0 ? uniqueAddresses(m.to) : uniqueAddresses(sender);
  const cc = mode === 'replyAll' ? uniqueAddresses([...(fromMe ? [] : m.to), ...m.cc], [me, ...to.map((a) => a.address)]) : [];
  const who = m.from ? escapeHtml(m.from.name ? `${m.from.name} <${m.from.address}>` : m.from.address) : 'someone';
  return {
    to,
    cc,
    bcc: [],
    subject: replySubject(m.subject),
    html: `<p></p><p>On ${escapeHtml(longDate(m.date))}, ${who} wrote:</p><blockquote>${originalBody(m, cidUrl)}</blockquote>`,
    ...threading,
  };
}

export interface DraftState {
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  /** The body's text. */
  text: string;
  /** Whether the body differs from what the draft opened with. */
  bodyChanged: boolean;
  /** Files the user added (a forward's own attachments do not count). */
  attachments: number;
}

/** Whether a draft has nothing worth asking about before it is thrown away. A reply that was only opened, not
 *  written in, is empty however much it quotes. */
export function isDraftEmpty(d: DraftState, initial: ComposeDraft | null): boolean {
  if (d.attachments > 0 || d.bodyChanged) return false;
  if (initial) {
    const same = (a: Address[], b: Address[]) => a.length === b.length && a.every((x, i) => x.address === b[i]!.address);
    return same(d.to, initial.to) && same(d.cc, initial.cc) && same(d.bcc, initial.bcc) && d.subject === initial.subject;
  }
  return d.to.length + d.cc.length + d.bcc.length === 0 && !d.subject.trim() && !d.text.trim();
}

/** A file in the composer that is ready to send (one picked, dropped, or carried over from a forward or a draft). */
export interface ComposeFile {
  name: string;
  type: string;
  size: number;
  file: Blob;
  /** Carried over from the original (a forward's, a draft's): it does not count as something the person added. */
  forwarded: boolean;
}

/** What opens a composer: the mode and the message it starts as, and where it came from. */
export interface ComposeRequest {
  mode: ComposeMode;
  draft: ComposeDraft;
  /** The message replied to or forwarded (its folder and uid), for fetching a forward's attachments; for `draft`, the draft. */
  source?: { folder: string; uid: number };
  /** The conversation the message answered (or the draft) is in. */
  threadId?: string;
  /** For an answer: the message as another of the three modes would start it (the inline composer's menu). */
  remode?: (mode: AnswerMode) => ComposeDraft;
  /** Files already chosen: a composer opened again after its send failed, or moved out of its conversation. */
  files?: ComposeFile[];
  /** Opened again with what had been written: closing it asks first. */
  restored?: boolean;
}

/** A message the composer handed over to send (App.tsx sends it while the composer is already gone). */
export interface Outgoing {
  accountId: string;
  /** The message, its HTML as the editor had it (pasted pictures still data: URLs) and without its files. */
  message: Omit<OutgoingMessage, 'attachments'>;
  files: { filename: string; contentType: string; file: Blob }[];
  /** The composer as it was, to open again if the send fails. */
  request: ComposeRequest;
}
