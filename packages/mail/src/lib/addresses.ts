// Addresses as people type and paste them into To, Cc and Bcc: `ann@example.com`, `Ann Lee <ann@example.com>`,
// `"Lee, Ann" <ann@example.com>`, several at once separated by commas, semicolons or new lines.
import type { Address } from '../api';

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

export const isEmail = (s: string) => EMAIL.test(s.trim());

/** Split on commas, semicolons and line breaks outside quotes and angle brackets. */
function splitList(input: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quoted = false;
  let angle = false;
  for (const ch of input) {
    if (ch === '"') quoted = !quoted;
    else if (ch === '<' && !quoted) angle = true;
    else if (ch === '>' && !quoted) angle = false;
    if (!quoted && !angle && (ch === ',' || ch === ';' || ch === '\n' || ch === '\r')) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** One address as typed, or null if it is not one. */
export function parseAddress(input: string): Address | null {
  const s = input.trim();
  const angled = /^(.*?)<\s*([^<>\s]+)\s*>$/.exec(s);
  if (angled) {
    const address = angled[2]!;
    if (!isEmail(address)) return null;
    const name = angled[1]!.trim().replace(/^"(.*)"$/, '$1').replace(/\\"/g, '"').trim();
    return { name, address };
  }
  const bare = s.replace(/^mailto:/i, '');
  return isEmail(bare) ? { name: '', address: bare } : null;
}

/** Every address in a typed or pasted list, and whatever could not be read as one (to leave in the field). */
export function parseAddressList(input: string): { addresses: Address[]; invalid: string[] } {
  const addresses: Address[] = [];
  const invalid: string[] = [];
  for (const part of splitList(input)) {
    const a = parseAddress(part);
    if (a) addresses.push(a);
    else invalid.push(part);
  }
  return { addresses, invalid };
}

/** `Ann Lee <ann@example.com>`, quoting a name that needs it; just the address without a name. */
export function formatAddress(a: Address): string {
  if (!a.name) return a.address;
  const name = /[",;<>@()]/.test(a.name) ? `"${a.name.replace(/"/g, '\\"')}"` : a.name;
  return `${name} <${a.address}>`;
}

/** The name to show for an address: its name, else the part before the @. */
export const displayName = (a: Address | null | undefined) => (a ? a.name || a.address.split('@')[0] || a.address : '(no sender)');

/** A recipient as the short "to" line under a sender names them (as Gmail does): the first name, or the whole address when there is no name. */
export function shortName(a: Address): string {
  const name = a.name.trim().replace(/^["']|["']$/g, '').trim();
  if (!name || name.includes('@')) return a.address;
  // "Miller, James" is James.
  const comma = name.indexOf(',');
  const first = comma > 0 ? name.slice(comma + 1).trim().split(/\s+/)[0] : name.split(/\s+/)[0];
  return first || name;
}

/** Addresses once each (by address, ignoring case), leaving out `exclude`. */
export function uniqueAddresses(list: Address[], exclude: string[] = []): Address[] {
  const seen = new Set(exclude.map((e) => e.toLowerCase()));
  const out: Address[] = [];
  for (const a of list) {
    const key = a.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}
