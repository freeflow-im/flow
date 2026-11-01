// One spreadsheet open in the app's own editor (SheetController, Toolbar, FormulaBar, Grid, TabBar and the
// menus from commands.ts), loaded and saved through the plugin's tools. Edits the model makes arrive by
// polling the revision and are applied as one undoable step; the tab and ranges the user has selected go to
// the model as context.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cellKey, rangeToString } from '../../shared/cellref.ts';
import type { Workbook } from '../../shared/types.ts';
import { cellContextItems, dataItems, editItems, formatItems, insertItems, isMac, MOD, tabContextItems, viewItems, type CommandHost } from '../../client/src/commands.ts';
import { ComparePanel } from '../../client/src/components/ComparePanel.tsx';
import { FilterMenu } from '../../client/src/components/FilterMenu.tsx';
import { FindBar } from '../../client/src/components/FindBar.tsx';
import { FormulaBar } from '../../client/src/components/FormulaBar.tsx';
import { MenuList, type MenuItem } from '../../client/src/components/Menu.tsx';
import { ConfirmModal, PromptModal } from '../../client/src/components/Modal.tsx';
import { TabBar } from '../../client/src/components/TabBar.tsx';
import { Toolbar } from '../../client/src/components/Toolbar.tsx';
import { Grid } from '../../client/src/grid/Grid.tsx';
import { checkExcelFile, pickExcelFile } from '../../client/src/importFile.ts';
import { SheetController } from '../../client/src/state/controller.ts';
import { useController } from '../../client/src/state/useController.ts';
import type { FileKind, Host, OpenFile } from './host.ts';

interface FileSummary {
  id: string;
  title: string;
  updated_at: string;
}

type Loaded = { meta: FileSummary; rev: string; data: Workbook };
type Dialog = { kind: 'rename' } | { kind: 'delete' } | { kind: 'deleteTab'; tabId: string } | null;

function downloadFile(name: string, mime: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toCSV(ctl: SheetController): string {
  const tab = ctl.tab;
  const ext = ctl.store.engine.extent(tab.id);
  const rows: string[] = [];
  for (let r = 0; r < ext.rows; r++) {
    const row: string[] = [];
    for (let c = 0; c < ext.cols; c++) {
      const v = tab.cells[cellKey(r, c)] ? ctl.store.display(tab.id, r, c) : '';
      row.push(/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    }
    rows.push(row.join(','));
  }
  return rows.join('\n');
}

export function SheetWorkbench({ host, id, remote, onBack, onOpen }: { host: Host; id: string; remote: OpenFile | null; onBack(): void; onOpen(file: { kind: FileKind; id: string }): void }) {
  const [state, setState] = useState<{ meta: FileSummary; ctl: SheetController } | { error: string } | null>(null);
  const rev = useRef('');
  const syncing = useRef(false);

  const applyRemote = useCallback(
    async (ctl: SheetController, force: boolean) => {
      if (syncing.current) return;
      syncing.current = true;
      try {
        const r = await host.call<Loaded>('get_file', { kind: 'sheet', id });
        if (r.rev === rev.current) return;
        if (!force && (ctl.saver.hasUnsavedChanges() || ctl.edit)) return;
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
    let ctl: SheetController | null = null;
    let cancelled = false;
    setState(null);
    host
      .call<Loaded>('get_file', { kind: 'sheet', id })
      .then((r) => {
        if (cancelled) return;
        rev.current = r.rev;
        const c = new SheetController(r.data, async (wb) => {
          try {
            const saved = await host.call<{ rev: string }>('save_file', { kind: 'sheet', id, rev: rev.current, data: wb });
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
        if (ctl.edit) ctl.commitEdit();
        void ctl.saver.flush();
        ctl.dispose();
      }
    };
  }, [host, id, applyRemote]);

  useEffect(() => {
    if (state && 'ctl' in state && remote?.id === id && remote.rev !== rev.current) void applyRemote(state.ctl, false);
  }, [state, remote, id, applyRemote]);

  if (!state) return <div className="page-loading">Loading spreadsheet…</div>;
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
  return <Workbench host={host} meta={state.meta} ctl={state.ctl} onBack={onBack} onOpen={onOpen} />;
}

function Workbench({ host, meta, ctl, onBack, onOpen }: { host: Host; meta: FileSummary; ctl: SheetController; onBack(): void; onOpen(file: { kind: FileKind; id: string }): void }) {
  useController(ctl);
  const [title, setTitle] = useState(meta.title);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const [, setSaveTick] = useState(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => ctl.saver.subscribe(() => setSaveTick((t) => t + 1)), [ctl]);
  useEffect(() => setTitle(meta.title), [meta.title]);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);

  // Tell the server and the model where the user is in the spreadsheet.
  useEffect(() => {
    let last = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
    const push = () => {
      const tab = ctl.tab;
      const selection = ctl.sel.ranges.slice(-10).map((r) => rangeToString(r));
      const key = `${tab.name}|${selection.join(',')}`;
      if (key === last) return;
      last = key;
      void host.call('set_open_file', { kind: 'sheet', id: meta.id, tab: tab.name, selection }).catch(() => {});
      const where = selection.length === 1 ? `with ${selection[0]} selected` : `with ${selection.join(', ')} selected`;
      const text = `The user has the spreadsheet "${meta.title}" open in Docs, on the tab "${tab.name}", ${where}.`;
      void host.setModelContext(text, { sheet_id: meta.id, title: meta.title, tab: tab.name, selection }, `Docs: ${meta.title}`).catch(() => {});
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

  const rename = async (t: string) => {
    await host.call('rename_file', { kind: 'sheet', id: meta.id, title: t });
    setTitle(t);
  };

  const unavailable = (what: string) => () => notify(`${what} is not available in ChatGPT. Open the spreadsheet in the Docs app for that.`);

  const cmd: CommandHost = useMemo(
    () => ({
      ctl,
      notify,
      renameSheet: () => setDialog({ kind: 'rename' }),
      createBranch: unavailable('Branching'),
      compareWithOriginal: unavailable('Comparing branches'),
      isBranch: false,
      deleteSheet: () => setDialog({ kind: 'delete' }),
      deleteTab: (tabId) => setDialog({ kind: 'deleteTab', tabId }),
      newSheet: async () => {
        if (ctl.edit) ctl.commitEdit();
        await ctl.saver.flush();
        const r = await host.call<{ file: { id: string } }>('create_sheet', { title: 'Untitled spreadsheet' });
        onOpen({ kind: 'sheet', id: r.file.id });
      },
      goHome: () => void ctl.saver.flush().then(onBack),
      openConnectors: unavailable('Data connectors'),
      importXlsx: async () => {
        const file = await pickExcelFile();
        if (!file) return;
        const problem = checkExcelFile(file);
        if (problem) return notify(problem);
        notify(`Importing “${file.name}”…`);
        try {
          const { ticket, url } = await host.call<{ ticket: string; url: string }>('upload_ticket');
          const q = new URLSearchParams({ ticket, name: file.name, convert: '1' });
          const res = await fetch(`${url}?${q}`, { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file });
          const body = (await res.json()) as { workbook?: Workbook; warnings?: string[]; error?: string };
          if (!res.ok || !body.workbook) throw new Error(body.error ?? `Import failed (${res.status}).`);
          const renamed = ctl.importTabs(body.workbook.tabs);
          const n = body.workbook.tabs.length;
          const notes = [...(body.warnings ?? [])];
          if (renamed.length) notes.push(`Renamed to avoid clashing with existing sheets: ${renamed.map((r) => `"${r.from}" → "${r.to}"`).join(', ')}.`);
          setImportWarnings(notes);
          notify(`Added ${n} sheet${n === 1 ? '' : 's'} from “${file.name}”. Press ${MOD}Z to undo.`);
        } catch (e) {
          notify(e instanceof Error ? e.message : String(e));
        }
      },
      download: (kind) => {
        if (kind === 'json') downloadFile(`${meta.title}.json`, 'application/json', JSON.stringify(ctl.store.workbook, null, 2));
        else downloadFile(`${meta.title} - ${ctl.tab.name}.csv`, 'text/csv', toCSV(ctl));
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctl, notify, host, meta.title, onBack, onOpen],
  );

  // Close top menus on outside click.
  useEffect(() => {
    if (!openMenu) return;
    const close = () => setOpenMenu(null);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [openMenu]);

  // Context menu closes on outside click / Escape.
  useEffect(() => {
    if (!ctl.menu) return;
    const close = () => ctl.openMenu(null);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', key);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', key);
      window.removeEventListener('blur', close);
    };
  }, [ctl, ctl.menu]);

  // Global shortcuts. Capture phase so they work wherever focus is (grid, formula bar, tab rename, ...).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F11' && e.shiftKey) {
        e.preventDefault();
        ctl.addTab();
      } else if ((isMac ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        ctl.openSearch();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ctl]);

  // The File menu without the things that need the full app (branches, connectors).
  const fileMenu = (): MenuItem[] => [
    { label: 'New spreadsheet', action: () => void cmd.newSheet() },
    { label: 'All files', action: () => cmd.goHome() },
    { label: 'Import Excel file (.xlsx, .xls)…', action: () => cmd.importXlsx() },
    'sep',
    { label: 'Rename', action: () => cmd.renameSheet() },
    {
      label: 'Download',
      submenu: [
        { label: 'Comma-separated values (.csv, current sheet)', action: () => cmd.download('csv') },
        { label: 'Workbook (.json)', action: () => cmd.download('json') },
      ],
    },
    'sep',
    { label: 'Delete spreadsheet', danger: true, action: () => cmd.deleteSheet() },
  ];

  const menus: { key: string; label: string; items: () => MenuItem[] }[] = [
    { key: 'file', label: 'File', items: fileMenu },
    { key: 'edit', label: 'Edit', items: () => editItems(cmd) },
    { key: 'view', label: 'View', items: () => viewItems(cmd) },
    { key: 'insert', label: 'Insert', items: () => insertItems(cmd) },
    { key: 'format', label: 'Format', items: () => formatItems(cmd) },
    { key: 'data', label: 'Data', items: () => dataItems(cmd) },
  ];

  const saveLabel = {
    saved: 'All changes saved',
    dirty: 'Unsaved changes',
    saving: 'Saving…',
    error: `Save failed — retrying${ctl.saver.error ? ` (${ctl.saver.error})` : ''}`,
  }[ctl.saver.status];

  const ctxMenu = ctl.menu;
  const ctxItems = ctxMenu ? (ctxMenu.kind === 'tab' ? tabContextItems(cmd, ctxMenu.tabId) : cellContextItems(cmd, ctxMenu.kind)) : null;
  const deletingTab = dialog?.kind === 'deleteTab' ? ctl.store.getTab(dialog.tabId) : null;

  return (
    <div className="workbench docs-plugin">
      <header className="wb-header">
        <button className="wb-back" title="All files" onClick={() => cmd.goHome()}>
          ‹ Docs
        </button>
        <div className="wb-titles">
          <div className="wb-title-row">
            <input
              className="wb-title"
              value={title}
              aria-label="Spreadsheet name"
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
                    if (ctl.edit) ctl.commitEdit();
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
          {host.appLink({ kind: 'sheet', id: meta.id }) && (
            <button className="btn" title="Open in the full app in a new tab" onClick={() => void ctl.saver.flush().then(() => host.openLink(host.appLink({ kind: 'sheet', id: meta.id })!))}>
              Open ↗
            </button>
          )}
        </div>
      </header>
      <Toolbar host={cmd} />
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
          <button className="link" onClick={() => setImportWarnings([])}>
            Dismiss
          </button>
        </div>
      )}
      <FormulaBar ctl={ctl} />
      <div className="grid-area">
        <div className="grid-main">
          <Grid ctl={ctl} notify={notify} />
          {ctl.search && <FindBar ctl={ctl} />}
        </div>
        {ctl.compare && <ComparePanel ctl={ctl} />}
      </div>
      <TabBar host={cmd} />

      {ctxMenu && ctxItems && (
        <div onMouseDown={(e) => e.stopPropagation()}>
          <MenuList items={ctxItems} onDone={() => ctl.openMenu(null)} style={{ position: 'fixed', left: ctxMenu.x, top: ctxMenu.y }} />
        </div>
      )}
      {ctl.filterMenu && ctl.tab.filter && <FilterMenu key={`${ctl.tab.id}:${ctl.filterMenu.col}`} ctl={ctl} />}

      {dialog?.kind === 'rename' && <PromptModal title="Rename spreadsheet" label="Name" initial={meta.title} confirmText="Rename" onConfirm={rename} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'delete' && (
        <ConfirmModal
          title="Delete spreadsheet?"
          message={<>“{meta.title}” will be permanently deleted. This cannot be undone.</>}
          confirmText="Delete"
          danger
          onConfirm={async () => {
            ctl.saver.dispose();
            await host.call('delete_file', { kind: 'sheet', id: meta.id });
            onBack();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {deletingTab && (
        <ConfirmModal
          title="Delete sheet?"
          message={<>Delete the sheet “{deletingTab.name}”? You can undo this with {MOD}Z.</>}
          confirmText="Delete"
          danger
          onConfirm={() => ctl.deleteTab(deletingTab.id)}
          onClose={() => setDialog(null)}
        />
      )}
      {toast && <div className="docs-toast">{toast}</div>}
    </div>
  );
}
