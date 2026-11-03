// APNs provider authentication tokens, as on the Node server (packages/server/src/push/apnsAuth.ts): a bare ES256 JWT
// signed by the team's .p8 Auth Key, re-signed every 55 minutes (Apple rejects one older than 60 and throttles a
// provider that signs one per request). jose signs with Web Crypto, so this runs on Workers unchanged.
//
// The cache is module state, so every Org object in an isolate shares one token: it names the team, not a tenant.
import { SignJWT, importPKCS8, type CryptoKey } from 'jose';
import { config } from '../config.js';

/** Re-sign after this long. Apple's window is 20–60 min; 55 leaves clock slack. */
const TTL_MS = 55 * 60 * 1000;

let cached: { jwt: string; expiresAt: number; fingerprint: string } | null = null;
let key: { fingerprint: string; key: CryptoKey } | null = null;

export interface ApnsCredentials {
  /** The `.p8` Auth Key, PEM text. */
  keyPem: string;
  /** 10-char key id, the JWT header's `kid`. */
  keyId: string;
  /** Apple Developer team id, the JWT's `iss`. */
  teamId: string;
}

/** The credentials, or exactly what is missing. FLOW_APNS_KEY is base64 of the .p8; a raw PEM is accepted too. */
export function apnsCredentials(): ApnsCredentials {
  const missing = [
    config.apnsKey ? null : 'FLOW_APNS_KEY',
    config.apnsKeyId ? null : 'FLOW_APNS_KEY_ID',
    config.apnsTeamId ? null : 'FLOW_APNS_TEAM_ID',
  ].filter(Boolean);
  if (missing.length > 0) throw new Error(`FLOW_PUSH_DRIVER=apns needs ${missing.join(', ')}`);
  const raw = config.apnsKey!.trim();
  let keyPem = raw;
  if (!raw.includes('BEGIN PRIVATE KEY')) {
    try { keyPem = atob(raw.replace(/\s+/g, '')); } catch { keyPem = ''; }
  }
  if (!keyPem.includes('BEGIN PRIVATE KEY')) throw new Error('FLOW_APNS_KEY is neither a PKCS#8 PEM nor base64 of one');
  return { keyPem, keyId: config.apnsKeyId!, teamId: config.apnsTeamId! };
}

/** The current provider token, signing a new one only when the cached one has aged out or the credentials changed. */
export async function apnsProviderToken(now: number = Date.now()): Promise<string> {
  const creds = apnsCredentials();
  const fingerprint = `${creds.teamId}:${creds.keyId}:${creds.keyPem.length}`;
  if (cached && cached.expiresAt > now && cached.fingerprint === fingerprint) return cached.jwt;
  if (key?.fingerprint !== fingerprint) key = { fingerprint, key: await importPKCS8(creds.keyPem, 'ES256') };
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: creds.keyId })
    .setIssuer(creds.teamId)
    .setIssuedAt(Math.floor(now / 1000))
    .sign(key.key);
  cached = { jwt, expiresAt: now + TTL_MS, fingerprint };
  return jwt;
}

/** Drop the cached token: on a 403 ExpiredProviderToken (clock skew), and in tests. */
export function resetApnsProviderToken(): void {
  cached = null;
}
