// The open folder's conversations, after shadcn/ui's Mail example's list (MIT, see LICENSE-shadcn.md): All / Unread, a
// row per thread (who wrote in it and how many messages, the newest one's subject, snippet and date, the unread dot,
// the star, and the newest one's attachments as chips that open the preview), checkboxes for acting on several at once,
// and more rows as the list scrolls to its end (`before=`). With a mouse, rows drag onto an inbox tab or a folder
// (lib/dnd.ts); a checked row takes the other checked ones with it.
import { useEffect, useRef, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { Archive, ArrowLeft, CircleHelp, Columns2, EllipsisVertical, FolderInput, PanelTop, Loader2, Mail, MailOpen, Menu, Paperclip, RefreshCw, Search, Star, Tag, Trash2, X } from 'lucide-react';
import type { Category, MailFolder, MessageSummary, ThreadSummary } from '../api';
import { AttachmentChips, CHIPS_PAPERCLIP } from './AttachmentChips';
import { AttachmentPreview } from './AttachmentPreview';
import { displayName } from '../lib/addresses';
import { startDrag } from '../lib/dnd';
import { folderLabel, orderFolders } from '../lib/folders';
import { listDate, fullDate, relativeDate } from '../lib/format';
import { TAB_INFO } from '../lib/tabs';
import { conversationSubject, dragThreadUids, participantsLabel } from '../lib/threads';
import { cn } from '../lib/utils';
import { TAB_ICONS } from './InboxTabs';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from './ui/dropdown-menu';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs';

export type ListTab = 'all' | 'unread';

export interface MessageListProps {
  /** The account the rows are in: a row's attachment chips open the preview with it. */
  accountId: string;
  /** The account's own address: "me" in a row's names. */
  me: string;
  title: string;
  rows: ThreadSummary[];
  loading: boolean;
  error: string | null;
  refreshing: boolean;
  onRefresh(): void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore(): void;
  tab: ListTab;
  onTab(t: ListTab): void;
  query: string;
  onClearQuery(): void;
  openId: string | null;
  cursorId: string | null;
  onOpen(threadId: string): void;
  checked: Set<string>;
  onCheck(threadId: string, on: boolean, range: boolean): void;
  onCheckAll(on: boolean): void;
  onFlag(t: ThreadSummary): void;
  onBulk(action: 'read' | 'unread' | 'flag' | 'unflag' | 'delete'): void;
  onBulkMove(to: string): void;
  folders: MailFolder[] | undefined;
  currentFolder: string | null;
  /** Wide screens: the open message beside the list ('split') or in its place ('full'). */
  readingPane?: { value: 'full' | 'split'; onChange(v: 'full' | 'split'): void } | undefined;
  /** Gmail's list: one line a thread (names, subject - snippet, date), with actions on hover. */
  dense?: boolean | undefined;
  /** A row's own actions, on hover in the dense list. */
  onRowAction?: ((t: ThreadSummary, action: 'archive' | 'delete' | 'read' | 'unread') => void) | undefined;
  /** On a narrow screen, the button that opens the folders. */
  onShowFolders?: (() => void) | undefined;
  /** The list's own search (the suite bar has none on Mail): runs a search, or ends it with an empty one. */
  onSearch?: ((q: string) => void) | undefined;
  /** A wide screen: the search field always shows, beside the folder's name; otherwise the search button opens it. */
  searchBar?: boolean | undefined;
  /** The inbox tabs (InboxTabs), above the rows. */
  tabBar?: ReactNode | undefined;
  /** "Move to tab", for an inbox with tabs: the tabs, the one open (null while searching), and the move (of a thread's messages in the folder). */
  tabMove?: { tabs: Category[]; current: Category | null; onMove(uids: number[], tab: Category): void; onWhy?(t: ThreadSummary): void } | undefined;
  /** Rows can be dragged onto a tab or a folder (a mouse or trackpad, not a touch screen). */
  draggable?: boolean | undefined;
  /** The last page came back short while the server sorts older mail into tabs; it is asked for again shortly. */
  sorting?: boolean | undefined;
}

/** The list's date: "5 min ago" for the last hour, then the time today, the weekday this week, the date before. */
function rowDate(iso: string): string {
  const age = Date.now() - new Date(iso).getTime();
  return age >= 0 && age < 3_600_000 ? relativeDate(iso) : listDate(iso);
}

export function MessageList(p: MessageListProps) {
  const sentinel = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const { hasMore, loadingMore, onLoadMore } = p;
  const [searching, setSearching] = useState(false);
  const [draft, setDraft] = useState(p.searchBar ? (p.query ?? '') : '');
  const showSearch = !!p.onSearch && (searching || !!p.searchBar);
  // On a wide screen (the full app and Home) the field sits beside the folder's name, in the header row; on a phone it
  // opens on a row of its own.
  const inlineSearch = showSearch && !!p.searchBar;
  const searchField = (
    <form
      className={inlineSearch ? 'flex min-w-0 flex-1 items-center' : 'flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-2'}
      onSubmit={(e) => {
        e.preventDefault();
        p.onSearch?.(draft.trim());
      }}
    >
      <input
        autoFocus={!p.searchBar}
        data-testid="mail-list-search"
        type="search"
        aria-label="Search mail"
        placeholder={`Search ${p.title}`}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          // Emptying the field ends the search, as the suite bar's did.
          if (!e.target.value.trim() && p.query) p.onSearch?.('');
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          setDraft('');
          if (p.query) p.onSearch?.('');
          e.currentTarget.blur();
        }}
        className={cn('min-w-0 flex-1 rounded-lg border border-border bg-white px-3 text-sm outline-none focus:border-primary', inlineSearch ? 'h-8' : 'h-9')}
      />
    </form>
  );
  // The field shows the search in force: cleared with it ("Results for …" ✕), as the suite bar's is.
  useEffect(() => {
    if (p.searchBar) setDraft(p.query ?? '');
  }, [p.searchBar, p.query]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !loadingMore) onLoadMore();
    }, { root: scroller.current, rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadingMore, onLoadMore, p.rows.length]);

  // The keyboard's row stays in view.
  useEffect(() => {
    if (p.cursorId === null) return;
    [...(scroller.current?.querySelectorAll<HTMLElement>('[data-thread]') ?? [])].find((el) => el.dataset.thread === p.cursorId)?.scrollIntoView({ block: 'nearest' });
  }, [p.cursorId]);

  // The attachment open in the preview from a row's chip: that row's newest message (as it was) and the position in its files.
  const [previewing, setPreviewing] = useState<{ m: MessageSummary; at: number } | null>(null);
  // An invitation's text/calendar alternative is not a file (its invite.ics is, as Gmail shows it).
  const chips = (row: MessageSummary, className?: string) => {
    const m = row.attachments?.some((a) => /^text\/calendar/i.test(a.mimeType)) ? { ...row, attachments: row.attachments.filter((a) => !/^text\/calendar/i.test(a.mimeType)) } : row;
    return m.attachments?.length ? <AttachmentChips files={m.attachments} dense={p.dense} onOpen={(at) => setPreviewing({ m, at })} className={className} /> : null;
  };

  // The row whose menu is open (its ⋮, or a right-click on it): it keeps its hover actions while the menu is up.
  const [menuId, setMenuId] = useState<string | null>(null);
  const tabTargets = (current: Category | null | undefined) => (p.tabMove?.tabs ?? []).filter((t) => t !== current);
  const allChecked = p.rows.length > 0 && p.rows.every((t) => p.checked.has(t.threadId));
  /** A row's drag: its thread's messages, or every checked row's when it is checked. */
  const drag = (t: ThreadSummary) => (p.draggable ? { draggable: true, onDragStart: (e: ReactDragEvent) => startDrag(e, dragThreadUids(t.threadId, p.checked, p.rows)) } : {});
  const bulk = p.checked.size > 0;
  const moveTargets = (() => {
    const { special, tree } = orderFolders(p.folders ?? []);
    const flat: MailFolder[] = [...special];
    const walk = (nodes: typeof tree) => nodes.forEach((n) => (n.folder && flat.push(n.folder), walk(n.children)));
    walk(tree);
    return flat.filter((f) => f.path !== p.currentFolder);
  })();
  /** The row's names: the thread's writers, or whom the newest message went to in Sent and Drafts. */
  const who = (t: ThreadSummary) =>
    p.currentFolder && /sent|draft/i.test(p.currentFolder) && t.latest.to.length ? `To: ${t.latest.to.map((a) => displayName(a)).join(', ')}` : participantsLabel(t.participants, p.me);
  const count = (t: ThreadSummary, unread: boolean) => (t.count > 1 ? <span className={cn('ml-1 shrink-0 text-xs', unread ? 'font-bold text-ink' : 'text-muted')}>{t.count}</span> : null);

  return (
    <section className="@container flex h-full min-w-0 flex-col bg-white" aria-label="Messages">
      <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-hairline px-3">
        {p.onShowFolders && !bulk && (
          <Button variant="ghost" size="icon-sm" onClick={p.onShowFolders} aria-label="Show folders">
            <Menu />
          </Button>
        )}
        <input
          type="checkbox"
          className="size-4 shrink-0 accent-primary"
          aria-label={allChecked ? 'Select none' : 'Select all'}
          checked={allChecked}
          ref={(el) => {
            if (el) el.indeterminate = bulk && !allChecked;
          }}
          onChange={(e) => p.onCheckAll(e.target.checked)}
        />
        {bulk ? (
          <div className="flex min-w-0 flex-1 items-center gap-0.5">
            <span className="mr-2 text-sm font-medium whitespace-nowrap">{p.checked.size} selected</span>
            <Button variant="ghost" size="icon-sm" title="Mark as read" aria-label="Mark as read" onClick={() => p.onBulk('read')}>
              <MailOpen />
            </Button>
            <Button variant="ghost" size="icon-sm" title="Mark as unread" aria-label="Mark as unread" onClick={() => p.onBulk('unread')}>
              <Mail />
            </Button>
            <Button variant="ghost" size="icon-sm" title="Star" aria-label="Star" onClick={() => p.onBulk('flag')}>
              <Star />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" title="Move to" aria-label="Move to">
                  <FolderInput />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {moveTargets.map((f) => (
                  <DropdownMenuItem key={f.path} onSelect={() => p.onBulkMove(f.path)}>
                    {f.specialUse ? folderLabel(f) : f.path}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {p.tabMove && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" title="Move to tab" aria-label="Move to tab">
                    <Tag />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuLabel>Move to tab</DropdownMenuLabel>
                  <TabItems tabs={tabTargets(p.tabMove.current)} onSelect={(tab) => p.tabMove!.onMove(p.rows.filter((t) => p.checked.has(t.threadId)).flatMap((t) => t.uids), tab)} />
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <Button variant="ghost" size="icon-sm" title="Delete" aria-label="Delete" onClick={() => p.onBulk('delete')}>
              <Trash2 />
            </Button>
            <Button variant="ghost" size="icon-sm" className="ml-auto" title="Clear selection" aria-label="Clear selection" onClick={() => p.onCheckAll(false)}>
              <X />
            </Button>
          </div>
        ) : (
          <>
            <h1 className={cn('min-w-0 truncate text-base font-semibold', !inlineSearch && 'flex-1')}>{p.title}</h1>
            {inlineSearch && searchField}
            {p.onSearch && !p.searchBar && (
              <Button variant="ghost" size="icon-sm" title="Search" aria-label="Search" aria-pressed={searching} onClick={() => setSearching(!searching)}>
                <Search />
              </Button>
            )}
            {p.readingPane && (
              <Button
                variant="ghost"
                size="icon-sm"
                title={p.readingPane.value === 'full' ? 'Show messages beside the list' : 'Show messages in place of the list'}
                aria-label={p.readingPane.value === 'full' ? 'Show messages beside the list' : 'Show messages in place of the list'}
                onClick={() => p.readingPane!.onChange(p.readingPane!.value === 'full' ? 'split' : 'full')}
              >
                {p.readingPane.value === 'full' ? <Columns2 /> : <PanelTop />}
              </Button>
            )}
            <Button variant="ghost" size="icon-sm" title="Refresh" aria-label="Refresh" onClick={p.onRefresh}>
              <RefreshCw className={cn(p.refreshing && 'animate-spin')} />
            </Button>
            <Tabs value={p.tab} onValueChange={(v) => p.onTab(v as ListTab)}>
              <TabsList>
                <TabsTrigger value="all">All</TabsTrigger>
                <TabsTrigger value="unread">Unread</TabsTrigger>
              </TabsList>
            </Tabs>
          </>
        )}
      </div>
      {showSearch && !inlineSearch && searchField}
      {!p.query && p.tabBar}
      {p.query && (
        <div className="flex shrink-0 items-center gap-2 border-b border-hairline bg-selected-blue px-4 py-1.5 text-[14px]">
          <span className="min-w-0 flex-1 truncate">
            Results for <b>“{p.query}”</b>
          </span>
          <button type="button" className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-primary hover:bg-primary-tint" onClick={p.onClearQuery}>
            <ArrowLeft className="size-3.5" /> Clear search
          </button>
        </div>
      )}
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label={p.title} aria-multiselectable>
        {p.loading && (
          <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted">
            <Loader2 className="size-4 animate-spin" /> Loading messages…
          </div>
        )}
        {p.error && <div className="m-4 rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-danger">{p.error}</div>}
        {!p.loading && !p.error && p.rows.length === 0 && !p.sorting && (
          <div className="p-10 text-center text-sm text-muted">{p.query
              ? 'No messages match your search.'
              : p.tab === 'unread'
                ? 'No unread messages.'
                : p.tabMove?.current && p.tabBar
                  ? p.hasMore
                    ? `Looking for ${TAB_INFO[p.tabMove.current].label} mail…`
                    : `No messages in ${TAB_INFO[p.tabMove.current].label}.`
                  : 'No messages in this folder.'}</div>
        )}
        {p.rows.map((t) => {
          const m = t.latest;
          const id = t.threadId;
          const isOpen = p.openId === id;
          const isCursor = p.cursorId === id;
          const isChecked = p.checked.has(id);
          const unread = t.unread > 0;
          const names = who(t);
          if (p.dense) {
            const act = (e: ReactMouseEvent, a: 'archive' | 'delete' | 'read' | 'unread') => {
              e.stopPropagation();
              p.onRowAction?.(t, a);
            };
            const menuOpen = menuId === id;
            return (
              <div
                key={id}
                data-thread={id}
                role="option"
                aria-selected={isOpen}
                tabIndex={-1}
                onClick={() => p.onOpen(id)}
                {...drag(t)}
                onContextMenu={(e) => {
                  if (!p.onRowAction) return;
                  e.preventDefault();
                  setMenuId(id);
                }}
                className={cn(
                  'group relative flex cursor-pointer flex-col border-b border-hairline pr-3 pl-2 text-sm hover:z-10 hover:shadow-[inset_1px_0_0_#dadce0,inset_-1px_0_0_#dadce0,0_1px_2px_0_rgba(60,64,67,.3),0_1px_3px_1px_rgba(60,64,67,.15)]',
                  unread ? 'bg-white' : 'bg-[#f2f6fc]',
                  isChecked && 'bg-selected-blue',
                  isCursor && 'shadow-[inset_3px_0_0_var(--color-primary)]',
                  menuOpen && 'z-10 shadow-[inset_1px_0_0_#dadce0,inset_-1px_0_0_#dadce0,0_1px_2px_0_rgba(60,64,67,.3),0_1px_3px_1px_rgba(60,64,67,.15)]',
                )}
              >
                <div className="flex h-10 items-center gap-1">
                <div className="flex shrink-0 items-center" onClick={(e) => e.stopPropagation()}>
                  <span className="flex size-8 items-center justify-center">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      aria-label={`Select conversation with ${names}`}
                      checked={isChecked}
                      onChange={(e) => p.onCheck(id, e.target.checked, (e.nativeEvent as MouseEvent).shiftKey)}
                    />
                  </span>
                  <button
                    type="button"
                    aria-label={t.flagged ? 'Unstar' : 'Star'}
                    aria-pressed={t.flagged}
                    className={cn('flex size-8 items-center justify-center rounded-full hover:bg-hover', t.flagged ? 'text-flag' : 'text-faint hover:text-muted')}
                    onClick={() => p.onFlag(t)}
                  >
                    <Star className="size-[18px]" fill={t.flagged ? 'currentColor' : 'none'} strokeWidth={1.75} />
                  </button>
                </div>
                <span className={cn('flex w-[200px] shrink-0 items-baseline pr-4 pl-1', unread ? 'font-bold text-ink' : 'text-ink')}>
                  <span className="min-w-0 truncate">{names}</span>
                  {count(t, unread)}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  <span className={unread ? 'font-bold text-ink' : 'text-ink'}>{conversationSubject(m.subject, t.count) || '(no subject)'}</span>
                  {m.snippet && <span className="text-muted"> - {m.snippet}</span>}
                </span>
                {/* The chips below say it; a message whose files are not known until it is opened keeps the paperclip. */}
                {m.hasAttachments && !m.attachments?.length && <Paperclip className="mx-2 size-4 shrink-0 text-muted" aria-label="Has attachments" />}
                <time dateTime={t.date} title={fullDate(t.date)} className={cn('w-20 shrink-0 text-right text-xs whitespace-nowrap group-hover:hidden', menuOpen && 'hidden', unread ? 'font-bold text-ink' : 'text-muted')}>
                  {listDate(t.date)}
                </time>
                {p.onRowAction && (
                  <span className={cn('hidden shrink-0 items-center group-hover:flex', menuOpen && 'flex')}>
                    <RowAction label="Archive" onClick={(e) => act(e, 'archive')}>
                      <Archive />
                    </RowAction>
                    <RowAction label="Delete" onClick={(e) => act(e, 'delete')}>
                      <Trash2 />
                    </RowAction>
                    <RowAction label={unread ? 'Mark as read' : 'Mark as unread'} onClick={(e) => act(e, unread ? 'read' : 'unread')}>
                      {unread ? <MailOpen /> : <Mail />}
                    </RowAction>
                    <DropdownMenu open={menuOpen} onOpenChange={(o) => setMenuId(o ? id : null)}>
                      <DropdownMenuTrigger asChild>
                        <button type="button" title="More" aria-label="More" onClick={(e) => e.stopPropagation()} className={rowActionClass}>
                          <EllipsisVertical />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                        <DropdownMenuItem onSelect={() => p.onRowAction?.(t, unread ? 'read' : 'unread')}>
                          {unread ? <MailOpen /> : <Mail />} {unread ? 'Mark as read' : 'Mark as unread'}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => p.onFlag(t)}>
                          <Star /> {t.flagged ? 'Remove star' : 'Add star'}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => p.onRowAction?.(t, 'archive')}>
                          <Archive /> Archive
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => p.onRowAction?.(t, 'delete')}>
                          <Trash2 /> Delete
                        </DropdownMenuItem>
                        {p.tabMove && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuSub>
                              <DropdownMenuSubTrigger>
                                <Tag /> Move to tab
                              </DropdownMenuSubTrigger>
                              <DropdownMenuSubContent>
                                <TabItems tabs={tabTargets(t.category ?? p.tabMove.current)} onSelect={(tab) => p.tabMove!.onMove(t.uids, tab)} />
                              </DropdownMenuSubContent>
                            </DropdownMenuSub>
                            {p.tabMove.onWhy && t.category && (
                              <DropdownMenuItem onSelect={() => p.tabMove!.onWhy!(t)}>
                                <CircleHelp /> Why is this in {TAB_INFO[t.category].label}?
                              </DropdownMenuItem>
                            )}
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </span>
                )}
                </div>
                {/* Under the subject, where Gmail puts them: past the checkbox, the star and the names. */}
                {chips(m, 'pb-2 pl-[272px]')}
              </div>
            );
          }
          return (
            <div
              key={id}
              data-thread={id}
              role="option"
              aria-selected={isOpen}
              tabIndex={-1}
              onClick={() => p.onOpen(id)}
              {...drag(t)}
              className={cn(
                'group relative flex cursor-pointer gap-3 border-b border-hairline py-2.5 pr-3 pl-3 text-sm transition-colors hover:bg-panel',
                isChecked && 'bg-selected-blue hover:bg-selected-blue',
                isOpen && 'bg-row-selected hover:bg-row-selected',
                isCursor && !isOpen && 'shadow-[inset_3px_0_0_var(--color-primary)]',
              )}
            >
              <div className="flex shrink-0 flex-col items-center gap-2 pt-0.5" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  aria-label={`Select conversation with ${names}`}
                  checked={isChecked}
                  onChange={(e) => p.onCheck(id, e.target.checked, (e.nativeEvent as MouseEvent).shiftKey)}
                />
                <button
                  type="button"
                  aria-label={t.flagged ? 'Unstar' : 'Star'}
                  aria-pressed={t.flagged}
                  className={cn('rounded p-0.5 hover:bg-hover', t.flagged ? 'text-flag' : 'text-faint opacity-0 group-hover:opacity-100 focus:opacity-100')}
                  onClick={() => p.onFlag(t)}
                >
                  <Star className="size-4" fill={t.flagged ? 'currentColor' : 'none'} strokeWidth={1.75} />
                </button>
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {unread && <span className="size-2 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
                  <span className={cn('flex min-w-0 flex-1 items-baseline', unread ? 'font-semibold text-ink' : 'text-ink')}>
                    <span className="min-w-0 truncate">{names}</span>
                    {count(t, unread)}
                  </span>
                  {(m.hasAttachments || !!m.attachments?.length) && (
                    <Paperclip className={cn('size-3.5 shrink-0 text-muted', !!m.attachments?.length && CHIPS_PAPERCLIP)} aria-label="Has attachments" />
                  )}
                  <time dateTime={t.date} title={fullDate(t.date)} className={cn('shrink-0 text-xs', unread ? 'font-semibold text-ink' : 'text-muted')}>
                    {rowDate(t.date)}
                  </time>
                </div>
                <div className={cn('truncate text-[14px]', unread ? 'font-semibold text-ink' : 'text-ink')}>{conversationSubject(m.subject, t.count) || '(no subject)'}</div>
                {m.snippet && <div className="line-clamp-1 text-[14px] text-muted">{m.snippet}</div>}
                {chips(m, 'mt-1.5')}
              </div>
            </div>
          );
        })}
        {p.sorting && (
          <div role="status" className="flex items-center justify-center gap-2 p-4 text-xs text-muted">
            <Loader2 className="size-3.5 animate-spin" /> Sorting older mail…
          </div>
        )}
        {p.hasMore && (
          <div ref={sentinel} className="flex items-center justify-center p-4 text-xs text-muted">
            {p.loadingMore ? <Loader2 className="size-4 animate-spin" /> : <button type="button" onClick={p.onLoadMore} className="hover:underline">Load more</button>}
          </div>
        )}
      </div>
      {previewing && previewing.m.attachments?.[previewing.at] && (
        <AttachmentPreview
          accountId={p.accountId}
          message={previewing.m}
          files={previewing.m.attachments}
          index={previewing.at}
          onIndex={(at) => setPreviewing((v) => (v ? { ...v, at } : v))}
          onClose={() => setPreviewing(null)}
        />
      )}
    </section>
  );
}

function TabItems({ tabs, onSelect }: { tabs: Category[]; onSelect(tab: Category): void }) {
  return tabs.map((t) => {
    const Icon = TAB_ICONS[t];
    return (
      <DropdownMenuItem key={t} onSelect={() => onSelect(t)}>
        <Icon /> {TAB_INFO[t].label}
      </DropdownMenuItem>
    );
  });
}

const rowActionClass = 'flex size-8 items-center justify-center rounded-full text-muted hover:bg-hover hover:text-ink [&_svg]:size-[18px]';

function RowAction({ label, onClick, children }: { label: string; onClick(e: ReactMouseEvent): void; children: ReactNode }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} className={rowActionClass}>
      {children}
    </button>
  );
}
