// The mail API on the edge Worker (packages/edge, /v1/mail/*), typed as its contract states it. Same origin, with the
// suite's session cookie; a 401 means the session ended, and the suite's sign-in page brings the user back here.

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
}
export interface Attachment {
  index: number;
  filename: string;
  mimeType: string;
  size: number;
  contentId: string | null;
  inline: boolean;
}
export interface MessageDetail extends MessageSummary {
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
let onSignedOut = () => window.location.assign(`/?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
export const setSignedOutHandler = (fn: () => void) => {
  onSignedOut = fn;
};

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
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
  return `${base(accountId)}/messages/${uid}/attachments/${index}${query({ folder, inline: inline ? 1 : undefined })}`;
}

export const mailApi = {
  provider: (email: string) => request<ProviderPreset | null>('GET', `/v1/mail/providers${query({ email })}`),
  accounts: async () => (await request<{ accounts: MailAccount[] }>('GET', '/v1/mail/accounts')).accounts,
  addAccount: async (account: NewAccount) => (await request<{ account: MailAccount }>('POST', '/v1/mail/accounts', account)).account,
  updateAccount: async (id: string, patch: AccountPatch) => (await request<{ account: MailAccount }>('PATCH', base(id), patch)).account,
  deleteAccount: (id: string) => request<{ ok: true }>('DELETE', base(id)),
  folders: async (accountId: string) => (await request<{ folders: MailFolder[] }>('GET', `${base(accountId)}/folders`)).folders,
  messages: (accountId: string, params: { folder: string; limit?: number; before?: number; q?: string; category?: Category }) =>
    request<MessagePage>('GET', `${base(accountId)}/messages${query(params)}`),
  message: async (accountId: string, folder: string, uid: number) =>
    (await request<{ message: MessageDetail }>('GET', `${base(accountId)}/messages/${uid}${query({ folder })}`)).message,
  setFlags: (accountId: string, body: { folder: string; uids: number[]; seen?: boolean; flagged?: boolean }) => request<{ ok: true }>('PATCH', `${base(accountId)}/messages`, body),
  move: (accountId: string, body: { folder: string; uids: number[]; to: string }) => request<{ ok: true }>('POST', `${base(accountId)}/messages/move`, body),
  remove: (accountId: string, body: { folder: string; uids: number[] }) => request<{ ok: true }>('POST', `${base(accountId)}/messages/delete`, body),
  /** "Move to tab": the messages' senders go there from now on; `previous` is what to restore to undo it. */
  moveToTab: (accountId: string, body: { folder: string; uids: number[]; category: Category }) =>
    request<{ ok: true; senders: string[]; previous: { address: string; category: Category | null }[] }>('POST', `${base(accountId)}/messages/category`, body),
  setSenderTabs: (accountId: string, senders: { address: string; category: Category | null }[]) => request<{ ok: true }>('POST', `${base(accountId)}/senders/category`, { senders }),
  send: (accountId: string, message: OutgoingMessage) => request<{ ok: true; messageId: string }>('POST', `${base(accountId)}/send`, message),
};
