// FreeFlow Contacts (platform.md §11, phase 6.5): one object per account (`idFromName(accountId)`), the fifth app, added by
// its manifest (@flow/shared's APP_MANIFESTS, `contacts`). It holds the account's own contacts and one grant, `org` viewer
// on the account's list, when the person shares it with the organization; the grant is told to the Org object's share
// index, which is how a member's object learns whose lists it may read.
//
// GET /v1/contacts answers the merge: the account's own contacts, the organization's members (the directory's accounts,
// with their addresses), the lists other members shared with the organization (`shared`, with the owner's name), and the
// people the person wrote to from Mail (the Mail object of the same account, its accounts' contacts with `sent` > 0).
// Each change to an own contact publishes `contacts.changed` to the account alone.
//
// Ids: an own contact is `<accountId>:<12 hex>`, so a reference to it names the object that resolves it (apps.ts); a member
// is `member:<accountId>` and a Mail correspondent `mail:<address>`, neither stored.
import { DurableObject } from 'cloudflare:workers';
import { Hono, type Context } from 'hono';
import { z } from 'zod4';
import { formatReference, type AccountDTO, type Role } from '@flow/shared';
import { GRANTS_DDL, grantSql, grantsForChainSql, principalsOf, revokeSql, type GrantPrincipal } from '@flow/shared/grants';
import type { CallerContext, ObjectBindings } from '../org/routes/compat';
import { ownerMismatch, ownerRefusal } from '../perAccount';
import { ApiError } from '../errors';
import { sendMail, type MailEnv } from '../mail';
import { EmailBody, compose, loadAttachments, membersOf, resolveRecipients, withinHourly, type FileReach } from './email';
import './tools';

export interface ContactsEnv extends MailEnv {
  /** The organization's event log: `contacts.changed`. */
  EVENTS?: DurableObjectNamespace<import('../events/object').Events>;
  /** The organization's share index: the `org` grant on the list, and the lists shared with this account. */
  ORG?: DurableObjectNamespace<import('../org/object').Org>;
  /** The directory: the organization's accounts, its members. */
  DIRECTORY?: DurableObjectNamespace<import('../directory/object').Directory>;
  /** The account's Mail object: the people written to. */
  MAIL?: DurableObjectNamespace<import('../imap/object').Mail>;
  /** Other accounts' Contacts objects: the lists they shared. */
  CONTACTS?: DurableObjectNamespace<Contacts>;
  /** The organization's Docs object: a Docs file attached to an email to members (email.ts). */
  DOCS?: DurableObjectNamespace<import('../docs/object').Docs>;
}

export type ContactSource = 'own' | 'member' | 'shared' | 'mail';

/** A contact as the API answers it. `owner` is a shared list's owner; `userId` and `accountId` a member's (a DM's). */
export interface ContactDTO {
  id: string;
  source: ContactSource;
  name: string;
  emails: string[];
  phone?: string;
  orgName?: string;
  notes?: string;
  owner?: { accountId: string; name: string };
  userId?: string;
  accountId?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** The tables, in order; append-only. */
export const CONTACTS_DDL: readonly string[] = [
  'CREATE TABLE IF NOT EXISTS contacts_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  `CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL, emails TEXT NOT NULL DEFAULT '[]', phone TEXT, org_name TEXT, notes TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  ...GRANTS_DDL,
];

/** The grant's object: the account's list, named by the account. */
const LIST = 'list';
const MAX_CONTACTS = 2000;
const LIST_LIMIT = 500;

const Email = z.string().trim().toLowerCase().email().max(320);
export const NewContact = z.object({
  name: z.string().trim().min(1).max(200),
  emails: z.array(Email).max(20).optional(),
  phone: z.string().trim().max(60).optional(),
  orgName: z.string().trim().max(200).optional(),
  notes: z.string().max(4000).optional(),
}).strict();
export const ContactPatch = NewContact.partial().strict();
export const ShareBody = z.object({ org: z.boolean() }).strict();

const badRequest = (message: string) => new ApiError(400, 'bad_request', message);
const notFound = () => new ApiError(404, 'not_found', 'no such contact');

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  throw badRequest(issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'invalid body');
}

interface Row { id: string; name: string; emails: string; phone: string | null; org_name: string | null; notes: string | null; created_at: number; updated_at: number }

const toContact = (r: Row, source: ContactSource = 'own'): ContactDTO => ({
  id: r.id, source, name: r.name, emails: JSON.parse(r.emails) as string[],
  ...(r.phone ? { phone: r.phone } : {}), ...(r.org_name ? { orgName: r.org_name } : {}), ...(r.notes ? { notes: r.notes } : {}),
  createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
});

/** Whether a contact matches a search: its name, an address, its organization or its phone, without case. */
export function matches(c: ContactDTO, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return [c.name, ...c.emails, c.orgName ?? '', c.phone ?? '', c.owner?.name ?? ''].some((x) => x.toLowerCase().includes(s));
}

/**
 * The sources merged into one list, in the order own, member, shared, mail, each sorted by name: an address the person
 * wrote to is left out when a contact of another source already has it (Mail's are the least known).
 */
export function mergeContacts(parts: { own: ContactDTO[]; members: ContactDTO[]; shared: ContactDTO[]; mail: ContactDTO[] }): ContactDTO[] {
  const byName = (a: ContactDTO, b: ContactDTO) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id);
  const seen = new Set([...parts.own, ...parts.members, ...parts.shared].flatMap((c) => c.emails));
  const mail = parts.mail.filter((c) => !c.emails.some((e) => seen.has(e)));
  return [...[...parts.own].sort(byName), ...[...parts.members].sort(byName), ...[...parts.shared].sort(byName), ...mail.sort(byName)];
}

type Bindings = ObjectBindings;
const json = async (c: Context) => c.req.json().catch(() => { throw badRequest('the body is not JSON'); });

export class Contacts extends DurableObject<ContactsEnv> {
  private readonly sql: SqlStorage;
  private readonly app = new Hono<{ Bindings: Bindings }>();

  constructor(ctx: DurableObjectState, env: ContactsEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const ddl of CONTACTS_DDL) this.sql.exec(ddl);
    this.routes();
  }

  state(key: string): string | null {
    return (this.sql.exec('SELECT value FROM contacts_state WHERE key = ?', key).toArray()[0]?.value as string | undefined) ?? null;
  }

  setState(key: string, value: string): void {
    this.sql.exec('INSERT INTO contacts_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
  }

  /** A request from routes/contacts.ts or a tool (apps.ts), for the account this object belongs to; anyone else's is refused. */
  async handle(request: Request, caller: CallerContext): Promise<Response> {
    const wrong = ownerMismatch(this, caller, 'the Contacts');
    if (wrong) { console.error(`[contacts] ${wrong}`); return ownerRefusal(wrong); }
    if (caller.account?.displayName && caller.account.displayName !== this.state('owner_name')) this.setState('owner_name', caller.account.displayName);
    return this.app.fetch(request, { caller } satisfies Bindings);
  }

  /**
   * The account's list as a reader in the same organization sees it, when the list is shared with them (the `org` viewer
   * grant): the owner and the contacts; null otherwise (an RPC from the reader's own Contacts object).
   */
  async sharedWith(reader: CallerContext): Promise<{ owner: { accountId: string; name: string }; contacts: ContactDTO[] } | null> {
    const owner = this.state('owner_account_id');
    if (!owner || !this.readerRole(reader)) return null;
    const who = { accountId: owner, name: this.ownerName() };
    return { owner: who, contacts: this.rows().map((r) => ({ ...toContact(r, 'shared'), owner: who })) };
  }

  /**
   * The list or one contact described for a reference's chip (GET /v1/references, apps.ts): the name and the reader's role,
   * owner for the account itself, viewer for a member of the organization the list is shared with; null for nothing to see.
   */
  describe(caller: CallerContext, _channelIds: string[], kind: string, id: string): { title: string; summary?: string; role: Role } | null {
    const owner = this.state('owner_account_id');
    if (!owner || !caller.account) return null;
    const role: Role | null = caller.account.id === owner ? 'owner' : this.readerRole(caller);
    if (!role) return null;
    if (kind === LIST) return id === owner ? { title: `${this.ownerName()}’s contacts`, role } : null;
    if (kind !== 'contact') return null;
    const r = this.row(id);
    if (!r) return null;
    const emails = JSON.parse(r.emails) as string[];
    return { title: r.name, ...(emails[0] ? { summary: emails[0] } : {}), role };
  }

  // ---- the routes ---------------------------------------------------------------------------------------------------

  private routes(): void {
    const app = this.app;
    app.onError((err) => {
      if (err instanceof ApiError) return Response.json({ error: { code: err.code, message: err.message } }, { status: err.statusCode });
      console.error(`[contacts] ${(err as Error).stack ?? err}`);
      return Response.json({ error: { code: 'internal', message: 'internal error' } }, { status: 500 });
    });
    app.get('/v1/contacts', async (c) => c.json({ contacts: (await this.merged(c.env.caller!, c.req.query('q') ?? '')).slice(0, LIST_LIMIT) }));
    app.get('/v1/contacts/search', async (c) => {
      const q = (c.req.query('q') ?? '').trim();
      if (!q) throw badRequest('q: what to search for');
      return c.json({ contacts: (await this.merged(c.env.caller!, q)).slice(0, LIST_LIMIT) });
    });
    app.get('/v1/contacts/share', (c) => c.json({ org: this.isShared() }));
    app.put('/v1/contacts/share', async (c) => {
      const b = parse(ShareBody, await json(c));
      await this.share(b.org, c.env.caller!);
      return c.json({ org: this.isShared() });
    });
    app.post('/v1/contacts', async (c) => {
      const b = parse(NewContact, await json(c));
      const count = Number(this.sql.exec('SELECT COUNT(*) AS n FROM contacts').toArray()[0]?.n ?? 0);
      if (count >= MAX_CONTACTS) throw badRequest(`at most ${MAX_CONTACTS} contacts`);
      const now = Date.now();
      const id = `${this.state('owner_account_id')}:${[...crypto.getRandomValues(new Uint8Array(6))].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
      this.sql.exec('INSERT INTO contacts (id, name, emails, phone, org_name, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id, b.name, JSON.stringify([...new Set(b.emails ?? [])]), b.phone || null, b.orgName || null, b.notes || null, now, now);
      const contact = toContact(this.row(id)!);
      await this.publish('added', contact, c.env.caller!);
      return c.json({ contact }, 201);
    });
    app.patch('/v1/contacts/:id', async (c) => {
      const had = this.row(c.req.param('id'));
      if (!had) throw notFound();
      const b = parse(ContactPatch, await json(c));
      const next = { name: b.name ?? had.name, emails: b.emails ? JSON.stringify([...new Set(b.emails)]) : had.emails, phone: b.phone !== undefined ? b.phone || null : had.phone,
        org_name: b.orgName !== undefined ? b.orgName || null : had.org_name, notes: b.notes !== undefined ? b.notes || null : had.notes };
      this.sql.exec('UPDATE contacts SET name = ?, emails = ?, phone = ?, org_name = ?, notes = ?, updated_at = ? WHERE id = ?', next.name, next.emails, next.phone, next.org_name, next.notes, Date.now(), had.id);
      const contact = toContact(this.row(had.id)!);
      await this.publish('updated', contact, c.env.caller!);
      return c.json({ contact });
    });
    // Email to members of the organization (email.ts): every recipient checked against the directory, then one message each.
    app.post('/v1/contacts/email', async (c) => c.json(await this.emailMembers(c.env.caller!, parse(EmailBody, await json(c)))));
    app.delete('/v1/contacts/:id', async (c) => {
      const had = this.row(c.req.param('id'));
      if (!had) throw notFound();
      this.sql.exec('DELETE FROM contacts WHERE id = ?', had.id);
      await this.publish('deleted', toContact(had), c.env.caller!);
      return c.json({ ok: true });
    });
  }

  // ---- email to members ----------------------------------------------------------------------------------------------

  private async emailMembers(caller: CallerContext, input: import('./email').EmailInput): Promise<{ sent: { name: string; address: string }[]; failed?: { name: string; address: string; error: string }[]; attachments: { filename: string; type: string; bytes: number }[] }> {
    const account = caller.account;
    if (!account || account.kind === 'guest') throw new ApiError(403, 'forbidden', "Email to members is for the organization's members.");
    const org = account.organizationId || caller.organizationId!;
    const to = resolveRecipients(input.to, membersOf(await this.accounts(org)), caller);
    const log = withinHourly(JSON.parse(this.state('email_sent') ?? '[]') as number[], to.length);
    if (!log.ok) throw new ApiError(429, 'rate_limited', 'Too many emails in the last hour (at most 50 recipients an hour). Try again later.');
    const attachments = await loadAttachments(input.attachments ?? [], this.fileReach(caller, org));
    const sender = { name: account.displayName || account.address || caller.user?.email || 'A member', address: account.address ?? caller.user?.email ?? null };
    const sent: { name: string; address: string }[] = [], failed: { name: string; address: string; error: string }[] = [];
    for (const m of to) {
      try {
        await sendMail(this.env, compose(input, m, sender, attachments));
        sent.push({ name: m.name, address: m.address });
      } catch (err) {
        console.error(`[contacts] email to ${m.accountId}: ${(err as Error).message.slice(0, 200)}`);
        failed.push({ name: m.name, address: m.address, error: 'the mail service did not take it' });
      }
      log.kept.push(Date.now());
      this.setState('email_sent', JSON.stringify(log.kept));
    }
    console.log(`[contacts] email from ${account.id}: ${sent.length} sent, ${failed.length} failed, ${attachments.length} attachment(s)`);
    if (!sent.length) throw new ApiError(502, 'send_failed', 'The email could not be sent just now. Try again in a moment.');
    return { sent, ...(failed.length ? { failed } : {}), attachments: attachments.map((a) => ({ filename: a.filename, type: a.type, bytes: Math.floor((a.content.length * 3) / 4) - (a.content.endsWith('==') ? 2 : a.content.endsWith('=') ? 1 : 0) })) };
  }

  /** The organization's accounts, from the directory. */
  private async accounts(org: string): Promise<AccountDTO[]> {
    const ns = this.env.DIRECTORY;
    if (!ns) throw new ApiError(503, 'unavailable', 'the directory is not reachable');
    const stub = ns.get(ns.idFromName('directory'));
    const answer = await (stub.call as never as (m: string, a: unknown[]) => Promise<{ ok: boolean; value?: AccountDTO[]; message?: string }>)('accountsOfOrganization', [org]);
    if (!answer.ok) throw new Error(answer.message ?? 'the directory refused');
    return answer.value ?? [];
  }

  /** The caller's Docs and Chat, as the caller (routes/docs.ts and the Org object's own access checks decide what they may open). */
  private fileReach(caller: CallerContext, org: string): FileReach {
    const origin = 'https://contacts.internal';
    const { DOCS, ORG } = this.env;
    const userId = caller.user?.id ?? null;
    return {
      ...(DOCS && ORG && userId ? {
        docs: async (path: string) => {
          const channelIds = await ORG.get(ORG.idFromName(org)).channelIdsOf(userId);
          const who = { userId, email: caller.user?.email ?? null, token: caller.token, ip: caller.ip, accountId: caller.account?.id ?? null, channelIds };
          return DOCS.get(DOCS.idFromName(org)).handle(new Request(`${origin}${path}`), who, org);
        },
      } : {}),
      ...(ORG ? { chat: (path: string) => ORG.get(ORG.idFromName(org)).handle(new Request(`${origin}${path}`), caller, null) } : {}),
    };
  }

  // ---- the merge ------------------------------------------------------------------------------------------------------

  private rows(): Row[] {
    return this.sql.exec('SELECT * FROM contacts ORDER BY name COLLATE NOCASE, id').toArray() as unknown as Row[];
  }

  private row(id: string): Row | null {
    return (this.sql.exec('SELECT * FROM contacts WHERE id = ?', id).toArray()[0] as unknown as Row | undefined) ?? null;
  }

  private ownerName(): string {
    return this.state('owner_name') || 'Someone';
  }

  /** The caller's own contacts and everyone the caller may see, merged and searched. A source that fails is left out (logged). */
  private async merged(caller: CallerContext, q: string): Promise<ContactDTO[]> {
    const quiet = <T>(what: string, p: Promise<T[]>): Promise<T[]> => p.catch((err: Error) => { console.error(`[contacts] ${what}: ${err.message.slice(0, 200)}`); return []; });
    const [members, shared, mail] = await Promise.all([quiet('members', this.members(caller)), quiet('shared', this.sharedLists(caller)), quiet('mail', this.mailContacts(caller))]);
    return mergeContacts({ own: this.rows().map((r) => toContact(r)), members, shared, mail }).filter((c) => matches(c, q));
  }

  /** The organization's other active accounts, with their addresses (the directory's accounts). */
  private async members(caller: CallerContext): Promise<ContactDTO[]> {
    const org = caller.account?.organizationId || caller.organizationId, ns = this.env.DIRECTORY;
    if (!org || !ns) return [];
    const stub = ns.get(ns.idFromName('directory'));
    const answer = await (stub.call as never as (m: string, a: unknown[]) => Promise<{ ok: boolean; value?: AccountDTO[]; message?: string }>)('accountsOfOrganization', [org]);
    if (!answer.ok) throw new Error(answer.message ?? 'the directory refused');
    return (answer.value ?? [])
      // A guest has no address (§3.3), so it is no one to write to.
      .filter((a): a is AccountDTO & { address: string } => a.id !== caller.account?.id && a.state !== 'removed' && a.state !== 'suspended' && !!a.address)
      .map((a) => ({ id: `member:${a.id}`, source: 'member', name: a.displayName || a.address, emails: [a.address.toLowerCase()], accountId: a.id, userId: a.principalId }));
  }

  /** The lists shared with the caller's organization by other members: the share index names them, their objects answer. */
  private async sharedLists(caller: CallerContext): Promise<ContactDTO[]> {
    const org = caller.account?.organizationId || caller.organizationId, { ORG, CONTACTS } = this.env;
    if (!org || !ORG || !CONTACTS || !caller.account) return [];
    const items = await ORG.get(ORG.idFromName(org)).sharedWith({ accountId: caller.account.id, channelIds: [] }, { includeOrg: true });
    const owners = items.map((i) => i.ref.split('/')).filter((p) => p[1] === 'contacts' && p[2] === LIST && p[3] && p[3] !== caller.account!.id).map((p) => p[3]!);
    const lists = await Promise.all([...new Set(owners)].map((o) => CONTACTS.get(CONTACTS.idFromName(o)).sharedWith(caller).catch(() => null)));
    return lists.flatMap((l) => l?.contacts ?? []);
  }

  /** The people the caller wrote to, from each of the Mail object's accounts (`GET …/contacts`, `sent` > 0). */
  private async mailContacts(caller: CallerContext): Promise<ContactDTO[]> {
    const ns = this.env.MAIL;
    if (!ns || !caller.account) return [];
    const mail = ns.get(ns.idFromName(caller.account.id));
    const get = async <T>(path: string): Promise<T | null> => {
      const res = await mail.handle(new Request(`https://contacts.internal${path}`), caller);
      return res.ok ? ((await res.json()) as T) : null;
    };
    const accounts = (await get<{ accounts: { id: string }[] }>('/v1/mail/accounts'))?.accounts ?? [];
    const out = new Map<string, ContactDTO>();
    for (const a of accounts) {
      const list = (await get<{ contacts: { name: string; address: string; sent: number }[] }>(`/v1/mail/accounts/${encodeURIComponent(a.id)}/contacts?limit=200`))?.contacts ?? [];
      for (const m of list) {
        const address = m.address.toLowerCase();
        if (m.sent > 0 && !out.has(address)) out.set(address, { id: `mail:${address}`, source: 'mail', name: m.name || address, emails: [address] });
      }
    }
    return [...out.values()];
  }

  // ---- sharing --------------------------------------------------------------------------------------------------------

  private isShared(): boolean {
    const owner = this.state('owner_account_id');
    if (!owner) return false;
    const q = grantsForChainSql([{ objectKind: LIST, objectId: owner }]);
    return this.sql.exec(q.sql, ...q.params).toArray().some((g) => g.principal === 'org');
  }

  /** A reader's role on the list: viewer for a member of the owner's organization the list is shared with, else null. */
  private readerRole(reader: CallerContext): Role | null {
    const owner = this.state('owner_account_id'), org = this.state('owner_organization_id');
    const account = reader.account;
    if (!owner || !org || !account || (account.organizationId || reader.organizationId) !== org) return null;
    const mine = new Set<string>(principalsOf({ accountId: account.id, channelIds: [] }));
    const q = grantsForChainSql([{ objectKind: LIST, objectId: owner }]);
    return this.sql.exec(q.sql, ...q.params).toArray().some((g) => mine.has(g.principal as string)) ? 'viewer' : null;
  }

  /** The `org` viewer grant on the list given or taken away, and told to the share index (logged on failure). */
  private async share(on: boolean, caller: CallerContext): Promise<void> {
    const owner = this.state('owner_account_id')!, org = this.state('owner_organization_id');
    const had = this.isShared();
    if (on) {
      const g = grantSql({ objectKind: LIST, objectId: owner, principal: 'org' as GrantPrincipal, role: 'viewer', grantedBy: caller.account!.id, grantedAt: new Date().toISOString() });
      this.sql.exec(g.sql, ...g.params);
    } else {
      const q = revokeSql(LIST, owner, 'org');
      this.sql.exec(q.sql, ...q.params);
    }
    const ns = this.env.ORG;
    if (!ns || !org || had === on) return;
    const ref = formatReference({ organizationId: org, app: 'contacts', kind: LIST, id: owner });
    try {
      const stub = ns.get(ns.idFromName(org));
      if (on) await stub.recordShare({ ref, principal: 'org', role: 'viewer', grantedBy: caller.account!.id, title: `${this.ownerName()}’s contacts`, kind: LIST });
      else await stub.revokeShare({ ref, principal: 'org', revokedBy: caller.account!.id });
    } catch (err) {
      console.error(`[contacts] share index: ${(err as Error).message.slice(0, 200)}`);
    }
  }

  // ---- events ---------------------------------------------------------------------------------------------------------

  /** `contacts.changed` into the organization's log, for the account alone (platform.md §5.2). A failure is logged, never the write's. */
  private async publish(change: 'added' | 'updated' | 'deleted', contact: ContactDTO, caller: CallerContext): Promise<void> {
    const ns = this.env.EVENTS, org = this.state('owner_organization_id'), owner = this.state('owner_account_id');
    if (!ns || !org || !owner) return;
    try {
      await ns.get(ns.idFromName(org)).publish({
        type: 'contacts.changed', organizationId: org, actor: caller.account?.id ?? null,
        ...(caller.via ? { via: caller.via } : {}), ...(caller.invokedBy ? { invokedBy: caller.invokedBy } : {}),
        ref: { organizationId: org, app: 'contacts', kind: 'contact', id: contact.id },
        audience: `account:${owner}`,
        ts: new Date().toISOString(),
        data: { change, contactId: contact.id, name: contact.name, emails: contact.emails },
      });
    } catch (err) {
      console.error(`[contacts] contacts.changed: ${(err as Error).message.slice(0, 200)}`);
    }
  }
}
