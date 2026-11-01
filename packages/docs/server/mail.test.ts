import { describe, expect, it } from 'vitest';
import { mailerFromEnv, parseAddress } from './mail.ts';

const mail = { to: 'someone@example.com', subject: 'Hi', text: 'Hello' };

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

describe('parseAddress', () => {
  it('splits a display name from the address', () => {
    expect(parseAddress('Sheets <noreply@example.com>')).toEqual({ address: 'noreply@example.com', name: 'Sheets' });
    expect(parseAddress('"Sheets App" <noreply@example.com>')).toEqual({ address: 'noreply@example.com', name: 'Sheets App' });
    expect(parseAddress('<noreply@example.com>')).toEqual({ address: 'noreply@example.com' });
    expect(parseAddress(' noreply@example.com ')).toEqual({ address: 'noreply@example.com' });
  });
});

describe('mailerFromEnv', () => {
  it('logs instead of sending when no provider is configured', async () => {
    const logged: string[] = [];
    const send = mailerFromEnv((m) => logged.push(m), {});
    await send(mail);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('someone@example.com');
    expect(logged[0]).toContain('Hello');
  });

  it('sends through Cloudflare Email Service', async () => {
    const f = fakeFetch(200, { success: true, errors: [], result: { delivered: [mail.to], permanent_bounces: [], queued: [] } });
    const send = mailerFromEnv(() => {}, { CLOUDFLARE_ACCOUNT_ID: 'acct1', CLOUDFLARE_API_TOKEN: 'tok', MAIL_FROM: 'Sheets <noreply@example.com>' }, f.fn);
    await send(mail);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe('https://api.cloudflare.com/client/v4/accounts/acct1/email/sending/send');
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(f.calls[0].init.body as string)).toEqual({
      from: { address: 'noreply@example.com', name: 'Sheets' },
      to: mail.to,
      subject: 'Hi',
      text: 'Hello',
    });
  });

  it('reports Cloudflare errors and bounces', async () => {
    const env = { CLOUDFLARE_ACCOUNT_ID: 'acct1', CLOUDFLARE_API_TOKEN: 'tok', MAIL_FROM: 'noreply@example.com' };
    const denied = fakeFetch(403, { success: false, errors: [{ code: 10102, message: 'email.sending.error.authentication.forbidden' }], result: null });
    await expect(mailerFromEnv(() => {}, env, denied.fn)(mail)).rejects.toThrow(/403.*forbidden/);
    const bounced = fakeFetch(200, { success: true, errors: [], result: { delivered: [], permanent_bounces: [mail.to], queued: [] } });
    await expect(mailerFromEnv(() => {}, env, bounced.fn)(mail)).rejects.toThrow(/bounced/);
    const suppressed = fakeFetch(200, { success: true, errors: [], result: { delivered: [], permanent_bounces: [], queued: [], suppressed_recipients: [mail.to] } });
    await expect(mailerFromEnv(() => {}, env, suppressed.fn)(mail)).rejects.toThrow(/suppression/);
  });

  it('refuses a half-configured Cloudflare setup', () => {
    expect(() => mailerFromEnv(() => {}, { CLOUDFLARE_ACCOUNT_ID: 'acct1' })).toThrow(/CLOUDFLARE_API_TOKEN/);
    expect(() => mailerFromEnv(() => {}, { CLOUDFLARE_ACCOUNT_ID: 'acct1', CLOUDFLARE_API_TOKEN: 'tok' })).toThrow(/MAIL_FROM/);
  });

  it('falls back to Resend when only its key is set', async () => {
    const f = fakeFetch(200, { id: 'x' });
    await mailerFromEnv(() => {}, { RESEND_API_KEY: 'rk' }, f.fn)(mail);
    expect(f.calls[0].url).toBe('https://api.resend.com/emails');
    expect(JSON.parse(f.calls[0].init.body as string).to).toEqual([mail.to]);
  });
});
