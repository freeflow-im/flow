// One presentation open in the app's own deck editor (DeckController, DeckEditor, DeckToolbar, thumbnails,
// notes and present mode), loaded and saved through the plugin's tools. Edits the model makes arrive by
// polling the revision and are applied slide by slide, so they are undoable; the slide and selection the
// user is on go to the model as context.
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { pickImageFile, uploadImageFile } from '../../client/src/cellImage.ts';
import { imageDialogOpen } from '../../client/src/image/dialogOpen.ts';
import { ImageEditDialog } from '../../client/src/image/ImageEditDialog.tsx';
import type { PictureSizes } from '../../client/src/image/ImageFileEditor.tsx';
import { storePicture } from './imageStore.ts';
import { isMac, MOD } from '../../client/src/commands.ts';
import { MenuList, type MenuItem } from '../../client/src/components/Menu.tsx';
import { ConfirmModal, PromptModal } from '../../client/src/components/Modal.tsx';
import { ResizeHandle, usePanelWidth } from '../../client/src/components/ResizeHandle.tsx';
import { DeckController, useDeckController } from '../../client/src/deck/controller.ts';
import { DeckEditor } from '../../client/src/deck/DeckEditor.tsx';
import { DeckToolbar, LAYOUT_NAMES, shapeMenuItems } from '../../client/src/deck/DeckToolbar.tsx';
import { useDeckFonts } from '../../client/src/deck/fonts.ts';
import { PresentMode } from '../../client/src/deck/PresentMode.tsx';
import { ThumbnailStrip } from '../../client/src/deck/ThumbnailStrip.tsx';
import { SLIDE_TRAY } from '../../client/src/panelSize.ts';
import { deckOutline, LAYOUT_IDS, THEME_IDS, THEMES, type Deck } from '../../shared/deck.ts';
import type { Host, OpenFile } from './host.ts';

interface FileSummary {
  id: string;
  title: string;
  updated_at: string;
}

type Loaded = { meta: FileSummary; rev: string; data: Deck };
type Dialog = { kind: 'rename' } | { kind: 'delete' } | { kind: 'deleteSlide'; index: number } | null;

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);

/** Natural size of an image, for sizing a new image element. */
function imageSize(src: string): Promise<{ w: number; h: number } | undefined> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(undefined);
    img.src = src;
  });
}

export function DeckWorkbench({ host, id, remote, onBack }: { host: Host; id: string; remote: OpenFile | null; onBack(): void }) {
  const [state, setState] = useState<{ meta: FileSummary; ctl: DeckController } | { error: string } | null>(null);
  const rev = useRef('');
  const syncing = useRef(false);

  const applyRemote = useCallback(
    async (ctl: DeckController, force: boolean) => {
      if (syncing.current) return;
      syncing.current = true;
      try {
        const r = await host.call<Loaded>('get_file', { kind: 'deck', id });
        if (r.rev === rev.current) return;
        if (!force && ctl.saver.hasUnsavedChanges()) return;
        rev.current = r.rev;
        setState((s) => (s && 'ctl' in s ? { ...s, meta: r.meta } : s));
        ctl.replaceWith(r.data);
      } finally {
        syncing.current = false;
      }
    },
    [host, id],
  );

  useEffect(() => {
    let ctl: DeckController | null = null;
    let cancelled = false;
    setState(null);
    host
      .call<Loaded>('get_file', { kind: 'deck', id })
      .then((r) => {
        if (cancelled) return;
        rev.current = r.rev;
        const c = new DeckController(r.data, async (d) => {
          try {
            const saved = await host.call<{ rev: string }>('save_file', { kind: 'deck', id, rev: rev.current, data: d });
            rev.current = saved.rev;
          } catch (e) {
            const data = (e as { data?: { conflict?: boolean } }).data;
            if (!data?.conflict) throw e;
            await applyRemote(c, true);
          }
        });
        ctl = c;
        setState({ meta: r.meta, ctl: c });
      })
      .catch((e: Error) => !cancelled && setState({ error: e.message }));
    return () => {
      cancelled = true;
      if (ctl) {
        void ctl.saver.flush();
        ctl.dispose();
      }
    };
  }, [host, id, applyRemote]);

  useEffect(() => {
    if (state && 'ctl' in state && remote?.id === id && remote.rev !== rev.current) void applyRemote(state.ctl, false);
  }, [state, remote, id, applyRemote]);

  if (!state) return <div className="page-loading">Loading presentation…</div>;
  if ('error' in state) {
    return (
      <div className="page-error">
        <p>{state.error}</p>
        <button className="btn primary" onClick={onBack}>
          Back to Docs
        </button>
      </div>
    );
  }
  return <Workbench host={host} meta={state.meta} ctl={state.ctl} onBack={onBack} />;
}

function Workbench({ host, meta, ctl, onBack }: { host: Host; meta: FileSummary; ctl: DeckController; onBack(): void }) {
  useDeckController(ctl);
  useDeckFonts(ctl.deck);
  const [title, setTitle] = useState(meta.title);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; index: number } | null>(null);
  const [showNotes, setShowNotes] = useState(true);
  const [, setSaveTick] = useState(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const tray = usePanelWidth(SLIDE_TRAY, () => (bodyRef.current ? { available: bodyRef.current.clientWidth - 8 } : {}), bodyRef);

  useEffect(() => ctl.saver.subscribe(() => setSaveTick((t) => t + 1)), [ctl]);
  useEffect(() => setTitle(meta.title), [meta.title]);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);

  // Tell the server and the model where the user is in the presentation.
  useEffect(() => {
    let last = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
    const push = () => {
      const slide = ctl.current + 1;
      const selection = ctl.selection;
      const key = `${slide}/${ctl.deck.slides.length}|${selection.join(',')}`;
      if (key === last) return;
      last = key;
      void host.call('set_open_file', { kind: 'deck', id: meta.id, slide, selection }).catch(() => {});
      const elements = deckOutline(ctl.deck, ctl.current).slides.find((s) => s.slide === slide)?.elements.filter((e) => selection.includes(e.id)) ?? [];
      const count = ctl.deck.slides.length;
      const text = elements.length
        ? `The user has "${meta.title}" open in Docs, on slide ${slide} of ${count}, with ${elements.length === 1 ? 'this element' : 'these elements'} selected:\n${JSON.stringify(elements).slice(0, 600)}`
        : `The user has "${meta.title}" open in Docs, on slide ${slide} of ${count}.`;
      void host.setModelContext(text, { deck_id: meta.id, title: meta.title, slide, selection }, `Docs: ${meta.title}`).catch(() => {});
    };
    const unsub = ctl.subscribe(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(push, 600);
    });
    push();
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [ctl, host, meta.id, meta.title]);

  const addImageFiles = useCallback(
    async (files: File[]) => {
      for (const file of files.slice(0, 10)) {
        try {
          const url = await uploadImageFile(file, (b) => host.uploadImage(b));
          ctl.addImage(url, await imageSize(url));
        } catch (e) {
          notify(e instanceof Error ? e.message : String(e));
        }
      }
    },
    [ctl, host, notify],
  );
  // The picture element open in the image editor (as on the app's presentation page): saving stores the edited
  // picture as a new image and puts it on the slide as one step.
  const [editingImage, setEditingImage] = useState<string | null>(null);
  const editedPicture = ctl.deck.slides.flatMap((s) => s.elements).find((e) => e.id === editingImage && e.type === 'image');
  const saveEditedImage = async (id: string, image: Blob, sizes: PictureSizes) => {
    const url = await storePicture(host, image);
    if (!ctl.replacePicture(id, url, sizes.before, sizes.after)) notify('The picture is no longer in the presentation, so the edit was not put in.');
  };

  const insertImage = async () => {
    const file = await pickImageFile();
    if (file) await addImageFiles([file]);
  };

  // Global shortcuts (not while typing in an input, the notes or an inline text editor).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (ctl.presenting || ctl.cropping || imageDialogOpen() || isTyping(e.target)) return;
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
        ctl.selection.length ? ctl.duplicateSelected() : ctl.duplicateSlide();
      } else if (mod && k === 'c') {
        if (ctl.selection.length) ctl.copySelected();
      } else if (mod && k === 'a') {
        e.preventDefault();
        ctl.select(ctl.slide.elements.map((el) => el.id));
      } else if (mod && k === 'b') {
        e.preventDefault();
        const t = ctl.selected.find((el) => el.type === 'text');
        if (t?.type === 'text') ctl.styleSelected({ bold: !(t.style?.bold ?? t.role === 'title') });
      } else if (mod && k === 'i') {
        e.preventDefault();
        const t = ctl.selected.find((el) => el.type === 'text');
        if (t?.type === 'text') ctl.styleSelected({ italic: t.style?.italic ? undefined : true });
      } else if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) {
        if (ctl.selection.length) {
          e.preventDefault();
          ctl.deleteSelected();
        }
      } else if (!mod && e.key.startsWith('Arrow')) {
        const step = e.shiftKey ? 10 : 1;
        if (ctl.selection.length) {
          e.preventDefault();
          ctl.nudge(e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
          e.preventDefault();
          ctl.goTo(ctl.current + 1);
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
          e.preventDefault();
          ctl.goTo(ctl.current - 1);
        }
      } else if (e.key === 'PageDown') {
        e.preventDefault();
        ctl.goTo(ctl.current + 1);
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        ctl.goTo(ctl.current - 1);
      } else if (e.key === 'Escape') {
        ctl.select([]);
      } else if (e.key === 'F5') {
        e.preventDefault();
        ctl.setPresenting(true);
      } else if (e.key === 'Enter' && ctl.selection.length === 1) {
        e.preventDefault();
        ctl.startEditing(ctl.selection[0]);
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      if (ctl.presenting || imageDialogOpen() || isTyping(e.target)) return;
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
      if (files.length) {
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
  }, [ctl, addImageFiles]);

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
    await host.call('rename_file', { kind: 'deck', id: meta.id, title: t });
    setTitle(t);
  };

  const slideMenu = (index: number): MenuItem[] => [
    { label: 'New slide', shortcut: '', submenu: LAYOUT_IDS.map((l) => ({ label: LAYOUT_NAMES[l], action: () => ctl.addSlide(l, {}, index + 1) })) },
    { label: 'Duplicate slide', shortcut: `${MOD}D`, action: () => ctl.duplicateSlide(index) },
    { label: 'Delete slide', danger: true, disabled: ctl.deck.slides.length <= 1, action: () => setDialog({ kind: 'deleteSlide', index }) },
    'sep',
    { label: 'Layout', submenu: LAYOUT_IDS.map((l) => ({ label: LAYOUT_NAMES[l], checked: ctl.deck.slides[index]?.layout === l, action: () => ctl.setLayout(l, index) })) },
  ];

  const menus: { key: string; label: string; items: () => MenuItem[] }[] = [
    {
      key: 'file',
      label: 'File',
      items: () => [
        { label: 'Rename…', action: () => setDialog({ kind: 'rename' }) },
        'sep',
        { label: 'Delete presentation', danger: true, action: () => setDialog({ kind: 'delete' }) },
        'sep',
        { label: 'All files', action: onBack },
      ],
    },
    {
      key: 'edit',
      label: 'Edit',
      items: () => [
        { label: 'Undo', shortcut: `${MOD}Z`, disabled: !ctl.store.canUndo(), action: () => ctl.undo() },
        { label: 'Redo', shortcut: `${MOD}Y`, disabled: !ctl.store.canRedo(), action: () => ctl.redo() },
        'sep',
        { label: 'Copy', shortcut: `${MOD}C`, disabled: !ctl.selection.length, action: () => ctl.copySelected() },
        { label: 'Paste', shortcut: `${MOD}V`, action: () => ctl.paste() },
        { label: 'Duplicate', shortcut: `${MOD}D`, action: () => (ctl.selection.length ? ctl.duplicateSelected() : ctl.duplicateSlide()) },
        { label: 'Delete', shortcut: 'Delete', disabled: !ctl.selection.length, action: () => ctl.deleteSelected() },
        { label: 'Select all', shortcut: `${MOD}A`, action: () => ctl.select(ctl.slide.elements.map((e) => e.id)) },
      ],
    },
    {
      key: 'view',
      label: 'View',
      items: () => [
        { label: 'Present', shortcut: 'F5', action: () => ctl.setPresenting(true) },
        'sep',
        { label: 'Speaker notes', checked: showNotes, action: () => setShowNotes(!showNotes) },
      ],
    },
    {
      key: 'insert',
      label: 'Insert',
      items: () => [
        { label: 'New slide', submenu: LAYOUT_IDS.map((l) => ({ label: LAYOUT_NAMES[l], action: () => ctl.addSlide(l) })) },
        'sep',
        { label: 'Text box', action: () => ctl.addText('body') },
        { label: 'Title', action: () => ctl.addText('title') },
        { label: 'Image…', action: () => void insertImage() },
        { label: 'Shape', submenu: shapeMenuItems(ctl) },
      ],
    },
    {
      key: 'slide',
      label: 'Slide',
      items: () => [
        ...slideMenu(ctl.current),
        { label: 'Theme', submenu: THEME_IDS.map((t) => ({ label: THEMES[t].name, checked: ctl.deck.theme === t, action: () => ctl.setTheme(t) })) },
        { label: 'Remove background color', disabled: !ctl.slide.bg, action: () => ctl.setBackground(undefined) },
      ],
    },
    {
      key: 'arrange',
      label: 'Arrange',
      items: () => [
        { label: 'Bring to front', disabled: !ctl.selection.length, action: () => ctl.reorder(ctl.selection, 'front') },
        { label: 'Bring forward', disabled: !ctl.selection.length, action: () => ctl.reorder(ctl.selection, 'forward') },
        { label: 'Send backward', disabled: !ctl.selection.length, action: () => ctl.reorder(ctl.selection, 'backward') },
        { label: 'Send to back', disabled: !ctl.selection.length, action: () => ctl.reorder(ctl.selection, 'back') },
      ],
    },
  ];

  const saveLabel = {
    saved: 'All changes saved',
    dirty: 'Unsaved changes',
    saving: 'Saving…',
    error: `Save failed — retrying${ctl.saver.error ? ` (${ctl.saver.error})` : ''}`,
  }[ctl.saver.status];

  const onThumbContextMenu = (e: MouseEvent, index: number) => setCtxMenu({ x: e.clientX, y: e.clientY, index });

  return (
    <div className="workbench deck-page docs-plugin">
      <header className="wb-header">
        <button className="wb-back" title="All files" onClick={() => void ctl.saver.flush().then(onBack)}>
          ‹ Docs
        </button>
        <div className="wb-titles">
          <div className="wb-title-row">
            <input
              className="wb-title"
              value={title}
              aria-label="Presentation name"
              size={Math.max(8, title.length + 1)}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => {
                const t = title.trim();
                if (t && t !== meta.title) rename(t).catch((e: Error) => notify(e.message));
                else setTitle(meta.title);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') {
                  setTitle(meta.title);
                  setTimeout(() => (e.target as HTMLInputElement).blur());
                }
              }}
            />
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
        <div className="wb-user wb-ask">
          {host.appLink({ kind: 'deck', id: meta.id }) && (
            <button className="btn" title="Open in the full app in a new tab" onClick={() => void ctl.saver.flush().then(() => host.openLink(host.appLink({ kind: 'deck', id: meta.id })!))}>
              Open ↗
            </button>
          )}
        </div>
      </header>
      <DeckToolbar ctl={ctl} onPresent={() => ctl.setPresenting(true)} onInsertImage={() => void insertImage()} onEditImage={setEditingImage} />
      <div className="deck-body" ref={bodyRef}>
        <ThumbnailStrip ctl={ctl} width={tray.width} onContextMenu={onThumbContextMenu} />
        <ResizeHandle panel={tray} side="left" label="Resize slide thumbnails" className="deck-thumbs-resize" />
        <div className="deck-main">
          <DeckEditor ctl={ctl} onImageFiles={(files) => void addImageFiles(files)} onEditImage={setEditingImage} />
          {showNotes && <NotesPane ctl={ctl} />}
        </div>
      </div>

      {ctxMenu && (
        <div onMouseDown={(e) => e.stopPropagation()}>
          <MenuList items={slideMenu(ctxMenu.index)} onDone={() => setCtxMenu(null)} style={{ position: 'fixed', left: ctxMenu.x, top: ctxMenu.y }} />
        </div>
      )}

      {ctl.presenting && <PresentMode ctl={ctl} onExit={() => ctl.setPresenting(false)} />}
      {editingImage && editedPicture?.type === 'image' && <ImageEditDialog src={editedPicture.src} name="picture" onSave={(image, sizes) => saveEditedImage(editingImage, image, sizes)} onClose={() => setEditingImage(null)} />}

      {dialog?.kind === 'rename' && <PromptModal title="Rename presentation" label="Name" initial={meta.title} confirmText="Rename" onConfirm={rename} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'delete' && (
        <ConfirmModal
          title="Delete presentation?"
          message={<>“{meta.title}” will be permanently deleted. This cannot be undone.</>}
          confirmText="Delete"
          danger
          onConfirm={async () => {
            ctl.saver.dispose();
            await host.call('delete_file', { kind: 'deck', id: meta.id });
            onBack();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'deleteSlide' && (
        <ConfirmModal
          title="Delete slide?"
          message={<>Delete slide {dialog.index + 1}? You can undo this with {MOD}Z.</>}
          confirmText="Delete"
          danger
          onConfirm={() => void ctl.deleteSlides([dialog.index])}
          onClose={() => setDialog(null)}
        />
      )}
      {toast && <div className="docs-toast">{toast}</div>}
    </div>
  );
}

/** Speaker notes for the current slide; saved when the field loses focus. */
function NotesPane({ ctl }: { ctl: DeckController }) {
  const slide = ctl.slide;
  const [draft, setDraft] = useState(slide.notes ?? '');
  const [forId, setForId] = useState(slide.id);
  if (forId !== slide.id) {
    setForId(slide.id);
    setDraft(slide.notes ?? '');
  }
  return (
    <div className="deck-notes">
      <textarea
        value={draft}
        placeholder="Speaker notes"
        aria-label="Speaker notes"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== (slide.notes ?? '')) ctl.setNotes(draft);
        }}
      />
    </div>
  );
}
