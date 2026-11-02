// @ts-nocheck: copied from packages/docs, where it is typechecked under that package's settings (cloudflare-spikes.md).
// Encryption at rest for connection credentials: AES-256-GCM with a server key. The key comes from
// CONNECTOR_ENCRYPTION_KEY, or else a random key generated once and kept in the data directory.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from '../../runtime/fs.ts';

/**
 * On Workers there is no data directory to keep a generated key in. CONNECTOR_KEY_BASE64 is the key the Node server generated
 * (its data directory's connector.key), so imported credentials still decrypt; CONNECTOR_ENCRYPTION_KEY works as before.
 */
export function loadKey(keyFile: string, envKey = process.env.CONNECTOR_ENCRYPTION_KEY): Buffer {
  if (envKey) return createHash('sha256').update(envKey).digest();
  if (process.env.CONNECTOR_KEY_BASE64) return Buffer.from(process.env.CONNECTOR_KEY_BASE64, 'base64');
  if (existsSync(keyFile)) return Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64');
  console.warn('connectors: no CONNECTOR_KEY_BASE64 or CONNECTOR_ENCRYPTION_KEY; saved credentials will not survive this object');
  return randomBytes(32);
}

/** "v1.<iv>.<tag>.<ciphertext>", all base64. */
export function encrypt(key: Buffer, data: Record<string, string>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
}

export function decrypt(key: Buffer, blob: string): Record<string, string> {
  const [v, iv, tag, ct] = blob.split('.');
  if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Unreadable credentials');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
  return JSON.parse(pt) as Record<string, string>;
}

/** "••••" plus the last four characters of a long enough secret. */
export function mask(secret: string | undefined): string {
  const t = (secret ?? '').trim();
  return t.length >= 12 ? `••••${t.slice(-4)}` : '••••';
}
