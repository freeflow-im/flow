// Fetching a file from a web address that someone else chose (the assistant, from a search result or from what
// the user typed). The server makes the request, so it must not be led to its own network: only http(s), only
// names that resolve to public addresses, and every redirect is checked the same way before it is followed.
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/** A file that could not be fetched, with a reason to tell the user. */
export class WebFetchError extends Error {}

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const)
  blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 127],
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(net, bits, 'ipv6');

/** True for an address on the public internet (not loopback, private, link-local, multicast or reserved). */
export function isPublicAddress(address: string): boolean {
  // An IPv4 address written as IPv6 (::ffff:10.0.0.1) is judged as the IPv4 address it is.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const a = mapped ? mapped[1] : address;
  const family = isIP(a);
  if (!family) return false;
  return !blocked.check(a, family === 4 ? 'ipv4' : 'ipv6');
}

/** The addresses a host name resolves to. Replaceable, so tests need no network. */
export const resolver = {
  lookup: async (host: string): Promise<string[]> => (await dnsLookup(host, { all: true })).map((r) => r.address),
};

async function checkPublic(u: URL): Promise<void> {
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new WebFetchError('Only http and https addresses can be fetched.');
  if (u.username || u.password) throw new WebFetchError('The address must not carry a user name or password.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = await resolver.lookup(host);
    } catch {
      throw new WebFetchError(`Could not find ${u.hostname}.`);
    }
  }
  if (!addresses.length || !addresses.every(isPublicAddress)) throw new WebFetchError('Only files on the public internet can be fetched.');
}

/** The file name a response gives, or the last part of its address. */
function nameOf(res: Response, u: URL): string {
  const disposition = res.headers.get('content-disposition') ?? '';
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(disposition)?.[1];
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition)?.[1];
  let name = '';
  try {
    name = star ? decodeURIComponent(star.trim()) : (plain?.trim() ?? decodeURIComponent(u.pathname.split('/').pop() ?? ''));
  } catch {
    // A name that does not decode: go without.
  }
  return name.replace(/[\\/\u0000-\u001f]/g, '_').trim().slice(0, 200);
}

export interface FetchedFile {
  bytes: Buffer;
  /** From the response's Content-Disposition, else the end of the address; may be empty. */
  name: string;
  /** The Content-Type the server gave, without parameters; may be empty or wrong. */
  type: string;
}

const MAX_REDIRECTS = 5;

/**
 * Fetch a file from the public web, up to `limit` bytes (which may depend on the file's name). Throws
 * WebFetchError for anything to tell the user: a bad or private address, a failed request, a file too large.
 */
export async function fetchPublicFile(address: string, opts: { limit: number | ((name: string) => number); fetchFn?: typeof fetch; timeoutMs?: number }): Promise<FetchedFile> {
  let u: URL;
  try {
    u = new URL(address);
  } catch {
    throw new WebFetchError('The file address is not a valid URL.');
  }
  const fetchFn = opts.fetchFn ?? fetch;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 60_000);
  let res: Response;
  for (let hop = 0; ; hop++) {
    await checkPublic(u);
    try {
      // Some hosts refuse requests without a browser-like agent; redirects are followed here, one checked hop at a time.
      res = await fetchFn(u, { redirect: 'manual', signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; UniversalDocs/1.0)', accept: '*/*' } });
    } catch {
      throw new WebFetchError(`Could not reach ${u.hostname}.`);
    }
    if (res.status < 300 || res.status >= 400) break;
    const next = res.headers.get('location');
    if (!next || hop >= MAX_REDIRECTS) throw new WebFetchError('The address redirects too many times.');
    await res.body?.cancel().catch(() => {});
    try {
      u = new URL(next, u);
    } catch {
      throw new WebFetchError('The address redirects somewhere that is not a valid URL.');
    }
  }
  if (!res.ok) throw new WebFetchError(`Could not download the file (${res.status}).`);
  const name = nameOf(res, u);
  const limit = typeof opts.limit === 'function' ? opts.limit(name) : opts.limit;
  const tooLarge = () => new WebFetchError(`The file is too large to import (over ${Math.round(limit / 1024 / 1024)} MB).`);
  if (Number(res.headers.get('content-length') ?? 0) > limit) {
    await res.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  // Read in pieces, so a server that sends more than it said is cut off at the limit.
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of res.body ?? []) {
      size += chunk.byteLength;
      if (size > limit) throw tooLarge();
      chunks.push(Buffer.from(chunk));
    }
  } catch (e) {
    if (e instanceof WebFetchError) throw e;
    throw new WebFetchError('The download was cut off.');
  }
  if (!size) throw new WebFetchError('The file is empty.');
  return { bytes: Buffer.concat(chunks), name, type: (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() };
}
