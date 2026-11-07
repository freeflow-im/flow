// FreeFlow Mail: the suite bar, the folders on the left, the list of conversations and the reading pane on the right
// (side by side on wide screens; the list, then the thread with a back button, under 900px; the folders behind a button
// under 760px), compose and the account dialogs, and the keyboard.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { openSuiteSearch } from '@flow/suite-bar';
import { MailApiError, mailApi, setMailWorkspace, type Category, type MailAccount, type MessageDetail, type ThreadSummary, type TabStatus } from './api';
import { AccountSettingsDialog, AddAccountDialog } from './components/AccountForms';
import { ConnectMail } from './components/ConnectMail';
import { NoOrganization } from './components/NoOrganization';
import { InboxTabs } from './components/InboxTabs';
import { MailSuiteBar } from './components/MailSuiteBar';
import { MessageList, type ListTab } from './components/MessageList';
import { ThreadView, type ThreadViewHandle } from './components/ThreadView';
import { ResizeHandle } from './components/ResizeHandle';
import { setReadingPane, useReadingPane } from './lib/layoutPref';
import { Sidebar } from './components/Sidebar';
import { useMediaQuery, useResizableWidth } from './hooks/layout';
import { fetchBody, keys, prefetchThread, useAccounts, useFolders, useMessageActions, useMessages, useThread, useThreads, useTabStatus } from './hooks/mail';
import { useMailAssistant } from './hooks/assistant';
import { useOrganizations } from './hooks/organization';
import { mailContext, setAssistantOpen, useAssistantOpen, type MessageRef } from './lib/assistant';
import { cidUrlOf, emptyDraft, fromDraft, prefill, type ComposeMode, type ComposeRequest, type Outgoing } from './lib/compose';
import type { Notice } from './lib/notice';
import { sendInBackground } from './lib/outgoing';
import { findSpecial, folderLabel } from './lib/folders';
import { folderDropTarget, tabDropTarget, useCanDrag } from './lib/dnd';
import { TAB_INFO, reasonText, tabFromParam, tabsOf, writeTabParam, markTabSeen, readTabSeen, type TabSeen } from './lib/tabs';
import { expandedByDefault, groupByThread, replyTarget, soloThreadId } from './lib/threads';
import { cn } from './lib/utils';

// The editor (TipTap) is most of the code: it loads when compose first opens.
const Compose = lazy(() => import('./components/Compose').then((m) => ({ default: m.Compose })));
// The assistant's panel (and the Markdown of its replies) loads when it first opens.
const AssistantPanel = lazy(() => import('./components/AssistantPanel').then((m) => ({ default: m.AssistantPanel })));

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

/** A passing message at the bottom, with an action (Undo, Open) for some; one in progress ("Sending…") stays until replaced. */
type Toast = Notice;

type Dialog = { kind: 'add' } | { kind: 'settings'; accountId: string | null; focusPassword?: boolean } | null;

export function App() {
  const qc = useQueryClient();
  // Mail is the account's in the organization selected in the suite bar (platform.md §3.6): every request names it, and
  // choosing another one reads everything again.
  const organizations = useOrganizations();
  const org = organizations.active?.id ?? null;
  setMailWorkspace(org);
  const shownOrg = useRef(org);
  useEffect(() => {
    if (shownOrg.current === org) return;
    shownOrg.current = org;
    void qc.resetQueries({ queryKey: ['mail'] });
  }, [org, qc]);
  const accounts = useAccounts();
  const narrow = useMediaQuery('(max-width: 899px)');
  // The open thread in place of the list (Gmail's way, or any narrow screen), or beside it.
  const readingPane = useReadingPane();
  const stacked = narrow || readingPane === 'full';
  const tiny = useMediaQuery('(max-width: 759px)');
  const sidebar = useResizableWidth('flow.mail.sidebarWidth', 248, 180, 480);
  const listPane = useResizableWidth('flow.mail.listWidth', 420, 300, 720);
  // The assistant: beside the mail, or over it below 1100px.
  const assistantOpen = useAssistantOpen();
  const assistantOverlay = useMediaQuery('(max-width: 1099px)');
  const assistantPane = useResizableWidth('flow.mail.assistantWidth', 380, 300, 720, 'left');

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
  // The open conversation; a link to one message (`uid=`) opens the thread it is in once that is known.
  const [openId, setOpenId] = useState<string | null>(() => initialParam('thread'));
  const [pendingUid, setPendingUid] = useState<number | null>(() => (initialParam('uid') && !initialParam('thread') ? Number(initialParam('uid')) : null));
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const lastChecked = useRef<string | null>(null);
  // The composer dialog, and the account it writes from (the one shown when it opened).
  const [compose, setCompose] = useState<{ accountId: string; request: ComposeRequest; key: number } | null>(null);
  const composeKey = useRef(0);
  const openCompose = useCallback((accountId: string, request: ComposeRequest) => setCompose({ accountId, request, key: ++composeKey.current }), []);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [drawer, setDrawer] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const pane = useRef<ThreadViewHandle | null>(null);

  // Gmail's inbox tabs: in INBOX, for an account that has them on; a search covers the whole folder, whatever the tab.
  const [tabChoice, setTabChoice] = useState<string | null>(() => initialParam('tab'));
  const accountTabs = useMemo(() => tabsOf(account), [account]);
  const showTabs = folder?.toUpperCase() === 'INBOX' && accountTabs.length > 0;
  const inboxTab = tabFromParam(tabChoice, accountTabs);
  // The tabs' badges: what arrived after the newest the person saw in each tab (remembered per browser), polled with the lists.
  const [tabSeen, setTabSeen] = useState<TabSeen>(() => (account ? readTabSeen(account.id) : {}));
  useEffect(() => { setTabSeen(account ? readTabSeen(account.id) : {}); }, [account?.id]);
  const tabStatus = useTabStatus(account?.id ?? null, showTabs, tabSeen);
  const tabStatusById = useMemo(() => Object.fromEntries((tabStatus.data ?? []).map((t) => [t.category, t])) as Partial<Record<Category, TabStatus>>, [tabStatus.data]);
  useEffect(() => {
    if (!account || !tabStatus.data) return;
    let next = tabSeen;
    for (const t of tabStatus.data) {
      // The open tab is seen as far as it goes; a tab never seen starts from where it is (nothing is new until something arrives).
      if (t.newest && (t.category === inboxTab || next[t.category] === undefined)) next = markTabSeen(account.id, next, t.category, t.newest.uid);
    }
    if (next !== tabSeen) setTabSeen(next);
  }, [account, tabStatus.data, inboxTab, tabSeen]);
  const category: Category | null = showTabs && !q ? inboxTab : null;
  const canDrag = useCanDrag();

  // A folder's own pages are conversations; a search is messages, grouped here.
  const threads = useThreads(account?.id ?? null, folder, category, !q);
  const messages = useMessages(account?.id ?? null, folder, q, null, !!q);
  const listing = q ? messages : threads;
  const rows = useMemo<ThreadSummary[]>(
    () => (q ? groupByThread(messages.data?.pages.flatMap((p) => p.messages) ?? []) : (threads.data?.pages.flatMap((p) => p.threads) ?? [])),
    [q, messages.data, threads.data],
  );
  const visible = useMemo(() => (tab === 'unread' ? rows.filter((t) => t.unread > 0 || t.threadId === openId) : rows), [rows, tab, openId]);
  const rowOf = useCallback((id: string | null) => (id === null ? undefined : rows.find((t) => t.threadId === id)), [rows]);
  const thread = useThread(account?.id ?? null, openId, folder);
  const actions = useMessageActions(account?.id ?? null, folder);

  // A link to one message: its thread, from the list when it is there, else asked of the server (a message the server
  // does not place in a thread opens on its own).
  useEffect(() => {
    if (pendingUid === null || !account || !folder) return;
    const row = rows.find((t) => t.uids.includes(pendingUid));
    if (row) {
      setPendingUid(null);
      setOpenId(row.threadId);
      setCursorId(row.threadId);
      return;
    }
    if (listing.isPending) return;
    let cancelled = false;
    void mailApi.message(account.id, folder, pendingUid).then(
      (m) => {
        if (cancelled) return;
        setPendingUid(null);
        const id = m.threadId ?? soloThreadId(m.uid);
        qc.setQueryData(keys.thread(account.id, id), (old: unknown) => old ?? (m.threadId ? undefined : { threadId: id, messages: [m] }));
        setOpenId(id);
        setCursorId(id);
      },
      () => {
        if (!cancelled) setPendingUid(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [pendingUid, rows, account, folder, listing.isPending, qc]);

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
    if (openId !== null) params.set('thread', openId);
    window.history.replaceState(null, '', `${import.meta.env.BASE_URL}?${params}`);
  }, [account, folder, openId, showTabs, inboxTab]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), typeof toast === 'string' ? 4000 : toast.progress ? 60_000 : 8000);
    return () => window.clearTimeout(t);
  }, [toast]);

  // Opening a thread marks the messages it shows expanded (the unread ones) read, in this folder, once they are on
  // screen: after the frame that shows them, and not for a thread passed over before it was drawn.
  const marked = useRef(new Set<string>());
  const markSeen = actions.flags.mutate;
  const threadLoaded = !!thread.data && thread.data.threadId === openId;
  useEffect(() => {
    const t = thread.data;
    if (!t || !threadLoaded || !account) return;
    const shown = expandedByDefault(t.messages);
    const uids = t.messages.filter((m, i) => shown.has(i) && !m.seen && m.folder === folder && !marked.current.has(`${account.id}:${m.folder}:${m.uid}`)).map((m) => m.uid);
    if (!uids.length) return;
    let timer = 0;
    const frame = requestAnimationFrame(() => {
      timer = window.setTimeout(() => {
        for (const uid of uids) marked.current.add(`${account.id}:${folder}:${uid}`);
        markSeen({ uids, seen: true });
      }, 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [thread.data, threadLoaded, account, folder, markSeen]);

  // The next (older) conversation is read ahead once this one is in, so j opens it at once.
  const nextId = useMemo(() => {
    const i = visible.findIndex((t) => t.threadId === openId);
    return i >= 0 ? (visible[i + 1]?.threadId ?? null) : null;
  }, [visible, openId]);
  useEffect(() => {
    if (!account || !folder || nextId === null || !threadLoaded) return;
    void prefetchThread(qc, account.id, nextId, folder);
  }, [qc, account, folder, nextId, threadLoaded]);

  const resetSelection = () => {
    setOpenId(null);
    setPendingUid(null);
    setCursorId(null);
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

  const openThread = useCallback((id: string) => {
    setOpenId(id);
    setCursorId(id);
  }, []);

  /** The conversations an action applies to: the checked ones, else the open one, else the keyboard's. */
  const targetIds = (): string[] => (checked.size ? [...checked] : openId !== null ? [openId] : cursorId !== null ? [cursorId] : []);
  /** Their messages in this folder (an open thread not in the list, from a link: those of its messages here). */
  const uidsOf = (ids: string[]): number[] =>
    ids.flatMap((id) => rowOf(id)?.uids ?? (id === openId && threadLoaded ? thread.data!.messages.filter((m) => m.folder === folder).map((m) => m.uid) : []));
  /** After the open conversation leaves the list, the next one (older) opens on wide screens, as mail apps do. */
  const afterRemoving = (ids: string[]) => {
    const gone = new Set(ids);
    if (openId !== null && gone.has(openId)) {
      const i = visible.findIndex((t) => t.threadId === openId);
      const next = visible.slice(i + 1).find((t) => !gone.has(t.threadId)) ?? visible.slice(0, i).reverse().find((t) => !gone.has(t.threadId));
      if (next && !stacked) openThread(next.threadId);
      else {
        setOpenId(null);
        setCursorId(next?.threadId ?? null);
      }
    }
    setChecked(new Set());
  };
  const plural = (n: number) => (n === 1 ? 'Conversation' : `${n} conversations`);
  const archive = (ids = targetIds()) => {
    const uids = uidsOf(ids);
    if (!uids.length) return;
    const to = findSpecial(folders.data, 'archive') ?? findSpecial(folders.data, 'all');
    if (!to || to.path === folder) return setToast('This account has no Archive folder. Use Move to instead.');
    afterRemoving(ids);
    actions.move.mutate({ uids, to: to.path }, { onSuccess: () => setToast(`${plural(ids.length)} archived.`), onError: (e) => setToast(`Could not archive: ${errorText(e)}`) });
  };
  const remove = (ids = targetIds()) => {
    const uids = uidsOf(ids);
    if (!uids.length) return;
    afterRemoving(ids);
    const inTrash = folderInfo?.specialUse === 'trash';
    actions.remove.mutate({ uids }, { onSuccess: () => setToast(inTrash ? `${plural(ids.length)} deleted forever.` : `${plural(ids.length)} moved to Trash.`), onError: (e) => setToast(`Could not delete: ${errorText(e)}`) });
  };
  const moveTo = (to: string, ids = targetIds()) => {
    const uids = uidsOf(ids);
    if (!uids.length) return;
    afterRemoving(ids);
    const name = folders.data?.find((f) => f.path === to);
    actions.move.mutate({ uids, to }, { onSuccess: () => setToast(`${plural(ids.length)} moved to ${name ? folderLabel(name) : to}.`), onError: (e) => setToast(`Could not move: ${errorText(e)}`) });
  };
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
    const ids = rows.filter((t) => t.uids.some((u) => uids.includes(u))).map((t) => t.threadId);
    if (category && category !== tab) afterRemoving(ids);
    else setChecked(new Set());
    const label = TAB_INFO[tab].label;
    actions.moveToTab.mutate(
      { uids, category: tab },
      {
        onSuccess: (res) => {
          const who = res.senders.length === 1 ? (rows.flatMap((t) => t.participants).find((a) => a.address.toLowerCase() === res.senders[0])?.name || res.senders[0]) : `these ${res.senders.length} senders`;
          setToast({
            text: res.senders.length ? `Mail from ${who} now goes to ${label}.` : `${plural(ids.length)} moved to ${label}.`,
            action: {
              label: 'Undo',
              run: () =>
                void mailApi.setSenderTabs(accountIdNow, res.previous).then(
                  () => {
                    void qc.invalidateQueries({ queryKey: keys.allMessages(accountIdNow) });
                    void qc.invalidateQueries({ queryKey: keys.allThreads(accountIdNow) });
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
  /** Whether any message of these conversations, in this folder, is unread (the open thread knows each of its own). */
  const anyUnread = (ids: string[]) =>
    ids.some((id) => (id === openId && threadLoaded ? thread.data!.messages.some((m) => m.folder === folder && !m.seen) : (rowOf(id)?.unread ?? 0) > 0));
  const toggleSeen = (ids = targetIds()) => {
    const uids = uidsOf(ids);
    if (!uids.length) return;
    const unread = anyUnread(ids);
    setSeen(uids, unread);
    // Marking the open conversation unread closes it, so it stays unread.
    if (!unread && openId !== null && ids.includes(openId)) {
      for (const uid of uids) marked.current.add(`${account?.id}:${folder}:${uid}`);
      if (stacked) setOpenId(null);
    }
  };
  const toggleFlag = (ids = targetIds()) => {
    const uids = uidsOf(ids);
    if (!uids.length) return;
    const anyUnflagged = ids.some((id) => (id === openId && threadLoaded ? thread.data!.messages.some((m) => m.folder === folder && !m.flagged) : !rowOf(id)?.flagged));
    actions.flags.mutate({ uids, flagged: anyUnflagged });
  };

  /** Compose: new, or an answer to a message of the open thread (the last one unless given). */
  const startCompose = useCallback(
    (mode: ComposeMode, m?: MessageDetail) => {
      if (!account) return;
      if (mode === 'new') return openCompose(account.id, { mode, draft: emptyDraft() });
      const target = m ?? (thread.data && thread.data.threadId === openId ? replyTarget(thread.data.messages, folder) : undefined);
      if (!target || ('bodyPending' in target && target.bodyPending)) return;
      const cidUrl = cidUrlOf(account.id, target);
      const source = { folder: target.folder, uid: target.uid };
      const threadId = openId ?? undefined;
      if (mode === 'draft') return openCompose(account.id, { mode, draft: fromDraft(target, cidUrl), source, ...(threadId ? { threadId } : {}) });
      const me = account.email;
      const remode = (next: typeof mode) => prefill(next, target, me, cidUrl);
      openCompose(account.id, { mode, draft: remode(mode), source, ...(threadId ? { threadId } : {}), remode });
    },
    [account, thread.data, openId, folder, openCompose],
  );

  /** Shows a message (the assistant's open_mail_message, a link in its chat): its account and folder, then its thread. */
  const showMessage = (ref: MessageRef): boolean => {
    if (!list.some((a) => a.id === ref.account)) return false;
    setAccountId(ref.account);
    setFolderChoice(ref.folder);
    setTabChoice(null);
    setQ('');
    setSearchText('');
    setChecked(new Set());
    setOpenId(null);
    setPendingUid(ref.uid);
    setDrawer(false);
    return true;
  };
  // "Open draft" in the assistant's chat: the draft is shown, then opens in Compose once it has loaded.
  const [pendingDraft, setPendingDraft] = useState<MessageRef | null>(null);
  const openDraft = (ref: MessageRef) => {
    if (showMessage(ref)) setPendingDraft(ref);
    else setToast('That draft is in a mail account that is not connected here.');
  };
  useEffect(() => {
    const m = pendingDraft && threadLoaded ? thread.data!.messages.find((x) => x.uid === pendingDraft.uid && x.folder === pendingDraft.folder && !x.bodyPending) : undefined;
    if (!pendingDraft || !m || account?.id !== pendingDraft.account) return;
    setPendingDraft(null);
    openCompose(account.id, { mode: 'draft', draft: fromDraft(m, cidUrlOf(account.id, m)), source: { folder: m.folder, uid: m.uid }, ...(openId ? { threadId: openId } : {}) });
  }, [pendingDraft, thread.data, threadLoaded, account, openId, openCompose]);

  /**
   * Sends what a composer handed over, the composer already closed: "Sending…" while it goes, then "Message sent." (a sent
   * draft leaves Drafts, and its conversation closes if it is still open); on failure the reason, with Open, which puts the
   * composer back as it was (under its message if that conversation is open on a wide screen, else in the dialog).
   */
  const reopen = useRef<(accountId: string, request: ComposeRequest) => void>(() => {});
  reopen.current = (accountId, request) => {
    if (accountId === account?.id && !narrow && request.threadId === openId && pane.current?.reopen(request)) return;
    if (accountId !== account?.id) setAccountId(accountId);
    openCompose(accountId, request);
  };
  const sendMail = useCallback(
    (out: Outgoing) =>
      void sendInBackground(out, {
        send: mailApi.send,
        notice: setToast,
        reopen: (o) => reopen.current(o.accountId, o.request),
        onSent: () => {
          const sentDraft = out.request.mode === 'draft' ? out.request.threadId : undefined;
          if (sentDraft) setOpenId((cur) => (cur === sentDraft ? null : cur));
          void qc.invalidateQueries({ queryKey: keys.allMessages(out.accountId) });
          void qc.invalidateQueries({ queryKey: keys.allThreads(out.accountId) });
          void qc.invalidateQueries({ queryKey: keys.folders(out.accountId) });
        },
      }),
    [qc],
  );

  const chat = useMailAssistant({
    org,
    context: () => {
      const open = threadLoaded ? thread.data!.messages : [];
      const last = replyTarget(open, folder);
      return mailContext({
        account: account ? { id: account.id, email: account.email } : { id: '', email: '' },
        folder: folder ?? 'INBOX',
        tab: showTabs ? inboxTab : null,
        search: q,
        message: last ?? null,
        checked: uidsOf([...checked]),
        thread: open.filter((m) => m !== last).map((m) => ({ folder: m.folder, uid: m.uid })),
      });
    },
    show: showMessage,
    onMailChanged: () => {
      void qc.invalidateQueries({ queryKey: ['mail', 'messages'] });
      void qc.invalidateQueries({ queryKey: ['mail', 'threads'] });
      void qc.invalidateQueries({ queryKey: ['mail', 'folders'] });
    },
  });

  const onCheck = (id: string, on: boolean, range: boolean) => {
    setChecked((cur) => {
      const next = new Set(cur);
      if (range && lastChecked.current !== null) {
        const a = visible.findIndex((t) => t.threadId === lastChecked.current);
        const b = visible.findIndex((t) => t.threadId === id);
        if (a >= 0 && b >= 0) for (const t of visible.slice(Math.min(a, b), Math.max(a, b) + 1)) on ? next.add(t.threadId) : next.delete(t.threadId);
      }
      on ? next.add(id) : next.delete(id);
      return next;
    });
    lastChecked.current = id;
  };

  /** The conversation after (1, older) or before (-1, newer) the open one in the list. */
  const step = (by: 1 | -1) => {
    const i = visible.findIndex((t) => t.threadId === openId);
    const t = i < 0 ? undefined : visible[i + by];
    if (!t) return;
    setCursorId(t.threadId);
    setOpenId(t.threadId);
  };

  // The keyboard, as in other mail apps. Not while typing, and not under a dialog.
  const keyState = useRef({ visible, cursorId, openId, narrow: stacked });
  keyState.current = { visible, cursorId, openId, narrow: stacked };
  const handlers = useRef({ archive, remove, toggleSeen, startCompose });
  handlers.current = { archive, remove, toggleSeen, startCompose };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      const typing = t && (t.isContentEditable || /^(TEXTAREA|SELECT)$/.test(t.tagName) || (t.tagName === 'INPUT' && !/^(checkbox|radio|button)$/.test((t as HTMLInputElement).type)));
      if (typing) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      const { visible: v, cursorId: cur, openId: open, narrow: isNarrow } = keyState.current;
      const h = handlers.current;
      const at = v.findIndex((x) => x.threadId === (cur ?? open));
      const go = (i: number) => {
        const x = v[Math.max(0, Math.min(v.length - 1, i))];
        if (!x) return;
        setCursorId(x.threadId);
        // Side by side, the thread follows the keyboard. In place of the list, j/k move the selection in the list, and
        // with a thread open they open the next (older) or previous (newer) one, as Gmail does.
        if (!isNarrow || open !== null) setOpenId(x.threadId);
      };
      switch (e.key) {
        case 'j':
          go(at < 0 ? 0 : at + 1);
          break;
        case 'k':
          go(at < 0 ? 0 : at - 1);
          break;
        case 'n':
          if (open === null) return;
          pane.current?.step(1);
          break;
        case 'p':
          if (open === null) return;
          pane.current?.step(-1);
          break;
        case 'Enter':
          if (cur !== null) setOpenId(cur);
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
          if (!pane.current?.compose('reply')) h.startCompose('reply');
          break;
        case 'a':
          if (!pane.current?.compose('replyAll')) h.startCompose('replyAll');
          break;
        case 'f':
          if (!pane.current?.compose('forward')) h.startCompose('forward');
          break;
        case 'c':
          h.startCompose('new');
          break;
        case '/':
          openSuiteSearch();
          break;
        case 'Escape':
          if (isNarrow && open !== null) setOpenId(null);
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
      // The logo and the Mail tab: the inbox list, as Gmail's logo does (Primary, no search, nothing open).
      onHome={() => {
        chooseFolder(findSpecial(folders.data, 'inbox')?.path ?? 'INBOX');
        setTab('all');
        setDrawer(false);
      }}
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
      assistant={{ open: assistantOpen, onToggle: () => setAssistantOpen(!assistantOpen) }}
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
          {typeof toast !== 'string' && toast.progress && <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />}
          <span>{typeof toast === 'string' ? toast : toast.text}</span>
          {typeof toast !== 'string' && toast.action && (
            <button
              type="button"
              className="shrink-0 rounded px-1.5 py-0.5 font-semibold text-[#8ab4f8] hover:bg-white/10"
              onClick={() => {
                setToast(null);
                toast.action?.run();
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </>
  );

  if ((organizations.ready && !org) || (accounts.error instanceof MailApiError && accounts.error.code === 'no_account')) {
    return (
      <div className="flex h-dvh flex-col">
        {bar}
        <NoOrganization app="Mail" />
      </div>
    );
  }
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
      onDropMessages={
        canDrag
          ? (path, uids) => {
              const to = folderDropTarget(folder, path);
              if (to) moveTo(to, rows.filter((t) => t.uids.some((u) => uids.includes(u))).map((t) => t.threadId));
            }
          : undefined
      }
    />
  );
  const openRow = rowOf(openId);
  const listEl = (
    <MessageList
      accountId={account.id}
      me={account.email}
      title={folderInfo ? folderLabel(folderInfo) : folder === 'INBOX' ? 'Inbox' : (folder ?? '')}
      rows={visible}
      loading={listing.isPending && !!folder && !needsLogin}
      error={needsLogin ? `Mail from ${account.email} appears here once FreeFlow can sign in to it again.` : errorText(listing.error)}
      refreshing={listing.isFetching && !listing.isFetchingNextPage && !listing.isPending}
      onRefresh={() => {
        void listing.refetch();
        void folders.refetch();
      }}
      hasMore={!!listing.hasNextPage}
      loadingMore={listing.isFetchingNextPage}
      onLoadMore={() => void listing.fetchNextPage()}
      tab={tab}
      onTab={setTab}
      query={q}
      onClearQuery={() => {
        setQ('');
        setSearchText('');
      }}
      openId={openId}
      cursorId={cursorId}
      readingPane={narrow ? undefined : { value: readingPane, onChange: setReadingPane }}
      dense={!narrow && readingPane === 'full'}
      onRowAction={(t, a) => (a === 'archive' ? archive([t.threadId]) : a === 'delete' ? remove([t.threadId]) : setSeen(t.uids, a === 'read'))}
      onOpen={openThread}
      checked={checked}
      onCheck={onCheck}
      onCheckAll={(on) => setChecked(on ? new Set(visible.map((t) => t.threadId)) : new Set())}
      onFlag={(t) => actions.flags.mutate({ uids: t.uids, flagged: !t.flagged })}
      onBulk={(a) => {
        const ids = [...checked];
        if (a === 'read' || a === 'unread') setSeen(uidsOf(ids), a === 'read');
        else if (a === 'flag' || a === 'unflag') actions.flags.mutate({ uids: uidsOf(ids), flagged: a === 'flag' });
        else remove(ids);
      }}
      onBulkMove={(to) => moveTo(to, [...checked])}
      folders={folders.data}
      currentFolder={folder}
      onShowFolders={tiny ? () => setDrawer(true) : undefined}
      tabBar={
        showTabs ? (
          <InboxTabs status={tabStatusById}
            tabs={accountTabs}
            active={inboxTab}
            onChange={chooseTab}
            onDropMessages={
              canDrag
                ? (target, uids) => {
                    const to = tabDropTarget(category, target);
                    if (to) moveToTab(uids, to);
                  }
                : undefined
            }
          />
        ) : undefined
      }
      tabMove={showTabs ? { tabs: accountTabs, current: category, onMove: moveToTab, onWhy: (t) => setToast(`${reasonText(t.categoryReason, t.category ?? 'primary')}.`) } : undefined}
      draggable={canDrag}
      sorting={!!listing.data?.pages[listing.data.pages.length - 1]?.sorting}
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
    <ThreadView
      handle={pane}
      accountId={account.id}
      me={account.email}
      folder={folder}
      thread={threadLoaded ? thread.data : undefined}
      loading={openId !== null && (thread.isPending || !threadLoaded)}
      error={errorText(thread.error)}
      folders={folders.data}
      canArchive={!!(findSpecial(folders.data, 'archive') ?? findSpecial(folders.data, 'all')) && folderInfo?.specialUse !== 'archive'}
      onBack={stacked ? () => setOpenId(null) : undefined}
      position={stacked && openId !== null ? { index: visible.findIndex((t) => t.threadId === openId), count: visible.length } : undefined}
      onNewer={stacked ? () => step(-1) : undefined}
      onOlder={stacked ? () => step(1) : undefined}
      onReply={(m) => startCompose('reply', m)}
      onReplyAll={(m) => startCompose('replyAll', m)}
      onForward={(m) => startCompose('forward', m)}
      onEditDraft={folderInfo?.specialUse === 'drafts' ? (m) => startCompose('draft', m) : undefined}
      onArchive={() => archive(openId !== null ? [openId] : [])}
      onMove={(to) => moveTo(to, openId !== null ? [openId] : [])}
      tabMove={showTabs && openId !== null ? { tabs: accountTabs, current: openRow?.category ?? category, onMove: (tab) => moveToTab(uidsOf([openId]), tab) } : undefined}
      onDelete={() => remove(openId !== null ? [openId] : [])}
      onToggleSeen={() => toggleSeen(openId !== null ? [openId] : [])}
      onToggleFlag={() => toggleFlag(openId !== null ? [openId] : [])}
      onNeedBody={(m) => openId !== null && void fetchBody(qc, account.id, openId, m)}
      onNotice={setToast}
      inline={narrow ? undefined : { account, onSend: sendMail, onDetach: (request) => openCompose(account.id, request) }}
      onFlagMessage={(m, flagged) => {
        // A message of the thread in another folder is flagged there; this folder's actions flag here.
        if (m.folder === folder) actions.flags.mutate({ uids: [m.uid], flagged });
        else void mailApi.setFlags(account.id, { folder: m.folder, uids: [m.uid], flagged }).then(() => qc.invalidateQueries({ queryKey: keys.thread(account.id, openId ?? '') }), (e: unknown) => setToast(`Could not star: ${errorText(e)}`));
      }}
    />
  );

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      {bar}
      {needsLogin && (
        <div role="alert" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-warn-border bg-warn-bg px-4 py-2 text-[14px]">
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
            // The list stays mounted under the open thread, so going back finds it where it was.
            <div className="relative min-w-0 flex-1">
              <div className={cn('h-full', openId !== null && 'invisible')}>{listEl}</div>
              {openId !== null && <div className="absolute inset-0 z-10">{view}</div>}
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
        {assistantOpen && !assistantOverlay && <ResizeHandle label="Resize the assistant" {...assistantPane.handleProps} />}
        {assistantOpen && (
          <Suspense fallback={null}>
            <AssistantPanel
              chat={chat}
              onMessage={openId !== null}
              overlay={assistantOverlay}
              width={assistantPane.width}
              onClose={() => setAssistantOpen(false)}
              onShow={(ref) => {
                if (!showMessage(ref)) setToast('That message is in a mail account that is not connected here.');
              }}
              onOpenDraft={openDraft}
            />
          </Suspense>
        )}
      </div>
      {compose && (
        <Suspense fallback={null}>
          <Compose
            key={compose.key}
            account={list.find((a) => a.id === compose.accountId) ?? account}
            request={compose.request}
            narrow={narrow}
            onClose={() => setCompose(null)}
            onSend={(out) => {
              setCompose(null);
              sendMail(out);
            }}
          />
        </Suspense>
      )}
      {dialogs}
    </div>
  );
}
