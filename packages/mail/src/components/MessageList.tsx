// The open folder's messages, after shadcn/ui's Mail example's list (MIT, see LICENSE-shadcn.md): All / Unread, the
// rows (sender, subject, snippet, date, unread dot, flag, attachment), checkboxes for acting on several at once, and
// more rows as the list scrolls to its end (`before=`).
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Columns2, FolderInput, PanelTop, Loader2, Mail, MailOpen, Menu, Paperclip, RefreshCw, Search, Star, Trash2, X } from 'lucide-react';
import type { MailFolder, MessageSummary } from '../api';
import { displayName } from '../lib/addresses';
import { folderLabel, orderFolders } from '../lib/folders';
import { listDate, fullDate, relativeDate } from '../lib/format';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs';

export type ListTab = 'all' | 'unread';

export interface MessageListProps {
  title: string;
  messages: MessageSummary[];
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
  openUid: number | null;
  cursorUid: number | null;
  onOpen(uid: number): void;
  checked: Set<number>;
  onCheck(uid: number, on: boolean, range: boolean): void;
  onCheckAll(on: boolean): void;
  onFlag(m: MessageSummary): void;
  onBulk(action: 'read' | 'unread' | 'flag' | 'unflag' | 'delete'): void;
  onBulkMove(to: string): void;
  folders: MailFolder[] | undefined;
  currentFolder: string | null;
  /** Wide screens: the open message beside the list ('split') or in its place ('full'). */
  readingPane?: { value: 'full' | 'split'; onChange(v: 'full' | 'split'): void } | undefined;
  /** On a narrow screen, the button that opens the folders. */
  onShowFolders?: (() => void) | undefined;
  /** On a phone, where the suite bar has no search: a search field of the list's own. */
  onSearch?: ((q: string) => void) | undefined;
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
  const [draft, setDraft] = useState('');

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !loadingMore) onLoadMore();
    }, { root: scroller.current, rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadingMore, onLoadMore, p.messages.length]);

  // The keyboard's row stays in view.
  useEffect(() => {
    if (p.cursorUid === null) return;
    scroller.current?.querySelector(`[data-uid="${p.cursorUid}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [p.cursorUid]);

  const allChecked = p.messages.length > 0 && p.messages.every((m) => p.checked.has(m.uid));
  const bulk = p.checked.size > 0;
  const moveTargets = (() => {
    const { special, tree } = orderFolders(p.folders ?? []);
    const flat: MailFolder[] = [...special];
    const walk = (nodes: typeof tree) => nodes.forEach((n) => (n.folder && flat.push(n.folder), walk(n.children)));
    walk(tree);
    return flat.filter((f) => f.path !== p.currentFolder);
  })();

  return (
    <section className="flex h-full min-w-0 flex-col bg-white" aria-label="Messages">
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
            <Button variant="ghost" size="icon-sm" title="Delete" aria-label="Delete" onClick={() => p.onBulk('delete')}>
              <Trash2 />
            </Button>
            <Button variant="ghost" size="icon-sm" className="ml-auto" title="Clear selection" aria-label="Clear selection" onClick={() => p.onCheckAll(false)}>
              <X />
            </Button>
          </div>
        ) : (
          <>
            <h1 className="min-w-0 flex-1 truncate text-base font-semibold">{p.title}</h1>
            {p.onSearch && (
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
      {p.onSearch && searching && (
        <form
          className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            p.onSearch?.(draft.trim());
          }}
        >
          <input
            autoFocus
            type="search"
            aria-label="Search mail"
            placeholder={`Search ${p.title}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-white px-3 text-sm outline-none focus:border-primary"
          />
        </form>
      )}
      {p.query && (
        <div className="flex shrink-0 items-center gap-2 border-b border-hairline bg-selected-blue px-4 py-1.5 text-[13px]">
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
        {!p.loading && !p.error && p.messages.length === 0 && (
          <div className="p-10 text-center text-sm text-muted">{p.query ? 'No messages match your search.' : p.tab === 'unread' ? 'No unread messages.' : 'No messages in this folder.'}</div>
        )}
        {p.messages.map((m) => {
          const isOpen = p.openUid === m.uid;
          const isCursor = p.cursorUid === m.uid;
          const isChecked = p.checked.has(m.uid);
          const who = p.currentFolder && /sent|draft/i.test(p.currentFolder) && m.to.length ? `To: ${m.to.map((a) => displayName(a)).join(', ')}` : displayName(m.from);
          return (
            <div
              key={m.uid}
              data-uid={m.uid}
              role="option"
              aria-selected={isOpen}
              tabIndex={-1}
              onClick={() => p.onOpen(m.uid)}
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
                  aria-label={`Select message from ${displayName(m.from)}`}
                  checked={isChecked}
                  onChange={(e) => p.onCheck(m.uid, e.target.checked, (e.nativeEvent as MouseEvent).shiftKey)}
                />
                <button
                  type="button"
                  aria-label={m.flagged ? 'Unstar' : 'Star'}
                  aria-pressed={m.flagged}
                  className={cn('rounded p-0.5 hover:bg-hover', m.flagged ? 'text-flag' : 'text-faint opacity-0 group-hover:opacity-100 focus:opacity-100')}
                  onClick={() => p.onFlag(m)}
                >
                  <Star className="size-4" fill={m.flagged ? 'currentColor' : 'none'} strokeWidth={1.75} />
                </button>
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {!m.seen && <span className="size-2 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
                  <span className={cn('min-w-0 flex-1 truncate', !m.seen ? 'font-semibold text-ink' : 'text-ink')}>{who}</span>
                  {m.hasAttachments && <Paperclip className="size-3.5 shrink-0 text-muted" aria-label="Has attachments" />}
                  <time dateTime={m.date} title={fullDate(m.date)} className={cn('shrink-0 text-xs', !m.seen ? 'font-semibold text-ink' : 'text-muted')}>
                    {rowDate(m.date)}
                  </time>
                </div>
                <div className={cn('truncate text-[13px]', !m.seen ? 'font-semibold text-ink' : 'text-ink')}>{m.subject || '(no subject)'}</div>
                {m.snippet && <div className="line-clamp-1 text-[13px] text-muted">{m.snippet}</div>}
              </div>
            </div>
          );
        })}
        {p.hasMore && (
          <div ref={sentinel} className="flex items-center justify-center p-4 text-xs text-muted">
            {p.loadingMore ? <Loader2 className="size-4 animate-spin" /> : <button type="button" onClick={p.onLoadMore} className="hover:underline">Load more</button>}
          </div>
        )}
      </div>
    </section>
  );
}
