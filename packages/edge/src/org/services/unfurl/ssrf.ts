// Phase 11 §4: SSRF guard.
//
// Runs before EVERY connection, including each redirect hop. On Node this resolved DNS itself and pinned the
// connection to the vetted address, because the server sat in a private network with a metadata endpoint. A Worker's
// subrequests go out through Cloudflare's network, which does not route to private, loopback or link-local
// addresses, and a Worker can neither resolve a name to the address it will connect to nor choose that address.
// So what is left here is what the URL itself says: the scheme (guardedFetch), IP literals in the blocked ranges,
// names that are only ever internal, the operator's denylist, and an allowlist for local test runs.
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
  // The same, as the URL parser writes it: [::ffff:127.0.0.1] becomes [::ffff:7f00:1].
  const mappedHex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(addr);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1]!, 16), lo = parseInt(mappedHex[2]!, 16);
    return isBlockedV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (addr.startsWith('64:ff9b:')) return true; // NAT64: an IPv4 address in disguise
  const first = addr.split(':')[0] ?? '';
  const head = parseInt(first || '0', 16);
  if (Number.isNaN(head)) return true;
  if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((head & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** 4 for a dotted-quad IPv4 address, 6 for an IPv6 one (without brackets), else 0. */
function isIP(host: string): 0 | 4 | 6 {
  if (ipv4ToInt(host) !== null) return 4;
  return /^[0-9a-f:.%]+$/i.test(host) && host.includes(':') ? 6 : 0;
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

/** Hosts exempt from this guard, comma-separated in FLOW_UNFURL_ALLOW_HOSTS: only for a local test run, which links to
 * a page on localhost. Never set in production. */
function testAllowlist(): string[] {
  return (process.env.FLOW_UNFURL_ALLOW_HOSTS ?? '')
    .split(',')
    .map((s: string) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Names that only ever mean a machine on a private network. */
const INTERNAL_NAME = /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa|corp)$/;

/**
 * §4: refuse a URL whose host is a non-public address or an internal name. Throws SsrfError.
 */
export function assertPublicUrl(url: URL): void {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (testAllowlist().includes(host)) return;
  for (const denied of egressDenylist()) {
    if (host === denied || host.endsWith(`.${denied}`)) {
      throw new SsrfError(`host ${host} is denied by operator config`);
    }
  }
  // An IP literal is judged directly. The URL parser has already turned 0x7f.1 and 2130706433 into 127.0.0.1.
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new SsrfError(`address ${host} is not public`);
    return;
  }
  if (!host.includes('.') || INTERNAL_NAME.test(host)) throw new SsrfError(`${host} is not a public name`);
}
