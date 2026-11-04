// Writing a message: a dialog on wide screens, the whole screen on narrow ones. To, Cc and Bcc as chips, the subject,
// the rich-text body (Editor.tsx), files picked or dropped (sent as base64, 20 MB in all). Reply, Reply all and
// Forward arrive prefilled (lib/compose.ts), as does a saved draft opened to edit (sending it removes it from Drafts);
// closing a draft with something in it asks first.
import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Loader2, Paperclip, Send, Trash2, X } from 'lucide-react';
import { attachmentUrl, mailApi, MAX_SEND_BYTES, type Address, type MailAccount, type OutgoingAttachment } from '../api';
import { parseAddressList } from '../lib/addresses';
import { isDraftEmpty, type ComposeDraft, type ComposeMode } from '../lib/compose';
import { fileSize } from '../lib/format';
import { cn } from '../lib/utils';
import { EditorArea, EditorToolbar, useMailEditor } from './Editor';
import { AddressField } from './AddressField';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';

export interface ComposeRequest {
  mode: ComposeMode;
  draft: ComposeDraft;
  /** The message replied to or forwarded (its folder and uid), for fetching a forward's attachments; for `draft`, the draft. */
  source?: { folder: string; uid: number };
}

interface FileItem {
  id: number;
  name: string;
  type: string;
  size: number;
  file: Blob | null;
  status: 'loading' | 'ready' | 'error';
  forwarded: boolean;
}

const TITLES: Record<ComposeMode, string> = { new: 'New message', reply: 'Reply', replyAll: 'Reply all', forward: 'Forward', draft: 'Draft' };

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error ?? new Error('Could not read the file'));
    r.readAsDataURL(blob);
  });
}

let nextFileId = 1;

export function Compose({ account, request, narrow, onClose, onSent }: { account: MailAccount; request: ComposeRequest; narrow: boolean; onClose(): void; onSent(): void }) {
  const { draft, mode } = request;
  const [to, setTo] = useState<Address[]>(draft.to);
  const [cc, setCc] = useState<Address[]>(draft.cc);
  const [bcc, setBcc] = useState<Address[]>(draft.bcc);
  const [showCc, setShowCc] = useState(draft.cc.length > 0 || draft.bcc.length > 0);
  const [subject, setSubject] = useState(draft.subject);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [dragging, setDragging] = useState(false);
  const pending = useRef({ to: '', cc: '', bcc: '' });
  const fileInput = useRef<HTMLInputElement>(null);
  const editor = useMailEditor(draft.html);
  const baseline = useRef<string | null>(null);
  useEffect(() => {
    // StrictMode and TipTap may hand over an editor that is already destroyed; the next one sets it.
    if (editor && !editor.isDestroyed && baseline.current === null) baseline.current = editor.getHTML();
  }, [editor]);

  // A forward carries the original's attachments: fetched here, sent again as the user's own.
  useEffect(() => {
    if (!draft.forwardAttachments?.length || !request.source) return;
    const src = request.source;
    const items = draft.forwardAttachments.map((a) => ({ id: nextFileId++, name: a.filename, type: a.mimeType, size: a.size, file: null, status: 'loading' as const, forwarded: true }));
    setFiles((f) => [...f, ...items]);
    for (const [i, a] of draft.forwardAttachments.entries()) {
      const item = items[i]!;
      fetch(attachmentUrl(account.id, src.folder, src.uid, a.index), { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
        .then(
          (blob) => setFiles((f) => f.map((x) => (x.id === item.id ? { ...x, file: blob, size: blob.size, status: 'ready' } : x))),
          () => setFiles((f) => f.map((x) => (x.id === item.id ? { ...x, status: 'error' } : x))),
        );
    }
  }, [draft, request.source, account.id]);

  const total = files.reduce((n, f) => n + f.size, 0);
  const addFiles = (list: FileList | File[]) => {
    const added = Array.from(list).map((file) => ({ id: nextFileId++, name: file.name, type: file.type || 'application/octet-stream', size: file.size, file, status: 'ready' as const, forwarded: false }));
    setFiles((f) => [...f, ...added]);
  };

  const send = useMutation({
    mutationFn: async () => {
      // What was typed but not yet a chip counts.
      const finish = (list: Address[], text: string, label: string) => {
        if (!text.trim()) return list;
        const { addresses, invalid } = parseAddressList(text);
        if (invalid.length) throw new Error(`${label}: “${invalid.join(', ')}” is not an email address.`);
        return [...list, ...addresses];
      };
      const toAll = finish(to, pending.current.to, 'To');
      const ccAll = finish(cc, pending.current.cc, 'Cc');
      const bccAll = finish(bcc, pending.current.bcc, 'Bcc');
      if (toAll.length + ccAll.length + bccAll.length === 0) throw new Error('Add at least one recipient.');
      if (files.some((f) => f.status === 'loading')) throw new Error('Wait for the attachments to finish loading.');
      if (files.some((f) => f.status === 'error')) throw new Error('An attachment could not be loaded. Remove it to send.');
      const html = editor?.getHTML() ?? '';
      if (total + html.length > MAX_SEND_BYTES) throw new Error(`Messages can be at most 20 MB with their attachments (this one is ${fileSize(total + html.length)}).`);
      const attachments: OutgoingAttachment[] = await Promise.all(files.map(async (f) => ({ filename: f.name, contentType: f.type, contentBase64: await toBase64(f.file!) })));
      return mailApi.send(account.id, {
        to: toAll,
        ...(ccAll.length ? { cc: ccAll } : {}),
        ...(bccAll.length ? { bcc: bccAll } : {}),
        subject,
        html,
        text: editor?.getText({ blockSeparator: '\n\n' }) ?? '',
        ...(draft.inReplyTo ? { inReplyTo: draft.inReplyTo } : {}),
        ...(draft.references?.length ? { references: draft.references } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(mode === 'draft' && request.source ? { replacesDraft: request.source } : {}),
      });
    },
    onSuccess: () => onSent(),
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const empty = () =>
    isDraftEmpty(
      {
        to,
        cc,
        bcc,
        subject,
        text: (editor?.getText() ?? '') + pending.current.to + pending.current.cc + pending.current.bcc,
        bodyChanged: baseline.current !== null && !!editor && !editor.isDestroyed && editor.getHTML() !== baseline.current,
        attachments: files.filter((f) => !f.forwarded).length,
      },
      mode === 'new' ? null : draft,
    );
  const requestClose = () => (empty() ? onClose() : setConfirming(true));

  return (
    <Dialog open onOpenChange={(open) => !open && requestClose()}>
      <DialogContent
        hideClose
        aria-describedby={undefined}
        onInteractOutside={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            send.mutate();
          }
        }}
        className={cn(
          'gap-0 overflow-hidden p-0',
          narrow ? 'left-0 top-0 h-dvh max-h-none w-screen max-w-none translate-x-0 translate-y-0 rounded-none border-0' : 'h-[min(720px,calc(100dvh-48px))] max-w-3xl',
        )}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragging(false);
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-hairline bg-panel px-4">
          <DialogTitle className="flex-1 text-[15px] font-semibold">{TITLES[mode]}</DialogTitle>
          <button type="button" onClick={requestClose} className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-ink" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4">
          <div className="flex min-h-[40px] items-center gap-2 border-b border-hairline px-1 text-[13px]">
            <span className="w-10 shrink-0 text-muted">From</span>
            <span className="truncate text-ink">
              {account.displayName ? `${account.displayName} <${account.email}>` : account.email}
            </span>
          </div>
          <AddressField
            label="To"
            value={to}
            onChange={setTo}
            autoFocus={to.length === 0}
            onPendingChange={(t) => (pending.current.to = t)}
            trailing={
              !showCc && (
                <button type="button" className="shrink-0 rounded px-1.5 py-0.5 text-[13px] text-muted hover:bg-hover hover:text-ink" onClick={() => setShowCc(true)}>
                  Cc Bcc
                </button>
              )
            }
          />
          {showCc && (
            <>
              <AddressField label="Cc" value={cc} onChange={setCc} onPendingChange={(t) => (pending.current.cc = t)} />
              <AddressField label="Bcc" value={bcc} onChange={setBcc} onPendingChange={(t) => (pending.current.bcc = t)} />
            </>
          )}
          <div className="flex min-h-[40px] items-center border-b border-hairline px-1">
            <input aria-label="Subject" placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted" />
          </div>
          <div className="min-h-0 flex-1 py-2">
            <EditorArea editor={editor} />
          </div>
          {files.length > 0 && (
            <div className="flex flex-wrap gap-2 pb-3">
              {files.map((f) => (
                <span key={f.id} className={cn('inline-flex max-w-[260px] items-center gap-2 rounded-lg border border-border bg-panel px-2.5 py-1.5 text-[13px]', f.status === 'error' && 'border-danger/40 text-danger')}>
                  {f.status === 'loading' ? <Loader2 className="size-3.5 animate-spin text-muted" /> : <Paperclip className="size-3.5 text-muted" />}
                  <span className="min-w-0 truncate">{f.name}</span>
                  <span className="shrink-0 text-xs text-muted">{f.status === 'error' ? 'failed' : fileSize(f.size)}</span>
                  <button type="button" className="rounded p-0.5 text-muted hover:bg-row-selected hover:text-ink" aria-label={`Remove ${f.name}`} onClick={() => setFiles((all) => all.filter((x) => x.id !== f.id))}>
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
        {dragging && <div className="pointer-events-none absolute inset-0 z-10 m-2 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-selected-blue/80 text-sm font-medium text-primary">Drop files to attach</div>}
        {error && (
          <div role="alert" className="mx-4 mb-2 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-[13px] text-danger">
            {error}
          </div>
        )}
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-hairline px-3 py-2">
          <Button
            onClick={() => {
              setError(null);
              send.mutate();
            }}
            disabled={send.isPending}
            className="rounded-full px-5"
            title="Send (⌘Enter)"
          >
            {send.isPending ? <Loader2 className="animate-spin" /> : <Send />}
            Send
          </Button>
          <EditorToolbar editor={editor} />
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => (e.target.files && addFiles(e.target.files), (e.target.value = ''))} />
          <Button variant="ghost" size="icon-sm" title="Attach files" aria-label="Attach files" onClick={() => fileInput.current?.click()}>
            <Paperclip />
          </Button>
          <span className={cn('text-xs text-muted', total > MAX_SEND_BYTES && 'text-danger')}>{total > 0 && `${fileSize(total)} of 20 MB`}</span>
          <Button variant="ghost" size="icon-sm" className="ml-auto" title="Discard" aria-label="Discard draft" onClick={requestClose}>
            <Trash2 />
          </Button>
        </div>
      </DialogContent>
      {confirming && (
        <Dialog open onOpenChange={(o) => !o && setConfirming(false)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Discard this draft?</DialogTitle>
              <DialogDescription>{mode === 'draft' ? 'Your changes will be lost. The saved draft stays in Drafts.' : 'What you have written will be lost. Drafts are not saved yet.'}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirming(false)}>
                Keep writing
              </Button>
              <Button variant="destructive" onClick={onClose}>
                Discard
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </Dialog>
  );
}
