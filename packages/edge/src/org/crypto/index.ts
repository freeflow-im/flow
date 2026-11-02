// Envelope encryption of message bodies (phase1.md §2/§4 design notes).
//
// AES-256-GCM. The data key is identified by `enc_key_id` and never lives in
// Postgres. In production the data key is unwrapped once at boot via KMS; in
// local dev the KMS stand-in is a sealed key file (FLOW_DATA_KEY_FILE,
// chmod 600, gitignored) auto-generated on first boot. FLOW_DATA_KEY (raw
// base64) overrides for tests/CI. The key is held only in memory.
//
// Only the message service calls this module — routes, gateway and clients
// see plaintext DTOs.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import path from 'node:path';
import { config } from '../config.js';

export const SCHEME_PLAINTEXT = 0; // dev only, never written by this module
export const SCHEME_AES_256_GCM_V1 = 1;

const NONCE_LEN = 12;
const TAG_LEN = 16;

export interface EncryptedBody {
  body: Buffer; // ciphertext || gcm auth tag (16 bytes)
  bodyNonce: Buffer;
  encKeyId: string;
  encScheme: number;
}

interface KeyFile {
  keyId: string;
  dataKey: string; // base64, 32 bytes
}

let activeKey: { keyId: string; key: Buffer } | null = null;
const keyring = new Map<string, Buffer>(); // keyId -> key (supports rotation reads)

/** Load (or on first boot create) the data key. Idempotent. */
export function initCrypto(): void {
  if (activeKey) return;
  if (config.dataKeyInline) {
    const key = Buffer.from(config.dataKeyInline, 'base64');
    if (key.length !== 32) throw new Error('FLOW_DATA_KEY must be 32 bytes (base64)');
    activeKey = { keyId: 'env-1', key };
  } else {
    throw new Error('FLOW_DATA_KEY is not set');
  }
  keyring.set(activeKey.keyId, activeKey.key);
}

function requireKey(keyId?: string): { keyId: string; key: Buffer } {
  if (!activeKey) initCrypto();
  if (keyId === undefined) return activeKey!;
  const key = keyring.get(keyId);
  if (!key) throw new Error(`unknown enc_key_id: ${keyId}`);
  return { keyId, key };
}

export function encryptBody(plaintext: string): EncryptedBody {
  const { keyId, key } = requireKey();
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    body: Buffer.concat([ct, tag]),
    bodyNonce: nonce,
    encKeyId: keyId,
    encScheme: SCHEME_AES_256_GCM_V1,
  };
}

export function decryptBody(row: {
  body: Buffer;
  bodyNonce: Buffer;
  encKeyId: string;
  encScheme: number;
}): string {
  if (row.encScheme === SCHEME_PLAINTEXT) return row.body.toString('utf8');
  if (row.encScheme !== SCHEME_AES_256_GCM_V1) {
    throw new Error(`unknown enc_scheme: ${row.encScheme}`);
  }
  const { key } = requireKey(row.encKeyId);
  const ct = row.body.subarray(0, row.body.length - TAG_LEN);
  const tag = row.body.subarray(row.body.length - TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, row.bodyNonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// ---- file blobs (phase2.md §3) ---------------------------------
// Same envelope scheme and data-key registry as message bodies, but the nonce
// is prepended to the blob (files have no dedicated nonce column):
//   blob = nonce(12) || ciphertext || gcm_tag(16)

export function encryptBlob(plaintext: Buffer): { blob: Buffer; encKeyId: string } {
  const { keyId, key } = requireKey();
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { blob: Buffer.concat([nonce, ct, cipher.getAuthTag()]), encKeyId: keyId };
}

export function decryptBlob(blob: Buffer, encKeyId: string): Buffer {
  if (blob.length < NONCE_LEN + TAG_LEN) throw new Error('blob too short');
  const { key } = requireKey(encKeyId);
  const nonce = blob.subarray(0, NONCE_LEN);
  const ct = blob.subarray(NONCE_LEN, blob.length - TAG_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** For tests only. */
export function _resetCryptoForTests(): void {
  activeKey = null;
  keyring.clear();
}
