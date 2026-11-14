// A Docs file dropped on an email (docs/specs/side-panel.md §7.1): sent as a link to the file, or attached. A link when
// every recipient is in the sender's own mail domain and is a member of the organization, who can open it once it is
// shared with them (on send, read only); an attachment otherwise, and when there is no recipient yet. The person can
// choose either on the file's chip.
import { useEffect, useState } from 'react';
import type { DocsFileRef } from '@flow/suite-bar';
import type { DocsFile } from './docsFiles';

/** Domains anyone can have an address at: two people there are not colleagues, so they never count as one domain. */
export const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com', 'icloud.com',
  'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'mail.com', 'zoho.com',
  'yandex.com', 'fastmail.com', 'hey.com',
]);

export const domainOf = (address: string): string => address.slice(address.lastIndexOf('@') + 1).trim().toLowerCase();

/** A member of the organization, as `GET /v1/workspaces/:id/members` lists one: their sign-in email and mailbox address. */
export interface OrgMember {
  accountId?: string;
  userId: string;
  email: string;
  address?: string;
  isAgent?: boolean;
}

/** The member a mail address is: by their organization mailbox, or the email they sign in with. */
export function memberOf(address: string, members: readonly OrgMember[]): OrgMember | null {
  const a = address.trim().toLowerCase();
  return members.find((m) => !m.isAgent && (m.address?.toLowerCase() === a || (!!m.email && m.email.toLowerCase() === a))) ?? null;
}

/** Whether a dropped file goes as a link by default: every recipient in the sender's domain (not a free one) and a member. */
export function linkByDefault(from: string, recipients: readonly string[], members: readonly OrgMember[]): boolean {
  if (!recipients.length) return false;
  const domain = domainOf(from);
  if (!domain || FREE_MAIL_DOMAINS.has(domain)) return false;
  return recipients.every((r) => domainOf(r) === domain && !!memberOf(r, members));
}

/** The page a Docs file opens on (Docs' own addresses, client/src/components/WebCopyDialogs.tsx pathOfFile). */
export function docsFileUrl(f: Pick<DocsFile, 'kind' | 'id'>, origin = window.location.origin): string {
  const seg = f.kind === 'deck' ? 'd' : f.kind === 'doc' ? 'doc' : f.kind === 'markdown' ? 'md' : f.kind === 'file' ? 'f' : 's';
  return `${origin}/docs/${seg}/${encodeURIComponent(f.id)}`;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The links a message carries, as HTML (after what was written) and as text. */
export function linksBlock(files: readonly Pick<DocsFile, 'kind' | 'id' | 'name'>[], origin?: string): { html: string; text: string } {
  if (!files.length) return { html: '', text: '' };
  const rows = files.map((f) => ({ name: f.name, url: docsFileUrl(f, origin) }));
  return {
    html: rows.map((r) => `<p><a href="${escapeHtml(r.url)}">${escapeHtml(r.name)}</a></p>`).join(''),
    text: rows.map((r) => `${r.name}: ${r.url}`).join('\n'),
  };
}

const enc = encodeURIComponent;

/** The members of each organization, read once a page (they change rarely; a send reads them again when they are missing). */
const memberCache = new Map<string, Promise<OrgMember[]>>();

/** The organization's members, read once and kept while the page is open; null until then and on a failure. */
export function useOrgMembers(workspace: string | null): OrgMember[] | null {
  const [members, setMembers] = useState<OrgMember[] | null>(null);
  useEffect(() => {
    if (!workspace) return setMembers(null);
    let live = true;
    let p = memberCache.get(workspace);
    if (!p) {
      p = fetchMembers(workspace);
      memberCache.set(workspace, p);
      p.catch(() => memberCache.delete(workspace));
    }
    p.then((m) => live && setMembers(m), () => live && setMembers(null));
    return () => {
      live = false;
    };
  }, [workspace]);
  return members;
}

/** The organization's members (for the rule above, and to share with). */
export async function fetchMembers(workspace: string): Promise<OrgMember[]> {
  const res = await fetch(`/v1/workspaces/${enc(workspace)}/members`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`The organization's members could not be read (${res.status}).`);
  return ((await res.json()) as { members: OrgMember[] }).members;
}

/**
 * Lets the recipients open a linked file: read only, each member by their account. A file in Organization files is
 * open to every member already. Throws with what to tell the person when Docs refuses (they do not manage the file).
 */
export async function shareWith(f: Pick<DocsFile, 'kind' | 'id' | 'name' | 'shared'>, members: readonly OrgMember[], workspace: string): Promise<void> {
  if (f.shared) return;
  const grantKind = f.kind === 'file' ? 'file' : 'sheet';
  for (const m of members) {
    const res = await fetch(`/api/grants/${grantKind}/${enc(f.id)}?workspace=${enc(workspace)}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ principal: `account:${m.accountId ?? m.userId}`, role: 'viewer' }),
    });
    if (!res.ok) {
      const msg = ((await res.json().catch(() => null)) as { error?: string } | null)?.error;
      throw new Error(`“${f.name}” could not be shared with the recipients${msg ? `: ${msg}` : ''}. Send it as an attachment instead.`);
    }
  }
}

/** A file dragged from Docs (the side panel), as attach-from-Docs names one. */
export function docsFileOfRef(r: DocsFileRef): DocsFile {
  return { kind: r.kind, id: r.id, name: r.name, folder: r.folder, shared: r.shared, ...(r.format ? { format: r.format } : {}), ...(r.type ? { type: r.type } : {}), ...(r.size !== undefined ? { size: r.size } : {}) };
}
