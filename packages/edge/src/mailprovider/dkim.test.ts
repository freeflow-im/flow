import { describe, expect, it } from 'vitest';
import { dkimName, dkimSelector, generateDkimKey, pemBody, pkcs8ToPkcs1Pem } from './dkim';

const ALG = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };

describe('DKIM keys', () => {
  it('names the selector by month and the record by selector', () => {
    expect(dkimSelector(new Date('2026-11-07T12:00:00Z'))).toBe('ff202611');
    expect(dkimSelector(new Date('2027-01-31T23:59:59Z'))).toBe('ff202701');
    expect(dkimName('ff202611', 'acme.test')).toBe('ff202611._domainkey.acme.test');
  });

  it('generates a pair whose TXT public key verifies what the private key signs', async () => {
    const key = await generateDkimKey(2048, new Date('2026-11-07T00:00:00Z'));
    expect(key.selector).toBe('ff202611');
    expect(key.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PRIVATE KEY-----\n$/);
    expect(key.privateKeyPem).not.toContain('\r');
    const m = /^v=DKIM1; k=rsa; p=([A-Za-z0-9+/=]+)$/.exec(key.publicTxt);
    expect(m).not.toBeNull();
    const priv = await crypto.subtle.importKey('pkcs8', pemBody(key.privateKeyPem), ALG, false, ['sign']);
    const pub = await crypto.subtle.importKey('spki', Buffer.from(m![1]!, 'base64'), ALG, false, ['verify']);
    expect((pub.algorithm as RsaHashedKeyAlgorithm).modulusLength).toBe(2048);
    const data = new TextEncoder().encode('dkim-signature header and body hash');
    const sig = await crypto.subtle.sign(ALG, priv, data);
    expect(await crypto.subtle.verify(ALG, pub, sig, data)).toBe(true);
    expect(await crypto.subtle.verify(ALG, pub, sig, new TextEncoder().encode('tampered'))).toBe(false);
  });

  it('unwraps PKCS#8 to the PKCS#1 key OpenSRS\'s sample shows', async () => {
    const key = await generateDkimKey(1024);
    const pkcs1 = pkcs8ToPkcs1Pem(key.privateKeyPem);
    expect(pkcs1).toMatch(/^-----BEGIN RSA PRIVATE KEY-----\n/);
    // An RSAPrivateKey is a SEQUENCE starting with version 0, and node reads it as the same key.
    const der = pemBody(pkcs1);
    expect(der[0]).toBe(0x30);
    const { createPrivateKey } = await import('node:crypto');
    const a = createPrivateKey({ key: pkcs1, format: 'pem' }).export({ format: 'jwk' });
    const b = createPrivateKey({ key: key.privateKeyPem, format: 'pem' }).export({ format: 'jwk' });
    expect(a.n).toBe(b.n);
    expect(() => pkcs8ToPkcs1Pem('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n')).toThrow();
  });
});
