// Outgoing email. Providers, in order of preference:
//   - Cloudflare Email Service, when CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are set (MAIL_FROM must be an
//     address on a domain verified for sending in that account);
//   - Resend, when RESEND_API_KEY is set;
//   - otherwise the message is written to the server log, which is enough for a single-operator deployment:
//     the password reset link can be copied from the server's log.
export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export type Mailer = (mail: Mail) => Promise<void>;

/** Splits "Name <addr@example.com>" into its parts; a bare address has no name. */
export function parseAddress(s: string): { address: string; name?: string } {
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^<>\s]+)>\s*$/.exec(s);
  if (m) return m[1] ? { address: m[2], name: m[1].trim() } : { address: m[2] };
  return { address: s.trim() };
}

export function mailerFromEnv(log: (msg: string) => void, env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): Mailer {
  if (env.CLOUDFLARE_ACCOUNT_ID || env.CLOUDFLARE_API_TOKEN) {
    if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
      throw new Error('Email via Cloudflare needs both CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.');
    }
    if (!env.MAIL_FROM) throw new Error('Email via Cloudflare needs MAIL_FROM (an address on a domain verified for sending in the Cloudflare account).');
    return cloudflareMailer({ accountId: env.CLOUDFLARE_ACCOUNT_ID, token: env.CLOUDFLARE_API_TOKEN, from: env.MAIL_FROM }, fetchFn);
  }
  if (env.RESEND_API_KEY) return resendMailer({ key: env.RESEND_API_KEY, from: env.MAIL_FROM ?? 'Sheets <onboarding@resend.dev>' }, fetchFn);
  return async (mail) => {
    log(`[mail] No email provider is configured (CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN, or RESEND_API_KEY); not sent. To: ${mail.to} | Subject: ${mail.subject}\n${mail.text}`);
  };
}

/** Cloudflare Email Service REST API: POST /accounts/{account_id}/email/sending/send. */
export function cloudflareMailer(cfg: { accountId: string; token: string; from: string }, fetchFn: typeof fetch = fetch): Mailer {
  const from = parseAddress(cfg.from);
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfg.accountId)}/email/sending/send`;
  return async (mail) => {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: mail.to, subject: mail.subject, text: mail.text }),
    });
    const text = await res.text();
    let body: {
      success?: boolean;
      errors?: { code?: number; message?: string }[];
      result?: { permanent_bounces?: string[]; suppressed_recipients?: string[] };
    } = {};
    try {
      body = JSON.parse(text);
    } catch {
      /* non-JSON error page; reported below */
    }
    if (!res.ok || body.success === false) {
      const detail = body.errors?.map((e) => `${e.code ?? ''} ${e.message ?? ''}`.trim()).join('; ') || text.slice(0, 300);
      throw new Error(`Cloudflare Email returned ${res.status}: ${detail}`);
    }
    if (body.result?.permanent_bounces?.length) throw new Error(`Cloudflare Email: ${mail.to} permanently bounced`);
    // Addresses on the account's suppression list (earlier hard bounces, complaints) are silently dropped.
    if (body.result?.suppressed_recipients?.length) throw new Error(`Cloudflare Email: ${mail.to} is on the suppression list; not sent`);
  };
}

export function resendMailer(cfg: { key: string; from: string }, fetchFn: typeof fetch = fetch): Mailer {
  return async (mail) => {
    const res = await fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: cfg.from, to: [mail.to], subject: mail.subject, text: mail.text }),
    });
    if (!res.ok) throw new Error(`Resend returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  };
}
