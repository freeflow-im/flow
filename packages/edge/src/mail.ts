// Mail through Cloudflare's Email Service, as packages/server/src/email/index.ts sends it. With no token (local runs) it
// goes to the log, so a test can read the link.
import type { Mail } from './directory/core';

export interface MailEnv {
  CLOUDFLARE_ACCOUNT_ID?: string;
  EMAIL_API_TOKEN?: string;
  EMAIL_FROM?: string;
}

export async function sendMail(env: MailEnv, mail: Mail): Promise<void> {
  if (!env.EMAIL_API_TOKEN) {
    console.log(`[mail] to=${mail.to} subject="${mail.subject}" ${mail.text.replace(/\n/g, ' ')}`);
    return;
  }
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/email/sending/send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.EMAIL_API_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: mail.to, subject: mail.subject, text: mail.text }),
  });
  const json = (await res.json().catch(() => ({}))) as { success?: boolean; errors?: { code: number; message: string }[] };
  if (!res.ok || !json.success) throw new Error(`mail failed: ${json.errors?.map((e) => e.message).join('; ') ?? res.status}`);
}
