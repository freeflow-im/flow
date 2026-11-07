// DKIM keys made in the Worker (platform.md §3.5): the platform generates each domain's key pair and keeps the private key,
// sealed, because OpenSRS obfuscates a key once it is saved and cannot give it back
// (https://support.opensrs.com/support/solutions/articles/201000063124-set-dkim-record-for-hostedemail-domains-using-api).
// That article asks for 1024-bit keys only on OpenSRS's own SystemDNS nameservers; ours are the organization's or
// Cloudflare's, so the default is 2048.

/** A DKIM key pair: the private key for the provider, the TXT value for `<selector>._domainkey.<domain>`. */
export interface DkimKey {
  selector: string;
  /** PKCS#8 PEM, `\n` line breaks. */
  privateKeyPem: string;
  /** `v=DKIM1; k=rsa; p=<base64 SPKI>`. */
  publicTxt: string;
}

/** The selector for keys made in a month, `ff<yyyymm>`: a rotation next month gets a new name beside the old record. */
export const dkimSelector = (now = new Date()) => `ff${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

/** The DNS name a selector's public key is published at. */
export const dkimName = (selector: string, domain: string) => `${selector}._domainkey.${domain}`;

const base64 = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString('base64');

/** DER as PEM with the given label, 64 columns, `\n` line breaks. */
export function pem(label: string, der: ArrayBuffer | Uint8Array): string {
  const lines = base64(der).match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/** The DER inside a PEM. */
export function pemBody(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(Buffer.from(text.replace(/-----(BEGIN|END) [^-]+-----/g, '').replace(/\s+/g, ''), 'base64'));
}

/** One DER element at `at`: where its contents start and end. */
function tlv(der: Uint8Array, at: number): { tag: number; start: number; end: number } {
  const tag = der[at]!;
  let len = der[at + 1]!;
  let start = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + der[start + i]!;
    start += n;
  }
  if (start + len > der.length) throw new Error('truncated DER');
  return { tag, start, end: start + len };
}

/** The RSAPrivateKey (PKCS#1) inside a PKCS#8 PrivateKeyInfo: SEQUENCE { INTEGER, SEQUENCE algorithm, OCTET STRING key }. */
export function pkcs8ToPkcs1Pem(pkcs8Pem: string): string {
  const der = pemBody(pkcs8Pem);
  const outer = tlv(der, 0);
  if (outer.tag !== 0x30) throw new Error('not a PKCS#8 key');
  const version = tlv(der, outer.start);
  const algorithm = tlv(der, version.end);
  const key = tlv(der, algorithm.end);
  if (version.tag !== 0x02 || algorithm.tag !== 0x30 || key.tag !== 0x04) throw new Error('not a PKCS#8 key');
  return pem('RSA PRIVATE KEY', der.slice(key.start, key.end));
}

/** A fresh RSA key pair (RSASSA-PKCS1-v1_5 with SHA-256, the rsa-sha256 of RFC 6376) by WebCrypto. */
export async function generateDkimKey(bits = 2048, now = new Date()): Promise<DkimKey> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: bits, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer;
  const spki = (await crypto.subtle.exportKey('spki', pair.publicKey)) as ArrayBuffer;
  return { selector: dkimSelector(now), privateKeyPem: pem('PRIVATE KEY', pkcs8), publicTxt: `v=DKIM1; k=rsa; p=${base64(spki)}` };
}
