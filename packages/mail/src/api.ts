// The mail API on the edge Worker (packages/edge, /v1/mail/*), typed as its contract states it. Same origin, with the
// suite's session cookie; a 401 means the session ended, and the suite's sign-in page brings the user back here.
import { readActiveOrganization } from './suite';

export type Security = 'tls' | 'starttls' | 'none';
export interface ServerSettings {
  host: string;
  port: number;
  security: Security;
  /** Defaults to the account's email address. */
  username?: string;
}
export type AccountStatus = 'ok' | 'auth_failed' | 'connect_failed';
/** Gmail's inbox tabs. Primary is always there; the others are switched on per account. */
export type Category = 'primary' | 'promotions' | 'social' | 'updates' | 'forums';
export type TabCategory = Exclude<Category, 'primary'>;
export interface MailAccount {
  id: string;
  email: string;
  displayName: string;
  imap: ServerSettings;
  smtp: ServerSettings;
  status: AccountStatus;
  statusMessage?: string;
  /** The inbox tabs that are on besides Primary; [] means tabs off. */
  tabs: TabCategory[];
}
export type SpecialUse = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'all' | 'flagged';
export interface MailFolder {
  path: string;
  name: string;
  delimiter: string;
  specialUse: SpecialUse | null;
  unread: number;
  total: number;
}
export interface Address {
  name: string;
  address: string;
}
/** Someone written to (`sent` times) or heard from (`received`), as the composer completes addresses (from the account's cached mail). */
export interface Contact { name: string; address: string; sent: number; received: number; lastAt: number }
/** An inbox tab as the tab bar badges it: how many cached messages are in it, unread, arrived after the newest the person saw there (`after`), and the newest. */
export interface TabStatus { category: Category; total: number; unread: number; new: number; newest: MessageSummary | null }
export interface MessageSummary {
  uid: number;
  folder: string;
  messageId: string | null;
  from: Address | null;
  to: Address[];
  cc: Address[];
  subject: string;
  /** The first ~160 characters of the text; may be ''. */
  snippet: string;
  /** ISO 8601. */
  date: string;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  hasAttachments: boolean;
  size: number;
  /** INBOX only, when the account has tabs on. */
  category?: Category;
  /**
   * Why it is in that tab, when the server knows: "Gmail category:updates", "Gmail: no category", "sender moved to primary",
   * or the header rule's reason ("newsletter (List-Id, List-Unsubscribe)"). Put into words by `reasonText` (lib/tabs.ts).
   */
  categoryReason?: string;
  /**
   * The files the row shows as chips (no bytes: names, types and sizes from the message's structure), with the `index` the
   * opened message and `attachmentUrl` use; the pictures the body shows are left out. Absent when there are none, or when
   * the server cannot tell without reading the message whole (`hasAttachments` still says).
   */
  attachments?: AttachmentSummary[];
  /** The conversation it belongs to, when the server knows (a cached message): `GET …/threads/:threadId`. */
  threadId?: string;
}
/** One conversation as a list shows it: its newest message in the folder stands for it, and names the row (`uid`). */
export interface ThreadSummary {
  threadId: string;
  folder: string;
  /** The newest message of the thread in this folder: the row's identity, and the `before` of the page after it. */
  uid: number;
  /** The thread's messages in this folder, newest first: what archive, delete, flag and move act on. */
  uids: number[];
  /** The newest message in this folder: its subject, snippet, date and attachments are the row's. */
  latest: MessageSummary;
  /** Messages in the thread, in every folder of the account. */
  count: number;
  unread: number;
  flagged: boolean;
  /** Who wrote in it, oldest first. */
  participants: Address[];
  /** ISO 8601: the newest activity, in any folder. */
  date: string;
  folders: string[];
  category?: Category;
  categoryReason?: string;
}
export interface ThreadPage {
  threads: ThreadSummary[];
  next: number | null;
  /** As a message page's: a tab's page came back short while the server sorts older mail; ask again shortly. */
  sorting?: true;
}
/**
 * A message of an open conversation: its body is `null` with `bodyPending` while the server has not fetched it yet (ask
 * again shortly, or read the message itself: hooks/mail.ts `fetchBody`). `bodyFailed` is the client's: that read failed.
 */
export type ThreadMessage = MessageDetail & { bodyPending?: true; bodyFailed?: true };
export interface ThreadDetail {
  threadId: string;
  /** Oldest first, across the account's folders. */
  messages: ThreadMessage[];
}
/** An attachment as a list row knows it. */
export interface AttachmentSummary {
  index: number;
  filename: string;
  mimeType: string;
  size: number;
}
export interface Attachment {
  index: number;
  filename: string;
  mimeType: string;
  size: number;
  contentId: string | null;
  inline: boolean;
}
export interface MessageDetail extends Omit<MessageSummary, 'attachments'> {
  replyTo: Address[];
  bcc: Address[];
  inReplyTo: string | null;
  references: string[];
  /** The message's own HTML, untrusted: render it only through sanitize.ts. */
  html: string | null;
  text: string | null;
  attachments: Attachment[];
}
export interface ProviderPreset {
  imap: ServerSettings;
  smtp: ServerSettings;
  name: string;
  appPasswordUrl?: string;
}
export interface NewAccount {
  email: string;
  displayName: string;
  password: string;
  imap: ServerSettings;
  smtp: ServerSettings;
}
export type AccountPatch = Partial<Pick<NewAccount, 'displayName' | 'password' | 'imap' | 'smtp'> & { tabs: TabCategory[] }>;
export interface OutgoingAttachment {
  filename: string;
  contentType: string;
  contentBase64: string;
  /** An inline picture the HTML shows as `cid:<contentId>` (bare): sent as a related part, not a file. */
  contentId?: string;
  inline?: boolean;
}
export interface OutgoingMessage {
  to: Address[];
  cc?: Address[];
  bcc?: Address[];
  subject: string;
  html: string;
  text?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: OutgoingAttachment[];
  /** A saved draft this message is: the server deletes it from Drafts once the message is sent. */
  replacesDraft?: { folder: string; uid: number };
}
export interface MessagePage {
  messages: MessageSummary[];
  /** The `before` for the next (older) page; null at the end. */
  next: number | null;
  /** An inbox tab's page that came back short while the server sorts older mail into tabs: ask for it again shortly. */
  sorting?: true;
}

export type ErrorCode = 'auth_failed' | 'connect_failed' | 'not_found' | 'bad_request' | 'rate_limited' | 'server_error' | 'unauthorized' | (string & {});

export class MailApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  constructor(code: ErrorCode, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** The total size the send route accepts (attachments are counted as their decoded bytes). */
export const MAX_SEND_BYTES = 20 * 1024 * 1024;

/** Called on a 401: the session is gone (the default sends the browser to the suite's sign-in, then back). */
let onSignedOut = () => {
  if (new URLSearchParams(window.location.search).has('next')) return; // already standing in for the sign-in page (the dev server): no loop
  window.location.assign(`/?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
};
export const setSignedOutHandler = (fn: () => void) => {
  onSignedOut = fn;
};

/** The organization every /v1/mail request names (`?workspace=`): its Mail is that account's (platform.md §3.6). Set
 * from the suite bar's selection (App.tsx); until then, the one Chat selected. */
let workspace: string | null = null;
export const setMailWorkspace = (id: string | null) => {
  workspace = id;
};
/** A /v1/mail (or /v1/calendar: invitations) path, naming the organization. */
export function inWorkspace(path: string): string {
  const id = workspace ?? readActiveOrganization();
  return id && /^\/v1\/(mail|calendar)\//.test(path) ? `${path}${path.includes('?') ? '&' : '?'}workspace=${encodeURIComponent(id)}` : path;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(inWorkspace(path), {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    onSignedOut();
    throw new MailApiError('unauthorized', 'Your session has ended. Sign in again.', 401);
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    throw new MailApiError(err?.error?.code ?? 'server_error', err?.error?.message ?? `${res.status} ${res.statusText}`, res.status);
  }
  return (await res.json()) as T;
}

const enc = encodeURIComponent;
const base = (accountId: string) => `/v1/mail/accounts/${enc(accountId)}`;
const query = (params: Record<string, string | number | undefined | null>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
};

/** Where an attachment's bytes are (`inline` for showing it in the page, as cid: images do, rather than downloading). */
export function attachmentUrl(accountId: string, folder: string, uid: number, index: number, inline = false): string {
  return inWorkspace(`${base(accountId)}/messages/${uid}/attachments/${index}${query({ folder, inline: inline ? 1 : undefined })}`);
}

export const mailApi = {
  provider: (email: string) => request<ProviderPreset | null>('GET', `/v1/mail/providers${query({ email })}`),
  accounts: async () => (await request<{ accounts: MailAccount[] }>('GET', '/v1/mail/accounts')).accounts,
  addAccount: async (account: NewAccount) => (await request<{ account: MailAccount }>('POST', '/v1/mail/accounts', account)).account,
  updateAccount: async (id: string, patch: AccountPatch) => (await request<{ account: MailAccount }>('PATCH', base(id), patch)).account,
  deleteAccount: (id: string) => request<{ ok: true }>('DELETE', base(id)),
  folders: async (accountId: string) => (await request<{ folders: MailFolder[] }>('GET', `${base(accountId)}/folders`)).folders,
  tabStatus: async (accountId: string, after: Partial<Record<Category, number>>) =>
    (await request<{ tabs: TabStatus[] }>('GET', `${base(accountId)}/tabs${query({ folder: 'INBOX', after: Object.entries(after).map(([t, u]) => `${t}:${u}`).join(',') || undefined })}`)).tabs,
  contacts: async (accountId: string, q: string, limit = 8) => (await request<{ contacts: Contact[] }>('GET', `${base(accountId)}/contacts?q=${encodeURIComponent(q)}&limit=${limit}`)).contacts,
  messages: (accountId: string, params: { folder: string; limit?: number; before?: number; q?: string; category?: Category }) =>
    request<MessagePage>('GET', `${base(accountId)}/messages${query(params)}`),
  message: async (accountId: string, folder: string, uid: number) =>
    (await request<{ message: MessageDetail }>('GET', `${base(accountId)}/messages/${uid}${query({ folder })}`)).message,
  /** A folder's conversations (or one inbox tab's), newest first; `before` is the last row's `uid`. */
  threads: (accountId: string, params: { folder: string; limit?: number; before?: number; category?: Category }) =>
    request<ThreadPage>('GET', `${base(accountId)}/threads${query(params)}`),
  /** One conversation, every message of it in the account; `folder` is where it was opened from. */
  thread: async (accountId: string, threadId: string, folder: string) =>
    (await request<{ thread: ThreadDetail }>('GET', `${base(accountId)}/threads/${enc(threadId)}${query({ folder })}`)).thread,
  setFlags: (accountId: string, body: { folder: string; uids: number[]; seen?: boolean; flagged?: boolean }) => request<{ ok: true }>('PATCH', `${base(accountId)}/messages`, body),
  move: (accountId: string, body: { folder: string; uids: number[]; to: string }) => request<{ ok: true }>('POST', `${base(accountId)}/messages/move`, body),
  remove: (accountId: string, body: { folder: string; uids: number[] }) => request<{ ok: true }>('POST', `${base(accountId)}/messages/delete`, body),
  /** "Move to tab": the messages' senders go there from now on; `previous` is what to restore to undo it. */
  moveToTab: (accountId: string, body: { folder: string; uids: number[]; category: Category }) =>
    request<{ ok: true; senders: string[]; previous: { address: string; category: Category | null }[] }>('POST', `${base(accountId)}/messages/category`, body),
  setSenderTabs: (accountId: string, senders: { address: string; category: Category | null }[]) => request<{ ok: true }>('POST', `${base(accountId)}/senders/category`, { senders }),
  send: (accountId: string, message: OutgoingMessage) => request<{ ok: true; messageId: string }>('POST', `${base(accountId)}/send`, message),
};

// ---- Invitations, through Calendar (packages/edge src/calendar/invites.ts; docs/specs/calendar.md §14) -------------------

export type InviteResponse = 'accepted' | 'declined' | 'tentative' | 'needs-action';
export interface InvitePerson { name: string | null; email: string; role: 'required' | 'optional'; response: InviteResponse; self?: true }
/** The event an invitation is about, as the card shows it (ISO instants; dates, the end exclusive, for an all-day one). */
export interface InviteEvent {
  uid: string;
  summary: string;
  location: string | null;
  description: string | null;
  start: string;
  end: string;
  allDay: boolean;
  timezone: string | null;
  status: 'confirmed' | 'tentative' | 'cancelled';
  organizer: InvitePerson | null;
  attendees: InvitePerson[];
  myResponse?: InviteResponse;
  /** The series' RRULE / RDATE / EXDATE lines. */
  recurrence: string[];
  /** One occurrence of a series (an update or a cancellation of it). */
  recurrenceId?: string;
  conference?: { url: string; label: string };
  sequence: number;
}
export interface InviteAnswer {
  action: 'request' | 'cancel' | 'reply';
  event: InviteEvent;
  /** On one of the person's calendars already (Google and iCloud put invitations there before the mail is read). */
  onCalendar: { calendarId: string; id: string; eventId: string; myResponse: InviteResponse | null; cancelled: boolean } | null;
  /** A reply to the person's own event: who answered, and what. */
  reply?: { name: string | null; email: string; response: InviteResponse };
  organizerIsMe: boolean;
  /** The calendars an invitation can go on. */
  calendars: { id: string; name: string; color: string; isDefault: boolean }[];
}
/** How the answer reached the organizer: their server's own way, an email from this account, nothing to tell, or an email that failed. */
export type Replied = { replied: 'server' | 'email' | 'none' } | { replied: 'failed'; replyError: string };
/** A message's invitation part, as the Calendar API names it. */
export interface InviteRef { account: string; folder: string; uid: number; part: number }

const inviteBody = (r: InviteRef) => ({ account: r.account, messageId: { folder: r.folder, uid: r.uid }, part: r.part });
export const inviteApi = {
  read: (r: InviteRef) => request<InviteAnswer>('POST', '/v1/calendar/invites', inviteBody(r)),
  respond: (r: InviteRef, response: Exclude<InviteResponse, 'needs-action'>, calendarId?: string) =>
    request<InviteAnswer & Replied>('POST', '/v1/calendar/invites/respond', { ...inviteBody(r), response, ...(calendarId ? { calendarId } : {}) }),
  cancel: (r: InviteRef) => request<InviteAnswer & { removed: boolean }>('POST', '/v1/calendar/invites/cancel', inviteBody(r)),
};

// ---- Attachment previews in Docs (packages/docs/server/previews.ts, through the Worker's routes/previews.ts) ----------

/** The file a preview became in Docs: its page there. */
export interface SavedToDocs {
  kind: string;
  id: string;
  title: string;
  /** The file's page in Docs (/workspace/doc/<id>, ...). */
  url: string;
}
export interface DocsPreview {
  id: string;
  kind: 'doc' | 'deck' | 'sheet' | 'markdown' | 'pdf' | 'file';
  filename: string;
  size: number;
  expiresAt: number;
  saved?: SavedToDocs;
}

/** Docs answers errors as `{ error: "message" }`; the Worker's own routes as `{ error: { code, message } }`. */
async function docsRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    onSignedOut();
    throw new MailApiError('unauthorized', 'Your session has ended. Sign in again.', 401);
  }
  const data = (await res.json().catch(() => null)) as { error?: string | { code?: string; message?: string } } | null;
  if (!res.ok) {
    const e = data?.error;
    throw new MailApiError(typeof e === 'object' ? (e.code ?? 'server_error') : 'server_error', typeof e === 'string' ? e : (e?.message ?? `${res.status} ${res.statusText}`), res.status);
  }
  return data as T;
}

/** Where a preview is drawn: Docs' read-only page for it, in the organization it was made in. */
export const previewPageUrl = (id: string, workspace: string) => `/workspace/preview/${enc(id)}?workspace=${enc(workspace)}`;

export const previewApi = {
  /** Make (or find, if made this hour) Docs' preview of an attachment; `workspace` is the organization (default: the first). */
  create: (accountId: string, folder: string, uid: number, index: number, workspace: string | null) =>
    docsRequest<{ preview: DocsPreview; workspace: string }>('POST', '/api/previews/mail', { account: accountId, folder, uid, index, ...(workspace ? { workspace } : {}) }),
  /** Save it as a file in My files in Docs (once: again gives the same file). */
  save: (id: string, workspace: string) => docsRequest<{ saved: SavedToDocs }>('POST', `/api/previews/${enc(id)}/save?workspace=${enc(workspace)}`),
};
