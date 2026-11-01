// One document open in the app's own editor (DocController, DocEditor, DocToolbar and dialogs), loaded and
// saved through the plugin's tools. Edits the model makes arrive by polling the revision; the user's cursor
// and selection go to the model as context, so "make this shorter" in the composer means the selection.
import { useCallback, useEffect, useRef, useState } from 'react';
import { pickImageFile, uploadImageFile } from '../../client/src/cellImage.ts';
import { ImageEditDialog } from '../../client/src/image/ImageEditDialog.tsx';
import type { PictureSizes } from '../../client/src/image/ImageFileEditor.tsx';
import { storePicture } from './imageStore.ts';
import { MOD } from '../../client/src/commands.ts';
import { MenuList, type MenuItem } from '../../client/src/components/Menu.tsx';
import { ConfirmModal, PromptModal } from '../../client/src/components/Modal.tsx';
import { ResizeHandle, usePanelWidth } from '../../client/src/components/ResizeHandle.tsx';
import { DocController, useDocController } from '../../client/src/doc/controller.ts';
import { DocEditor } from '../../client/src/doc/DocEditor.tsx';
import { DocStyleDialog } from '../../client/src/doc/DocStyleDialog.tsx';
import { DocToolbar } from '../../client/src/doc/DocToolbar.tsx';
import { useDocFonts } from '../../client/src/doc/fonts.ts';
import { PageSetupDialog } from '../../client/src/doc/PageSetupDialog.tsx';
import { PageThumbnails } from '../../client/src/doc/PageThumbnails.tsx';
import { DOC_TRAY } from '../../client/src/panelSize.ts';
import { PAGE_SIZES, type BlockType, type Doc } from '../../shared/doc.ts';
import { safeLinkUrl } from '../../shared/links.ts';
import type { Host, OpenFile } from './host.ts';

interface DocSummary {
  id: string;
  title: string;
  updated_at: string;
}

type Loaded = { meta: DocSummary; rev: string; data: Doc };

type Dialog = { kind: 'rename' } | { kind: 'delete' } | { kind: 'link'; initial: string } | { kind: 'pageSetup' } | { kind: 'docStyle' } | null;

const LINE_SPACINGS: [string, number | null][] = [['Default', null], ['Single', 1.15], ['1.5', 1.5], ['Double', 2]];
const ZOOMS = [50, 75, 100, 125, 150] as const;
const MAX_CONTEXT_TEXT = 500;

export function Editor({ host, id, remote, onBack }: { host: Host; id: string; remote: OpenFile | null; onBack(): void }) {
  const [state, setState] = useState<{ meta: DocSummary; ctl: DocController } | { error: string } | null>(null);
  const rev = useRef('');
  const syncing = useRef(false);

  /** Take the server's version when it is newer than ours. With force, even over unsaved local edits. */
  const applyRemote = useCallback(
    async (ctl: DocController, force: boolean) => {
      if (syncing.current) return;
      syncing.current = true;
      try {
        const r = await host.call<Loaded>('get_file', { kind: 'doc', id });
        if (r.rev === rev.current) return;
        if (!force && ctl.saver.hasUnsavedChanges()) return; // Our save will conflict and come back here with force.
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
    let ctl: DocController | null = null;
    let cancelled = false;
    setState(null);
    host
      .call<Loaded>('get_file', { kind: 'doc', id })
      .then((r) => {
        if (cancelled) return;
        rev.current = r.rev;
        const c = new DocController(r.data, async (d) => {
          try {
            const saved = await host.call<{ rev: string }>('save_file', { kind: 'doc', id, rev: rev.current, data: d });
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

  // The model edited (or renamed) the document: the poll in DocsApp saw a new revision.
  useEffect(() => {
    if (state && 'ctl' in state && remote?.id === id && remote.rev !== rev.current) void applyRemote(state.ctl, false);
  }, [state, remote, id, applyRemote]);

  if (!state) return <div className="page-loading">Loading document…</div>;
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

function Workbench({ host, meta, ctl, onBack }: { host: Host; meta: DocSummary; ctl: DocController; onBack(): void }) {
  useDocController(ctl);
  useDocFonts(ctl.doc);
  const [title, setTitle] = useState(meta.title);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [showThumbs, setShowThumbs] = useState(false);
  const [, setSaveTick] = useState(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const tray = usePanelWidth(DOC_TRAY, () => (rowRef.current ? { available: rowRef.current.clientWidth - 8 } : {}), rowRef);

  useEffect(() => ctl.saver.subscribe(() => setSaveTick((t) => t + 1)), [ctl]);
  useEffect(() => setTitle(meta.title), [meta.title]);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);

  // Tell the server and the model where the user is in the document.
  useEffect(() => {
    let last = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
    const push = () => {
      const cursor_block = ctl.cursorBlock();
      const selected = ctl.selectedText().trim().slice(0, MAX_CONTEXT_TEXT);
      const key = `${cursor_block}|${selected}`;
      if (key === last) return;
      last = key;
      void host.call('set_open_file', { kind: 'doc', id: meta.id, cursor_block, ...(selected ? { selected_text: selected } : {}) }).catch(() => {});
      const text = selected
        ? `The user has "${meta.title}" open in Docs and has selected this text in block ${cursor_block}:\n${selected}`
        : `The user has "${meta.title}" open in Docs; the cursor is in block ${cursor_block}.`;
      void host.setModelContext(text, { doc_id: meta.id, title: meta.title, cursor_block, selected_text: selected }, `Docs: ${meta.title}`).catch(() => {});
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

  const openLinkDialog = useCallback(() => setDialog({ kind: 'link', initial: ctl.linkAtCursor()?.href ?? '' }), [ctl]);
  useEffect(() => {
    ctl.onLinkPrompt = openLinkDialog;
    return () => {
      ctl.onLinkPrompt = null;
    };
  }, [ctl, openLinkDialog]);

  useEffect(() => {
    if (!openMenu) return;
    const close = () => setOpenMenu(null);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [openMenu]);

  const upload = useCallback((blob: Blob) => host.uploadImage(blob), [host]);
  const addImageFiles = useCallback(
    async (files: File[]) => {
      for (const file of files.slice(0, 10)) {
        try {
          ctl.insertImage(await uploadImageFile(file, upload), { alt: file.name.replace(/\.[^.]+$/, '') });
        } catch (e) {
          notify(e instanceof Error ? e.message : String(e));
        }
      }
    },
    [ctl, upload, notify],
  );
  // The picture open in the image editor (as on the app's document page): saving stores the edited picture as a
  // new image and puts it in the block as one step.
  const [editingImage, setEditingImage] = useState<{ pos: number; src: string } | null>(null);
  const editImage = useCallback(() => {
    const img = ctl.selectedImage();
    if (img) setEditingImage({ pos: img.pos, src: String(img.node.attrs.src) });
  }, [ctl]);
  const saveEditedImage = async (editing: { pos: number; src: string }, image: Blob, sizes: PictureSizes) => {
    const url = await storePicture(host, image);
    if (!ctl.replaceImage(editing.pos, editing.src, url, sizes.before, sizes.after)) notify('The picture is no longer in the document, so the edit was not put in.');
  };

  const insertImage = async () => {
    const file = await pickImageFile();
    if (file) await addImageFiles([file]);
  };

  const rename = async (t: string) => {
    await host.call('rename_file', { kind: 'doc', id: meta.id, title: t });
    setTitle(t);
  };

  const blockItem = (type: BlockType, label: string, shortcut?: string): MenuItem => ({ label, shortcut, checked: ctl.currentBlock() === type, action: () => ctl.setBlockType(type) });
  const menus: { key: string; label: string; items: () => MenuItem[] }[] = [
    {
      key: 'file',
      label: 'File',
      items: () => [
        { label: 'Rename…', action: () => setDialog({ kind: 'rename' }) },
        'sep',
        { label: 'Delete document', danger: true, action: () => setDialog({ kind: 'delete' }) },
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
        { label: 'Clear formatting', action: () => ctl.clearFormatting() },
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
          submenu: [{ label: 'Fit width', checked: ctl.zoom === 'fit', action: () => ctl.setZoom('fit') }, ...ZOOMS.map((z) => ({ label: `${z}%`, checked: ctl.zoom === z, action: () => ctl.setZoom(z) }))],
        },
      ],
    },
    {
      key: 'insert',
      label: 'Insert',
      items: () => [
        { label: 'Image…', action: () => void insertImage() },
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
        { label: 'Line spacing', submenu: LINE_SPACINGS.map(([label, value]) => ({ label, checked: (ctl.spacingAt().line ?? null) === value, action: () => ctl.setSpacing({ line: value }) })) },
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
    <div className="workbench doc-page docs-plugin">
      <header className="wb-header">
        <button className="wb-back" title="All documents" onClick={() => void ctl.saver.flush().then(onBack)}>
          ‹ Docs
        </button>
        <div className="wb-titles">
          <div className="wb-title-row">
            <input
              className="wb-title"
              value={title}
              aria-label="Document name"
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
          {host.appLink({ kind: 'doc', id: meta.id }) && (
            <button className="btn" title="Open in the full app in a new tab" onClick={() => void ctl.saver.flush().then(() => host.openLink(host.appLink({ kind: 'doc', id: meta.id })!))}>
              Open ↗
            </button>
          )}
        </div>
      </header>
      <DocToolbar ctl={ctl} onLink={openLinkDialog} onInsertImage={() => void insertImage()} onEditImage={editImage} />
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
          <DocEditor ctl={ctl} onImageFiles={(files) => void addImageFiles(files)} onEditImage={editImage} />
        </div>
      </div>

      {editingImage && <ImageEditDialog src={editingImage.src} name="picture" onSave={(image, sizes) => saveEditedImage(editingImage, image, sizes)} onClose={() => setEditingImage(null)} />}
      {dialog?.kind === 'pageSetup' && <PageSetupDialog ctl={ctl} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'docStyle' && <DocStyleDialog ctl={ctl} onClose={() => setDialog(null)} />}
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
            await host.call('delete_file', { kind: 'doc', id: meta.id });
            onBack();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {toast && <div className="docs-toast">{toast}</div>}
    </div>
  );
}
