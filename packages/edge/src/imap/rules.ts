// FreeFlow Mail's checks that need no mail server: what a request may ask for (which servers, which ports), the provider
// presets, and the request bodies. The Mail object (object.ts) and routes/mail.ts use them; rules.test.ts tests them.
import { z } from 'zod';
import { ApiError } from '../errors';
import { CATEGORIES, TAB_CATEGORIES } from './categorize';

export type Security = 'tls' | 'starttls' | 'none';
export interface ServerSettings { host: string; port: number; security: Security; username?: string }
export interface Provider { name: string; imap: ServerSettings; smtp: ServerSettings; appPasswordUrl?: string }

export const mailError = (status: number, code: string, message: string) => new ApiError(status, code, message);
export const badRequest = (message: string) => mailError(400, 'bad_request', message);
export const notFound = (message: string) => mailError(404, 'not_found', message);

/** The only ports a production Worker connects to, each with the one security it is used with. */
const PORTS: Record<'imap' | 'smtp', Record<number, Security>> = {
  imap: { 993: 'tls', 143: 'starttls' },
  smtp: { 465: 'tls', 587: 'starttls' },
};

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i;

function ipv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
}

function privateIpv4([a, b]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** A host that names this machine or a private network: an IP literal in a private range, or localhost. */
export function isPrivateHost(raw: string): boolean {
  const host = raw.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const v4 = ipv4(host);
  if (v4) return privateIpv4(v4);
  if (!host.includes(':')) return false;
  // IPv6: loopback, unspecified, unique local (fc00::/7), link-local (fe80::/10) and IPv4-mapped private addresses.
  if (host === '::1' || host === '::' || /^0*:0*:0*:0*:0*:0*:0*:0*1?$/.test(host)) return true;
  if (/^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host)) return true;
  const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (mapped) { const m = ipv4(mapped[1]); return !m || privateIpv4(m); }
  return false;
}

/** Throws `bad_request` for a server a Worker should not connect to. `allowInsecure` is MAIL_ALLOW_INSECURE=1 (local dev). */
export function checkServer(kind: 'imap' | 'smtp', s: ServerSettings, allowInsecure: boolean): void {
  const host = s.host.trim();
  const isIp = !!ipv4(host) || host.includes(':');
  if (!isIp && !HOSTNAME.test(host)) throw badRequest(`${kind}.host: not a host name`);
  if (allowInsecure) return;
  if (s.security === 'none') throw badRequest(`${kind}.security: an unencrypted connection is not allowed; use tls or starttls`);
  const expected = PORTS[kind][s.port];
  if (!expected) throw badRequest(`${kind}.port: use ${Object.keys(PORTS[kind]).join(' or ')}`);
  if (expected !== s.security) throw badRequest(`${kind}.port: port ${s.port} is used with ${expected}, not ${s.security}`);
  if (isPrivateHost(host)) throw badRequest(`${kind}.host: a private or local address is not allowed`);
}

// ---- provider presets ---------------------------------------------------------------------------------------------

const tls = (host: string, port = 993): ServerSettings => ({ host, port, security: 'tls' });
const PROVIDERS: { domains: string[]; provider: Provider }[] = [
  { domains: ['gmail.com', 'googlemail.com'], provider: { name: 'Gmail', imap: tls('imap.gmail.com'), smtp: tls('smtp.gmail.com', 465), appPasswordUrl: 'https://myaccount.google.com/apppasswords' } },
  { domains: ['icloud.com', 'me.com', 'mac.com'], provider: { name: 'iCloud Mail', imap: tls('imap.mail.me.com'), smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' }, appPasswordUrl: 'https://account.apple.com/account/manage' } },
  { domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'], provider: { name: 'Outlook.com', imap: tls('outlook.office365.com'), smtp: { host: 'smtp-mail.outlook.com', port: 587, security: 'starttls' } } },
  { domains: ['yahoo.com', 'ymail.com', 'rocketmail.com'], provider: { name: 'Yahoo Mail', imap: tls('imap.mail.yahoo.com'), smtp: tls('smtp.mail.yahoo.com', 465), appPasswordUrl: 'https://login.yahoo.com/account/security' } },
  { domains: ['fastmail.com', 'fastmail.fm'], provider: { name: 'Fastmail', imap: tls('imap.fastmail.com'), smtp: tls('smtp.fastmail.com', 465), appPasswordUrl: 'https://app.fastmail.com/settings/security/apps' } },
];

/** The preset for an address's domain, with the address as the username; null for a domain we have no preset for. */
export function providerFor(email: string): Provider | null {
  const domain = email.trim().toLowerCase().split('@')[1];
  const found = domain ? PROVIDERS.find((p) => p.domains.includes(domain)) : undefined;
  if (!found) return null;
  const address = email.trim();
  const p = found.provider;
  return { ...p, imap: { ...p.imap, username: address }, smtp: { ...p.smtp, username: address } };
}

/** Gmail keeps its own copy of what it sends in Sent Mail, so appending one would make two. */
export const savesSentCopy = (imap: ServerSettings, smtp: ServerSettings) => /(^|\.)(gmail|googlemail)\.com$/i.test(imap.host) || /(^|\.)(gmail|googlemail)\.com$/i.test(smtp.host);

// ---- request bodies -----------------------------------------------------------------------------------------------

export const Server = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  security: z.enum(['tls', 'starttls', 'none']),
  username: z.string().max(320).optional(),
});
export const NewAccount = z.object({
  email: z.string().trim().email().max(320),
  displayName: z.string().max(200).default(''),
  password: z.string().min(1).max(1000),
  imap: Server,
  smtp: Server,
});
export const AccountPatch = z.object({
  displayName: z.string().max(200).optional(),
  password: z.string().min(1).max(1000).optional(),
  imap: Server.optional(),
  smtp: Server.optional(),
  /** The inbox tabs that are on, besides Primary. Changing only these never re-verifies the login. */
  tabs: z.array(z.enum(TAB_CATEGORIES)).max(8).optional(),
});
const Uids = z.array(z.number().int().positive()).min(1).max(1000);
export const FlagsBody = z.object({ folder: z.string().min(1), uids: Uids, seen: z.boolean().optional(), flagged: z.boolean().optional() });
export const MoveBody = z.object({ folder: z.string().min(1), uids: Uids, to: z.string().min(1) });
/** "Move to tab": the messages' senders go to `category` from now on. */
export const CategoryBody = z.object({ folder: z.string().min(1), uids: Uids, category: z.enum(CATEGORIES) });
/** Sets (or, with `category: null`, forgets) the tab chosen for senders: how a move is undone. */
export const SendersCategoryBody = z.object({ senders: z.array(z.object({ address: z.string().trim().toLowerCase().min(3).max(320), category: z.enum(CATEGORIES).nullable() })).min(1).max(1000) });
export const DeleteBody = z.object({ folder: z.string().min(1), uids: Uids });
const Address = z.object({ name: z.string().max(500).default(''), address: z.string().trim().email() });
export const SendBody = z.object({
  to: z.array(Address).default([]),
  cc: z.array(Address).optional(),
  bcc: z.array(Address).optional(),
  subject: z.string().max(2000).default(''),
  html: z.string().default(''),
  text: z.string().optional(),
  inReplyTo: z.string().max(1000).optional(),
  references: z.array(z.string().max(1000)).max(500).optional(),
  attachments: z.array(z.object({ filename: z.string().min(1).max(500), contentType: z.string().max(200).default('application/octet-stream'), contentBase64: z.string() })).optional(),
});
export const MAX_SEND_BYTES = 20 * 1024 * 1024;

/** The bytes a message's parts come to: its bodies and its attachments decoded. */
export function sendSize(body: z.output<typeof SendBody>): number {
  const b64 = (s: string) => Math.floor((s.replace(/[^A-Za-z0-9+/]/g, '').length * 3) / 4);
  return new TextEncoder().encode(body.html).length + new TextEncoder().encode(body.text ?? '').length + (body.attachments ?? []).reduce((n, a) => n + b64(a.contentBase64), 0);
}

/** Parses a body with a schema, or throws `bad_request` naming the first problem. */
export function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  throw badRequest(issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'invalid request');
}
