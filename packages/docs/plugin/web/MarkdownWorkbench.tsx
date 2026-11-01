// One Markdown document open in the app's own text editor and preview (MarkdownController, MarkdownEditor,
// MarkdownPreview), loaded and saved through the plugin's tools. Edits the model makes arrive by polling the
// revision; the block the cursor is in and the selected text go to the model as context.
import { useCallback, useEffect, useRef, useState } from 'react';
import { MenuList, type MenuItem } from '../../client/src/components/Menu.tsx';
import { ConfirmModal, PromptModal } from '../../client/src/components/Modal.tsx';
import { MarkdownController, useMarkdownController } from '../../client/src/markdown/controller.ts';
import { MarkdownEditor } from '../../client/src/markdown/MarkdownEditor.tsx';
import { MarkdownPreview } from '../../client/src/markdown/MarkdownPreview.tsx';
import { markdownOutline } from '../../shared/agent/markdownBlocks.ts';
import type { MarkdownDoc } from '../../shared/markdown.ts';
import type { Host, OpenFile } from './host.ts';

interface FileSummary {
  id: string;
  title: string;
  updated_at: string;
}

type Loaded = { meta: FileSummary; rev: string; data: MarkdownDoc };
type Dialog = { kind: 'rename' } | { kind: 'delete' } | null;

const MAX_CONTEXT_TEXT = 500;

function downloadFile(name: string, mime: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function MarkdownWorkbench({ host, id, remote, onBack }: { host: Host; id: string; remote: OpenFile | null; onBack(): void }) {
  const [state, setState] = useState<{ meta: FileSummary; ctl: MarkdownController } | { error: string } | null>(null);
  const rev = useRef('');
  const syncing = useRef(false);

  /** Take the server's version when it is newer than ours. With force, even over unsaved local edits. */
  const applyRemote = useCallback(
    async (ctl: MarkdownController, force: boolean) => {
      if (syncing.current) return;
      syncing.current = true;
      try {
        const r = await host.call<Loaded>('get_file', { kind: 'markdown', id });
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
    let ctl: MarkdownController | null = null;
    let cancelled = false;
    setState(null);
    host
      .call<Loaded>('get_file', { kind: 'markdown', id })
      .then((r) => {
        if (cancelled) return;
        rev.current = r.rev;
        const c = new MarkdownController(r.data, async (doc) => {
          try {
            const saved = await host.call<{ rev: string }>('save_file', { kind: 'markdown', id, rev: rev.current, data: doc });
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

function Workbench({ host, meta, ctl, onBack }: { host: Host; meta: FileSummary; ctl: MarkdownController; onBack(): void }) {
  useMarkdownController(ctl);
  const [title, setTitle] = useState(meta.title);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(true);
  const [, setSaveTick] = useState(0);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => ctl.saver.subscribe(() => setSaveTick((t) => t + 1)), [ctl]);
  useEffect(() => setTitle(meta.title), [meta.title]);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);

  // Tell the server and the model where the user is: the block the cursor is in, and the selected text.
  useEffect(() => {
    let last = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
    const push = () => {
      const ta = editorRef.current;
      const cursor_block = markdownOutline(ctl.text, { cursor: ta ? ta.selectionStart : ctl.cursor }).cursor_block;
      const selected = ta ? ta.value.slice(ta.selectionStart, ta.selectionEnd).trim().slice(0, MAX_CONTEXT_TEXT) : '';
      const key = `${cursor_block}|${selected}`;
      if (key === last) return;
      last = key;
      void host.call('set_open_file', { kind: 'markdown', id: meta.id, ...(cursor_block ? { cursor_block } : {}), ...(selected ? { selected_text: selected } : {}) }).catch(() => {});
      const where = cursor_block ? `the cursor is in block ${cursor_block}` : 'it is empty';
      const text = selected
        ? `The user has the Markdown document "${meta.title}" open in Docs and has selected this text${cursor_block ? ` in block ${cursor_block}` : ''}:\n${selected}`
        : `The user has the Markdown document "${meta.title}" open in Docs; ${where}.`;
      void host.setModelContext(text, { doc_id: meta.id, kind: 'markdown', title: meta.title, cursor_block, selected_text: selected }, `Docs: ${meta.title}`).catch(() => {});
    };
    const later = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(push, 600);
    };
    const unsub = ctl.subscribe(later);
    document.addEventListener('selectionchange', later);
    push();
    return () => {
      unsub();
      document.removeEventListener('selectionchange', later);
      if (timer) clearTimeout(timer);
    };
  }, [ctl, host, meta.id, meta.title]);

  // Close menus on outside click.
  useEffect(() => {
    if (!openMenu) return;
    const close = () => setOpenMenu(null);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [openMenu]);

  const rename = async (t: string) => {
    await host.call('rename_file', { kind: 'markdown', id: meta.id, title: t });
    setTitle(t);
  };

  const goHome = () => void ctl.saver.flush().then(onBack);

  const menus: { key: string; label: string; items: () => MenuItem[] }[] = [
    {
      key: 'file',
      label: 'File',
      items: () => [
        { label: 'All files', action: goHome },
        { label: 'Rename…', action: () => setDialog({ kind: 'rename' }) },
        'sep',
        { label: 'Download (.md)', action: () => downloadFile(/\.(md|markdown)$/i.test(title) ? title : `${title}.md`, 'text/markdown', ctl.text) },
        'sep',
        { label: 'Delete document', danger: true, action: () => setDialog({ kind: 'delete' }) },
      ],
    },
    { key: 'view', label: 'View', items: () => [{ label: 'Preview', checked: showPreview, action: () => setShowPreview(!showPreview) }] },
  ];

  const saveLabel = {
    saved: 'All changes saved',
    dirty: 'Unsaved changes',
    saving: 'Saving…',
    error: `Save failed — retrying${ctl.saver.error ? ` (${ctl.saver.error})` : ''}`,
  }[ctl.saver.status];

  const link = host.appLink({ kind: 'markdown', id: meta.id });

  return (
    <div className="workbench md-page docs-plugin">
      <header className="wb-header">
        <button className="wb-back" title="All files" onClick={goHome}>
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
          <button className={`btn${showPreview ? ' active' : ''}`} aria-pressed={showPreview} onClick={() => setShowPreview(!showPreview)} title="Show or hide the rendered preview">
            Preview
          </button>
          {link && (
            <button className="btn" title="Open in the full app in a new tab" onClick={() => void ctl.saver.flush().then(() => host.openLink(link))}>
              Open ↗
            </button>
          )}
        </div>
      </header>
      <div className="md-body-row">
        <div className="md-editor-col">
          <MarkdownEditor ctl={ctl} editorRef={editorRef} previewRef={previewRef} />
        </div>
        {showPreview && (
          <div className="md-preview" style={{ width: '50%' }} ref={previewRef}>
            <MarkdownPreview text={ctl.text} />
          </div>
        )}
      </div>

      {dialog?.kind === 'rename' && <PromptModal title="Rename document" label="Name" initial={meta.title} confirmText="Rename" onConfirm={rename} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'delete' && (
        <ConfirmModal
          title="Delete document?"
          message={<>“{title}” will be permanently deleted. This cannot be undone.</>}
          confirmText="Delete"
          danger
          onConfirm={async () => {
            ctl.saver.dispose();
            await host.call('delete_file', { kind: 'markdown', id: meta.id });
            onBack();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {toast && <div className="docs-toast">{toast}</div>}
    </div>
  );
}
