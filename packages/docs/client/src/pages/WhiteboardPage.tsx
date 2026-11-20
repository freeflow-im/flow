// A whiteboard (shared/whiteboard.ts): one large canvas, edited with the slide editor (client/src/deck) in its
// whiteboard mode. The board is held as a one-slide deck (boardAsDeck) and saved back as a board (deckAsBoard).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { nameWithExt } from '../../../shared/docNames.ts';
import type { Deck, SlideElement } from '../../../shared/deck.ts';
import type { SheetMeta } from '../../../shared/types.ts';
import { BOARD_H, BOARD_W, boardAsDeck, deckAsBoard, GRID } from '../../../shared/whiteboard.ts';
import { AgentButton } from '../agent/AgentPanel.tsx';
import { useRegisterWhiteboard } from '../agent/AgentProvider.tsx';
import { api, ApiError } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { imageFileProblem, uploadImageFile, pickImageFile } from '../cellImage.ts';
import { isMac, MOD } from '../commands.ts';
import { Account } from '../components/Account.tsx';
import { FavoriteStar } from '../components/FavoriteStar.tsx';
import { FileSearchButton } from '../components/FileSearch.tsx';
import { FolderCrumbs, lastListingHref } from '../components/FolderCrumbs.tsx';
import { WhiteboardIcon } from '../components/Logo.tsx';
import { MenuList, type MenuItem } from '../components/Menu.tsx';
import { ConfirmModal, PromptModal } from '../components/Modal.tsx';
import { useOpenInTab } from '../components/OpenInTab.tsx';
import { useOrganizationMenu, withScope } from '../components/OrganizationActions.tsx';
import { TitleInput } from '../components/TitleInput.tsx';
import { DeckController, useDeckController } from '../deck/controller.ts';
import { DeckEditor } from '../deck/DeckEditor.tsx';
import { DeckToolbar, shapeMenuItems } from '../deck/DeckToolbar.tsx';
import { useDeckFonts } from '../deck/fonts.ts';
import { appName } from '../brand.ts';
import { useFavicon } from '../favicon.ts';
import { imageDialogOpen } from '../image/dialogOpen.ts';
import { RevisionSync, takenMessage } from '../state/revisionSync.ts';
import { viewOnlyGuard } from '../state/store.ts';
import { onBeforeLeave } from '../suite.ts';

const BOARD = { w: BOARD_W, h: BOARD_H, grid: GRID };

/** Natural size of an image, for sizing a new image element. */
function imageSize(src: string): Promise<{ w: number; h: number } | undefined> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(undefined);
    img.src = src;
  });
}

/** A picture shown from the browser's copy while it uploads (addImageFiles): not saved until it has its stored address. */
const isPending = (el: SlideElement) => el.type === 'image' && el.src.startsWith('blob:');
const savedBoard = (d: Deck) => {
  const board = deckAsBoard(d);
  return board.elements.some(isPending) ? { ...board, elements: board.elements.filter((el) => !isPending(el)) } : board;
};

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);

export function WhiteboardPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<{ meta: SheetMeta; ctl: DeckController; sync: RevisionSync<Deck> } | { error: string } | null>(null);

  useEffect(() => {
    let ctl: DeckController | null = null;
    let stopSync = () => {};
    let cancelled = false;
    setState(null);
    api
      .getWhiteboard(id!)
      .then(({ meta, board }) => {
        if (cancelled) return;
        // Saves name the revision loaded, and the editor follows saves made elsewhere (revisionSync.ts).
        const sync = new RevisionSync<Deck>(meta.id, meta.updatedAt, {
          save: (d, rev) => api.saveWhiteboard(meta.id, savedBoard(d), rev),
          load: async () => {
            const latest = await api.getWhiteboard(meta.id);
            return { meta: latest.meta, doc: boardAsDeck(latest.board) };
          },
        });
        ctl = new DeckController(boardAsDeck(board), sync.save);
        ctl.canvas = { w: BOARD_W, h: BOARD_H };
        stopSync = sync.attach(ctl);
        if (meta.role === 'viewer') ctl.store.guard = viewOnlyGuard;
        setState({ meta, ctl, sync });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setState({ error: e instanceof ApiError && e.status === 404 ? 'This whiteboard does not exist or was deleted.' : String((e as Error).message ?? e) });
      });
    return () => {
      cancelled = true;
      stopSync();
      if (ctl) {
        void ctl.saver.flush();
        ctl.dispose();
      }
    };
  }, [id]);

  if (!state) return <div className="page-loading">Loading whiteboard…</div>;
  if ('error' in state) {
    return (
      <div className="page-error">
        <p>{state.error}</p>
        <Link to="/" className="btn primary">
          Back to home
        </Link>
      </div>
    );
  }
  return <WhiteboardWorkbench key={state.meta.id} initialMeta={state.meta} ctl={state.ctl} sync={state.sync} />;
}

type Dialog = { kind: 'rename' } | { kind: 'delete' } | null;

function WhiteboardWorkbench({ initialMeta, ctl, sync }: { initialMeta: SheetMeta; ctl: DeckController; sync: RevisionSync<Deck> }) {
  // In the FreeFlow suite the suite bar replaces the logo, the Assistant button and Sign out.
  const inSuite = !!useAuth().suite;
  useEffect(() => onBeforeLeave(() => ctl.saver.flush()), [ctl]);
  useDeckController(ctl);
  useDeckFonts(ctl.deck);
  useFavicon('whiteboard');
  const navigate = useNavigate();
  const [meta, setMeta] = useState(initialMeta);
  useRegisterWhiteboard(ctl, meta);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [, setSaveTick] = useState(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => ctl.saver.subscribe(() => setSaveTick((t) => t + 1)), [ctl]);
  useEffect(() => {
    document.title = `${meta.title} - ${appName()}`;
    return () => {
      document.title = appName();
    };
  }, [meta.title]);
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (ctl.saver.hasUnsavedChanges()) {
        void ctl.saver.flush();
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [ctl]);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);

  useEffect(
    () =>
      sync.onTaken((t) => {
        setMeta(t.meta);
        if (t.changed) notify(takenMessage(t));
      }),
    [sync, notify],
  );

  const addImageFiles = useCallback(
    async (files: File[]) => {
      // Each picture shows at once, from the browser's copy and at its own size; its upload runs behind it, and
      // the stored address takes the copy's place everywhere (undo steps too) when it is done.
      for (const file of files.slice(0, 10)) {
        const problem = imageFileProblem(file);
        if (problem) {
          notify(problem);
          continue;
        }
        const local = URL.createObjectURL(file);
        ctl.setPlace(null);
        ctl.addImage(local, await imageSize(local));
        uploadImageFile(file)
          .then(async (url) => {
            await imageSize(url); // loaded before the swap, so the picture does not blink
            ctl.store.rewriteElements((el) => (el.type === 'image' && el.src === local ? { ...el, src: url } : el));
          })
          .catch((e: unknown) => {
            ctl.store.rewriteElements((el) => (el.type === 'image' && el.src === local ? null : el));
            notify(e instanceof Error ? e.message : String(e));
          })
          .finally(() => setTimeout(() => URL.revokeObjectURL(local), 5000));
      }
    },
    [ctl, notify],
  );
  const uploadImage = async () => {
    const file = await pickImageFile();
    if (file) await addImageFiles([file]);
  };

  // Copy and paste of items on the board; a picture on the system clipboard pastes as a new picture, unless items
  // were copied here since the window last had the focus. Text being typed keeps its own copy and paste.
  const copiedHere = useRef(false);
  useEffect(() => {
    const blur = () => (copiedHere.current = false);
    window.addEventListener('blur', blur);
    return () => window.removeEventListener('blur', blur);
  }, []);
  const copy = useCallback(() => {
    if (!ctl.selection.length) return;
    ctl.copySelected();
    copiedHere.current = true;
  }, [ctl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (ctl.cropping || imageDialogOpen() || document.querySelector('.modal-backdrop') || isTyping(e.target)) return;
      const mod = isMac ? e.metaKey : e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') {
        e.preventDefault();
        e.shiftKey ? ctl.redo() : ctl.undo();
      } else if (mod && k === 'y') {
        e.preventDefault();
        ctl.redo();
      } else if (mod && k === 'd') {
        e.preventDefault();
        ctl.duplicateSelected();
      } else if (mod && k === 'c') {
        copy();
      } else if (mod && k === 'a') {
        e.preventDefault();
        ctl.select(ctl.slide.elements.map((el) => el.id));
      } else if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) {
        if (ctl.selection.length) {
          e.preventDefault();
          ctl.deleteSelected();
        }
      } else if (!mod && e.key.startsWith('Arrow') && ctl.selection.length) {
        // One grid step at a time (Shift: four).
        const step = GRID * (e.shiftKey ? 4 : 1);
        e.preventDefault();
        ctl.nudge(e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0);
      } else if (e.key === 'Escape') {
        if (ctl.place || ctl.tool) {
          ctl.setPlace(null);
          ctl.setTool(null);
        } else ctl.select([]);
      } else if (e.key === 'Enter' && ctl.selection.length === 1) {
        e.preventDefault();
        ctl.startEditing(ctl.selection[0]);
      } else if (!mod && !e.altKey && ctl.selection.length === 0) {
        // The tools' keys: T types text, N puts a note, V selects.
        if (k === 't') ctl.setPlace('text');
        else if (k === 'n') ctl.setPlace('note');
        else if (k === 'v') ctl.setPlace(null);
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      if (imageDialogOpen() || isTyping(e.target)) return;
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
      if (files.length && !copiedHere.current) {
        e.preventDefault();
        void addImageFiles(files);
      } else ctl.paste();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('paste', onPaste);
    };
  }, [ctl, addImageFiles, copy]);

  useEffect(() => {
    if (!openMenu && !ctxMenu) return;
    const close = () => {
      setOpenMenu(null);
      setCtxMenu(null);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [openMenu, ctxMenu]);

  const rename = async (t: string) => {
    const { meta: m } = await api.renameWhiteboard(meta.id, t);
    setMeta(m);
  };

  const openInTab = useOpenInTab();
  const orgMenu = useOrganizationMenu(meta, (m) => setMeta((cur) => withScope(cur, m)), notify);
  const arrange: MenuItem[] = [
    { label: 'Bring to front', disabled: !ctl.selection.length, action: () => ctl.reorder(ctl.selection, 'front') },
    { label: 'Bring forward', disabled: !ctl.selection.length, action: () => ctl.reorder(ctl.selection, 'forward') },
    { label: 'Send backward', disabled: !ctl.selection.length, action: () => ctl.reorder(ctl.selection, 'backward') },
    { label: 'Send to back', disabled: !ctl.selection.length, action: () => ctl.reorder(ctl.selection, 'back') },
  ];
  const menus: { key: string; label: string; items: () => MenuItem[] }[] = [
    {
      key: 'file',
      label: 'File',
      items: () => [
        ...openInTab.items,
        ...orgMenu.items,
        {
          label: 'New whiteboard',
          action: async () => {
            const { board } = await api.createWhiteboard('Untitled whiteboard');
            window.open(`/w/${board.id}`, '_blank');
          },
        },
        { label: 'Rename…', action: () => setDialog({ kind: 'rename' }) },
        'sep',
        {
          label: 'Download',
          submenu: [
            {
              label: 'JSON (.json)',
              action: () => {
                const url = URL.createObjectURL(new Blob([JSON.stringify(deckAsBoard(ctl.deck), null, 2)], { type: 'application/json' }));
                const a = document.createElement('a');
                a.href = url;
                a.download = nameWithExt(meta.title, 'json');
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              },
            },
          ],
        },
        'sep',
        { label: 'Delete whiteboard', danger: true, action: () => setDialog({ kind: 'delete' }) },
        'sep',
        { label: 'Home', action: () => navigate('/') },
      ],
    },
    {
      key: 'edit',
      label: 'Edit',
      items: () => [
        { label: 'Undo', shortcut: `${MOD}Z`, disabled: !ctl.store.canUndo(), action: () => ctl.undo() },
        { label: 'Redo', shortcut: `${MOD}Y`, disabled: !ctl.store.canRedo(), action: () => ctl.redo() },
        'sep',
        { label: 'Copy', shortcut: `${MOD}C`, disabled: !ctl.selection.length, action: copy },
        { label: 'Paste', shortcut: `${MOD}V`, action: () => ctl.paste() },
        { label: 'Duplicate', shortcut: `${MOD}D`, disabled: !ctl.selection.length, action: () => ctl.duplicateSelected() },
        { label: 'Delete', shortcut: 'Delete', disabled: !ctl.selection.length, action: () => ctl.deleteSelected() },
        { label: 'Select all', shortcut: `${MOD}A`, action: () => ctl.select(ctl.slide.elements.map((e) => e.id)) },
      ],
    },
    {
      key: 'insert',
      label: 'Insert',
      items: () => [
        { label: 'Text', shortcut: 'T', action: () => ctl.setPlace('text') },
        { label: 'Sticky note', shortcut: 'N', action: () => ctl.setPlace('note') },
        { label: 'Image…', action: () => void uploadImage() },
        { label: 'Shape', submenu: shapeMenuItems(ctl) },
        { label: 'Line', action: () => ctl.setTool({ kind: 'straight', arrow: false }) },
        { label: 'Arrow', action: () => ctl.setTool({ kind: 'straight', arrow: true }) },
      ],
    },
    { key: 'arrange', label: 'Arrange', items: () => arrange },
  ];

  const saveLabel = {
    saved: 'All changes saved',
    dirty: 'Unsaved changes',
    saving: 'Saving…',
    error: `Save failed — retrying${ctl.saver.error ? ` (${ctl.saver.error})` : ''}`,
  }[ctl.saver.status];

  const elementMenu = (): MenuItem[] =>
    ctl.selection.length
      ? [
          { label: 'Copy', shortcut: `${MOD}C`, action: copy },
          { label: 'Paste', shortcut: `${MOD}V`, action: () => ctl.paste() },
          { label: 'Duplicate', shortcut: `${MOD}D`, action: () => ctl.duplicateSelected() },
          { label: 'Delete', shortcut: 'Delete', action: () => ctl.deleteSelected() },
          'sep',
          ...arrange,
        ]
      : [
          { label: 'Paste', shortcut: `${MOD}V`, action: () => ctl.paste() },
          { label: 'Select all', shortcut: `${MOD}A`, action: () => ctl.select(ctl.slide.elements.map((e) => e.id)) },
        ];

  return (
    <div className="workbench deck-page whiteboard-page">
      {openInTab.dialog}
      {orgMenu.dialog}
      <header className="wb-header">
        {!inSuite && (
          <Link to={lastListingHref()} className="wb-logo" title="Back to the file list" onClick={() => void ctl.saver.flush()}>
            <WhiteboardIcon size={32} />
          </Link>
        )}
        <div className="wb-titles">
          <div className="wb-title-row">
            <FavoriteStar kind="whiteboard" id={meta.id} onError={notify} />
            <FolderCrumbs folder={meta.folder} file={meta} onLeave={() => void ctl.saver.flush()} />
            <TitleInput title={meta.title} label="Whiteboard name" onRename={rename} onError={notify} />
            <span className={`save-status ${ctl.saver.status}`}>{saveLabel}</span>
          </div>
          <nav className="menubar" onMouseDown={(e) => e.stopPropagation()}>
            {menus.map((m) => (
              <div key={m.key} className="menubar-entry">
                <button
                  className={`menubar-btn${openMenu === m.key ? ' open' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setOpenMenu(openMenu === m.key ? null : m.key);
                  }}
                  onMouseEnter={() => openMenu && setOpenMenu(m.key)}
                >
                  {m.label}
                </button>
                {openMenu === m.key && <MenuList items={m.items()} onDone={() => setOpenMenu(null)} style={{ top: 26, left: 0 }} />}
              </div>
            ))}
          </nav>
        </div>
        <div className="wb-user">
          <FileSearchButton />
          {!inSuite && <AgentButton />}
          {!inSuite && <Account before={() => ctl.saver.flush()} />}
        </div>
      </header>
      <DeckToolbar board ctl={ctl} onInsertImage={() => void uploadImage()} />
      <div className="deck-body">
        <div className="deck-main">
          <DeckEditor ctl={ctl} board={BOARD} onImageFiles={(files) => void addImageFiles(files)} onContextMenu={(at) => setCtxMenu(at)} />
        </div>
      </div>
      {ctxMenu && (
        <div onMouseDown={(e) => e.stopPropagation()}>
          <MenuList items={elementMenu()} onDone={() => setCtxMenu(null)} style={{ position: 'fixed', left: ctxMenu.x, top: ctxMenu.y }} />
        </div>
      )}
      {dialog?.kind === 'rename' && <PromptModal title="Rename whiteboard" label="Name" initial={meta.title} confirmText="Rename" onConfirm={rename} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'delete' && (
        <ConfirmModal
          title="Delete whiteboard?"
          message={<>“{meta.title}” will be permanently deleted. This cannot be undone.</>}
          confirmText="Delete"
          danger
          onConfirm={async () => {
            ctl.saver.dispose();
            await api.deleteWhiteboard(meta.id);
            navigate('/');
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
