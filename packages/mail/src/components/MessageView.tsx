// The reading pane, after shadcn/ui's Mail example's display (MIT, see LICENSE-shadcn.md): the actions (reply, reply
// all, forward, archive, move, delete, unread, star), the header (from, to, cc, date), the body and the attachments.
import { Archive, ArrowLeft, ChevronLeft, ChevronRight, Download, FileText, FolderInput, Forward, Loader2, Mail, MoreVertical, Reply, ReplyAll, Star, Trash2 } from 'lucide-react';
import { attachmentUrl, type Address, type Category, type MailFolder, type MessageDetail } from '../api';
import { displayName, formatAddress } from '../lib/addresses';
import { folderLabel, orderFolders } from '../lib/folders';
import { fileSize, fullDate, relativeDate } from '../lib/format';
import { TAB_INFO } from '../lib/tabs';
import { cn } from '../lib/utils';
import { TAB_ICONS } from './InboxTabs';
import { MessageBody } from './MessageBody';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';

export interface MessageViewProps {
  accountId: string;
  message: MessageDetail | undefined;
  loading: boolean;
  error: string | null;
  folders: MailFolder[] | undefined;
  canArchive: boolean;
  onBack?: (() => void) | undefined;
  /** In place of the list: where the open message is in it ("3 of 50"), and the newer (k) / older (j) one. */
  position?: { index: number; count: number } | undefined;
  onNewer?: (() => void) | undefined;
  onOlder?: (() => void) | undefined;
  onReply(): void;
  onReplyAll(): void;
  onForward(): void;
  onArchive(): void;
  onMove(to: string): void;
  /** "Move to tab" for an INBOX message of an account with tabs on: the tabs, and the move. */
  tabMove?: { tabs: Category[]; current: Category | null; onMove(tab: Category): void } | undefined;
  onDelete(): void;
  onToggleSeen(): void;
  onToggleFlag(): void;
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
    <div className="flex gap-1 text-[13px] text-muted">
      <span className="shrink-0">{label}</span>
      <span className="min-w-0 break-words text-ink/80">{list.map((a) => formatAddress(a)).join(', ')}</span>
    </div>
  );
}

export function MessageView(p: MessageViewProps) {
  const m = p.message;
  const moveTargets = (() => {
    const { special, tree } = orderFolders(p.folders ?? []);
    const flat: MailFolder[] = [...special];
    const walk = (nodes: typeof tree) => nodes.forEach((n) => (n.folder && flat.push(n.folder), walk(n.children)));
    walk(tree);
    return flat.filter((f) => f.path !== m?.folder);
  })();
  const files = m?.attachments.filter((a) => !a.inline || !a.contentId || !(m.html ?? '').includes(a.contentId.replace(/^<|>$/g, ''))) ?? [];

  return (
    <section className="flex h-full min-w-0 flex-col bg-white" aria-label="Message">
      <div className="flex h-[52px] shrink-0 items-center gap-0.5 border-b border-hairline px-2">
        {p.onBack && (
          <Action label="Back to the list" onClick={p.onBack}>
            <ArrowLeft />
          </Action>
        )}
        <Action label="Archive (e)" onClick={p.onArchive} disabled={!m || !p.canArchive}>
          <Archive />
        </Action>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" title="Move to" aria-label="Move to" disabled={!m}>
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
                  .filter((t) => t !== p.tabMove!.current)
                  .map((t) => {
                    const Icon = TAB_ICONS[t];
                    return (
                      <DropdownMenuItem key={t} onSelect={() => p.tabMove!.onMove(t)}>
                        <Icon /> {TAB_INFO[t].label}
                      </DropdownMenuItem>
                    );
                  })}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <Action label="Delete (#)" onClick={p.onDelete} disabled={!m}>
          <Trash2 />
        </Action>
        <div className="mx-1 h-6 w-px bg-hairline" />
        <Action label={m?.seen === false ? 'Mark as read (u)' : 'Mark as unread (u)'} onClick={p.onToggleSeen} disabled={!m}>
          <Mail />
        </Action>
        <Action label={m?.flagged ? 'Unstar' : 'Star'} onClick={p.onToggleFlag} disabled={!m} pressed={!!m?.flagged}>
          <Star className={cn(m?.flagged && 'text-flag')} fill={m?.flagged ? 'currentColor' : 'none'} />
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
          <Action label="Reply (r)" onClick={p.onReply} disabled={!m}>
            <Reply />
          </Action>
          <Action label="Reply all (a)" onClick={p.onReplyAll} disabled={!m}>
            <ReplyAll />
          </Action>
          <Action label="Forward (f)" onClick={p.onForward} disabled={!m}>
            <Forward />
          </Action>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="More" disabled={!m}>
                <MoreVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={p.onToggleSeen}>{m?.seen === false ? 'Mark as read' : 'Mark as unread'}</DropdownMenuItem>
              <DropdownMenuItem onSelect={p.onToggleFlag}>{m?.flagged ? 'Remove star' : 'Star'}</DropdownMenuItem>
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
        {!m && !p.loading && !p.error && (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-10 text-center text-sm text-muted">
            <Mail className="size-10 text-faint" strokeWidth={1.25} />
            No message selected
          </div>
        )}
        {m && (
          <article className="px-5 py-4">
            <h2 className="mb-4 text-xl font-normal leading-snug text-ink">{m.subject || '(no subject)'}</h2>
            <div className="mb-4 flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary-tint text-sm font-semibold text-primary-deep">
                {displayName(m.from).slice(0, 1).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-semibold text-ink">{displayName(m.from)}</span>
                  {m.from && m.from.name && <span className="text-[13px] text-muted">&lt;{m.from.address}&gt;</span>}
                  <span className="ml-auto shrink-0 text-xs text-muted" title={fullDate(m.date)}>
                    {fullDate(m.date)} ({relativeDate(m.date)})
                  </span>
                </div>
                <Addresses label="To:" list={m.to} />
                <Addresses label="Cc:" list={m.cc} />
                <Addresses label="Bcc:" list={m.bcc} />
                {m.replyTo.length > 0 && m.replyTo.some((r) => r.address !== m.from?.address) && <Addresses label="Reply to:" list={m.replyTo} />}
              </div>
            </div>
            <MessageBody accountId={p.accountId} message={m} />
            {files.length > 0 && (
              <div className="mt-4 border-t border-hairline pt-4">
                <div className="mb-2 text-[11px] font-medium uppercase tracking-[.06em] text-muted">
                  {files.length} attachment{files.length === 1 ? '' : 's'}
                </div>
                <div className="flex flex-wrap gap-2">
                  {files.map((a) => (
                    <a
                      key={a.index}
                      href={attachmentUrl(p.accountId, m.folder, m.uid, a.index)}
                      download={a.filename}
                      className="group flex max-w-[260px] items-center gap-2 rounded-lg border border-border bg-white px-3 py-2 text-[13px] hover:bg-hover"
                      title={`Download ${a.filename}`}
                    >
                      <FileText className="size-4 shrink-0 text-primary" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-ink">{a.filename || 'attachment'}</span>
                        <span className="block text-xs text-muted">{fileSize(a.size)}</span>
                      </span>
                      <Download className="size-4 shrink-0 text-muted opacity-0 group-hover:opacity-100" />
                    </a>
                  ))}
                </div>
              </div>
            )}
            {/* As Gmail ends a message: answer it without going back up to the toolbar. */}
            <div className="mt-6 flex flex-wrap gap-2 pb-6">
              <EndButton label="Reply" onClick={p.onReply}>
                <Reply />
              </EndButton>
              {m.to.length + m.cc.length > 1 && (
                <EndButton label="Reply all" onClick={p.onReplyAll}>
                  <ReplyAll />
                </EndButton>
              )}
              <EndButton label="Forward" onClick={p.onForward}>
                <Forward />
              </EndButton>
            </div>
          </article>
        )}
      </div>
    </section>
  );
}

function EndButton({ label, onClick, children }: { label: string; onClick(): void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex h-9 items-center gap-2 rounded-full border border-[#747775] bg-white px-5 text-sm font-medium text-ink hover:bg-hover [&_svg]:size-[18px]">
      {children}
      {label}
    </button>
  );
}
