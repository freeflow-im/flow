// RealtimeKit webhooks (docs/specs/meetings.md §5.3): each delivery is signed with RealtimeKit's RSA key, published at
// https://api.realtime.cloudflare.com/.well-known/webhooks.json. The `rtk-signature` header is a base64 RSASSA-PKCS1-v1_5
// SHA-256 signature of the raw body (never re-serialised JSON: whitespace and key order are part of the signed bytes).
const KEY_URL = 'https://api.realtime.cloudflare.com/.well-known/webhooks.json';
const KEY_TTL_MS = 60 * 60 * 1000;

let cached: { key: CryptoKey; at: number } | null = null;

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)).buffer;
}

export function importRtkKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('spki', pemToDer(pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
}

async function rtkKey(fetcher: typeof fetch): Promise<CryptoKey> {
  if (cached && Date.now() - cached.at < KEY_TTL_MS) return cached.key;
  const res = await fetcher(KEY_URL);
  const json = (await res.json()) as { data?: { publicKey?: string } };
  if (!json.data?.publicKey) throw new Error('realtimekit webhook key not found');
  cached = { key: await importRtkKey(json.data.publicKey), at: Date.now() };
  return cached.key;
}

/** True when `signature` (the rtk-signature header) signs `body` with RealtimeKit's key (or the key given, in tests). */
export async function verifyRtkWebhook(body: string, signature: string | undefined, key?: CryptoKey, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (!signature) return false;
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = Uint8Array.from(atob(signature), (ch) => ch.charCodeAt(0));
  } catch {
    return false;
  }
  try {
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key ?? (await rtkKey(fetcher)), sig, new TextEncoder().encode(body));
  } catch (err) {
    console.warn('realtimekit webhook key unavailable', String(err));
    return false;
  }
}
