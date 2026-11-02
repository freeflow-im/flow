import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { nameWithExt } from '../../../shared/docNames.ts';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { FolderCrumbs, lastListingHref } from '../components/FolderCrumbs.tsx';
import { FavoriteStar } from '../components/FavoriteStar.tsx';
import { FileSearchButton } from '../components/FileSearch.tsx';
import { TitleInput } from '../components/TitleInput.tsx';
import { LAYOUT_IDS, THEME_IDS, THEMES, type Deck } from '../../../shared/deck.ts';
import type { SheetMeta } from '../../../shared/types.ts';
import { AgentButton } from '../agent/AgentPanel.tsx';
import { useAgent, useRegisterDeck } from '../agent/AgentProvider.tsx';
import { api, ApiError } from '../api.ts';
import { RevisionSync, takenMessage } from '../state/revisionSync.ts';
import { Account } from '../components/Account.tsx';
import { uploadImageFile, pickImageFile } from '../cellImage.ts';
import { imageDialogOpen } from '../image/dialogOpen.ts';
import { ImageEditDialog } from '../image/ImageEditDialog.tsx';

// Remove background in the image editor: a model that runs in the browser, fetched when it is first used.
const loadBackgroundRemoval = () => import('@imgly/background-removal');
import type { PictureSizes } from '../image/ImageFileEditor.tsx';
import { isMac, MOD } from '../commands.ts';
import { DeckIcon } from '../components/Logo.tsx';
import { MenuList, type MenuItem } from '../components/Menu.tsx';
import { ConfirmModal, PromptModal } from '../components/Modal.tsx';
import { useOfficeFile } from '../components/OfficeFile.tsx';
import { lockedGuard } from '../state/store.ts';
import { pptxGuard } from '../deck/store.ts';
import { ResizeHandle, usePanelWidth } from '../components/ResizeHandle.tsx';
import { DeckController, useDeckController } from '../deck/controller.ts';
import { DeckEditor } from '../deck/DeckEditor.tsx';
import { useDeckFonts } from '../deck/fonts.ts';
import { useFavicon } from '../favicon.ts';
import { DeckToolbar, LAYOUT_NAMES, shapeMenuItems, tableMenuItems } from '../deck/DeckToolbar.tsx';
import { downloadPptx } from '../deck/pptx.ts';
import { copyPicture } from '../deck/copyPicture.ts';
import { FindBox, FindToggle } from '../find/FindBox.tsx';
import { isFindKey } from '../find/find.ts';
import { clearMatches, paintMatches, rangesIn } from '../find/highlights.ts';
import { VideoDialog } from '../components/VideoDialog.tsx';
import { SheetTableDialog } from '../deck/SheetTableDialog.tsx';
import { SheetChartDialog } from '../deck/SheetChartDialog.tsx';
import { useLinkedTables } from '../deck/linkedTables.ts';
import { PresentMode } from '../deck/PresentMode.tsx';
import { useAuth } from '../auth.tsx';
import { onBeforeLeave } from '../suite.ts';
import { ShareDialog } from '../components/ShareDialog.tsx';
import { checkPptxFile, pickPptxFile } from '../importFile.ts';
import { SlideView } from '../deck/SlideView.tsx';
import { ThumbnailStrip } from '../deck/ThumbnailStrip.tsx';
import { SLIDE_TRAY } from '../panelSize.ts';
import { appName } from '../brand.ts';
import { downloadPdf, printingPdf, signalPrintReady } from '../print.ts';
import { useOpenInTab } from '../components/OpenInTab.tsx';

/** Natural size of an image, for sizing a new image element. */
function imageSize(src: string): Promise<{ w: number; h: number } | undefined> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(undefined);
    img.src = src;
  });
}

function downloadFile(name: string, mime: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);

export function DeckPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<{ meta: SheetMeta; notKept?: string[]; ctl: DeckController; sync: RevisionSync<Deck> } | { error: string } | null>(null);
  const { deckFailed } = useAgent();

  useEffect(() => {
    let ctl: DeckController | null = null;
    let stopSync = () => {};
    let cancelled = false;
    setState(null);
    api
      .getDeck(id!)
      .then(({ meta, deck, notKept }) => {
        if (cancelled) return;
        // Saves name the revision loaded, and the editor follows saves made elsewhere (revisionSync.ts).
        const sync = new RevisionSync<Deck>(meta.id, meta.updatedAt, {
          save: (d, rev) => api.saveDeck(meta.id, d, rev),
          load: async () => {
            const latest = await api.getDeck(meta.id);
            if (ctl) {
              // The newer version is put in place as a change, which the guard must let through; then the
              // guard of its format applies. A PowerPoint file not yet allowed editing stays read-only.
              const c = ctl;
              const locked = c.store.guard === lockedGuard && latest.meta.format === meta.format;
              c.store.guard = null;
              setTimeout(() => (c.store.guard = locked ? lockedGuard : guardFor(latest.meta, undefined)));
            }
            return { meta: latest.meta, doc: latest.deck };
          },
        });
        ctl = new DeckController(deck, sync.save);
        stopSync = sync.attach(ctl);
        // A PowerPoint file only takes the changes it can hold, and none while it waits for the user's
        // yes to removing what the app cannot keep (useOfficeFile).
        ctl.store.guard = guardFor(meta, notKept);
        setState({ meta, notKept, ctl, sync });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const error = e instanceof ApiError && e.status === 404 ? 'This presentation does not exist or was deleted.' : String((e as Error).message ?? e);
        setState({ error });
        deckFailed(id!, error);
      });
    return () => {
      cancelled = true;
      stopSync();
      if (ctl) {
        void ctl.saver.flush();
        ctl.dispose();
      }
    };
  }, [id, deckFailed]);

  if (!state) return <div className="page-loading">Loading presentation…</div>;
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
  return <DeckWorkbench key={state.meta.id} initialMeta={state.meta} initialNotKept={state.notKept} ctl={state.ctl} sync={state.sync} />;
}

/** The guard of the file's format (desktop app): what a PowerPoint file cannot hold, or everything until editing is allowed. */
function guardFor(meta: SheetMeta, notKept: string[] | undefined) {
  if (meta.format !== 'pptx') return null;
  return notKept?.length ? lockedGuard : pptxGuard;
}

type Dialog = { kind: 'rename' } | { kind: 'delete' } | { kind: 'share' } | null;

function DeckWorkbench({ initialMeta, initialNotKept, ctl, sync }: { initialMeta: SheetMeta; initialNotKept?: string[]; ctl: DeckController; sync: RevisionSync<Deck> }) {
  // In the FreeFlow suite the suite bar replaces the logo, the Assistant button and Sign out (components/DocsSuiteBar.tsx).
  const inSuite = !!useAuth().suite;
  // The suite bar's Log out saves first, as Sign out here did.
  useEffect(() => onBeforeLeave(() => ctl.saver.flush()), [ctl]);
  useDeckController(ctl);
  useDeckFonts(ctl.deck);
  useFavicon('deck');
  const navigate = useNavigate();
  const location = useLocation();
  // Notes from a PowerPoint import: arrive via navigation state (home-page import) or from File → Import.
  const [importWarnings, setImportWarnings] = useState<string[]>(() => (location.state as { importWarnings?: string[] } | null)?.importWarnings ?? []);
  const dismissImportWarnings = () => {
    setImportWarnings([]);
    if (location.state) navigate(location.pathname, { replace: true, state: null });
  };
  const [meta, setMeta] = useState(initialMeta);
  useRegisterDeck(ctl, meta);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  // A right-click menu: a slide's (on its thumbnail, `index`) or the selected elements' (on the slide).
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; index?: number } | null>(null);
  const [showNotes, setShowNotes] = useState(true);
  // Made into a PDF by the server (print.ts), the page starts laid out for printing.
  const [printing, setPrinting] = useState(printingPdf);
  const [, setSaveTick] = useState(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The thumbnail tray shares the body with the canvas (less the 8px gap between them).
  const bodyRef = useRef<HTMLDivElement>(null);
  const tray = usePanelWidth(SLIDE_TRAY, () => (bodyRef.current ? { available: bodyRef.current.clientWidth - 8 } : {}), bodyRef);

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

  /** File › Download as PDF: saved first, then made by the server (print.ts). */
  const exportPdf = async () => {
    notify('Making the PDF…');
    try {
      await ctl.saver.flush();
      await downloadPdf(meta.id);
      notify('Downloaded.');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  };
  const office = useOfficeFile({
    meta,
    initialNotKept,
    own: 'presentation',
    allow: () => (ctl.store.guard = pptxGuard),
    keepOwn: async () => {
      await ctl.saver.flush();
      const { meta: kept } = await api.convertDeck(meta.id);
      // Keeping it is a new revision with the same content: the change that asked for it saves on top of it.
      sync.rev = kept.updatedAt;
      ctl.store.guard = null;
      setMeta(kept);
    },
    notify,
  });
  useEffect(() => {
    ctl.onRefused = office.onRefused;
    return () => {
      ctl.onRefused = null;
    };
  });
  // The file was saved somewhere else (another tab, the ChatGPT plugin) and the editor took that version.
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
      for (const file of files.slice(0, 10)) {
        try {
          const url = await uploadImageFile(file);
          ctl.addImage(url, await imageSize(url));
        } catch (e) {
          notify(e instanceof Error ? e.message : String(e));
        }
      }
    },
    [ctl, notify],
  );

  // ⌘F opens the presentation's find bar instead of the browser's page search, wherever the focus is.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isFindKey(e) || ctl.presenting) return;
      e.preventDefault();
      ctl.openFind();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ctl]);
  // The matches on the slide shown are highlighted where it is drawn, the one shown standing out. After every
  // redraw: the slide's text may have changed.
  useEffect(() => {
    const f = ctl.find;
    const canvas = bodyRef.current?.querySelector('.deck-main .deck-canvas');
    if (!f?.query || !canvas) return clearMatches();
    const ranges = rangesIn(canvas, f.query, f.matchCase);
    const hit = ctl.findMatches()[f.current];
    const el = hit && hit.slide === ctl.current ? canvas.querySelector(`[data-el="${CSS.escape(hit.el)}"]`) : null;
    paintMatches(ranges, (el && ranges.filter((r) => el.contains(r.startContainer))[hit!.n]) ?? null);
    return clearMatches;
  });

  // Copy: the selected elements for pasting here, and a single picture onto the system clipboard as well. A paste
  // is of the elements copied here, unless the window has lost focus since (something may have been copied in
  // another app): then a picture on the system clipboard is added as a new picture.
  const copiedHere = useRef(false);
  const copy = useCallback(() => {
    if (!ctl.selection.length) return;
    ctl.copySelected();
    copiedHere.current = true;
    const only = ctl.selected.length === 1 ? ctl.selected[0] : null;
    if (only?.type === 'image') copyPicture(only).catch((e: unknown) => notify(e instanceof Error ? e.message : String(e)));
  }, [ctl, notify]);
  useEffect(() => {
    const away = () => (copiedHere.current = false);
    window.addEventListener('blur', away);
    return () => window.removeEventListener('blur', away);
  }, []);

  // The picture element open in the image editor. Saving stores the edited picture as a new image and puts it
  // on the slide as one step, so undo brings the picture back as it was.
  const [editingImage, setEditingImage] = useState<string | null>(null);
  const [insertingVideo, setInsertingVideo] = useState(false);
  const [insertingSheetTable, setInsertingSheetTable] = useState(false);
  const [insertingSheetChart, setInsertingSheetChart] = useState(false);
  // Tables linked to spreadsheet ranges follow them while the presentation is open.
  const linked = useLinkedTables(ctl);
  const editedPicture = ctl.deck.slides.flatMap((s) => s.elements).find((e) => e.id === editingImage && e.type === 'image');
  const saveEditedImage = async (id: string, image: Blob, sizes: PictureSizes) => {
    const url = await uploadImageFile(image);
    if (!ctl.replacePicture(id, url, sizes.before, sizes.after)) notify('The picture is no longer in the presentation, so the edit was not put in.');
  };

  const insertImage = async () => {
    const file = await pickImageFile();
    if (file) await addImageFiles([file]);
  };

  const exportPptx = async () => {
    notify('Preparing the PowerPoint file…');
    try {
      const warnings = await downloadPptx(ctl.deck, meta.title);
      notify(warnings.length ? warnings.join(' ') : 'Downloaded.');
    } catch (e) {
      notify(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** File → Import: add the slides of a .pptx after the current slide, as one undoable change. */
  const importPptxSlides = async () => {
    const file = await pickPptxFile();
    if (!file) return;
    const problem = checkPptxFile(file);
    if (problem) return notify(problem);
    notify(`Importing “${file.name}”…`);
    try {
      const { deck, warnings } = await api.convertPptx(file);
      const at = ctl.current + 1;
      ctl.run((tx) => deck.slides.forEach((s, k) => tx.insertSlide(at + k, s)));
      ctl.goTo(at);
      setImportWarnings(warnings);
      const n = deck.slides.length;
      notify(`Added ${n} slide${n === 1 ? '' : 's'} from “${file.name}”. Press ${MOD}Z to undo.`);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  };

  // Global shortcuts (not while typing in an input, the notes or an inline text editor).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A picture being cropped keeps the keys to itself (CropOverlay takes Enter and Escape).
      // Keys in a dialog (Table from spreadsheet's list, say) are the dialog's.
      if (ctl.presenting || ctl.cropping || imageDialogOpen() || document.querySelector('.modal-backdrop') || isTyping(e.target)) return;
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
        copy();
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
        // A table edits its current cell, or its first.
        if (ctl.table) ctl.selectCell(ctl.table.id, ctl.tableCell?.r ?? 0, ctl.tableCell?.c ?? 0, true);
        else ctl.startEditing(ctl.selection[0]);
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      if (ctl.presenting || imageDialogOpen() || isTyping(e.target)) return;
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
      if (files.length && !copiedHere.current) {
        e.preventDefault();
        void addImageFiles(files);
      } else ctl.paste();
    };
    // Mod-J opens the prompt to the assistant on the slide. Caught on the way down, because a text box being
    // edited keeps its keys to itself; the text selected in it goes along, since opening the prompt ends the edit.
    const onAssist = (e: KeyboardEvent) => {
      if (!(isMac ? e.metaKey : e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'j' || ctl.presenting) return;
      const inText = e.target instanceof HTMLElement && !!e.target.closest('.sl-editing');
      if (isTyping(e.target) && !inText) return;
      e.preventDefault();
      const text = inText ? (window.getSelection()?.toString() ?? '') : '';
      ctl.setAssistant(text.trim() ? { text } : {});
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keydown', onAssist, true);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onAssist, true);
      window.removeEventListener('paste', onPaste);
    };
  }, [ctl, addImageFiles, copy]);

  // Close menus on outside click.
  useEffect(() => {
    if (!openMenu && !ctxMenu) return;
    const close = () => {
      setOpenMenu(null);
      setCtxMenu(null);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [openMenu, ctxMenu]);

  // Print: lay every slide out on its own page, print, then go back to the editor.
  useEffect(() => {
    if (!printing) return;
    if (printingPdf()) return void signalPrintReady();
    const done = () => setPrinting(false);
    window.addEventListener('afterprint', done);
    const t = setTimeout(() => window.print(), 50);
    return () => {
      clearTimeout(t);
      window.removeEventListener('afterprint', done);
    };
  }, [printing]);

  const rename = async (t: string) => {
    const { meta: m } = await api.renameDeck(meta.id, t);
    setMeta(m);
  };

  const slideMenu = (index: number): MenuItem[] => [
    { label: 'New slide', shortcut: '', submenu: LAYOUT_IDS.map((l) => ({ label: LAYOUT_NAMES[l], action: () => ctl.addSlide(l, {}, index + 1) })) },
    { label: 'Duplicate slide', shortcut: `${MOD}D`, action: () => ctl.duplicateSlide(index) },
    { label: 'Delete slide', danger: true, disabled: ctl.deck.slides.length <= 1, action: () => void ctl.deleteSlides([index]) },
    'sep',
    { label: 'Layout', submenu: LAYOUT_IDS.map((l) => ({ label: LAYOUT_NAMES[l], checked: ctl.deck.slides[index]?.layout === l, action: () => ctl.setLayout(l, index) })) },
  ];

  const openInTab = useOpenInTab();
  const local = !!useAuth().local;
  const menus: { key: string; label: string; items: () => MenuItem[] }[] = [
    {
      key: 'file',
      label: 'File',
      items: () => [
        ...openInTab.items,
        {
          label: 'New presentation',
          action: async () => {
            const { deck } = await api.createDeck('Untitled presentation');
            window.open(`/d/${deck.id}`, '_blank');
          },
        },
        { label: 'Rename…', action: () => setDialog({ kind: 'rename' }) },
        { label: 'Import PowerPoint slides…', action: () => void importPptxSlides() },
        'sep',
        { label: 'Download as PowerPoint (.pptx)', action: () => void exportPptx() },
        { label: 'Download as PDF', action: () => void exportPdf() },
        { label: 'Print / Save as PDF…', shortcut: `${MOD}P`, action: () => setPrinting(true) },
        { label: 'Download as JSON', action: () => downloadFile(nameWithExt(meta.title, 'json'), 'application/json', JSON.stringify(ctl.deck, null, 2)) },
        'sep',
        { label: 'Delete presentation', danger: true, action: () => setDialog({ kind: 'delete' }) },
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
        { label: 'Find…', shortcut: `${MOD}F`, action: () => ctl.openFind() },
        'sep',
        { label: 'Copy', shortcut: `${MOD}C`, disabled: !ctl.selection.length, action: copy },
        { label: 'Paste', shortcut: `${MOD}V`, action: () => ctl.paste() },
        { label: 'Duplicate', shortcut: `${MOD}D`, action: () => (ctl.selection.length ? ctl.duplicateSelected() : ctl.duplicateSlide()) },
        { label: 'Delete', shortcut: 'Delete', disabled: !ctl.selection.length, action: () => ctl.deleteSelected() },
        { label: 'Select all', shortcut: `${MOD}A`, action: () => ctl.select(ctl.slide.elements.map((e) => e.id)) },
        'sep',
        { label: 'Ask the assistant here…', shortcut: `${MOD}J`, action: () => ctl.setAssistant({}) },
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
        { label: 'Video…', action: () => setInsertingVideo(true) },
        { label: 'Table', submenu: tableMenuItems(ctl) },
        { label: 'Table from spreadsheet…', action: () => setInsertingSheetTable(true) },
        { label: 'Chart from spreadsheet…', action: () => setInsertingSheetChart(true) },
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
    // A public link is for a file on the server; the desktop app's files are on the person's computer.
    ...(local ? [] : [{ key: 'sharing', label: 'Sharing', items: (): MenuItem[] => [{ label: 'Public link…', action: () => setDialog({ kind: 'share' }) }] }]),
  ];

  const saveLabel = {
    saved: 'All changes saved',
    dirty: 'Unsaved changes',
    saving: 'Saving…',
    error: `Save failed — retrying${ctl.saver.error ? ` (${ctl.saver.error})` : ''}`,
  }[ctl.saver.status];

  const onThumbContextMenu = (e: MouseEvent, index: number) => setCtxMenu({ x: e.clientX, y: e.clientY, index });
  /** The right-click menu on the slide: for the selected elements, or with none, for the slide. */
  const elementMenu = (): MenuItem[] => {
    const picture = ctl.selected.length === 1 && ctl.selected[0].type === 'image' ? ctl.selected[0] : null;
    if (!ctl.selection.length)
      return [
        { label: 'Paste', shortcut: `${MOD}V`, action: () => ctl.paste() },
        { label: 'Select all', shortcut: `${MOD}A`, action: () => ctl.select(ctl.slide.elements.map((e) => e.id)) },
      ];
    return [
      { label: 'Copy', shortcut: `${MOD}C`, action: copy },
      { label: 'Paste', shortcut: `${MOD}V`, action: () => ctl.paste() },
      { label: 'Duplicate', shortcut: `${MOD}D`, action: () => ctl.duplicateSelected() },
      { label: 'Delete', shortcut: 'Delete', action: () => ctl.deleteSelected() },
      ...(picture ? ['sep' as const, { label: 'Crop', action: () => ctl.startCropping(picture.id) }, { label: 'Edit image…', action: () => setEditingImage(picture.id) }] : []),
      'sep',
      { label: 'Bring to front', action: () => ctl.reorder(ctl.selection, 'front') },
      { label: 'Bring forward', action: () => ctl.reorder(ctl.selection, 'forward') },
      { label: 'Send backward', action: () => ctl.reorder(ctl.selection, 'backward') },
      { label: 'Send to back', action: () => ctl.reorder(ctl.selection, 'back') },
    ];
  };

  return (
    <div className="workbench deck-page">
      {openInTab.dialog}
      {!printing && (
        <>
          <header className="wb-header">
            {!inSuite && (
              <Link to={lastListingHref()} className="wb-logo" title="Back to the file list" onClick={() => void ctl.saver.flush()}>
                <DeckIcon size={32} />
              </Link>
            )}
            <div className="wb-titles">
              <div className="wb-title-row">
                <FavoriteStar kind="deck" id={meta.id} onError={notify} />
                <FolderCrumbs folder={meta.folder} onLeave={() => void ctl.saver.flush()} />
                <TitleInput title={meta.title} label="Presentation name" onRename={rename} onError={notify} />
                <span className={`save-status ${ctl.saver.status}`}>{saveLabel}</span>
                {office.chip}
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
          <DeckToolbar ctl={ctl} onPresent={() => ctl.setPresenting(true)} onInsertImage={() => void insertImage()} onInsertVideo={() => setInsertingVideo(true)} onEditImage={setEditingImage} onInsertSheetTable={() => setInsertingSheetTable(true)} linked={linked} onOpenSheet={(id) => navigate(`/s/${encodeURIComponent(id)}`)} />
          {importWarnings.length > 0 && (
            <div className="import-banner" role="status">
              <div>
                <strong>Imported with some changes:</strong>
                <ul>
                  {importWarnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
              <button className="link" onClick={dismissImportWarnings}>
                Dismiss
              </button>
            </div>
          )}
          <div className="deck-body" ref={bodyRef}>
            <ThumbnailStrip ctl={ctl} width={tray.width} onContextMenu={onThumbContextMenu} />
            <ResizeHandle panel={tray} side="left" label="Resize slide thumbnails" className="deck-thumbs-resize" />
            <div className="deck-main">
              <DeckEditor ctl={ctl} onImageFiles={(files) => void addImageFiles(files)} onEditImage={setEditingImage} onContextMenu={(at) => setCtxMenu(at)} />
              {showNotes && <NotesPane ctl={ctl} />}
              {ctl.find && (
                <FindBox
                  query={ctl.find.query}
                  onQuery={(query) => ctl.setFind({ query })}
                  count={ctl.findMatches().length}
                  current={ctl.find.current}
                  onStep={(dir) => ctl.findStep(dir)}
                  onClose={() => ctl.closeFind()}
                  focusSeq={ctl.find.focusSeq}
                  placeholder="Find in slides"
                  label="Find in presentation"
                >
                  <FindToggle on={ctl.find.matchCase} title="Match case" onClick={() => ctl.setFind({ matchCase: !ctl.find!.matchCase })}>
                    Aa
                  </FindToggle>
                </FindBox>
              )}
            </div>
          </div>
        </>
      )}

      {printing && (
        <div className="deck-print">
          {/* The page is a slide's size; only while printing a presentation, so other pages keep theirs. */}
          <style>{'@page { size: 10in 5.625in; margin: 0; }'}</style>
          {ctl.deck.slides.map((s) => (
            <div key={s.id} className="deck-print-page">
              <SlideView slide={s} theme={ctl.deck.theme} scale={1} />
            </div>
          ))}
        </div>
      )}

      {ctxMenu && (
        <div onMouseDown={(e) => e.stopPropagation()}>
          <MenuList items={ctxMenu.index === undefined ? elementMenu() : slideMenu(ctxMenu.index)} onDone={() => setCtxMenu(null)} style={{ position: 'fixed', left: ctxMenu.x, top: ctxMenu.y }} />
        </div>
      )}

      {ctl.presenting && <PresentMode ctl={ctl} onExit={() => ctl.setPresenting(false)} />}
      {insertingSheetChart && <SheetChartDialog onInsert={(id, chartId, c, keep) => ctl.addSheetChart(id, chartId, c, keep)} onClose={() => setInsertingSheetChart(false)} />}
      {insertingSheetTable && <SheetTableDialog onInsert={(id, table, keep, used) => ctl.addSheetTable(id, table, keep, used)} onClose={() => setInsertingSheetTable(false)} />}
      {insertingVideo && <VideoDialog folder={meta.folder} onInsert={(src) => ctl.addVideo(src)} onClose={() => setInsertingVideo(false)} />}
      {editingImage && editedPicture?.type === 'image' && <ImageEditDialog backgroundRemovalLoader={loadBackgroundRemoval} src={editedPicture.src} name="picture" onSave={(image, sizes) => saveEditedImage(editingImage, image, sizes)} onClose={() => setEditingImage(null)} />}

      {dialog?.kind === 'share' && <ShareDialog kind="deck" id={meta.id} name={meta.title} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'rename' && <PromptModal title="Rename presentation" label="Name" initial={meta.title} confirmText="Rename" onConfirm={rename} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'delete' && (
        <ConfirmModal
          title="Delete presentation?"
          message={<>“{meta.title}” will be permanently deleted. This cannot be undone.</>}
          confirmText="Delete"
          danger
          onConfirm={async () => {
            ctl.saver.dispose();
            await api.deleteDeck(meta.id);
            navigate('/');
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {office.dialogs}
      {toast && <div className="toast">{toast}</div>}
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
