// /mail/compose: Mail's composer alone, for another app to show beside itself (Calendar's event: an email to a guest).
// It is filled from `?mailto=` (RFC 6068, @flow/shared createAddress('mail')) and `?docs=` (Docs files to add: Docs'
// File > Send as email), sends from the account Mail last showed
// (else the organization's mailbox, else the first), and tells the page around it when it is done, sent or not, with
// `{ type: 'flow:compose:done', sent }`. While it sends the form stays, hidden, so a failure gives it back as it was.
import { useRef, useState } from 'react';
import { X } from 'lucide-react';
import { mailDocsOf } from '@flow/suite-bar';
import { mailApi, setMailWorkspace } from './api';
import { ComposeForm, type ComposerHandle } from './components/ComposeForm';
import { useAccounts } from './hooks/mail';
import { useOrganizations } from './hooks/organization';
import { draftFromMailto, emptyDraft, type ComposeRequest } from './lib/compose';
import type { Notice } from './lib/notice';
import { sendInBackground } from './lib/outgoing';

const ACCOUNT_KEY = 'flow.mail.account';

function storedAccount(): string | null {
  try {
    return localStorage.getItem(ACCOUNT_KEY);
  } catch {
    return null;
  }
}

/** Tells the page around this one that the composer is done (it closes its drawer). Alone in a tab, back to Mail. */
function done(sent: boolean): void {
  if (window.parent !== window) window.parent.postMessage({ type: 'flow:compose:done', sent }, window.location.origin);
  else window.location.assign('/mail/');
}

export function ComposePage() {
  const org = useOrganizations().activeId;
  setMailWorkspace(org);
  const accounts = useAccounts();
  const [request] = useState<ComposeRequest>(() => {
    const q = new URLSearchParams(window.location.search);
    const docs = mailDocsOf(q.get('docs'));
    return { mode: 'new', draft: draftFromMailto(q.get('mailto') ?? '') ?? emptyDraft(), ...(docs.length ? { docs } : {}) };
  });
  const form = useRef<ComposerHandle | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [sending, setSending] = useState(false);
  const list = accounts.data ?? [];
  const stored = storedAccount();
  const account = list.find((a) => a.id === stored) ?? list.find((a) => a.kind === 'hosted') ?? list[0];

  if (accounts.isLoading) return <div className="p-4 text-sm text-muted">Loading…</div>;
  if (!account)
    return (
      <div className="flex flex-col gap-3 p-4 text-sm" data-testid="compose-page-no-account">
        <p>Connect a mail account in Mail to send email.</p>
        <a className="text-primary hover:underline" href="/mail/" target="_top">Open Mail</a>
      </div>
    );

  const text = typeof notice === 'string' ? notice : notice?.text ?? null;
  return (
    <div className="flex h-dvh flex-col bg-white text-ink" data-testid="compose-page">
      {sending && text && <div role="status" className="p-4 text-sm text-muted">{text}</div>}
      <div className={sending ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>
        {!sending && text && (
          <div role="alert" className="border-b border-hairline bg-warn-bg px-4 py-2 text-[13px]">{text}</div>
        )}
        <ComposeForm
          account={account}
          request={request}
          variant="dialog"
          handle={form}
          onClose={() => done(false)}
          onSend={(out) => {
            setSending(true);
            void sendInBackground(out, {
              send: mailApi.send,
              notice: setNotice,
              onSent: () => done(true),
              // A failure shows the form again, as it was, with the reason above it.
              reopen: () => {},
              onFailed: () => setSending(false),
            });
          }}
          header={(title, onClick) => (
            <div className="flex h-12 shrink-0 items-center gap-2 border-b border-hairline bg-panel px-4">
              <h1 className="min-w-0 flex-1 truncate text-[16px] font-semibold">{title}</h1>
              <span className="truncate text-[12px] text-muted" title="Sent from">{account.email}</span>
              <button type="button" onClick={onClick} className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-ink" aria-label="Close">
                <X className="size-4" />
              </button>
            </div>
          )}
        />
      </div>
    </div>
  );
}
