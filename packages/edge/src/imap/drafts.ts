// The message a send or a draft is made of, and its MIME (nodemailer's MailComposer, as the Sent copy is made). Pure apart
// from the composer, so drafts.test.ts can check what a draft's bytes say: its threading headers, Bcc kept, both bodies.
import MailComposer from 'nodemailer/lib/mail-composer';
import type Mail from 'nodemailer/lib/mailer';
import type { Address } from './convert';

export interface OutgoingParts {
  to: Address[];
  cc?: Address[] | undefined;
  bcc?: Address[] | undefined;
  subject: string;
  html: string;
  text?: string | undefined;
  inReplyTo?: string | undefined;
  references?: string[] | undefined;
}
export interface OutgoingFile { filename: string; contentType: string; content: Buffer }

/** Message-ID and the like want the angle brackets; the API passes ids with or without them. */
export const angled = (id: string) => (/^<.*>$/.test(id.trim()) ? id.trim() : `<${id.trim()}>`);

/** The nodemailer message for `parts`, from the account, with a new Message-ID on the account's domain. */
export function outgoingMessage(from: { email: string; displayName: string }, parts: OutgoingParts, files: OutgoingFile[], now = new Date()): Mail.Options & { messageId: string } {
  const domain = from.email.split('@')[1] || 'freeflow.im';
  return {
    from: { name: from.displayName, address: from.email },
    to: parts.to, cc: parts.cc, bcc: parts.bcc,
    subject: parts.subject, html: parts.html, text: parts.text,
    ...(parts.inReplyTo ? { inReplyTo: angled(parts.inReplyTo) } : {}),
    ...(parts.references?.length ? { references: parts.references.map(angled) } : {}),
    messageId: `<${crypto.randomUUID()}@${domain}>`,
    date: now,
    attachments: files.map((f) => ({ filename: f.filename, contentType: f.contentType, content: f.content })),
  };
}

/** The message's bytes. `keepBcc` for a copy kept in a folder (Sent, Drafts), where the Bcc line is the sender's own record. */
export function compileMime(message: Mail.Options, keepBcc: boolean): Promise<Buffer> {
  const composer = new MailComposer(message).compile();
  composer.keepBcc = keepBcc;
  return new Promise<Buffer>((resolve, reject) => composer.build((err, out) => (err ? reject(err) : resolve(out))));
}
