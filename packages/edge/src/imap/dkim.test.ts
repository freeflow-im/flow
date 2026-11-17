// DKIM verification (dkim.ts) against messages signed by nodemailer's own DKIM signer (an independent implementation),
// with the key served by a stand-in resolver: a good signature, a changed body or header, a key not there, and alignment.
import { generateKeyPairSync } from 'node:crypto';
import nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { verifyDkim, splitMessage } from './dkim';
import { screenReason } from './allowlist';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const p = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const resolve = async (name: string) => (name === 's1._domainkey.gmail.test' ? [`v=DKIM1; k=rsa; p=${p}`] : []);

async function signed(over: Record<string, unknown> = {}): Promise<string> {
  const t = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
  const info = await t.sendMail({
    from: 'Scott <scott@gmail.test>', to: 'ada@acme.test', subject: 'Hey hey', text: 'The plan for   tomorrow:\n\n  lunch at noon  \n\n\n',
    dkim: { domainName: 'gmail.test', keySelector: 's1', privateKey: pem }, ...over,
  });
  return (info.message as Buffer).toString('latin1');
}

describe('DKIM verification', () => {
  it('passes a message as its signer sent it', async () => {
    const raw = await signed();
    expect(await verifyDkim(raw, resolve)).toEqual([{ domain: 'gmail.test', selector: 's1', pass: true }]);
  });

  it('fails a changed body, a changed signed header, and a key that is not published', async () => {
    const raw = await signed();
    expect(splitMessage(raw).body).toContain('lunch');
    expect((await verifyDkim(raw.replace('lunch', 'dinner'), resolve))[0]).toMatchObject({ pass: false, reason: 'body hash mismatch' });
    expect((await verifyDkim(raw.replace('Subject: Hey hey', 'Subject: Pay this'), resolve))[0]).toMatchObject({ pass: false, reason: 'signature mismatch' });
    expect((await verifyDkim(raw, async () => []))[0]).toMatchObject({ pass: false, reason: 'no key record' });
  });

  it('keeps passing when the receiving server adds its headers, a forged X-DKIM among them changing nothing', async () => {
    const raw = await signed();
    const withHeaders = raw.replace('\r\n\r\n', "\r\nX-DKIM: signer='gmail.test' status='pass' reason=''\r\nX-DMARC-Status: pass\r\nX-Spam-Score: 1.3 (+)\r\n\r\n");
    expect((await verifyDkim(`Received: from mail.gmail.test by sunfire.mxrouting.net\r\n${withHeaders}`, resolve))[0]).toMatchObject({ pass: true });
  });

  it('lets an allowlisted sender through only on a signature aligned with its From domain', async () => {
    const allowed = new Set(['scott@gmail.test']);
    expect(screenReason('scott@gmail.test', [], allowed, false, ['gmail.test'])).toBe('ok');
    expect(screenReason('scott@gmail.test', [], allowed, false, ['evil.test'])).toBe('unauthenticated');
    expect(screenReason('scott@gmail.test', [], allowed, false, [])).toBe('unauthenticated');
    // A message with no signature, carrying only forged verdict headers, does not pass.
    const plain = "From: scott@gmail.test\r\nTo: ada@acme.test\r\nSubject: hi\r\nX-DKIM: signer='gmail.test' status='pass'\r\nX-DMARC-Status: pass\r\n\r\nhello\r\n";
    expect(await verifyDkim(plain, resolve)).toEqual([]);
  });
});
