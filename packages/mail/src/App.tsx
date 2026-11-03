// FreeFlow Mail: the suite bar, the folders on the left, the list and the reading pane on the right (side by side on
// wide screens; the list, then the message with a back button, under 900px; the folders behind a button under
// 760px), compose and the account dialogs, and the keyboard.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { openSuiteSearch } from '@flow/suite-bar';
import { MailApiError, mailApi, type Category, type MailAccount, type MessageSummary } from './api';
import { AccountSettingsDialog, AddAccountDialog } from './components/AccountForms';
import type { ComposeRequest } from './components/Compose';
import { ConnectMail } from './components/ConnectMail';
import { InboxTabs } from './components/InboxTabs';
import { MailSuiteBar } from './components/MailSuiteBar';
import { MessageList, type ListTab } from './components/MessageList';
import { MessageView } from './components/MessageView';
import { ResizeHandle } from './components/ResizeHandle';
import { setReadingPane, useReadingPane } from './lib/layoutPref';
import { Sidebar } from './components/Sidebar';
import { useMediaQuery, useResizableWidth } from './hooks/layout';
import { keys, prefetchMessage, useAccounts, useCategories, useFolders, useMessage, useMessageActions, useMessages } from './hooks/mail';
import { emptyDraft, prefill, type ComposeMode } from './lib/compose';
import { findSpecial, folderLabel } from './lib/folders';
import { markOpened, TAB_INFO, tabFromParam, tabsOf, useSince, writeTabParam } from './lib/tabs';
import { cn } from './lib/utils';

// The editor (TipTap) is most of the code: it loads when compose first opens.
const Compose = lazy(() => import('./components/Compose').then((m) => ({ default: m.Compose })));

const ACCOUNT_KEY = 'flow.mail.account';
const errorText = (e: unknown) => (e instanceof Error ? e.message : e ? String(e) : null);

function initialParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}
function storedAccount(): string | null {
  try {
    return initialParam('account') ?? localStorage.getItem(ACCOUNT_KEY);
  } catch {
    return initialParam('account');
  }
}

/** A passing message at the bottom, with an action (Undo) for some. */
type Toast = string | { text: string; action: { label: string; run(): void } };

type Dialog = { kind: 'add' } | { kind: 'settings'; accountId: string | null; focusPassword?: boolean } | null;

export function App() {
  const qc = useQueryClient();
  const accounts = useAccounts();
  const narrow = useMediaQuery('(max-width: 899px)');
  // The open message in place of the list (Gmail's way, or any narrow screen), or beside it.
  const readingPane = useReadingPane();
  const stacked = narrow || readingPane === 'full';
  const tiny = useMediaQuery('(max-width: 759px)');
  const sidebar = useResizableWidth('flow.mail.sidebarWidth', 248, 180, 480);
  const listPane = useResizableWidth('flow.mail.listWidth', 420, 300, 720);

  const [accountId, setAccountId] = useState<string | null>(storedAccount);
  const list = accounts.data ?? [];
  const account: MailAccount | null = list.find((a) => a.id === accountId) ?? list[0] ?? null;
  const folders = useFolders(account?.id ?? null);
  const [folderChoice, setFolderChoice] = useState<string | null>(() => initialParam('folder'));
  const folder = folders.data
    ? folderChoice && folders.data.some((f) => f.path === folderChoice)
      ? folderChoice
      : (findSpecial(folders.data, 'inbox')?.path ?? folders.data[0]?.path ?? null)
    : (folderChoice ?? 'INBOX');
  const folderInfo = folders.data?.find((f) => f.path === folder) ?? null;

  const [searchText, setSearchText] = useState('');
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<ListTab>('all');
  const [openUid, setOpenUid] = useState<number | null>(() => (initialParam('uid') ? Number(initialParam('uid')) : null));
  const [cursorUid, setCursorUid] = useState<number | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const lastChecked = useRef<number | null>(null);
  const [compose, setCompose] = useState<ComposeRequest | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [drawer, setDrawer] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);

  // Gmail's inbox tabs: in INBOX, for an account that has them on; a search covers the whole folder, whatever the tab.
  const [tabChoice, setTabChoice] = useState<string | null>(() => initialParam('tab'));
  const accountTabs = useMemo(() => tabsOf(account), [account]);
  const showTabs = folder?.toUpperCase() === 'INBOX' && accountTabs.length > 0;
  const inboxTab = tabFromParam(tabChoice, accountTabs);
  const category: Category | null = showTabs && !q ? inboxTab : null;
  const since = useSince(account?.id ?? null, accountTabs);
  const tabCounts = useCategories(account?.id ?? null, showTabs, since);

  const messages = useMessages(account?.id ?? null, folder, q, category);
  const all = useMemo(() => messages.data?.pages.flatMap((p) => p.messages) ?? [], [messages.data]);
  const visible = useMemo(() => (tab === 'unread' ? all.filter((m) => !m.seen || m.uid === openUid) : all), [all, tab, openUid]);
  const message = useMessage(account?.id ?? null, folder, openUid);
  const actions = useMessageActions(account?.id ?? null, folder);

  // Where we are, in the address (so a reload comes back to it) and the account in this browser.
  useEffect(() => {
    if (!account) return;
    try {
      localStorage.setItem(ACCOUNT_KEY, account.id);
    } catch {
      // Not kept.
    }
    const params = new URLSearchParams();
    params.set('account', account.id);
    if (folder) params.set('folder', folder);
    writeTabParam(params, showTabs ? inboxTab : null);
    if (openUid !== null) params.set('uid', String(openUid));
    window.history.replaceState(null, '', `${import.meta.env.BASE_URL}?${params}`);
  }, [account, folder, openUid, showTabs, inboxTab]);

  // The open tab's mail is not "new": it is marked opened on arriving and again on leaving it.
  useEffect(() => {
    const id = account?.id;
    if (!id || !category) return;
    markOpened(id, category);
    return () => markOpened(id, category);
  }, [account?.id, category]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), typeof toast === 'string' ? 4000 : 8000);
    return () => window.clearTimeout(t);
  }, [toast]);

  // Opening a message marks it read (the server's GET does not): once it is on screen, after the frame that shows it, and
  // not for one passed over before it was drawn.
  const marked = useRef(new Set<string>());
  const markSeen = actions.flags.mutate;
  useEffect(() => {
    const m = message.data;
    if (!m || m.seen || !account || m.uid !== openUid) return;
    const key = `${account.id}:${m.folder}:${m.uid}`;
    if (marked.current.has(key)) return;
    let timer = 0;
    const frame = requestAnimationFrame(() => {
      timer = window.setTimeout(() => {
        marked.current.add(key);
        markSeen({ uids: [m.uid], seen: true });
      }, 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [message.data, account, openUid, markSeen]);

  // The next (older) message is read ahead once this one is in, so j opens it at once.
  const nextUid = useMemo(() => {
    const i = visible.findIndex((m) => m.uid === openUid);
    return i >= 0 ? (visible[i + 1]?.uid ?? null) : null;
  }, [visible, openUid]);
  const openLoaded = !!message.data && message.data.uid === openUid;
  useEffect(() => {
    if (!account || !folder || nextUid === null || !openLoaded) return;
    void prefetchMessage(qc, account.id, folder, nextUid);
  }, [qc, account, folder, nextUid, openLoaded]);

  const resetSelection = () => {
    setOpenUid(null);
    setCursorUid(null);
    setChecked(new Set());
  };
  const chooseFolder = (path: string) => {
    setFolderChoice(path);
    setTabChoice(null);
    setQ('');
    setSearchText('');
    resetSelection();
    setDrawer(false);
  };
  const chooseAccount = (id: string) => {
    setAccountId(id);
    setFolderChoice(null);
    setTabChoice(null);
    setQ('');
    setSearchText('');
    resetSelection();
    setDrawer(false);
  };

  const openMessage = useCallback((uid: number) => {
    setOpenUid(uid);
    setCursorUid(uid);
  }, []);

  /** The messages an action applies to: the checked ones, else the open one, else the keyboard's. */
  const targets = (): number[] => (checked.size ? [...checked] : openUid !== null ? [openUid] : cursorUid !== null ? [cursorUid] : []);
  /** After the open message leaves the list, the next one (older) opens on wide screens, as mail apps do. */
  const afterRemoving = (uids: number[]) => {
    const gone = new Set(uids);
    if (openUid !== null && gone.has(openUid)) {
      const i = visible.findIndex((m) => m.uid === openUid);
      const next = visible.slice(i + 1).find((m) => !gone.has(m.uid)) ?? visible.slice(0, i).reverse().find((m) => !gone.has(m.uid));
      if (next && !stacked) openMessage(next.uid);
      else {
        setOpenUid(null);
        setCursorUid(next?.uid ?? null);
      }
    }
    setChecked(new Set());
  };
  const plural = (n: number) => (n === 1 ? 'Message' : `${n} messages`);
  const archive = (uids = targets()) => {
    if (!uids.length) return;
    const to = findSpecial(folders.data, 'archive') ?? findSpecial(folders.data, 'all');
    if (!to || to.path === folder) return setToast('This account has no Archive folder. Use Move to instead.');
    afterRemoving(uids);
    actions.move.mutate({ uids, to: to.path }, { onSuccess: () => setToast(`${plural(uids.length)} archived.`), onError: (e) => setToast(`Could not archive: ${errorText(e)}`) });
  };
  const remove = (uids = targets()) => {
    if (!uids.length) return;
    afterRemoving(uids);
    const inTrash = folderInfo?.specialUse === 'trash';
    actions.remove.mutate({ uids }, { onSuccess: () => setToast(inTrash ? `${plural(uids.length)} deleted forever.` : `${plural(uids.length)} moved to Trash.`), onError: (e) => setToast(`Could not delete: ${errorText(e)}`) });
  };
  const moveTo = (to: string, uids = targets()) => {
    if (!uids.length) return;
    afterRemoving(uids);
    const name = folders.data?.find((f) => f.path === to);
    actions.move.mutate({ uids, to }, { onSuccess: () => setToast(`${plural(uids.length)} moved to ${name ? folderLabel(name) : to}.`), onError: (e) => setToast(`Could not move: ${errorText(e)}`) });
  };
  const byUid = (uid: number): MessageSummary | undefined => all.find((m) => m.uid === uid);
  const chooseTab = (tab: Category) => {
    setTabChoice(tab);
    resetSelection();
  };
  /**
   * "Move to tab": the messages go there, and so does their senders' later mail (the server keeps the tab per sender);
   * the toast says so, with Undo, which puts each sender back as it was.
   */
  const moveToTab = (uids: number[], tab: Category) => {
    if (!uids.length || !account) return;
    const accountIdNow = account.id;
    if (category && category !== tab) afterRemoving(uids);
    else setChecked(new Set());
    const label = TAB_INFO[tab].label;
    actions.moveToTab.mutate(
      { uids, category: tab },
      {
        onSuccess: (res) => {
          const who = res.senders.length === 1 ? (all.find((m) => m.from?.address.toLowerCase() === res.senders[0])?.from?.name || res.senders[0]) : `these ${res.senders.length} senders`;
          setToast({
            text: res.senders.length ? `Mail from ${who} now goes to ${label}.` : `${plural(uids.length)} moved to ${label}.`,
            action: {
              label: 'Undo',
              run: () =>
                void mailApi.setSenderTabs(accountIdNow, res.previous).then(
                  () => {
                    void qc.invalidateQueries({ queryKey: keys.allMessages(accountIdNow) });
                    void qc.invalidateQueries({ queryKey: ['mail', 'categories', accountIdNow] });
                    setToast('Move undone.');
                  },
                  (e: unknown) => setToast(`Could not undo: ${errorText(e)}`),
                ),
            },
          });
        },
        onError: (e) => setToast(`Could not move: ${errorText(e)}`),
      },
    );
  };
  const setSeen = (uids: number[], seen: boolean) => uids.length && actions.flags.mutate({ uids, seen });
  const toggleSeen = (uids = targets()) => {
    if (!uids.length) return;
    const anyUnread = uids.some((u) => byUid(u)?.seen === false || (u === openUid && message.data?.seen === false));
    setSeen(uids, anyUnread);
    // Marking the open message unread closes it, so it stays unread.
    if (!anyUnread && openUid !== null && uids.includes(openUid)) {
      marked.current.add(`${account?.id}:${folder}:${openUid}`);
      if (stacked) setOpenUid(null);
    }
  };
  const toggleFlag = (uids = targets()) => {
    if (!uids.length) return;
    const anyUnflagged = uids.some((u) => !(byUid(u)?.flagged ?? (u === openUid && message.data?.flagged)));
    actions.flags.mutate({ uids, flagged: anyUnflagged });
  };

  const startCompose = useCallback(
    (mode: ComposeMode) => {
      if (!account) return;
      if (mode === 'new') return setCompose({ mode, draft: emptyDraft() });
      const m = message.data;
      if (!m) return;
      setCompose({ mode, draft: prefill(mode, m, account.email), source: { folder: m.folder, uid: m.uid } });
    },
    [account, message.data],
  );

  const onCheck = (uid: number, on: boolean, range: boolean) => {
    setChecked((cur) => {
      const next = new Set(cur);
      if (range && lastChecked.current !== null) {
        const a = visible.findIndex((m) => m.uid === lastChecked.current);
        const b = visible.findIndex((m) => m.uid === uid);
        if (a >= 0 && b >= 0) for (const m of visible.slice(Math.min(a, b), Math.max(a, b) + 1)) on ? next.add(m.uid) : next.delete(m.uid);
      }
      on ? next.add(uid) : next.delete(uid);
      return next;
    });
    lastChecked.current = uid;
  };

  /** The message after (1, older) or before (-1, newer) the open one in the list. */
  const step = (by: 1 | -1) => {
    const i = visible.findIndex((m) => m.uid === openUid);
    const m = i < 0 ? undefined : visible[i + by];
    if (!m) return;
    setCursorUid(m.uid);
    setOpenUid(m.uid);
  };

  // The keyboard, as in other mail apps. Not while typing, and not under a dialog.
  const keyState = useRef({ visible, cursorUid, openUid, narrow: stacked });
  keyState.current = { visible, cursorUid, openUid, narrow: stacked };
  const handlers = useRef({ archive, remove, toggleSeen, startCompose });
  handlers.current = { archive, remove, toggleSeen, startCompose };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      const typing = t && (t.isContentEditable || /^(TEXTAREA|SELECT)$/.test(t.tagName) || (t.tagName === 'INPUT' && !/^(checkbox|radio|button)$/.test((t as HTMLInputElement).type)));
      if (typing) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      const { visible: v, cursorUid: cur, openUid: open, narrow: isNarrow } = keyState.current;
      const h = handlers.current;
      const at = v.findIndex((m) => m.uid === (cur ?? open));
      const go = (i: number) => {
        const m = v[Math.max(0, Math.min(v.length - 1, i))];
        if (!m) return;
        setCursorUid(m.uid);
        // Side by side, the message follows the keyboard. In place of the list, j/k move the selection in the list, and
        // with a message open they open the next (older) or previous (newer) one, as Gmail does.
        if (!isNarrow || open !== null) setOpenUid(m.uid);
      };
      switch (e.key) {
        case 'j':
          go(at < 0 ? 0 : at + 1);
          break;
        case 'k':
          go(at < 0 ? 0 : at - 1);
          break;
        case 'Enter':
          if (cur !== null) setOpenUid(cur);
          else return;
          break;
        case 'e':
          h.archive();
          break;
        case '#':
          h.remove();
          break;
        case 'u':
          h.toggleSeen();
          break;
        case 'r':
          h.startCompose('reply');
          break;
        case 'a':
          h.startCompose('replyAll');
          break;
        case 'f':
          h.startCompose('forward');
          break;
        case 'c':
          h.startCompose('new');
          break;
        case '/':
          openSuiteSearch();
          break;
        case 'Escape':
          if (isNarrow && open !== null) setOpenUid(null);
          setChecked(new Set());
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const inboxUnread = findSpecial(folders.data, 'inbox')?.unread ?? 0;
  const bar = (
    <MailSuiteBar
      search={{
        placeholder: folderInfo ? `Search ${folderLabel(folderInfo)}` : 'Search mail',
        value: searchText,
        onChange: (text) => {
          setSearchText(text);
          // Emptying the field (or Esc) ends the search.
          if (!text.trim() && q) setQ('');
        },
        onSubmit: (text) => {
          setSearchText(text);
          setQ(text.trim());
          resetSelection();
        },
      }}
      unread={inboxUnread}
      onSettings={() => setDialog({ kind: 'settings', accountId: account?.id ?? null })}
    />
  );
  const dialogs = (
    <>
      {dialog?.kind === 'add' && (
        <AddAccountDialog
          defaultName={qc.getQueryData<{ displayName: string }>(['suite', 'me'])?.displayName ?? ''}
          onClose={() => setDialog(null)}
          onAdded={(a) => {
            setDialog(null);
            chooseAccount(a.id);
            setToast(`${a.email} is connected.`);
          }}
        />
      )}
      {dialog?.kind === 'settings' && (
        <AccountSettingsDialog
          accounts={list}
          initialId={dialog.accountId}
          {...(dialog.focusPassword ? { focusPassword: true } : {})}
          onClose={() => {
            setDialog(null);
            void qc.invalidateQueries({ queryKey: ['mail'] });
          }}
          onRemoved={(id) => {
            setDialog(null);
            if (id === account?.id) chooseAccount(list.find((a) => a.id !== id)?.id ?? '');
            setToast('The account was removed.');
          }}
        />
      )}
      {toast && (
        <div role="status" className="fixed bottom-5 left-1/2 z-[60] flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-4 rounded-lg bg-[#323232] px-4 py-2.5 text-sm text-white shadow-lg">
          <span>{typeof toast === 'string' ? toast : toast.text}</span>
          {typeof toast !== 'string' && (
            <button
              type="button"
              className="shrink-0 rounded px-1.5 py-0.5 font-semibold text-[#8ab4f8] hover:bg-white/10"
              onClick={() => {
                setToast(null);
                toast.action.run();
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </>
  );

  if (accounts.isPending) {
    return (
      <div className="flex h-dvh flex-col">
        {bar}
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted">
          <Loader2 className="size-4 animate-spin" /> Loading your mail…
        </div>
      </div>
    );
  }
  if (accounts.error) {
    return (
      <div className="flex h-dvh flex-col">
        {bar}
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="max-w-md rounded-xl border border-danger/30 bg-danger/5 p-5 text-sm">
            <div className="mb-1 font-semibold text-danger">Mail could not be loaded.</div>
            <div className="text-muted">{errorText(accounts.error)}</div>
          </div>
        </div>
      </div>
    );
  }
  if (!account) {
    return (
      <div className="flex h-dvh flex-col">
        {bar}
        <ConnectMail onAdd={() => setDialog({ kind: 'add' })} />
        {dialogs}
      </div>
    );
  }

  const folderError = folders.error instanceof MailApiError && (folders.error.code === 'auth_failed' || folders.error.code === 'connect_failed') ? folders.error : null;
  const needsLogin = account.status !== 'ok' || folderError;
  const sidebarEl = (
    <Sidebar
      accounts={list}
      account={account}
      onAccount={chooseAccount}
      folders={folders.data ?? (folders.error ? [] : undefined)}
      folder={folder}
      onFolder={chooseFolder}
      onCompose={() => {
        setDrawer(false);
        startCompose('new');
      }}
      onAddAccount={() => setDialog({ kind: 'add' })}
      onSettings={() => setDialog({ kind: 'settings', accountId: account.id })}
    />
  );
  const listEl = (
    <MessageList
      title={folderInfo ? folderLabel(folderInfo) : folder === 'INBOX' ? 'Inbox' : (folder ?? '')}
      messages={visible}
      loading={messages.isPending && !!folder && !needsLogin}
      error={needsLogin ? `Mail from ${account.email} appears here once FreeFlow can sign in to it again.` : errorText(messages.error)}
      refreshing={messages.isFetching && !messages.isFetchingNextPage && !messages.isPending}
      onRefresh={() => {
        void messages.refetch();
        void folders.refetch();
        if (showTabs) void tabCounts.refetch();
      }}
      hasMore={!!messages.hasNextPage}
      loadingMore={messages.isFetchingNextPage}
      onLoadMore={() => void messages.fetchNextPage()}
      tab={tab}
      onTab={setTab}
      query={q}
      onClearQuery={() => {
        setQ('');
        setSearchText('');
      }}
      openUid={openUid}
      cursorUid={cursorUid}
      readingPane={narrow ? undefined : { value: readingPane, onChange: setReadingPane }}
      dense={!narrow && readingPane === 'full'}
      onRowAction={(m, a) => (a === 'archive' ? archive([m.uid]) : a === 'delete' ? remove([m.uid]) : setSeen([m.uid], a === 'read'))}
      onOpen={openMessage}
      checked={checked}
      onCheck={onCheck}
      onCheckAll={(on) => setChecked(on ? new Set(visible.map((m) => m.uid)) : new Set())}
      onFlag={(m) => actions.flags.mutate({ uids: [m.uid], flagged: !m.flagged })}
      onBulk={(a) => {
        const uids = [...checked];
        if (a === 'read' || a === 'unread') setSeen(uids, a === 'read');
        else if (a === 'flag' || a === 'unflag') actions.flags.mutate({ uids, flagged: a === 'flag' });
        else remove(uids);
      }}
      onBulkMove={(to) => moveTo(to, [...checked])}
      folders={folders.data}
      currentFolder={folder}
      onShowFolders={tiny ? () => setDrawer(true) : undefined}
      tabBar={showTabs ? <InboxTabs tabs={accountTabs} active={inboxTab} counts={tabCounts.data} onChange={chooseTab} /> : undefined}
      tabMove={showTabs ? { tabs: accountTabs, current: category, onMove: moveToTab } : undefined}
      onSearch={
        tiny
          ? (text) => {
              setSearchText(text);
              setQ(text);
              resetSelection();
            }
          : undefined
      }
    />
  );
  const view = (
    <MessageView
      accountId={account.id}
      message={message.data}
      loading={openUid !== null && message.isPending}
      error={errorText(message.error)}
      folders={folders.data}
      canArchive={!!(findSpecial(folders.data, 'archive') ?? findSpecial(folders.data, 'all')) && folderInfo?.specialUse !== 'archive'}
      onBack={stacked ? () => setOpenUid(null) : undefined}
      position={stacked && openUid !== null ? { index: visible.findIndex((m) => m.uid === openUid), count: visible.length } : undefined}
      onNewer={stacked ? () => step(-1) : undefined}
      onOlder={stacked ? () => step(1) : undefined}
      onReply={() => startCompose('reply')}
      onReplyAll={() => startCompose('replyAll')}
      onForward={() => startCompose('forward')}
      onArchive={() => archive(openUid !== null ? [openUid] : [])}
      onMove={(to) => moveTo(to, openUid !== null ? [openUid] : [])}
      tabMove={showTabs && openUid !== null ? { tabs: accountTabs, current: byUid(openUid)?.category ?? category, onMove: (tab) => moveToTab([openUid], tab) } : undefined}
      onDelete={() => remove(openUid !== null ? [openUid] : [])}
      onToggleSeen={() => toggleSeen(openUid !== null ? [openUid] : [])}
      onToggleFlag={() => toggleFlag(openUid !== null ? [openUid] : [])}
    />
  );

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      {bar}
      {needsLogin && (
        <div role="alert" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-warn-border bg-warn-bg px-4 py-2 text-[13px]">
          <AlertTriangle className="size-4 shrink-0 text-[#b06000]" />
          <span className="min-w-0 flex-1">
            {account.status === 'connect_failed' || folderError?.code === 'connect_failed'
              ? `FreeFlow could not reach the mail server for ${account.email}.`
              : `${account.email} stopped accepting its password. Enter it again to keep getting mail.`}
            {(account.statusMessage ?? folderError?.message) && <span className="text-muted"> {account.statusMessage ?? folderError?.message}</span>}
          </span>
          <button type="button" className="font-medium text-primary hover:underline" onClick={() => setDialog({ kind: 'settings', accountId: account.id, focusPassword: true })}>
            {account.status === 'connect_failed' || folderError?.code === 'connect_failed' ? 'Check settings' : 'Re-enter password'}
          </button>
        </div>
      )}
      <div className="relative flex min-h-0 flex-1">
        {!tiny && (
          <>
            <div style={{ width: sidebar.width }} className="shrink-0 border-r border-hairline">
              {sidebarEl}
            </div>
            <ResizeHandle label="Resize the folders" {...sidebar.handleProps} />
          </>
        )}
        {tiny && drawer && (
          <div className="absolute inset-0 z-40 flex" onClick={() => setDrawer(false)}>
            <div className="h-full w-[min(300px,85vw)] border-r border-hairline shadow-xl" onClick={(e) => e.stopPropagation()}>
              {sidebarEl}
            </div>
            <div className="flex-1 bg-black/30" />
          </div>
        )}
        <div className="flex min-w-0 flex-1">
          {stacked ? (
            // The list stays mounted under the open message, so going back finds it where it was.
            <div className="relative min-w-0 flex-1">
              <div className={cn('h-full', openUid !== null && 'invisible')}>{listEl}</div>
              {openUid !== null && <div className="absolute inset-0 z-10">{view}</div>}
            </div>
          ) : (
            <>
              <div style={{ width: listPane.width }} className={cn('shrink-0 border-r border-hairline')}>
                {listEl}
              </div>
              <ResizeHandle label="Resize the message list" {...listPane.handleProps} />
              <div className="min-w-0 flex-1">{view}</div>
            </>
          )}
        </div>
      </div>
      {compose && (
        <Suspense fallback={null}>
          <Compose
            key={`${compose.mode}-${compose.source?.uid ?? 'new'}`}
            account={account}
            request={compose}
            narrow={narrow}
            onClose={() => setCompose(null)}
            onSent={() => {
              setCompose(null);
              setToast('Message sent.');
              void qc.invalidateQueries({ queryKey: keys.allMessages(account.id) });
              void qc.invalidateQueries({ queryKey: keys.folders(account.id) });
            }}
          />
        </Suspense>
      )}
      {dialogs}
    </div>
  );
}
