import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { nameWithExt } from '../../../shared/docNames.ts';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { FolderCrumbs, lastListingHref } from '../components/FolderCrumbs.tsx';
import { FavoriteStar } from '../components/FavoriteStar.tsx';
import { FileSearchButton } from '../components/FileSearch.tsx';
import { TitleInput } from '../components/TitleInput.tsx';
import { markdownTitle, type MarkdownDoc } from '../../../shared/markdown.ts';
import type { SheetMeta } from '../../../shared/types.ts';
import { AgentButton } from '../agent/AgentPanel.tsx';
import { useAgent, useRegisterMarkdown } from '../agent/AgentProvider.tsx';
import { api, ApiError } from '../api.ts';
import { RevisionSync, takenMessage } from '../state/revisionSync.ts';
import { Account } from '../components/Account.tsx';
import { MOD } from '../commands.ts';
import { MarkdownIcon } from '../components/Logo.tsx';
import { MenuList, type MenuItem } from '../components/Menu.tsx';
import { ConfirmModal, PromptModal } from '../components/Modal.tsx';
import { ResizeHandle, usePanelWidth } from '../components/ResizeHandle.tsx';
import { useFavicon } from '../favicon.ts';
import { MARKDOWN_ACCEPT, MAX_IMPORT_MB } from '../importFile.ts';
import { MarkdownController, useMarkdownController } from '../markdown/controller.ts';
import { MarkdownEditor, replaceRange, wrapSelection } from '../markdown/MarkdownEditor.tsx';
import { MarkdownPreview } from '../markdown/MarkdownPreview.tsx';
import { MARKDOWN_PREVIEW } from '../panelSize.ts';
import { FindBox, FindToggle } from '../find/FindBox.tsx';
import { findAll, stepIndex, useFind } from '../find/find.ts';
import { clearMatches, paintMatches, rangesIn } from '../find/highlights.ts';
import { TextareaMatches } from '../markdown/TextareaMatches.tsx';
import { appName } from '../brand.ts';
import { downloadPdf, printingPdf, signalPrintReady } from '../print.ts';
import { useOpenInTab } from '../components/OpenInTab.tsx';

// Diagrams in the preview: Mermaid is fetched when a document first has one.
const loadMermaid = () => import('mermaid');

function downloadFile(name: string, mime: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function pickMarkdownFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = MARKDOWN_ACCEPT;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/** A Markdown document: the text in a plain editor on the left, rendered GitHub-style on the right. */
export function MarkdownPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<{ meta: SheetMeta; ctl: MarkdownController; sync: RevisionSync<MarkdownDoc> } | { error: string } | null>(null);
  const { docFailed } = useAgent();

  useEffect(() => {
    let ctl: MarkdownController | null = null;
    let stopSync = () => {};
    let cancelled = false;
    setState(null);
    api
      .getMarkdown(id!)
      .then(({ meta, doc }) => {
        if (cancelled) return;
        // Saves name the revision loaded, and the editor follows saves made elsewhere (revisionSync.ts).
        const sync = new RevisionSync<MarkdownDoc>(meta.id, meta.updatedAt, {
          save: (d, rev) => api.saveMarkdown(meta.id, d, rev),
          load: async () => {
            const latest = await api.getMarkdown(meta.id);
            return { meta: latest.meta, doc: latest.doc };
          },
        });
        ctl = new MarkdownController(doc, sync.save);
        stopSync = sync.attach(ctl);
        setState({ meta, ctl, sync });
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
  return <MarkdownWorkbench key={state.meta.id} initialMeta={state.meta} ctl={state.ctl} sync={state.sync} />;
}

type Dialog = { kind: 'rename' } | { kind: 'delete' } | { kind: 'replace'; file: File; text: string } | null;

const PREVIEW_KEY = 'ui.markdownPreview';

function loadShowPreview(): boolean {
  try {
    return localStorage.getItem(PREVIEW_KEY) !== '0';
  } catch {
    return true;
  }
}

function MarkdownWorkbench({ initialMeta, ctl, sync }: { initialMeta: SheetMeta; ctl: MarkdownController; sync: RevisionSync<MarkdownDoc> }) {
  useMarkdownController(ctl);
  useFavicon('markdown');
  const navigate = useNavigate();
  const location = useLocation();
  // Notes from making the file of a PDF's text (FilePage), which arrive in the navigation state.
  const [importWarnings, setImportWarnings] = useState<string[]>(() => (location.state as { importWarnings?: string[] } | null)?.importWarnings ?? []);
  const dismissImportWarnings = () => {
    setImportWarnings([]);
    if (location.state) navigate(location.pathname, { replace: true, state: null });
  };
  const { open: agentOpen } = useAgent();
  const [meta, setMeta] = useState(initialMeta);
  useRegisterMarkdown(ctl, meta);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  // Made into a PDF by the server (print.ts), the preview is what prints, so it is shown.
  const [showPreview, setShowPreviewState] = useState(() => printingPdf() || loadShowPreview());
  useEffect(() => {
    if (printingPdf()) void signalPrintReady();
  }, []);
  const setShowPreview = (v: boolean) => {
    setShowPreviewState(v);
    try {
      localStorage.setItem(PREVIEW_KEY, v ? '1' : '0');
    } catch {
      // Not remembered, that's all.
    }
  };
  const rowRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  // The preview shares the body with the editor (less the 8px gap between them); the editor keeps a minimum.
  const preview = usePanelWidth(MARKDOWN_PREVIEW, () => (rowRef.current ? { available: rowRef.current.clientWidth - 8 } : {}), rowRef);
  const [, setSaveTick] = useState(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => ctl.saver.subscribe(() => setSaveTick((t) => t + 1)), [ctl]);

  // Find (⌘F): the matches in the text, marked over the editor and in the preview.
  const finder = useFind();
  const find = finder.find;
  const starts = useMemo(() => (find ? findAll(ctl.text, find.query, find.matchCase) : []), [find, ctl.text]);
  const current = find && find.current < starts.length ? find.current : -1;
  const searchFor = (patch: { query?: string; matchCase?: boolean }) => {
    if (!find) return;
    const next = { ...find, ...patch };
    const hits = findAll(ctl.text, next.query, next.matchCase);
    // The first match at or after the cursor.
    const from = editorRef.current?.selectionStart ?? 0;
    const at = hits.findIndex((h) => h >= from);
    finder.set({ ...patch, current: hits.length ? (at < 0 ? 0 : at) : -1 });
  };
  const closeFind = () => {
    const ta = editorRef.current;
    const at = current >= 0 ? starts[current] : -1;
    finder.close();
    if (!ta) return;
    // The match shown is selected, ready to type over.
    ta.focus();
    if (at >= 0 && find) ta.setSelectionRange(at, at + find.query.length);
  };
  useEffect(() => {
    const root = previewRef.current;
    if (!find?.query || !root) return clearMatches();
    paintMatches(rangesIn(root, find.query, find.matchCase), null);
    return clearMatches;
  }, [find, ctl.text, showPreview]);

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

  // The assistant panel opening or closing changes the room for the preview.
  useEffect(() => {
    preview.set(preview.width, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentOpen]);

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
  // The file was saved somewhere else (another tab, the ChatGPT plugin) and the editor took that version.
  useEffect(
    () =>
      sync.onTaken((t) => {
        setMeta(t.meta);
        if (t.changed) notify(takenMessage(t));
      }),
    [sync, notify],
  );

  // Close menus on outside click.
  useEffect(() => {
    if (!openMenu) return;
    const close = () => setOpenMenu(null);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [openMenu]);

  const rename = async (t: string) => {
    const { meta: m } = await api.renameMarkdown(meta.id, t);
    setMeta(m);
  };

  /** File → Import: replace the text with a .md file's (after confirming when there is text to lose). */
  const importMarkdownFile = async () => {
    const file = await pickMarkdownFile();
    if (!file) return;
    if (!/\.(md|markdown)$/i.test(file.name)) return notify('Please choose a Markdown file (.md).');
    if (file.size > MAX_IMPORT_MB * 1024 * 1024) return notify(`This file is too large to import (${MAX_IMPORT_MB} MB maximum).`);
    const text = await file.text();
    if (ctl.text.trim()) setDialog({ kind: 'replace', file, text });
    else {
      ctl.setText(text);
      notify(`Imported “${file.name}”.`);
    }
  };

  const insert = (before: string, after: string, placeholder: string) => () => {
    const ta = editorRef.current;
    if (ta) wrapSelection(ta, before, after, placeholder);
  };

  const openInTab = useOpenInTab();
  const menus: { key: string; label: string; items: () => MenuItem[] }[] = [
    {
      key: 'file',
      label: 'File',
      items: () => [
        ...openInTab.items,
        {
          label: 'New Markdown document',
          action: async () => {
            const { doc } = await api.createMarkdown('Untitled Markdown');
            window.open(`/md/${doc.id}`, '_blank');
          },
        },
        { label: 'Rename…', action: () => setDialog({ kind: 'rename' }) },
        { label: 'Import Markdown file…', action: () => void importMarkdownFile() },
        'sep',
        { label: 'Download (.md)', action: () => downloadFile(nameWithExt(meta.title, 'md'), 'text/markdown', ctl.text) },
        { label: 'Download as PDF', action: () => void exportPdf() },
        'sep',
        { label: 'Delete document', danger: true, action: () => setDialog({ kind: 'delete' }) },
        'sep',
        { label: 'Home', action: () => navigate('/') },
      ],
    },
    {
      key: 'view',
      label: 'View',
      items: () => [
        { label: 'Find…', shortcut: `${MOD}F`, action: () => finder.open() },
        'sep',
        { label: 'Preview', checked: showPreview, action: () => setShowPreview(!showPreview) },
        { label: 'Reset preview width', disabled: !showPreview, action: () => preview.set(preview.spec.def, true) },
      ],
    },
    {
      key: 'insert',
      label: 'Insert',
      items: () => [
        { label: 'Bold', shortcut: `${MOD}B`, action: insert('**', '**', 'bold text') },
        { label: 'Italic', shortcut: `${MOD}I`, action: insert('_', '_', 'italic text') },
        { label: 'Strikethrough', action: insert('~~', '~~', 'text') },
        { label: 'Inline code', action: insert('`', '`', 'code') },
        'sep',
        { label: 'Heading', action: insert('## ', '', 'Heading') },
        { label: 'Link', shortcut: `${MOD}K`, action: insert('[', '](https://)', 'link text') },
        { label: 'Image', action: insert('![', '](https://)', 'alt text') },
        { label: 'Code block', action: insert('```\n', '\n```', 'code') },
        { label: 'Quote', action: insert('> ', '', 'quote') },
        { label: 'Bulleted list', action: insert('- ', '', 'item') },
        { label: 'Numbered list', action: insert('1. ', '', 'item') },
        { label: 'Task list', action: insert('- [ ] ', '', 'task') },
        { label: 'Table', action: insert('| Column | Column |\n| --- | --- |\n| ', ' | |', 'cell') },
        { label: 'Horizontal rule', action: insert('\n---\n', '', '') },
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
    <div className="workbench md-page">
      {openInTab.dialog}
      <header className="wb-header">
        <Link to={lastListingHref()} className="wb-logo" title="Back to the file list" onClick={() => void ctl.saver.flush()}>
          <MarkdownIcon size={32} />
        </Link>
        <div className="wb-titles">
          <div className="wb-title-row">
            <FavoriteStar kind="markdown" id={meta.id} onError={notify} />
            <FolderCrumbs folder={meta.folder} onLeave={() => void ctl.saver.flush()} />
            <TitleInput title={meta.title} label="Document name" onRename={rename} onError={notify} />
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
          <button className={`btn${showPreview ? ' active' : ''}`} aria-pressed={showPreview} onClick={() => setShowPreview(!showPreview)} title="Show or hide the rendered preview">
            Preview
          </button>
          <FileSearchButton />
          <AgentButton />
          <Account before={() => ctl.saver.flush()} />
        </div>
      </header>
      {importWarnings.length > 0 && (
        <div className="import-banner" role="status">
          <div>
            <strong>Converted with some notes:</strong>
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
      <div className="md-body-row" ref={rowRef}>
        <div className="md-editor-col">
          <MarkdownEditor ctl={ctl} editorRef={editorRef} previewRef={previewRef} />
          {find?.query && <TextareaMatches textareaRef={editorRef} text={ctl.text} starts={starts} length={find.query.length} current={current} />}
          {find && (
            <FindBox
              query={find.query}
              onQuery={(query) => searchFor({ query })}
              count={starts.length}
              current={current}
              onStep={(dir) => finder.set({ current: stepIndex(current, starts.length, dir) })}
              onClose={closeFind}
              focusSeq={find.focusSeq}
              placeholder="Find in text"
              label="Find in Markdown"
            >
              <FindToggle on={find.matchCase} title="Match case" onClick={() => searchFor({ matchCase: !find.matchCase })}>
                Aa
              </FindToggle>
            </FindBox>
          )}
        </div>
        {showPreview && (
          <>
            <ResizeHandle panel={preview} side="right" label="Resize preview" className="md-preview-resize" />
            <div className="md-preview" style={{ width: preview.width }} ref={previewRef}>
              <MarkdownPreview text={ctl.text} loadMermaid={loadMermaid} folder={meta.folder ?? ''} />
            </div>
          </>
        )}
      </div>

      {dialog?.kind === 'rename' && <PromptModal title="Rename document" label="Name" initial={meta.title} confirmText="Rename" onConfirm={rename} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'replace' && (
        <ConfirmModal
          title="Replace the text?"
          message={<>The current text will be replaced with the contents of “{dialog.file.name}”. You can undo this with {MOD}Z.</>}
          confirmText="Replace"
          onConfirm={() => {
            const ta = editorRef.current;
            if (ta) {
              // Through the textarea so the replacement stays in the browser's undo history.
              replaceRange(ta, 0, ta.value.length, dialog.text);
            } else ctl.setText(dialog.text);
            if (meta.title === 'Untitled Markdown') void rename(markdownTitle(dialog.text, dialog.file.name)).catch(() => {});
            notify(`Imported “${dialog.file.name}”.`);
          }}
          onClose={() => setDialog(null)}
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
            await api.deleteMarkdown(meta.id);
            navigate('/');
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
