// Passwords, in the two forms already stored: argon2id from Flow, scrypt from the former MCP Docs accounts. In JavaScript,
// because Workers refuse to compile WebAssembly at run time (docs/specs/cloudflare-spikes.md).
import { scrypt, timingSafeEqual } from 'node:crypto';
import { argon2id } from '@noble/hashes/argon2.js';

const OPTS = { t: 2, m: 19456, p: 1 };
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64').replace(/=+$/, '');

export function hashPassword(password: string): string {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = argon2id(password, salt, { ...OPTS, dkLen: 32 });
  return `$argon2id$v=19$m=${OPTS.m},t=${OPTS.t},p=${OPTS.p}$${b64(salt)}$${b64(hash)}`;
}

function verifyArgon2(stored: string, password: string): boolean {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/.exec(stored);
  if (!m) return false;
  const expected = Buffer.from(m[5]!, 'base64');
  const actual = argon2id(password, Buffer.from(m[4]!, 'base64'), { m: +m[1]!, t: +m[2]!, p: +m[3]!, dkLen: expected.length });
  return timingSafeEqual(Buffer.from(actual), expected);
}

function verifyScrypt(stored: string, password: string): Promise<boolean> {
  const [, n, r, p, salt, hash] = stored.split('$');
  if (!n || !r || !p || !salt || !hash) return Promise.resolve(false);
  const expected = Buffer.from(hash, 'base64');
  return new Promise((resolve) => {
    scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: +n, r: +r, p: +p, maxmem: 256 * 1024 * 1024 }, (err, actual) => {
      resolve(!err && actual.length === expected.length && timingSafeEqual(actual, expected));
    });
  });
}

/** Anything else stored here (`!google:…`, `!agent:…`) is a sentinel that no password can match. */
export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return stored.startsWith('scrypt$') ? await verifyScrypt(stored, password) : verifyArgon2(stored, password);
  } catch {
    return false;
  }
}
