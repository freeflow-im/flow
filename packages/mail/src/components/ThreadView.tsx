// The reading pane: one conversation, its messages stacked oldest first (Gmail's way), after shadcn/ui's Mail example's
// display (MIT, see LICENSE-shadcn.md). The toolbar's actions (archive, move, delete, unread, star) are the thread's in
// the open folder; reply, reply all and forward answer the last message, or the one whose own buttons were used. The
// unread messages and the last one start expanded; the rest are one line each (who, the snippet, when), and a run of
// three or more read ones is folded into "N older messages". A body is only mounted when its message is expanded (its
// frame measures itself on load). n and p (App.tsx) step through the messages. On wide screens (`inline`), Reply, Reply all
// and Forward, from the buttons or r / a / f, open a composer under the message answered (InlineCompose.tsx, loaded with the
// editor); one at a time, and one with something written in it is not replaced, it takes the focus again.
import { Archive, ArrowLeft, CalendarPlus, ChevronLeft, ChevronRight, Download, FolderInput, Forward, Loader2, Mail, MoreVertical, Pencil, Reply, ReplyAll, Star, Trash2 } from 'lucide-react';
import { Fragment, lazy, Suspense, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { attachmentUrl, type Address, type Category, type MailAccount, type MailFolder, type MessageDetail, type ThreadDetail, type ThreadMessage } from '../api';
import { cidUrlOf, prefill, type AnswerMode, type ComposeRequest, type Outgoing } from '../lib/compose';
import type { Notice } from '../lib/notice';
import { displayName, formatAddress } from '../lib/addresses';
import { folderLabel, orderFolders } from '../lib/folders';
import { fileSize, fullDate, listDate, relativeDate } from '../lib/format';
import { intent } from '@flow/suite-bar/intents';
import { eventFromThread, invitationPart, isCalendarFile, threadPeople } from '../lib/invites';
import { TAB_INFO } from '../lib/tabs';
import { conversationSubject, expandedByDefault, foldRuns, replyTarget } from '../lib/threads';
import { cn } from '../lib/utils';
import { AttachmentPreview } from './AttachmentPreview';
import { FileIcon } from './FileIcon';
import { InviteCard } from './InviteCard';
import { TAB_ICONS } from './InboxTabs';
import { MessageBody } from './MessageBody';
import { Person, PersonActionsContext, type PersonActions } from './PersonCard';
import { Button } from './ui/button';
import type { ComposerHandle } from './ComposeForm';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';

// The composer (and the editor in it) loads when the first answer opens.
const InlineCompose = lazy(() => import('./InlineCompose'));

/** What App.tsx asks of the pane: the next (1) or previous (-1) message of the thread, expanded and in view (n, p); an answer to the last message under it (r, a, f); a composer opened again there. */
export interface ThreadViewHandle {
  step(by: 1 | -1): void;
  /** Opens the inline composer for the last message; false when there is none here (narrow screens, no thread): App.tsx opens the dialog. */
  compose(mode: AnswerMode): boolean;
  /** Opens this composer under its message, if that message is in the open thread and composers are inline here. */
  reopen(request: ComposeRequest): boolean;
}

export interface ThreadViewProps {
  /** What the person card on a name or address does (PersonCard.tsx); without it names are plain text. */
  people?: PersonActions | undefined;
  accountId: string;
  /** The account's own address: "me" among the names. */
  me: string;
  /** The folder the thread was opened from: its messages there are what the toolbar acts on. */
  folder: string | null;
  thread: ThreadDetail | undefined;
  loading: boolean;
  error: string | null;
  folders: MailFolder[] | undefined;
  canArchive: boolean;
  onBack?: (() => void) | undefined;
  /** In place of the list: where the open thread is in it ("3 of 50"), and the newer (k) / older (j) one. */
  position?: { index: number; count: number } | undefined;
  onNewer?: (() => void) | undefined;
  onOlder?: (() => void) | undefined;
  onReply(m: MessageDetail): void;
  onReplyAll(m: MessageDetail): void;
  onForward(m: MessageDetail): void;
  /** For a draft in Drafts: open it in Compose, to edit and send. */
  onEditDraft?: ((m: MessageDetail) => void) | undefined;
  onArchive(): void;
  onMove(to: string): void;
  /** "Move to tab" for an INBOX thread of an account with tabs on: the tabs, and the move. */
  tabMove?: { tabs: Category[]; current: Category | null; onMove(tab: Category): void } | undefined;
  onDelete(): void;
  onToggleSeen(): void;
  onToggleFlag(): void;
  /** One message's star. */
  onFlagMessage(m: MessageDetail, flagged: boolean): void;
  /** A message whose body the server has not fetched yet was opened (or Retry pressed): read it now (hooks/mail.ts `fetchBody`). */
  onNeedBody(m: ThreadMessage): void;
  handle?: Ref<ThreadViewHandle | null> | undefined;
  /** A passing message (App.tsx's toast): an invitation being answered, then answered. */
  onNotice?: ((notice: Notice) => void) | undefined;
  /** Wide screens: Reply, Reply all and Forward open a composer under the message, instead of `onReply` and the others. */
  inline?: { account: MailAccount; onSend(out: Outgoing): void; onDetach(request: ComposeRequest): void } | undefined;
  /** "Create event" from the thread: opens Calendar at this address (default: a new tab). */
  onOpenCalendar?: ((url: string) => void) | undefined;
}

function Action({ label, onClick, children, disabled, pressed }: { label: string; onClick(): void; children: React.ReactNode; disabled?: boolean; pressed?: boolean }) {
  return (
    <Button variant="ghost" size="icon-sm" title={label} aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}>
      {children}
    </Button>
  );
}

function Addresses({ label, list }: { label: string; list: Address[] }) {
  if (!list.length) return null;
  return (
    <div className="flex gap-1 text-[14px] text-muted">
      <span className="shrink-0">{label}</span>
      <span className="min-w-0 break-words text-ink/80">
        {list.map((a, i) => (
          <span key={`${a.address}-${i}`}>
            {i > 0 && ', '}
            <Person address={a}>{formatAddress(a)}</Person>
          </span>
        ))}
      </span>
    </div>
  );
}

/** The thread's subject: its last message's, less the "Re:" and "Fwd:" a reply adds. */
const threadSubject = (messages: readonly ThreadMessage[]) => conversationSubject(messages[messages.length - 1]?.subject ?? '', messages.length);

export function ThreadView(p: ThreadViewProps) {
  const t = p.thread;
  const messages = t?.messages ?? [];
  const moveTargets = (() => {
    const { special, tree } = orderFolders(p.folders ?? []);
    const flat: MailFolder[] = [...special];
    const walk = (nodes: typeof tree) => nodes.forEach((n) => (n.folder && flat.push(n.folder), walk(n.children)));
    walk(tree);
    return flat.filter((f) => f.path !== p.folder);
  })();

  // Which messages are open, the fold, the keyboard's message and the attachment preview start over with another thread.
  const [expanded, setExpanded] = useState<Set<number>>(() => expandedByDefault(messages));
  const [unfolded, setUnfolded] = useState(false);
  const [focus, setFocus] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState<{ index: number; at: number } | null>(null);
  const shownKey = t ? `${t.threadId}:${messages.length}` : '';
  const lastKey = useRef(shownKey);
  useEffect(() => {
    if (lastKey.current === shownKey) return;
    lastKey.current = shownKey;
    setExpanded(expandedByDefault(messages));
    setUnfolded(false);
    setFocus(null);
    setPreviewing(null);
    // (messages change with shownKey.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKey]);
  const toggle = (i: number) => {
    const m = messages[i];
    if (m?.bodyPending && !expanded.has(i)) p.onNeedBody(m);
    setExpanded((cur) => {
      const next = new Set(cur);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  };

  // The inline composer: the message it answers and what it opened with. Another conversation closes it (one with something
  // written moves to the dialog, InlineCompose.tsx).
  const [composing, setComposing] = useState<{ key: number; at: { folder: string; uid: number }; request: ComposeRequest } | null>(null);
  const composer = useRef<ComposerHandle | null>(null);
  const composeKey = useRef(0);
  const threadId = t?.threadId ?? null;
  useEffect(() => setComposing(null), [threadId]);
  const showComposer = (at: { folder: string; uid: number }, request: ComposeRequest) => {
    const i = messages.findIndex((x) => x.folder === at.folder && x.uid === at.uid);
    if (i < 0) return false;
    setUnfolded(true);
    setExpanded((cur) => (cur.has(i) ? cur : new Set(cur).add(i)));
    setComposing({ key: ++composeKey.current, at, request });
    return true;
  };
  /** Reply, Reply all or Forward to `m`: under it on wide screens, else App.tsx's dialog. */
  const answer = (mode: AnswerMode, m: MessageDetail) => {
    const inline = p.inline;
    if (!inline || !t) return void (mode === 'reply' ? p.onReply : mode === 'replyAll' ? p.onReplyAll : p.onForward)(m);
    // One composer at a time: one with something in it stays and takes the focus.
    if (composing && composer.current && !composer.current.isEmpty()) return composer.current.focus();
    const cidUrl = cidUrlOf(p.accountId, m);
    const remode = (next: AnswerMode) => prefill(next, m, p.me, cidUrl);
    showComposer({ folder: m.folder, uid: m.uid }, { mode, draft: remode(mode), source: { folder: m.folder, uid: m.uid }, threadId: t.threadId, remode });
  };

  const articles = useRef(new Map<number, HTMLElement>());
  useImperativeHandle(p.handle, () => ({
    compose(mode) {
      const m = replyTarget(messages, p.folder);
      if (!p.inline || !m || m.bodyPending) return false;
      answer(mode, m);
      return true;
    },
    reopen(request) {
      if (!p.inline || !t || request.threadId !== t.threadId || !request.source) return false;
      if (composing && composer.current && !composer.current.isEmpty()) return false;
      return showComposer(request.source, request);
    },
    step(by) {
      if (!messages.length) return;
      const from = focus ?? (by > 0 ? -1 : messages.length);
      const i = Math.max(0, Math.min(messages.length - 1, from + by));
      setFocus(i);
      setUnfolded(true);
      const m = messages[i];
      if (m?.bodyPending && !expanded.has(i)) p.onNeedBody(m);
      setExpanded((cur) => (cur.has(i) ? cur : new Set(cur).add(i)));
      articles.current.get(i)?.scrollIntoView?.({ block: 'nearest' });
    },
  }));

  const last = messages[messages.length - 1];
  const target = replyTarget(messages, p.folder);
  const inFolder = messages.filter((m) => m.folder === p.folder);
  const anyUnread = inFolder.some((m) => !m.seen);
  const anyFlagged = inFolder.some((m) => m.flagged);
  const draft = p.onEditDraft ? [...inFolder].reverse()[0] : undefined;
  const segments = foldRuns(messages, expanded);

  return (
    <PersonActionsContext.Provider value={p.people ?? null}>
    <section className="flex h-full min-w-0 flex-col bg-white" aria-label="Conversation">
      <div className="flex h-[52px] shrink-0 items-center gap-0.5 border-b border-hairline px-2">
        {p.onBack && (
          <Action label="Back to the list" onClick={p.onBack}>
            <ArrowLeft />
          </Action>
        )}
        <Action label="Archive (e)" onClick={p.onArchive} disabled={!t || !p.canArchive}>
          <Archive />
        </Action>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" title="Move to" aria-label="Move to" disabled={!t}>
              <FolderInput />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Move to</DropdownMenuLabel>
            {moveTargets.map((f) => (
              <DropdownMenuItem key={f.path} onSelect={() => p.onMove(f.path)}>
                {f.specialUse ? folderLabel(f) : f.path}
              </DropdownMenuItem>
            ))}
            {p.tabMove && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Move to tab</DropdownMenuLabel>
                {p.tabMove.tabs
                  .filter((tab) => tab !== p.tabMove!.current)
                  .map((tab) => {
                    const Icon = TAB_ICONS[tab];
                    return (
                      <DropdownMenuItem key={tab} onSelect={() => p.tabMove!.onMove(tab)}>
                        <Icon /> {TAB_INFO[tab].label}
                      </DropdownMenuItem>
                    );
                  })}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <Action label="Delete (#)" onClick={p.onDelete} disabled={!t}>
          <Trash2 />
        </Action>
        <div className="mx-1 h-6 w-px bg-hairline" />
        <Action label={anyUnread ? 'Mark as read (u)' : 'Mark as unread (u)'} onClick={p.onToggleSeen} disabled={!t}>
          <Mail />
        </Action>
        <Action label={anyFlagged ? 'Unstar' : 'Star'} onClick={p.onToggleFlag} disabled={!t} pressed={anyFlagged}>
          <Star className={cn(anyFlagged && 'text-flag')} fill={anyFlagged ? 'currentColor' : 'none'} />
        </Action>
        <div className="ml-auto flex items-center gap-0.5">
          {p.position && p.position.index >= 0 && (
            <>
              <span className="px-1.5 text-xs whitespace-nowrap text-muted">
                {p.position.index + 1} of {p.position.count}
              </span>
              <Action label="Newer (k)" onClick={() => p.onNewer?.()} disabled={p.position.index <= 0}>
                <ChevronLeft />
              </Action>
              <Action label="Older (j)" onClick={() => p.onOlder?.()} disabled={p.position.index >= p.position.count - 1}>
                <ChevronRight />
              </Action>
              <span className="mx-1 h-5 w-px bg-hairline" aria-hidden />
            </>
          )}
          {p.onEditDraft && (
            <Button size="sm" className="mr-1 gap-1.5" onClick={() => draft && p.onEditDraft!(draft)} disabled={!draft}>
              <Pencil className="size-3.5" /> Edit draft
            </Button>
          )}
          <Action label="Reply (r)" onClick={() => target && answer('reply', target)} disabled={!target}>
            <Reply />
          </Action>
          <Action label="Reply all (a)" onClick={() => target && answer('replyAll', target)} disabled={!target}>
            <ReplyAll />
          </Action>
          <Action label="Forward (f)" onClick={() => target && answer('forward', target)} disabled={!target}>
            <Forward />
          </Action>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="More" disabled={!t}>
                <MoreVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={p.onToggleSeen}>{anyUnread ? 'Mark as read' : 'Mark as unread'}</DropdownMenuItem>
              <DropdownMenuItem onSelect={p.onToggleFlag}>{anyFlagged ? 'Remove star' : 'Star'}</DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  // The suite's `create` intent to Calendar (@flow/suite-bar intents), in a new tab.
                  intent.create('calendar', eventFromThread(threadSubject(messages), threadPeople(messages, p.me)), p.onOpenCalendar ? { navigate: p.onOpenCalendar } : { newTab: true });
                }}
              >
                <CalendarPlus /> Create event
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={p.onDelete} className="text-danger">
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {p.loading && (
          <div className="flex items-center justify-center gap-2 p-10 text-sm text-muted">
            <Loader2 className="size-4 animate-spin" /> Opening…
          </div>
        )}
        {p.error && <div className="m-4 rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-danger">{p.error}</div>}
        {!t && !p.loading && !p.error && (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-10 text-center text-sm text-muted">
            <Mail className="size-10 text-faint" strokeWidth={1.25} />
            No conversation selected
          </div>
        )}
        {t && (
          <div className="px-5 py-4">
            <h2 className="mb-2 flex items-baseline gap-2 text-xl font-normal leading-snug text-ink">
              <span className="min-w-0">{threadSubject(messages) || '(no subject)'}</span>
              {messages.length > 1 && <span className="shrink-0 text-sm text-muted">{messages.length}</span>}
            </h2>
            {segments.map((s) =>
              s.kind === 'fold' && !unfolded ? (
                <button
                  key={`fold-${s.indexes[0]}`}
                  type="button"
                  className="my-1 flex w-full items-center gap-3 rounded-lg border border-dashed border-border px-4 py-2 text-left text-[14px] text-muted hover:bg-hover"
                  onClick={() => setUnfolded(true)}
                >
                  <span className="flex size-7 items-center justify-center rounded-full bg-panel text-xs font-semibold text-ink">{s.indexes.length}</span>
                  {s.indexes.length} older messages
                </button>
              ) : (
                (s.kind === 'fold' ? s.indexes : [s.index]).map((i) => {
                  const m = messages[i]!;
                  const here = composing && composing.at.folder === m.folder && composing.at.uid === m.uid && p.inline;
                  return (
                    <Fragment key={`${m.folder}/${m.uid}`}>
                    <ThreadMessageItem
                      ref={(el) => {
                        el ? articles.current.set(i, el) : articles.current.delete(i);
                      }}
                      accountId={p.accountId}
                      me={p.me}
                      message={m}
                      open={expanded.has(i)}
                      last={i === messages.length - 1}
                      focused={focus === i}
                      onToggle={() => toggle(i)}
                      onReply={() => answer('reply', m)}
                      onReplyAll={() => answer('replyAll', m)}
                      onForward={() => answer('forward', m)}
                      onEditDraft={p.onEditDraft && m.folder === p.folder ? () => p.onEditDraft!(m) : undefined}
                      onFlag={() => p.onFlagMessage(m, !m.flagged)}
                      onRetry={() => p.onNeedBody(m)}
                      onPreview={(at) => setPreviewing({ index: i, at })}
                      onNotice={p.onNotice ?? (() => {})}
                    />
                    {here && (
                      <Suspense fallback={null}>
                        <InlineCompose
                          key={composing.key}
                          account={p.inline!.account}
                          request={composing.request}
                          handle={composer}
                          onClose={() => setComposing(null)}
                          onSend={(out) => {
                            setComposing(null);
                            p.inline!.onSend(out);
                          }}
                          onDetach={p.inline!.onDetach}
                        />
                      </Suspense>
                    )}
                    </Fragment>
                  );
                })
              ),
            )}
            {previewing && messages[previewing.index] && (
              <AttachmentPreview
                accountId={p.accountId}
                message={messages[previewing.index]!}
                files={shownFiles(messages[previewing.index]!)}
                index={previewing.at}
                onIndex={(at) => setPreviewing((v) => (v ? { ...v, at } : v))}
                onClose={() => setPreviewing(null)}
              />
            )}
            {/* As Gmail ends a conversation: answer it without going back up to the toolbar. */}
            {last && !last.bodyPending && !(composing && p.inline) && (
              <div className="mt-6 flex flex-wrap gap-2 pb-6">
                {draft && p.onEditDraft && (
                  <EndButton label="Edit draft" onClick={() => p.onEditDraft!(draft)}>
                    <Pencil />
                  </EndButton>
                )}
                <EndButton label="Reply" onClick={() => target && answer('reply', target)}>
                  <Reply />
                </EndButton>
                {target && target.to.length + target.cc.length > 1 && (
                  <EndButton label="Reply all" onClick={() => answer('replyAll', target)}>
                    <ReplyAll />
                  </EndButton>
                )}
                <EndButton label="Forward" onClick={() => target && answer('forward', target)}>
                  <Forward />
                </EndButton>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
    </PersonActionsContext.Provider>
  );
}

/**
 * A message's attachments as listed under it: every part, the pictures its HTML shows by cid included (a flyer pasted into
 * the body is a file worth saving; the list's row leaves those out, this row does not), less the iCalendar of an
 * invitation, which its card shows.
 */
const shownFiles = (m: ThreadMessage) => {
  const invite = !m.bodyPending && invitationPart(m);
  return m.attachments.filter((a) => !(invite && isCalendarFile(a)));
};

interface ItemProps {
  ref: Ref<HTMLElement>;
  accountId: string;
  me: string;
  message: ThreadMessage;
  open: boolean;
  last: boolean;
  focused: boolean;
  onToggle(): void;
  onReply(): void;
  onReplyAll(): void;
  onForward(): void;
  onEditDraft?: (() => void) | undefined;
  onFlag(): void;
  onRetry(): void;
  onPreview(at: number): void;
  onNotice(notice: Notice): void;
}

/** One message of the thread: a line when collapsed; its header, body and attachments when open. */
function ThreadMessageItem({ ref, accountId, me, message: m, open, last, focused, onToggle, onReply, onReplyAll, onForward, onEditDraft, onFlag, onRetry, onPreview, onNotice }: ItemProps) {
  const files = shownFiles(m);
  const invite = m.bodyPending ? null : invitationPart(m);
  const fromMe = m.from?.address.toLowerCase() === me.toLowerCase();
  const name = fromMe ? 'me' : displayName(m.from);
  const toLine = m.to.map((a) => (a.address.toLowerCase() === me.toLowerCase() ? 'me' : displayName(a))).join(', ');
  return (
    <article
      ref={ref}
      data-uid={m.uid}
      data-folder={m.folder}
      aria-expanded={open}
      className={cn('-mx-2 mb-1 rounded-lg border border-transparent', open ? 'border-hairline bg-white' : 'hover:bg-panel', focused && 'ring-2 ring-primary/40')}
    >
      <div
        className="flex cursor-pointer items-start gap-3 px-3 py-2.5"
        onClick={(e) => {
          // The buttons, links and the Details disclosure in the header are their own; the rest opens or closes the message.
          if ((e.target as HTMLElement).closest('button, a, details')) return;
          onToggle();
        }}
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary-tint text-sm font-semibold text-primary-deep">{name.slice(0, 1).toUpperCase()}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            {m.from ? (
              <Person address={m.from} className={cn('text-ink', !m.seen ? 'font-bold' : 'font-semibold')}>
                {name}
              </Person>
            ) : (
              <span className={cn('text-ink', !m.seen ? 'font-bold' : 'font-semibold')}>{name}</span>
            )}
            {open && m.from && m.from.name && !fromMe && (
              <Person address={m.from} className="text-[14px] text-muted">
                &lt;{m.from.address}&gt;
              </Person>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted">
              <time dateTime={m.date} title={fullDate(m.date)}>{open ? `${fullDate(m.date)} (${relativeDate(m.date)})` : listDate(m.date)}</time>
              <button
                type="button"
                aria-label={m.flagged ? 'Unstar' : 'Star'}
                aria-pressed={m.flagged}
                className={cn('flex size-7 items-center justify-center rounded-full hover:bg-hover', m.flagged ? 'text-flag' : 'text-faint hover:text-muted')}
                onClick={onFlag}
              >
                <Star className="size-4" fill={m.flagged ? 'currentColor' : 'none'} strokeWidth={1.75} />
              </button>
              {open && (
                <>
                  <button type="button" title="Reply" aria-label={`Reply to ${name}`} className="flex size-7 items-center justify-center rounded-full text-muted hover:bg-hover hover:text-ink" onClick={onReply}>
                    <Reply className="size-4" />
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button type="button" aria-label={`More for the message from ${name}`} className="flex size-7 items-center justify-center rounded-full text-muted hover:bg-hover hover:text-ink">
                        <MoreVertical className="size-4" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={onReply}>Reply</DropdownMenuItem>
                      <DropdownMenuItem onSelect={onReplyAll}>Reply all</DropdownMenuItem>
                      <DropdownMenuItem onSelect={onForward}>Forward</DropdownMenuItem>
                      {onEditDraft && <DropdownMenuItem onSelect={onEditDraft}>Edit draft</DropdownMenuItem>}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={onFlag}>{m.flagged ? 'Remove star' : 'Star'}</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}
            </span>
          </div>
          {open ? (
            <>
              {toLine && (
                <div className="text-[14px] text-muted">
                  to{' '}
                  {m.to.map((a, i) => (
                    <span key={`${a.address}-${i}`}>
                      {i > 0 && ', '}
                      <Person address={a}>{a.address.toLowerCase() === me.toLowerCase() ? 'me' : displayName(a)}</Person>
                    </span>
                  ))}
                </div>
              )}
              <details className="text-[14px] text-muted">
                <summary className="cursor-pointer select-none hover:text-ink">Details</summary>
                <Addresses label="From:" list={m.from ? [m.from] : []} />
                <Addresses label="To:" list={m.to} />
                <Addresses label="Cc:" list={m.cc} />
                <Addresses label="Bcc:" list={m.bcc} />
                {m.replyTo.length > 0 && m.replyTo.some((r) => r.address !== m.from?.address) && <Addresses label="Reply to:" list={m.replyTo} />}
                <div className="flex gap-1"><span>In:</span><span className="text-ink/80">{m.folder}</span></div>
              </details>
            </>
          ) : (
            <div className="line-clamp-1 text-[14px] text-muted">{m.snippet || (m.bodyPending ? 'Loading…' : '')}</div>
          )}
        </div>
      </div>
      {open && (
        <div className="px-3 pb-3 pl-[64px]">
          {m.bodyPending && m.bodyFailed ? (
            <div className="flex items-center gap-3 py-4 text-sm text-muted">
              <span>Couldn't load this message.</span>
              <button type="button" className="font-medium text-primary hover:underline" onClick={onRetry}>
                Retry
              </button>
            </div>
          ) : m.bodyPending ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          ) : (
            <>
              {invite && <InviteCard invite={{ account: accountId, folder: m.folder, uid: m.uid, part: invite.index }} onNotice={onNotice} />}
              <MessageBody accountId={accountId} message={m} />
            </>
          )}
          {files.length > 0 && (
            <div className="mt-3 border-t border-hairline pt-3">
              <div className="mb-2 text-[12px] font-medium uppercase tracking-[.06em] text-muted">
                {files.length} attachment{files.length === 1 ? '' : 's'}
              </div>
              <div className="flex flex-wrap gap-2">
                {files.map((a, i) => (
                  <div key={a.index} className="group flex max-w-[260px] items-center rounded-lg border border-border bg-white text-[14px] hover:bg-hover">
                    {/* Opens the preview; Enter and Space here are the chip's, not the list's (App.tsx skips a key already handled). */}
                    <button
                      type="button"
                      onClick={() => onPreview(i)}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter' && e.key !== ' ') return;
                        e.preventDefault();
                        onPreview(i);
                      }}
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-l-lg py-2 pl-3 pr-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                      title={`Preview ${a.filename}`}
                      aria-label={`Preview ${a.filename || 'attachment'}, ${fileSize(a.size)}`}
                    >
                      <FileIcon file={a} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-ink">{a.filename || 'attachment'}</span>
                        <span className="block text-xs text-muted">{fileSize(a.size)}</span>
                      </span>
                    </button>
                    <a
                      href={attachmentUrl(accountId, m.folder, m.uid, a.index)}
                      download={a.filename}
                      className="mr-1.5 flex size-7 shrink-0 items-center justify-center rounded-full text-muted hover:bg-black/5 hover:text-ink focus-visible:ring-2 focus-visible:ring-primary/40 outline-none"
                      title={`Download ${a.filename}`}
                      aria-label={`Download ${a.filename}`}
                    >
                      <Download className="size-4" />
                    </a>
                  </div>
                ))}
              </div>
            </div>
          )}
          {!last && (
            <div className="mt-3 flex gap-2">
              <EndButton label="Reply" onClick={onReply} small>
                <Reply />
              </EndButton>
              <EndButton label="Forward" onClick={onForward} small>
                <Forward />
              </EndButton>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function EndButton({ label, onClick, children, small }: { label: string; onClick(): void; children: React.ReactNode; small?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('inline-flex items-center gap-2 rounded-full border border-[#747775] bg-white font-medium text-ink hover:bg-hover', small ? 'h-8 px-4 text-xs [&_svg]:size-4' : 'h-9 px-5 text-sm [&_svg]:size-[18px]')}
    >
      {children}
      {label}
    </button>
  );
}
