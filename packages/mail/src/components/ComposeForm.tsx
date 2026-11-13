// The composer itself, shared by the dialog (Compose.tsx: New message, a draft, and every mode on narrow screens) and the
// card under a message in a conversation (InlineCompose.tsx: Reply, Reply all and Forward on wide screens). To, Cc and Bcc
// as chips (the card shows them as one line, "Ann Lee (ann@x.com)", until clicked), the subject (the dialog only), the
// rich-text body (Editor.tsx), files picked, dropped or chosen from Docs (DocsPicker.tsx). Reply, Reply all and Forward arrive prefilled (lib/compose.ts), as
// does a saved draft opened to edit (sending it removes it from Drafts). Send checks what it can at once, then hands the
// message over (`onSend`, an `Outgoing`) and the composer closes: App.tsx sends it while a toast says "Sending…", and offers
// to open it again if that fails. Closing with something written asks first.
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react';
import { ChevronDown, FileText, Forward, Loader2, Paperclip, Reply, ReplyAll, Send, Trash2, Upload, X } from 'lucide-react';
import { attachmentUrl, mailApi, MAX_SEND_BYTES, type Address, type MailAccount } from '../api';
import { parseAddressList } from '../lib/addresses';
import { isDraftEmpty, type AnswerMode, type ComposeDraft, type ComposeMode, type ComposeRequest, type Outgoing } from '../lib/compose';
import { fileSize } from '../lib/format';
import { attachedAs, docsFiles, type DocsFile } from '../lib/docsFiles';
import { DocsPicker } from './DocsPicker';
import { cn } from '../lib/utils';
import { EditorArea, EditorToolbar, useMailEditor } from './Editor';
import { QuoteToggle } from './QuoteToggle';
import { quoteText, splitQuote } from '../lib/quote';
import { AddressField } from './AddressField';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';

interface FileItem {
  id: number;
  name: string;
  type: string;
  size: number;
  file: Blob | null;
  status: 'loading' | 'ready' | 'error';
  forwarded: boolean;
}

export const TITLES: Record<ComposeMode, string> = { new: 'New message', reply: 'Reply', replyAll: 'Reply all', forward: 'Forward', draft: 'Draft' };
const MODE_ICONS: Record<AnswerMode, typeof Reply> = { reply: Reply, replyAll: ReplyAll, forward: Forward };

let nextFileId = 1;
const trimTrailing = (html: string) => html.replace(/(<p><\/p>)+$/, '');
/** A reply's quote, kept out of the editor behind "⋯" until asked for, as Gmail does; a forward shows what it forwards. */
const fold = (mode: ComposeMode, html: string) => (mode === 'forward' ? null : splitQuote(html));

/** What the shells ask of the composer: Escape and the close button ask before dropping what was written. */
export interface ComposerHandle {
  requestClose(): void;
  /** Nothing written worth asking about. */
  isEmpty(): boolean;
  /** The composer as it is now, to open again elsewhere (the inline card moved to the dialog). */
  snapshot(): ComposeRequest;
  focus(): void;
}

export interface ComposeFormProps {
  account: MailAccount;
  request: ComposeRequest;
  /** The dialog's layout (title, From, the fields, the subject) or the inline card's (the mode menu, the recipients as one line). */
  variant: 'dialog' | 'inline';
  handle?: Ref<ComposerHandle | null> | undefined;
  onClose(): void;
  /** Send was pressed and the message is fine to send: the composer is done; the caller sends it. */
  onSend(out: Outgoing): void;
  /** The dialog's title row, given the title and the close button. */
  header?: ((title: string, close: () => void) => ReactNode) | undefined;
}

/** "Ann Lee (ann@x.com)", or the bare address. */
const recipientText = (a: Address) => (a.name && a.name !== a.address ? `${a.name} (${a.address})` : a.address);

export function ComposeForm({ account, request, variant, handle, onClose, onSend, header }: ComposeFormProps) {
  const inline = variant === 'inline';
  const [mode, setMode] = useState<ComposeMode>(request.mode);
  // The message the current mode started as: what "nothing written" is measured against, and its threading headers.
  const [initial, setInitial] = useState<ComposeDraft>(request.draft);
  const [to, setTo] = useState<Address[]>(request.draft.to);
  // The account's contacts, for the address fields' completion.
  const suggest = useCallback((q: string) => mailApi.contacts(account.id, q), [account.id]);
  const [cc, setCc] = useState<Address[]>(request.draft.cc);
  const [bcc, setBcc] = useState<Address[]>(request.draft.bcc);
  const [showCc, setShowCc] = useState(request.draft.cc.length > 0 || request.draft.bcc.length > 0);
  // The inline card shows the recipients as one line until clicked; a forward (nobody yet) starts with the fields open.
  const [fieldsOpen, setFieldsOpen] = useState(!inline || request.draft.to.length + request.draft.cc.length + request.draft.bcc.length === 0);
  const [subject, setSubject] = useState(request.draft.subject);
  const [files, setFiles] = useState<FileItem[]>(() => (request.files ?? []).map((f) => ({ id: nextFileId++, ...f, status: 'ready' as const })));
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [picking, setPicking] = useState(false);
  const pending = useRef({ to: '', cc: '', bcc: '' });
  const fileInput = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  // The quote of a reply (or a draft) stays out of the editor, and goes back on the end of what is sent, until "⋯" puts it in.
  const [start] = useState(() => fold(request.mode, request.draft.html));
  const [hiddenQuote, setHiddenQuote] = useState<string | null>(start?.quote ?? null);
  // A forward's To comes first; anything else starts in the body, above the quote.
  const editor = useMailEditor(start?.head ?? request.draft.html, request.draft.to.length > 0);
  const baseline = useRef<string | null>(null);
  useEffect(() => {
    // StrictMode and TipTap may hand over an editor that is already destroyed; the next one sets it.
    if (editor && !editor.isDestroyed && baseline.current === null) baseline.current = editor.getHTML();
  }, [editor]);
  const live = editor && !editor.isDestroyed ? editor : null;

  // A forward (or a draft) carries the original's attachments: fetched here, sent again as the person's own.
  const loadForwarded = useCallback(
    (list: NonNullable<ComposeDraft['forwardAttachments']>) => {
      const src = request.source;
      if (!list.length || !src) return;
      const items = list.map((a) => ({ id: nextFileId++, name: a.filename, type: a.mimeType, size: a.size, file: null, status: 'loading' as const, forwarded: true }));
      setFiles((f) => [...f, ...items]);
      for (const [i, a] of list.entries()) {
        const item = items[i]!;
        fetch(attachmentUrl(account.id, src.folder, src.uid, a.index), { credentials: 'same-origin' })
          .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
          .then(
            (blob) => setFiles((f) => f.map((x) => (x.id === item.id ? { ...x, file: blob, size: blob.size, status: 'ready' } : x))),
            () => setFiles((f) => f.map((x) => (x.id === item.id ? { ...x, status: 'error' } : x))),
          );
      }
    },
    [request.source, account.id],
  );
  const loaded = useRef(false);
  useEffect(() => {
    // Once (StrictMode runs effects twice); a composer opened again already has its files.
    if (loaded.current || request.files) return;
    loaded.current = true;
    if (request.draft.forwardAttachments) loadForwarded(request.draft.forwardAttachments);
  }, [request, loadForwarded]);

  const total = files.reduce((n, f) => n + f.size, 0);
  const addFiles = (list: FileList | File[]) => {
    const added = Array.from(list).map((file) => ({ id: nextFileId++, name: file.name, type: file.type || 'application/octet-stream', size: file.size, file, status: 'ready' as const, forwarded: false }));
    setFiles((f) => [...f, ...added]);
  };

  /** Files chosen in Docs: shown at once, attached when their bytes arrive (a document is made into a file first). */
  const addFromDocs = (list: DocsFile[]) => {
    const items = list.map((d) => ({ id: nextFileId++, ...attachedAs(d), size: d.kind === 'file' ? (d.size ?? 0) : 0, file: null, status: 'loading' as const, forwarded: false }));
    setFiles((f) => [...f, ...items]);
    for (const [i, d] of list.entries()) {
      const item = items[i]!;
      docsFiles.fetch(d).then(
        ({ blob, name, type }) => setFiles((f) => f.map((x) => (x.id === item.id ? { ...x, name, type, file: blob, size: blob.size, status: 'ready' } : x))),
        () => setFiles((f) => f.map((x) => (x.id === item.id ? { ...x, status: 'error' } : x))),
      );
    }
  };

  // The editor adds an empty paragraph after a closing quote on its first change (TipTap's trailing node): not a change.
  const bodyChanged = () => baseline.current !== null && !!live && trimTrailing(live.getHTML()) !== trimTrailing(baseline.current);
  /** The whole body: the editor's, with the folded quote after it. */
  const fullHtml = () => (live ? live.getHTML() + (hiddenQuote ?? '') : request.draft.html);
  /** "⋯" clicked: the quote goes into the editor, under what was written, where it can be trimmed or quoted in. */
  const showQuote = () => {
    if (!live || !hiddenQuote) return;
    const written = bodyChanged();
    const { from, to } = live.state.selection;
    live.commands.insertContentAt(live.state.doc.content.size, hiddenQuote);
    live.commands.setTextSelection({ from, to });
    if (!written) baseline.current = live.getHTML();
    setHiddenQuote(null);
  };
  const empty = () =>
    !request.restored &&
    isDraftEmpty(
      {
        to,
        cc,
        bcc,
        subject,
        text: (live?.getText() ?? '') + pending.current.to + pending.current.cc + pending.current.bcc,
        bodyChanged: bodyChanged(),
        attachments: files.filter((f) => !f.forwarded).length,
      },
      mode === 'new' ? null : initial,
    );
  const requestClose = () => (empty() ? onClose() : setConfirming(true));

  /** The recipients with what was typed but not yet a chip; `strict` throws on what is not an address. */
  const recipients = (strict: boolean) => {
    const finish = (list: Address[], text: string, label: string) => {
      if (!text.trim()) return list;
      const { addresses, invalid } = parseAddressList(text);
      if (invalid.length && strict) throw new Error(`${label}: “${invalid.join(', ')}” is not an email address.`);
      return [...list, ...addresses];
    };
    return { to: finish(to, pending.current.to, 'To'), cc: finish(cc, pending.current.cc, 'Cc'), bcc: finish(bcc, pending.current.bcc, 'Bcc') };
  };
  const snapshot = (r = recipients(false)): ComposeRequest => ({
    ...request,
    mode,
    draft: { ...initial, ...r, subject, html: fullHtml(), forwardAttachments: undefined },
    files: files.filter((f) => f.status === 'ready' && f.file).map((f) => ({ name: f.name, type: f.type, size: f.size, file: f.file!, forwarded: f.forwarded })),
    restored: true,
  });

  /** Checks what can be checked at once and hands the message over; what is wrong stays here, said above Send. */
  const send = () => {
    setError(null);
    try {
      const r = recipients(true);
      if (r.to.length + r.cc.length + r.bcc.length === 0) throw new Error('Add at least one recipient.');
      if (files.some((f) => f.status === 'loading')) throw new Error('Wait for the attachments to finish loading.');
      if (files.some((f) => f.status === 'error')) throw new Error('An attachment could not be loaded. Remove it to send.');
      if (total > MAX_SEND_BYTES) throw new Error(`Messages can be at most 20 MB with their attachments (this one is ${fileSize(total)}).`);
      onSend({
        accountId: account.id,
        message: {
          to: r.to,
          ...(r.cc.length ? { cc: r.cc } : {}),
          ...(r.bcc.length ? { bcc: r.bcc } : {}),
          subject,
          html: live ? fullHtml() : '',
          text: (live?.getText({ blockSeparator: '\n\n' }) ?? '') + (hiddenQuote ? `\n\n${quoteText(hiddenQuote)}` : ''),
          ...(initial.inReplyTo ? { inReplyTo: initial.inReplyTo } : {}),
          ...(initial.references?.length ? { references: initial.references } : {}),
          ...(mode === 'draft' && request.source ? { replacesDraft: request.source } : {}),
        },
        files: files.map((f) => ({ filename: f.name, contentType: f.type, file: f.file! })),
        request: snapshot(r),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setFieldsOpen(true);
    }
  };

  /** The inline card's menu: the same message as a reply, a reply to all, or a forward. What was written stays. */
  const switchMode = (next: AnswerMode) => {
    if (next === mode || !request.remode) return;
    const d = request.remode(next);
    const written = bodyChanged();
    setMode(next);
    setInitial(d);
    setTo(d.to);
    setCc(d.cc);
    setBcc(d.bcc);
    setShowCc(d.cc.length + d.bcc.length > 0);
    setSubject(d.subject);
    setFieldsOpen(d.to.length + d.cc.length === 0);
    // The original's files go along with a forward only.
    setFiles((f) => f.filter((x) => !x.forwarded));
    if (d.forwardAttachments) loadForwarded(d.forwardAttachments);
    if (live && !written) {
      const s = fold(next, d.html);
      live.commands.setContent(s?.head ?? d.html);
      setHiddenQuote(s?.quote ?? null);
      baseline.current = live.getHTML();
    }
    if (d.to.length) live?.commands.focus('start');
  };

  useImperativeHandle(handle, () => ({ requestClose, isEmpty: empty, snapshot: () => snapshot(), focus: () => {
    root.current?.scrollIntoView?.({ block: 'nearest' });
    live?.commands.focus();
  } }));

  const answering = mode === 'reply' || mode === 'replyAll' || mode === 'forward';
  const ModeIcon = answering ? MODE_ICONS[mode] : Reply;
  const everyone = [...to, ...cc, ...bcc];

  const fields = (
    <>
      <AddressField
        label="To"
        value={to}
        onChange={setTo}
        autoFocus={to.length === 0}
        onPendingChange={(t) => (pending.current.to = t)}
        suggest={suggest}
        trailing={
          !showCc && (
            <button type="button" className="shrink-0 rounded px-1.5 py-0.5 text-[14px] text-muted hover:bg-hover hover:text-ink" onClick={() => setShowCc(true)}>
              Cc Bcc
            </button>
          )
        }
      />
      {showCc && (
        <>
          <AddressField label="Cc" value={cc} onChange={setCc} onPendingChange={(t) => (pending.current.cc = t)} suggest={suggest} />
          <AddressField label="Bcc" value={bcc} onChange={setBcc} onPendingChange={(t) => (pending.current.bcc = t)} suggest={suggest} />
        </>
      )}
    </>
  );

  return (
    <div
      ref={root}
      className={cn('relative flex min-h-0 flex-col', !inline && 'flex-1')}
      onKeyDown={(e) => {
        // Keys from the menus and the "Discard?" dialog (portals) reach here through React; they are theirs.
        if (!e.currentTarget.contains(e.target as Node) || confirming) return;
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          send();
        } else if (inline && e.key === 'Escape') {
          // (The editor marks Escape handled; an open list of suggested addresses keeps it, AddressField.tsx.)
          e.preventDefault();
          e.stopPropagation();
          requestClose();
        }
      }}
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
      {header?.(TITLES[mode], requestClose)}
      <div className={cn('flex min-h-0 flex-1 flex-col', inline ? 'px-3' : 'overflow-y-auto px-4')}>
        {inline ? (
          <div className="flex min-h-[40px] items-center gap-1 border-b border-hairline text-[14px]">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" aria-label={`${TITLES[mode]}: change`} title="Reply, Reply all or Forward" className="flex h-8 shrink-0 items-center gap-0.5 rounded-md px-1.5 text-muted hover:bg-hover hover:text-ink">
                  <ModeIcon className="size-4" />
                  <ChevronDown className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {(['reply', 'replyAll', 'forward'] as const).map((m) => {
                  const Icon = MODE_ICONS[m];
                  return (
                    <DropdownMenuItem key={m} onSelect={() => switchMode(m)} disabled={!request.remode && m !== mode}>
                      <Icon /> {TITLES[m]}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
            {!fieldsOpen && (
              <button type="button" aria-label="Edit recipients" className="min-w-0 flex-1 truncate rounded px-1 py-1 text-left text-ink hover:bg-hover" onClick={() => setFieldsOpen(true)}>
                {everyone.map(recipientText).join(', ')}
              </button>
            )}
            {fieldsOpen && <span className="text-muted">{TITLES[mode]}</span>}
          </div>
        ) : (
          <div className="flex min-h-[40px] items-center gap-2 border-b border-hairline px-1 text-[14px]">
            <span className="w-10 shrink-0 text-muted">From</span>
            <span className="truncate text-ink">{account.displayName ? `${account.displayName} <${account.email}>` : account.email}</span>
          </div>
        )}
        {fieldsOpen && fields}
        {!inline && (
          <div className="flex min-h-[40px] items-center border-b border-hairline px-1">
            <input aria-label="Subject" placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted" />
          </div>
        )}
        <div className={cn('py-2', inline ? 'max-h-[60vh] min-h-[120px] overflow-y-auto' : 'min-h-0 flex-1')}>
          <EditorArea editor={editor} />
          {hiddenQuote && <QuoteToggle open={false} onClick={showQuote} className="mx-1 mb-1" />}
        </div>
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2 pb-3">
            {files.map((f) => (
              <span key={f.id} className={cn('inline-flex max-w-[260px] items-center gap-2 rounded-lg border border-border bg-panel px-2.5 py-1.5 text-[14px]', f.status === 'error' && 'border-danger/40 text-danger')}>
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
        <div role="alert" className="mx-4 mb-2 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-[14px] text-danger">
          {error}
        </div>
      )}
      <div className={cn('flex shrink-0 flex-wrap items-center gap-2 px-3 py-2', !inline && 'border-t border-hairline')}>
        <Button onClick={send} className="rounded-full px-5" title="Send (⌘Enter)">
          <Send />
          Send
        </Button>
        <EditorToolbar editor={editor} />
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => (e.target.files && addFiles(e.target.files), (e.target.value = ''))} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" title="Attach files" aria-label="Attach files">
              <Paperclip />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top">
            <DropdownMenuItem onSelect={() => fileInput.current?.click()}>
              <Upload />
              Upload from computer
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setPicking(true)}>
              <FileText />
              From Docs…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <span className={cn('text-xs text-muted', total > MAX_SEND_BYTES && 'text-danger')}>{total > 0 && `${fileSize(total)} of 20 MB`}</span>
        <Button variant="ghost" size="icon-sm" className="ml-auto" title="Discard" aria-label="Discard draft" onClick={requestClose}>
          <Trash2 />
        </Button>
      </div>
      {picking && <DocsPicker onPick={addFromDocs} onClose={() => setPicking(false)} />}
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
    </div>
  );
}
