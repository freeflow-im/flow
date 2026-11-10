// The Contacts tools (platform.md §5.4), at /mcp and in the assistant: registered here, which the object module imports, and
// run on the caller's own Contacts object through `ctx.apps.contacts` (apps.ts), the same HTTP API the routes forward to.
// contacts:read lists and searches the merged list (the person's own contacts, the organization's members, the lists
// shared with it, the people written to); contacts:write adds a contact; contacts:email sends email to members (email.ts).
import { z } from 'zod4';
import type { AppToolContext } from '../apps';
import { register } from '../registry';
import type { ContactDTO } from './object';

/** An error the agent should see as it is. */
export class ContactsToolError extends Error {}

interface ContactsTool {
  name: string;
  title: string;
  description: string;
  shape: Record<string, z.ZodType>;
  scopes: string[];
  annotations: Record<string, boolean>;
  run(ctx: AppToolContext, input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

async function call<T>(ctx: AppToolContext, method: string, path: string, body?: unknown): Promise<T> {
  const res = await ctx.fetch(`/v1/contacts${path}`, { method, ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  if (res.ok) return (await res.json()) as T;
  const err = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  throw new ContactsToolError(err?.error?.message ?? `Contacts answered ${res.status}`);
}

/** A contact as the tools return it: its source, and for a shared one whose list it is. */
const out = (c: ContactDTO) => ({
  id: c.id, source: c.source, name: c.name, emails: c.emails,
  ...(c.phone ? { phone: c.phone } : {}), ...(c.orgName ? { organization: c.orgName } : {}), ...(c.notes ? { notes: c.notes } : {}),
  ...(c.owner ? { shared_by: c.owner.name } : {}),
});

export const CONTACTS_TOOLS: ContactsTool[] = [
  {
    name: 'list_contacts',
    title: 'List contacts',
    description: "The user's contacts in FreeFlow Contacts: their own (source own), the organization's members with their addresses (member), contacts other members shared with the organization (shared, with shared_by), and people the user wrote to by email (mail). At most 500.",
    shape: {},
    scopes: ['contacts:read'],
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(ctx) {
      const { contacts } = await call<{ contacts: ContactDTO[] }>(ctx, 'GET', '');
      return { contacts: contacts.map(out), total: contacts.length };
    },
  },
  {
    name: 'find_contact',
    title: 'Find a contact',
    description: "Finds people in the user's contacts (their own, the organization's members, shared lists and people they emailed) whose name, address, organization or phone contains q. Use it to find someone's email address.",
    shape: { q: z.string().trim().min(1).max(200).describe('A name, an address or part of one, an organization or a phone number.') },
    scopes: ['contacts:read'],
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(ctx, input) {
      const { contacts } = await call<{ contacts: ContactDTO[] }>(ctx, 'GET', `/search?q=${encodeURIComponent(String(input.q))}`);
      return { contacts: contacts.slice(0, 50).map(out), total: contacts.length };
    },
  },
  {
    name: 'add_contact',
    title: 'Add a contact',
    description: "Adds a contact to the user's own contacts in FreeFlow Contacts: a name, and any of email addresses, a phone number, an organization and notes. Only when the user asks.",
    shape: {
      name: z.string().trim().min(1).max(200).describe('Their name.'),
      emails: z.array(z.string().email().max(320)).max(20).optional().describe('Their email addresses.'),
      phone: z.string().max(60).optional().describe('A phone number.'),
      organization: z.string().max(200).optional().describe('Where they work.'),
      notes: z.string().max(4000).optional().describe('Notes about them.'),
    },
    scopes: ['contacts:write'],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async run(ctx, input) {
      const { contact } = await call<{ contact: ContactDTO }>(ctx, 'POST', '', {
        name: input.name, ...(input.emails ? { emails: input.emails } : {}), ...(input.phone ? { phone: input.phone } : {}),
        ...(input.organization ? { orgName: input.organization } : {}), ...(input.notes ? { notes: input.notes } : {}),
      });
      return { added: out(contact), url: `${ctx.origin}/contacts/?contact=${encodeURIComponent(contact.id)}` };
    },
  },
  {
    name: 'email_members',
    title: 'Email members of the organization',
    description: "Sends an email to members of the user's organization, or to the user themself (\"me\"), now: from FreeFlow's address, named \"<user> via FreeFlow\", with Reply-To the user's address. Only members can receive it: any other address is refused and nothing is sent (use find_contact to look someone up). The body is Markdown. Attach files inline (content with a filename; base64 for binary files) or by reference to a file the user can open: docs_file_id (a Docs document, sheet or presentation is exported, as format or its usual format; a stored file goes as it is) or chat_file_id (a file attached in Chat). At most 10 recipients and 10 attachments, 18 MB in all, and 50 recipients an hour. Only send what the user asked to be sent.",
    shape: {
      to: z.array(z.string().trim().min(1).max(320)).min(1).max(10).describe('Who to send it to: "me" for the user, a member\'s email address, or a member\'s contact id (member:<accountId>, from list_contacts).'),
      subject: z.string().trim().min(1).max(200).describe('The subject line.'),
      body: z.string().max(50_000).describe('The message, in Markdown.'),
      attachments: z.array(z.object({
        filename: z.string().trim().min(1).max(200).optional().describe('The file name the recipient sees. Required with content; for a referenced file it defaults to the file\'s own name.'),
        content: z.string().optional().describe('The file\'s content, inline: text as it is, or base64 with encoding "base64".'),
        encoding: z.enum(['utf8', 'base64']).optional().describe('How content is written: utf8 (the default) or base64.'),
        type: z.string().max(200).optional().describe('Its MIME type; guessed from the file name when left out.'),
        docs_file_id: z.string().trim().min(1).max(200).optional().describe('A Docs file id: a document, sheet or presentation is exported; a stored file (PDF, picture, upload) is sent as it is.'),
        format: z.enum(['pdf', 'docx', 'xlsx', 'csv', 'pptx', 'md']).optional().describe('For a Docs document, sheet or presentation: the format to export it as. Defaults to docx, xlsx or pptx.'),
        chat_file_id: z.string().trim().min(1).max(200).optional().describe('The id of a file attached to a Chat message.'),
      })).max(10).optional().describe('Files to attach: each one gives exactly one of content, docs_file_id or chat_file_id.'),
    },
    scopes: ['contacts:email'],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async run(ctx, input) {
      return call<Record<string, unknown>>(ctx, 'POST', '/email', input);
    },
  },
];

// The registry: each tool at /mcp and in the assistant, on the caller's own Contacts object.
for (const t of CONTACTS_TOOLS) {
  register<{ apps?: Record<string, AppToolContext> }>('contacts', t.name, {
    run: async (ctx, input) => {
      const contacts = ctx.apps?.contacts;
      if (!contacts) throw new ContactsToolError('Contacts is not available here.');
      return t.run(contacts, input);
    },
    shape: t.shape,
    title: t.title,
    description: t.description,
    scopes: t.scopes,
    annotations: t.annotations,
    refusal: (e) => e instanceof ContactsToolError,
    failure: () => 'Contacts could not do that just now. Try again in a moment.',
    needs: 'contacts',
  });
}
