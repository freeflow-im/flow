import { DOMSerializer } from 'prosemirror-model';
import { nameWithExt, titleBase } from '../../../shared/docNames.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { FolderCrumbs, lastListingHref } from '../components/FolderCrumbs.tsx';
import { FavoriteStar } from '../components/FavoriteStar.tsx';
import { FileSearchButton } from '../components/FileSearch.tsx';
import { TitleInput } from '../components/TitleInput.tsx';
import { docNode, docSchema, docStyleCss, docStyleOf, PAGE_SIZES, type BlockType, type Doc } from '../../../shared/doc.ts';
import { docToMarkdown } from '../../../shared/docMarkdown.ts';
import { safeLinkUrl } from '../../../shared/links.ts';
import type { SheetMeta } from '../../../shared/types.ts';
import { AgentButton } from '../agent/AgentPanel.tsx';
import { useAgent, useRegisterDoc } from '../agent/AgentProvider.tsx';
import { api, ApiError } from '../api.ts';
import { RevisionSync, takenMessage } from '../state/revisionSync.ts';
import { Account } from '../components/Account.tsx';
import { pickImageFile, uploadImageFile } from '../cellImage.ts';
import { ImageEditDialog } from '../image/ImageEditDialog.tsx';

// Remove background in the image editor: a model that runs in the browser, fetched when it is first used.
const loadBackgroundRemoval = () => import('@imgly/background-removal');
import type { PictureSizes } from '../image/ImageFileEditor.tsx';
import { MOD } from '../commands.ts';
import { FindBox, FindToggle } from '../find/FindBox.tsx';
import { isFindKey } from '../find/find.ts';
import { DocIcon } from '../components/Logo.tsx';
import { MenuList, type MenuItem } from '../components/Menu.tsx';
import { ConfirmModal, PromptModal } from '../components/Modal.tsx';
import { useOfficeFile } from '../components/OfficeFile.tsx';
import { lockedGuard } from '../state/store.ts';
import { docxGuard } from '../doc/store.ts';
import { DocController, useDocController } from '../doc/controller.ts';
import { DocEditor, DocPrint } from '../doc/DocEditor.tsx';
import { PageThumbnails } from '../doc/PageThumbnails.tsx';
import { ZoomControls } from '../components/ZoomControls.tsx';
import { ResizeHandle, usePanelWidth } from '../components/ResizeHandle.tsx';
import { DOC_TRAY } from '../panelSize.ts';
import { PageSetupDialog } from '../doc/PageSetupDialog.tsx';
import { DocStyleDialog } from '../doc/DocStyleDialog.tsx';
import { DocToolbar } from '../doc/DocToolbar.tsx';
import { SignatureDialog } from '../pdf/SignatureDialog.tsx';
import { SignMenu, signatureFile, today, useSignatures, type Signature } from '../components/SignMenu.tsx';
import { VideoDialog } from '../components/VideoDialog.tsx';
import { checkDocxFile, pickDocxFile } from '../importFile.ts';
import { useDocFonts } from '../doc/fonts.ts';
import { useFavicon } from '../favicon.ts';
import { appName } from '../brand.ts';
import { downloadPdf, printingPdf, signalPrintReady } from '../print.ts';
import { useOpenInTab } from '../components/OpenInTab.tsx';

function downloadFile(name: string, mime: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A standalone HTML page of the document, for downloading. */
function docToHtml(ctl: DocController, title: string): string {
  const body = document.createElement('div');
  body.append(DOMSerializer.fromSchema(docSchema).serializeFragment(ctl.doc.content));
  const s = docStyleOf(ctl.doc);
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>\n<style>body{${docStyleCss(s)};max-width:760px;margin:40px auto;padding:0 24px;font-family:var(--doc-font);font-size:var(--doc-size);line-height:var(--doc-line);color:#1f1f1f}p{margin:0 0 var(--doc-space)}h1.doc-title{font-size:40px;font-weight:400;margin:0 0 6px}p.doc-subtitle{font-size:20px;color:#5f6368;margin:0 0 20px}img{max-width:100%}figure{margin:16px 0}figure[data-align=center]{text-align:center}figure[data-align=right]{text-align:right}blockquote{margin:0;padding-left:16px;border-left:3px solid #dadce0;color:#5f6368}pre{background:#f1f3f4;padding:12px;border-radius:6px;overflow:auto}code{font-family:Menlo,Consolas,monospace;font-size:14px}</style></head>\n<body>\n${body.innerHTML}\n</body></html>\n`;
}

export function DocPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<{ meta: SheetMeta; notKept?: string[]; ctl: DocController; sync: RevisionSync<Doc> } | { error: string } | null>(null);
  const { docFailed } = useAgent();

  useEffect(() => {
    let ctl: DocController | null = null;
    let stopSync = () => {};
    let cancelled = false;
    setState(null);
    api
      .getDoc(id!)
      .then(({ meta, doc, notKept }) => {
        if (cancelled) return;
        // Saves name the revision loaded, and the editor follows saves made elsewhere (revisionSync.ts).
        const sync = new RevisionSync<Doc>(meta.id, meta.updatedAt, {
          save: (d, rev) => api.saveDoc(meta.id, d, rev),
          load: async () => {
            const latest = await api.getDoc(meta.id);
            if (ctl) {
              // The newer version is put in place as a change, which the guard must let through; then the
              // guard of its format applies. A Word file not yet allowed editing stays read-only.
              const c = ctl;
              const locked = c.store.guard === lockedGuard && latest.meta.format === meta.format;
              c.store.guard = null;
              setTimeout(() => (c.store.guard = locked ? lockedGuard : guardFor(latest.meta, undefined)));
            }
            return { meta: latest.meta, doc: latest.doc };
          },
        });
        ctl = new DocController(doc, sync.save);
        stopSync = sync.attach(ctl);
        // A Word file only takes the changes it can hold, and none while it waits for the user's
        // yes to removing what the app cannot keep (useOfficeFile).
        ctl.store.guard = guardFor(meta, notKept);
        setState({ meta, notKept, ctl, sync });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const error = e instanceof ApiError && e.status === 404 ? 'This document does not exist or was deleted.' : String((e as Error).message ?? e);
        setState({ error });
        docFailed(id!, error);
      });
    return () => {
      cancelled = true;
      stopSync();
      if (ctl) {
        void ctl.saver.flush();
        ctl.dispose();
      }
    };
  }, [id, docFailed]);

  if (!state) return <div className="page-loading">Loading document…</div>;
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
  return <DocWorkbench key={state.meta.id} initialMeta={state.meta} initialNotKept={state.notKept} ctl={state.ctl} sync={state.sync} />;
}

/** The guard of the file's format (desktop app): what a Word file cannot hold, or everything until editing is allowed. */
function guardFor(meta: SheetMeta, notKept: string[] | undefined) {
  if (meta.format !== 'docx') return null;
  return notKept?.length ? lockedGuard : docxGuard;
}

type Dialog = { kind: 'rename' } | { kind: 'delete' } | { kind: 'link'; initial: string } | { kind: 'pageSetup' } | { kind: 'docStyle' } | null;

const LINE_SPACINGS: [string, number | null][] = [['Default', null], ['Single', 1.15], ['1.5', 1.5], ['Double', 2]];

const ZOOMS = [50, 75, 100, 125, 150, 200] as const;
/** A signature is put in the line this tall (in CSS pixels, about two lines of text), and no wider than this. */
const SIGNATURE_HEIGHT = 44;
const SIGNATURE_MAX_WIDTH = 240;
const THUMBS_KEY = 'ui.docThumbs';

function loadShowThumbs(): boolean {
  try {
    return localStorage.getItem(THUMBS_KEY) !== '0';
  } catch {
    return true;
  }
}

function DocWorkbench({ initialMeta, initialNotKept, ctl, sync }: { initialMeta: SheetMeta; initialNotKept?: string[]; ctl: DocController; sync: RevisionSync<Doc> }) {
  useDocController(ctl);
  useDocFonts(ctl.doc);
  useFavicon('doc');
  const navigate = useNavigate();
  const location = useLocation();
  // Notes from a Word import: arrive via navigation state (home-page import) or from File → Import.
  const [importWarnings, setImportWarnings] = useState<string[]>(() => (location.state as { importWarnings?: string[] } | null)?.importWarnings ?? []);
  const dismissImportWarnings = () => {
    setImportWarnings([]);
    if (location.state) navigate(location.pathname, { replace: true, state: null });
  };
  const [meta, setMeta] = useState(initialMeta);
  useRegisterDoc(ctl, meta);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [showThumbs, setShowThumbsState] = useState(loadShowThumbs);
  const setShowThumbs = (v: boolean) => {
    setShowThumbsState(v);
    try {
      localStorage.setItem(THUMBS_KEY, v ? '1' : '0');
    } catch {
      // Not remembered, that's all.
    }
  };
  // The thumbnail rail shares the body with the page area (less the 8px gap between them).
  const rowRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const tray = usePanelWidth(DOC_TRAY, () => (rowRef.current ? { available: rowRef.current.clientWidth - 8 } : {}), rowRef);
  const [, setSaveTick] = useState(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => ctl.saver.subscribe(() => setSaveTick((t) => t + 1)), [ctl]);
  // ⌘F opens the document's find bar instead of the browser's page search, wherever the focus is.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isFindKey(e)) return;
      e.preventDefault();
      ctl.openFind();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ctl]);
  // The size the pages are drawn at, which the zoom controls show and step from (fitting can land between levels).
  const [pageScale, setPageScale] = useState(1);
  const zoomOut = [...ZOOMS].reverse().find((z) => z < pageScale * 100 - 0.5);
  const zoomIn = ZOOMS.find((z) => z > pageScale * 100 + 0.5);

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
    own: 'document',
    allow: () => (ctl.store.guard = docxGuard),
    keepOwn: async () => {
      await ctl.saver.flush();
      const { meta: kept } = await api.convertDoc(meta.id);
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

  // The picture open in the image editor: where it was and what it was, to find it again when the edit is saved.
  // Saving stores the edited picture as a new image and puts it in the block as one step, so undo brings the
  // picture back as it was.
  const [editingImage, setEditingImage] = useState<{ pos: number; src: string } | null>(null);
  const editImage = useCallback(() => {
    const img = ctl.selectedImage();
    if (img) setEditingImage({ pos: img.pos, src: String(img.node.attrs.src) });
  }, [ctl]);
  const saveEditedImage = async (editing: { pos: number; src: string }, image: Blob, sizes: PictureSizes) => {
    const url = await uploadImageFile(image);
    if (!ctl.replaceImage(editing.pos, editing.src, url, sizes.before, sizes.after)) notify('The picture is no longer in the document, so the edit was not put in.');
  };

  const addImageFiles = useCallback(
    async (files: File[]) => {
      for (const file of files.slice(0, 10)) {
        try {
          const url = await uploadImageFile(file);
          ctl.insertImage(url, { alt: file.name.replace(/\.[^.]+$/, '') });
        } catch (e) {
          notify(e instanceof Error ? e.message : String(e));
        }
      }
    },
    [ctl, notify],
  );

  // Signing: a signature goes in the line at the cursor (on a form's blank, which it replaces when selected), stored
  // as a picture of the document, about as tall as two lines of text.
  const sigs = useSignatures();
  const [signing, setSigning] = useState(false);
  const signWith = async (sig: Signature) => {
    try {
      const url = await uploadImageFile(await signatureFile(sig));
      const width = Math.round(Math.min(SIGNATURE_MAX_WIDTH, (SIGNATURE_HEIGHT * sig.width) / Math.max(1, sig.height)));
      if (!ctl.insertInlineImage(url, { alt: 'Signature', width })) notify('Put the cursor in a line of text to sign there.');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  };
  const insertDate = () => {
    if (!ctl.insertText(today())) notify("Put the cursor in a line of text to put today's date there.");
  };

  const [insertingVideo, setInsertingVideo] = useState(false);
  const insertImage = async () => {
    const file = await pickImageFile();
    if (file) await addImageFiles([file]);
  };

  /** File → Import: add the blocks of a .docx after the cursor's block, as one undoable change. */
  const importDocxBlocks = async () => {
    const file = await pickDocxFile();
    if (!file) return;
    const problem = checkDocxFile(file);
    if (problem) return notify(problem);
    notify(`Importing “${file.name}”…`);
    try {
      const { doc, warnings } = await api.convertDocx(file);
      const blocks = docNode(doc).content;
      ctl.run((tr) => {
        const $head = tr.selection.$head;
        const pos = $head.depth ? $head.after(1) : $head.pos;
        tr.insert(pos, blocks).scrollIntoView();
      });
      setImportWarnings(warnings);
      const count = blocks.childCount;
      notify(`Added ${count} block${count === 1 ? '' : 's'} from “${file.name}”. Press ${MOD}Z to undo.`);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  };

  // The link dialog, from the toolbar, the Insert menu and Mod-K.
  const openLinkDialog = useCallback(() => setDialog({ kind: 'link', initial: ctl.linkAtCursor()?.href ?? '' }), [ctl]);
  useEffect(() => {
    ctl.onLinkPrompt = openLinkDialog;
    return () => {
      ctl.onLinkPrompt = null;
    };
  }, [ctl, openLinkDialog]);

  // Print: in Pages mode lay the pages out exactly as on screen, print, then go back to the editor. Made into a
  // PDF by the server (print.ts), the page is laid out once the fonts are in and says when it is drawn instead.
  useEffect(() => {
    if (!printingPdf()) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    void document.fonts.ready.then(() => (t = setTimeout(() => setPrinting(true), 50)));
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (!printing) return;
    if (printingPdf()) return void signalPrintReady();
    const done = () => setPrinting(false);
    window.addEventListener('afterprint', done);
    const t = setTimeout(() => window.print(), 80);
    return () => {
      clearTimeout(t);
      window.removeEventListener('afterprint', done);
    };
  }, [printing]);

  // Close menus on outside click.
  useEffect(() => {
    if (!openMenu) return;
    const close = () => setOpenMenu(null);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [openMenu]);

  const rename = async (t: string) => {
    const { meta: m } = await api.renameDoc(meta.id, t);
    setMeta(m);
  };

  const blockItem = (type: BlockType, label: string, shortcut?: string): MenuItem => ({ label, shortcut, checked: ctl.currentBlock() === type, action: () => ctl.setBlockType(type) });

  const openInTab = useOpenInTab();
  const menus: { key: string; label: string; items: () => MenuItem[] }[] = [
    {
      key: 'file',
      label: 'File',
      items: () => [
        ...openInTab.items,
        {
          label: 'New document',
          action: async () => {
            const { doc } = await api.createDoc('Untitled document');
            window.open(`/doc/${doc.id}`, '_blank');
          },
        },
        { label: 'Rename…', action: () => setDialog({ kind: 'rename' }) },
        { label: 'Import Word document…', action: () => void importDocxBlocks() },
        'sep',
        { label: 'Download as Markdown (.md)', action: () => downloadFile(nameWithExt(meta.title, 'md'), 'text/markdown', docToMarkdown(ctl.doc)) },
        { label: 'Download as web page (.html)', action: () => downloadFile(nameWithExt(meta.title, 'html'), 'text/html', docToHtml(ctl, titleBase(meta.title))) },
        { label: 'Download as PDF', action: () => void exportPdf() },
        { label: 'Print / Save as PDF…', shortcut: `${MOD}P`, action: () => setPrinting(true) },
        'sep',
        { label: 'Delete document', danger: true, action: () => setDialog({ kind: 'delete' }) },
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
        { label: 'Clear formatting', action: () => ctl.clearFormatting() },
        'sep',
        { label: 'Ask the assistant here…', shortcut: `${MOD}J`, action: () => ctl.setAssistantOpen(true) },
      ],
    },
    {
      key: 'view',
      label: 'View',
      items: () => [
        { label: 'Pages', checked: ctl.pageSetup().mode === 'pages', action: () => ctl.setPageSetup({ mode: 'pages' }) },
        { label: 'Pageless', checked: ctl.pageSetup().mode === 'pageless', action: () => ctl.setPageSetup({ mode: 'pageless' }) },
        'sep',
        { label: 'Page thumbnails', checked: showThumbs, action: () => setShowThumbs(!showThumbs) },
        'sep',
        {
          label: 'Zoom',
          submenu: [
            { label: 'Fit width', checked: ctl.zoom === 'fit', action: () => ctl.setZoom('fit') },
            ...ZOOMS.map((z) => ({ label: `${z}%`, checked: ctl.zoom === z, action: () => ctl.setZoom(z) })),
          ],
        },
      ],
    },
    {
      key: 'insert',
      label: 'Insert',
      items: () => [
        { label: 'Image…', action: () => void insertImage() },
        { label: 'Video…', action: () => setInsertingVideo(true) },
        { label: 'Signature…', disabled: office.locked, action: () => setSigning(true) },
        { label: "Today's date", disabled: office.locked, action: insertDate },
        { label: 'Link…', shortcut: `${MOD}K`, action: openLinkDialog },
        { label: 'Horizontal rule', action: () => ctl.insertHorizontalRule() },
        { label: 'Page break', shortcut: `${MOD}⏎`, action: () => ctl.insertPageBreak() },
      ],
    },
    {
      key: 'format',
      label: 'Format',
      items: () => [
        {
          label: 'Text',
          submenu: [
            { label: 'Bold', shortcut: `${MOD}B`, checked: ctl.isMarkActive('bold'), action: () => ctl.toggleMark('bold') },
            { label: 'Italic', shortcut: `${MOD}I`, checked: ctl.isMarkActive('italic'), action: () => ctl.toggleMark('italic') },
            { label: 'Underline', shortcut: `${MOD}U`, checked: ctl.isMarkActive('underline'), action: () => ctl.toggleMark('underline') },
            { label: 'Strikethrough', shortcut: `${MOD}⇧X`, checked: ctl.isMarkActive('strike'), action: () => ctl.toggleMark('strike') },
            { label: 'Code', shortcut: `${MOD}E`, checked: ctl.isMarkActive('code'), action: () => ctl.toggleMark('code') },
          ],
        },
        {
          label: 'Paragraph style',
          submenu: [
            blockItem('paragraph', 'Normal text', `${MOD}⌥0`),
            blockItem('title', 'Title'),
            blockItem('subtitle', 'Subtitle'),
            blockItem('heading1', 'Heading 1', `${MOD}⌥1`),
            blockItem('heading2', 'Heading 2', `${MOD}⌥2`),
            blockItem('heading3', 'Heading 3', `${MOD}⌥3`),
            blockItem('blockquote', 'Quote'),
            blockItem('code_block', 'Code block'),
          ],
        },
        {
          label: 'Align',
          submenu: [
            { label: 'Left', shortcut: `${MOD}⇧L`, checked: ctl.currentAlign() === 'left', action: () => ctl.setAlign('left') },
            { label: 'Center', shortcut: `${MOD}⇧E`, checked: ctl.currentAlign() === 'center', action: () => ctl.setAlign('center') },
            { label: 'Right', shortcut: `${MOD}⇧R`, checked: ctl.currentAlign() === 'right', action: () => ctl.setAlign('right') },
            { label: 'Justify', shortcut: `${MOD}⇧J`, checked: ctl.currentAlign() === 'justify', action: () => ctl.setAlign('justify') },
          ],
        },
        {
          label: 'Lists',
          submenu: [
            blockItem('bullet_list', 'Bulleted list', `${MOD}⇧8`),
            blockItem('ordered_list', 'Numbered list', `${MOD}⇧7`),
            'sep',
            { label: 'Increase indent', shortcut: 'Tab', action: () => ctl.indent() },
            { label: 'Decrease indent', shortcut: '⇧Tab', action: () => ctl.outdent() },
          ],
        },
        'sep',
        { label: 'Clear formatting', action: () => ctl.clearFormatting() },
        {
          label: 'Line spacing',
          submenu: LINE_SPACINGS.map(([label, value]) => ({ label, checked: (ctl.spacingAt().line ?? null) === value, action: () => ctl.setSpacing({ line: value }) })),
        },
        'sep',
        { label: 'Document style…', action: () => setDialog({ kind: 'docStyle' }) },
        { label: `Page setup… (${PAGE_SIZES[ctl.pageSetup().size].name.split(' ')[0]})`, action: () => setDialog({ kind: 'pageSetup' }) },
      ],
    },
  ];

  const saveLabel = {
    saved: 'All changes saved',
    dirty: 'Unsaved changes',
    saving: 'Saving…',
    error: `Save failed — retrying${ctl.saver.error ? ` (${ctl.saver.error})` : ''}`,
  }[ctl.saver.status];

  return (
    <div className={`workbench doc-page${printing && ctl.pageSetup().mode === 'pages' ? ' doc-printing-pages' : ''}`}>
      {openInTab.dialog}
      <header className="wb-header">
        <Link to={lastListingHref()} className="wb-logo" title="Back to the file list" onClick={() => void ctl.saver.flush()}>
          <DocIcon size={32} />
        </Link>
        <div className="wb-titles">
          <div className="wb-title-row">
            <FavoriteStar kind="doc" id={meta.id} onError={notify} />
            <FolderCrumbs folder={meta.folder} onLeave={() => void ctl.saver.flush()} />
            <TitleInput title={meta.title} label="Document name" onRename={rename} onError={notify} />
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
          <AgentButton />
          <Account before={() => ctl.saver.flush()} />
        </div>
      </header>
      <DocToolbar
        ctl={ctl}
        onLink={openLinkDialog}
        onInsertImage={() => void insertImage()}
        onInsertVideo={() => setInsertingVideo(true)}
        onEditImage={editImage}
        sign={<SignMenu sigs={sigs} disabled={office.locked} title="Sign at the cursor with one of your signatures, or put today's date there" onPick={(sig) => void signWith(sig)} onDate={insertDate} onError={notify} />}
      />
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
      <div className="doc-body-row" ref={rowRef}>
        {showThumbs && (
          <>
            <div className="doc-thumbs-col" style={{ width: tray.width }}>
              <button className="doc-thumbs-toggle" title="Hide page thumbnails" aria-label="Hide page thumbnails" onClick={() => setShowThumbs(false)}>
                ‹
              </button>
              <PageThumbnails ctl={ctl} width={tray.width} scrollRef={bodyRef} />
            </div>
            <ResizeHandle panel={tray} side="left" label="Resize page thumbnails" className="deck-thumbs-resize" />
          </>
        )}
        {!showThumbs && (
          <button className="doc-thumbs-toggle collapsed" title="Show page thumbnails" aria-label="Show page thumbnails" onClick={() => setShowThumbs(true)}>
            ›
          </button>
        )}
        <div
          className="doc-body"
          ref={bodyRef}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('Files')) e.preventDefault();
          }}
        >
          <DocEditor ctl={ctl} readOnly={office.locked} onImageFiles={(files) => void addImageFiles(files)} onScale={setPageScale} onEditImage={editImage} />
        </div>
        {ctl.find && (
          <FindBox
            query={ctl.find.query}
            onQuery={(query) => ctl.setFind({ query })}
            count={ctl.findMatches().length}
            current={ctl.find.current}
            onStep={(dir) => ctl.findStep(dir)}
            onClose={() => ctl.closeFind()}
            focusSeq={ctl.find.focusSeq}
            placeholder="Find in document"
            label="Find in document"
          >
            <FindToggle on={ctl.find.matchCase} title="Match case" onClick={() => ctl.setFind({ matchCase: !ctl.find!.matchCase })}>
              Aa
            </FindToggle>
          </FindBox>
        )}
        {/* Pages have a size to zoom; a pageless document always fills the window. */}
        {ctl.pageSetup().mode === 'pages' && (
          <ZoomControls
            percent={pageScale * 100}
            onOut={zoomOut === undefined ? undefined : () => ctl.setZoom(zoomOut)}
            onIn={zoomIn === undefined ? undefined : () => ctl.setZoom(zoomIn)}
            onFit={ctl.zoom === 'fit' ? undefined : () => ctl.setZoom('fit')}
          />
        )}
      </div>
      {printing && ctl.pageSetup().mode === 'pages' && <DocPrint ctl={ctl} />}

      {dialog?.kind === 'pageSetup' && <PageSetupDialog ctl={ctl} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'docStyle' && <DocStyleDialog ctl={ctl} onClose={() => setDialog(null)} />}
      {signing && <SignatureDialog onUse={async (image, remember) => (setSigning(false), void signWith(await sigs.add(image, remember)))} onClose={() => setSigning(false)} />}
      {insertingVideo && <VideoDialog folder={meta.folder} onInsert={(src, title) => ctl.insertVideo(src, { title: title.replace(/\.[^.]+$/, '') })} onClose={() => setInsertingVideo(false)} />}
      {editingImage && <ImageEditDialog backgroundRemovalLoader={loadBackgroundRemoval} src={editingImage.src} name="picture" onSave={(image, sizes) => saveEditedImage(editingImage, image, sizes)} onClose={() => setEditingImage(null)} />}
      {dialog?.kind === 'rename' && <PromptModal title="Rename document" label="Name" initial={meta.title} confirmText="Rename" onConfirm={rename} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'link' && (
        <PromptModal
          title={dialog.initial ? 'Edit link' : 'Add link'}
          label="Web address"
          initial={dialog.initial || 'https://'}
          confirmText={dialog.initial ? 'Update' : 'Add link'}
          validate={(v) => (v.trim() === '' || v.trim() === 'https://' || safeLinkUrl(v) ? null : 'Enter a full web address such as https://example.com, or leave it empty to remove the link.')}
          onConfirm={(v) => {
            const href = v.trim() === '' || v.trim() === 'https://' ? null : v.trim();
            if (!ctl.setLink(href)) notify('Select the text to link first.');
          }}
          onClose={() => {
            setDialog(null);
            ctl.focus();
          }}
        />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmModal
          title="Delete document?"
          message={<>“{meta.title}” will be permanently deleted. This cannot be undone.</>}
          confirmText="Delete"
          danger
          onConfirm={async () => {
            ctl.saver.dispose();
            await api.deleteDoc(meta.id);
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
