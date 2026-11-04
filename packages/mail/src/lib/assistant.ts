// The assistant in Mail, its pure parts: what each turn says the user is looking at (the `mail` context), the ids the
// mail tools use, the browser tools Mail runs (open_mail_message; Docs' own are refused), and what the chat links to
// (a draft the assistant made, a file it saved to Docs). The panel is components/AssistantPanel.tsx, the turns
// hooks/assistant.ts.
import type { MessageDetail, MessageSummary } from '../api';
import { formatAddress } from './addresses';
import { MAX_MAIL_SELECTED, type ChatItem, type ClientToolCall, type ClientToolResult, type MailContext } from './docsAgent';
import { browserPref } from './prefs';

/** Whether the panel is open, remembered in this browser. */
const pref = browserPref<'closed' | 'open'>('mail.assistant', ['closed', 'open']);
export const useAssistantOpen = () => pref.use() === 'open';
export const setAssistantOpen = (open: boolean) => pref.set(open ? 'open' : 'closed');

/** A message where the mail tools find it: `<accountId>:<folder>:<uid>` (the account id has no colon, the UID is last). */
export interface MessageRef {
  account: string;
  folder: string;
  uid: number;
}

export const messageId = (r: MessageRef) => `${r.account}:${r.folder}:${r.uid}`;

/** The parts of a message id, or null for anything else. */
export function parseMessageId(id: unknown): MessageRef | null {
  if (typeof id !== 'string') return null;
  const first = id.indexOf(':');
  const last = id.lastIndexOf(':');
  if (first <= 0 || last <= first + 1) return null;
  const uid = Number(id.slice(last + 1));
  if (!Number.isInteger(uid) || uid <= 0) return null;
  return { account: id.slice(0, first), folder: id.slice(first + 1, last), uid };
}

/** A link to a message in Mail (`/mail/?account=&folder=&uid=`, the mail tools' links), as a message, or null. */
export function refOfLink(href: string, origin: string = window.location.origin): MessageRef | null {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || !/^\/mail\/?$/.test(url.pathname)) return null;
  const account = url.searchParams.get('account');
  const folder = url.searchParams.get('folder');
  const uid = Number(url.searchParams.get('uid'));
  return account && folder && Number.isInteger(uid) && uid > 0 ? { account, folder, uid } : null;
}

export interface MailView {
  account: { id: string; email: string };
  folder: string;
  /** The inbox tab shown, when the account has tabs and INBOX is open. */
  tab: string | null;
  search: string;
  /** The open message, once it has loaded. */
  message: Pick<MessageDetail | MessageSummary, 'uid' | 'folder' | 'subject' | 'from' | 'date'> | null;
  /** UIDs checked in the list (in `folder`). */
  checked: Iterable<number>;
}

/** What a turn sent from Mail says the user is looking at (rendered for the model by the server's renderMailContext). */
export function mailContext(v: MailView): MailContext {
  const selected = [...v.checked].slice(0, MAX_MAIL_SELECTED).map((uid) => messageId({ account: v.account.id, folder: v.folder, uid }));
  const m = v.message;
  return {
    page: 'mail',
    accountId: v.account.id,
    account: v.account.email,
    folder: v.folder,
    ...(v.tab ? { tab: v.tab } : {}),
    ...(v.search ? { search: v.search } : {}),
    ...(m
      ? {
          message: {
            id: messageId({ account: v.account.id, folder: m.folder, uid: m.uid }),
            accountId: v.account.id,
            folder: m.folder,
            uid: m.uid,
            subject: m.subject,
            from: m.from ? formatAddress(m.from) : '',
            date: m.date,
          },
        }
      : {}),
    ...(selected.length ? { selected } : {}),
  };
}

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

function resultOf(item: ToolItem): Record<string, unknown> | null {
  if (item.status !== 'ok' || !item.result) return null;
  try {
    const r = JSON.parse(item.result) as unknown;
    return r && typeof r === 'object' ? (r as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The draft a create_mail_draft call made, to open it in Compose. */
export function draftOf(item: ToolItem): MessageRef | null {
  if (item.name !== 'create_mail_draft') return null;
  return parseMessageId(resultOf(item)?.draft_id);
}

const DOCS_PAGES: Record<string, string> = { sheet: 's', deck: 'd', doc: 'doc', markdown: 'md', file: 'f' };

/** The Docs page of the file a save_mail_attachment_to_docs call made, and its name. */
export function savedFileOf(item: ToolItem): { href: string; name: string } | null {
  if (item.name !== 'save_mail_attachment_to_docs') return null;
  const r = resultOf(item);
  const file = r?.file as { id?: unknown; kind?: unknown; title?: unknown; filename?: unknown } | undefined;
  const page = typeof file?.kind === 'string' ? DOCS_PAGES[file.kind] : undefined;
  if (!file || typeof file.id !== 'string' || !page) return null;
  const name = typeof file.title === 'string' ? file.title : typeof file.filename === 'string' ? file.filename : typeof r?.filename === 'string' ? r.filename : 'the file';
  return { href: `/workspace/${page}/${encodeURIComponent(file.id)}`, name };
}

/** Mail tools after which the lists may have changed (a new draft in Drafts). */
export const CHANGES_MAIL = new Set(['create_mail_draft']);

/**
 * Runs the browser tools the assistant asked for, in Mail: open_mail_message shows the message; the tools of a file open
 * in Docs cannot run here, and say so (the model then uses its other tools).
 */
export async function runMailClientCalls(calls: ClientToolCall[], show: (ref: MessageRef) => boolean | Promise<boolean>): Promise<ClientToolResult[]> {
  const results: ClientToolResult[] = [];
  for (const call of calls) {
    if (call.name === 'open_mail_message') {
      const ref = parseMessageId(call.input.id);
      if (!ref) results.push({ id: call.id, content: `"${String(call.input.id)}" is not a message id. Use an id from search_mail or the <app_context>.`, isError: true });
      else if (!(await show(ref))) results.push({ id: call.id, content: 'That message is in a mail account the user does not have here.', isError: true });
      else results.push({ id: call.id, content: JSON.stringify({ opened: messageId(ref) }) });
      continue;
    }
    results.push({
      id: call.id,
      content: `${call.name} works on a file open in FreeFlow Docs, and the user is in Mail. Use the mail tools, or the tools that read and make files by id (list_docs, read_other_doc, read_other_sheet, create_doc and the like), or give the user a link to open the file in Docs.`,
      isError: true,
    });
  }
  return results;
}
