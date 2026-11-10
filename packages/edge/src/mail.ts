// Mail through Cloudflare's Email Service, as packages/server/src/email/index.ts sends it. With no token (local runs) it
// goes to the log, so a test can read the link.
import type { Mail } from './directory/core';

export interface MailEnv {
  CLOUDFLARE_ACCOUNT_ID?: string;
  EMAIL_API_TOKEN?: string;
  EMAIL_FROM?: string;
}

/** A file sent with a message: its bytes as base64. */
export interface MailAttachment { filename: string; type: string; content: string }

/**
 * What the sender takes beyond the directory's plain mail: an HTML alternative (the text stays the fallback and says the
 * same), a display name for the From header (the address is always EMAIL_FROM, so a caller can label its mail but never
 * send as someone else), a Reply-To, and attachments.
 */
export interface OutgoingMail extends Mail {
  html?: string;
  fromName?: string;
  replyTo?: string;
  attachments?: MailAttachment[];
}

/** RFC 5322 `Display Name <addr>`, the name quoted when it has anything outside the unquoted-atom set (server/email). */
export function formatFrom(address: string, name?: string): string {
  if (!name) return address;
  const safe = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]+$/.test(name);
  const display = safe ? name : `"${name.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
  return `${display} <${address}>`;
}

export async function sendMail(env: MailEnv, mail: OutgoingMail): Promise<void> {
  const from = formatFrom(env.EMAIL_FROM ?? '', mail.fromName);
  if (!env.EMAIL_API_TOKEN) {
    const extra = `${mail.replyTo ? ` reply_to=${mail.replyTo}` : ''}${mail.html ? ' +html' : ''}${mail.attachments?.length ? ` attachments=${mail.attachments.map((a) => a.filename).join(',')}` : ''}`;
    console.log(`[mail] to=${mail.to} subject="${mail.subject}"${extra} ${mail.text.replace(/\n/g, ' ')}`);
    return;
  }
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/email/sending/send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.EMAIL_API_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      // A named sender is the REST API's { address, name } (a "Name <addr>" string is not documented there).
      from: mail.fromName ? { address: env.EMAIL_FROM, name: mail.fromName } : env.EMAIL_FROM, to: mail.to, subject: mail.subject, text: mail.text,
      ...(mail.html ? { html: mail.html } : {}),
      ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
      ...(mail.attachments?.length ? { attachments: mail.attachments.map((a) => ({ ...a, disposition: 'attachment' })) } : {}),
    }),
  });
  const json = (await res.json().catch(() => ({}))) as { success?: boolean; errors?: { code: number; message: string }[] };
  if (!res.ok || !json.success) throw new Error(`mail failed: ${json.errors?.map((e) => e.message).join('; ') ?? res.status}`);
}
