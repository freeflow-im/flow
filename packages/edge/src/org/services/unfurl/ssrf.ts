// Phase 11 §4: SSRF guard.
//
// Runs before EVERY connection, including each redirect hop. The rule that
// makes this actually safe (rather than theatre) is the pinning in
// `assertPublicHost` + `pinnedAgent`: we resolve DNS ourselves, judge the
// resolved addresses, then connect to *that* address with the hostname pinned
// in Host/SNI. Resolving twice — once to check, once to connect — is the
// classic DNS-rebinding hole, where the second lookup returns 127.0.0.1.
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

/** Parsed IPv4 → 32-bit int. Returns null for anything that isn't dotted-quad. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

/** §4 blocked IPv4 ranges, as [network, prefix-length]. */
const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (incl. cloud metadata 169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
];

function isBlockedV4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return true; // unparseable → refuse
  for (const [network, bits] of BLOCKED_V4) {
    const net = ipv4ToInt(network);
    if (net === null) continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((value & mask) === (net & mask)) return true;
  }
  return false;
}

function isBlockedV6(ip: string): boolean {
  const addr = ip.toLowerCase().split('%')[0]!; // strip zone id
  if (addr === '::' || addr === '::1') return true;
  // IPv4-mapped/compatible (::ffff:127.0.0.1) — judge the embedded v4.
  const mapped = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (mapped) return isBlockedV4(mapped[1]!);
  const first = addr.split(':')[0] ?? '';
  const head = parseInt(first || '0', 16);
  if (Number.isNaN(head)) return true;
  if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((head & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isBlockedV4(ip);
  if (kind === 6) return isBlockedV6(ip);
  return true; // not an IP literal → refuse
}

/** Extra hosts/domains the operator never wants fetched (own egress, internal
 * names). Comma-separated in FLOW_UNFURL_DENY_HOSTS. */
function egressDenylist(): string[] {
  return (process.env.FLOW_UNFURL_DENY_HOSTS ?? '')
    .split(',')
    .map((s: string) => s.trim().toLowerCase())
    .filter(Boolean);
}

export interface ResolvedHost {
  hostname: string;
  /** The address we will actually connect to. */
  address: string;
  family: 4 | 6;
}

/**
 * §4: resolve `hostname`, reject if ANY resolved address is non-public, and
 * return the address to connect to. Judging every answer (not just the one we
 * pick) means a round-robin record mixing a public and a private address is
 * refused outright rather than gambled on.
 */
export async function assertPublicHost(hostname: string): Promise<ResolvedHost> {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  for (const denied of egressDenylist()) {
    if (host === denied || host.endsWith(`.${denied}`)) {
      throw new SsrfError(`host ${host} is denied by operator config`);
    }
  }

  // An IP literal in the URL never hits DNS — judge it directly.
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new SsrfError(`address ${host} is not public`);
    return { hostname: host, address: host, family: isIP(host) === 6 ? 6 : 4 };
  }

  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await dnsLookup(host, { all: true });
  } catch (err) {
    throw new SsrfError(`dns lookup failed for ${host}: ${(err as Error).message}`);
  }
  if (answers.length === 0) throw new SsrfError(`no addresses for ${host}`);
  for (const a of answers) {
    if (isBlockedAddress(a.address)) {
      throw new SsrfError(`${host} resolves to non-public address ${a.address}`);
    }
  }
  const chosen = answers[0]!;
  return { hostname: host, address: chosen.address, family: chosen.family === 6 ? 6 : 4 };
}

/**
 * A `lookup` implementation for http.request/https.request that always answers
 * with the already-vetted address, whatever the resolver would say now. This
 * is what closes the rebinding window between check and connect: DNS is
 * resolved exactly once, by `assertPublicHost`.
 *
 * The request still carries the real hostname in Host and TLS SNI, so virtual
 * hosting and certificate validation behave normally.
 */
export function pinnedLookup(resolved: ResolvedHost): NodeLookup {
  return ((_hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    // net.connect calls this with `{ all: true }`, in which case the callback
    // takes an ARRAY of {address, family}. Answering with the scalar form
    // there makes Node read addresses[0].address off a string → "Invalid IP
    // address: undefined". Both shapes must be handled.
    const wantsAll =
      typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true;
    if (wantsAll) {
      callback(null, [{ address: resolved.address, family: resolved.family }]);
    } else {
      callback(null, resolved.address, resolved.family);
    }
  }) as unknown as NodeLookup;
}

/** The shape http.request/net.connect expect for a custom `lookup`. */
type NodeLookup = (
  hostname: string,
  options: unknown,
  callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
) => void;
