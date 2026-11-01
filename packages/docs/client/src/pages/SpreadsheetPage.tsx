import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { nameWithExt } from '../../../shared/docNames.ts';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { FolderCrumbs, lastListingHref } from '../components/FolderCrumbs.tsx';
import { FavoriteStar } from '../components/FavoriteStar.tsx';
import { FileSearchButton } from '../components/FileSearch.tsx';
import { TitleInput } from '../components/TitleInput.tsx';
import { cellKey } from '../../../shared/cellref.ts';
import type { SheetMeta, Workbook } from '../../../shared/types.ts';
import { AgentButton } from '../agent/AgentPanel.tsx';
import { useAgent, useRegisterSheet } from '../agent/AgentProvider.tsx';
import { api, ApiError } from '../api.ts';
import { RevisionSync, takenMessage } from '../state/revisionSync.ts';
import { Account } from '../components/Account.tsx';
import {
  cellContextItems,
  dataItems,
  editItems,
  fileItems,
  isMac,
  formatItems,
  insertItems,
  tabContextItems,
  viewItems,
  type CommandHost,
} from '../commands.ts';
import { FilterMenu } from '../components/FilterMenu.tsx';
import { ComparePanel } from '../components/ComparePanel.tsx';
import { ChartEditor } from '../chart/ChartEditor.tsx';
import { FindBar } from '../components/FindBar.tsx';
import { FormulaBar } from '../components/FormulaBar.tsx';
import { Logo } from '../components/Logo.tsx';
import { MenuList, type MenuItem } from '../components/Menu.tsx';
import { ConfirmModal, PromptModal } from '../components/Modal.tsx';
import { TabBar } from '../components/TabBar.tsx';
import { Toolbar } from '../components/Toolbar.tsx';
import { Grid } from '../grid/Grid.tsx';
import { useFavicon } from '../favicon.ts';
import { csvTitle, csvToWorkbook } from '../../../shared/csv.ts';
import { checkCsvFile, checkExcelFile, pickCsvFile, pickExcelFile } from '../importFile.ts';
import { uniqueTabName } from '../state/ops.ts';
import { SheetController } from '../state/controller.ts';
import { csvGuard, lockedGuard, EDIT_NOT_ALLOWED, xlsxGuard } from '../state/store.ts';
import { useController } from '../state/useController.ts';
import { appName } from '../brand.ts';
import { useOpenInTab } from '../components/OpenInTab.tsx';

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

/**
 * The guard of a spreadsheet's file format: a CSV or Excel file takes only the changes it can store, and an
 * Excel file holding things the app cannot keep (`notKept`) none until the user allows editing it.
 */
function guardFor(meta: SheetMeta, notKept: string[] | undefined) {
  if (meta.format === 'csv') return csvGuard;
  if (meta.format === 'xlsx') return notKept?.length ? lockedGuard : xlsxGuard;
  return null;
}

export function SpreadsheetPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<{ meta: SheetMeta; notKept?: string[]; ctl: SheetController; sync: RevisionSync<Workbook> } | { error: string } | null>(null);
  const { sheetFailed } = useAgent();

  useEffect(() => {
    let ctl: SheetController | null = null;
    let stopSync = () => {};
    let cancelled = false;
    setState(null);
    api
      .getSheet(id!)
      .then(({ sheet, workbook, notKept }) => {
        if (cancelled) return;
        // Saves name the revision loaded, and the editor follows saves made elsewhere (revisionSync.ts).
        const sync = new RevisionSync<Workbook>(sheet.id, sheet.updatedAt, {
          save: async (wb, rev) => ({ meta: (await api.saveSheet(sheet.id, wb, rev)).sheet }),
          load: async () => {
            const latest = await api.getSheet(sheet.id);
            if (ctl) {
              // The newer version is put in place as a change, which the guard must let through; then the
              // guard of its format applies (it may have been converted elsewhere). An Excel file the user
              // has not allowed editing yet stays read-only.
              const c = ctl;
              const locked = c.store.guard === lockedGuard && latest.sheet.format === 'xlsx';
              c.store.guard = null;
              setTimeout(() => (c.store.guard = locked ? lockedGuard : guardFor(latest.sheet, undefined)));
            }
            return { meta: latest.sheet, doc: latest.workbook };
          },
        });
        ctl = new SheetController(workbook, sync.save);
        stopSync = sync.attach(ctl);
        // A CSV or Excel file only takes changes it can store; the rest asks to convert it first, or to allow
        // editing an Excel file that holds things the app cannot keep (see Workbench).
        ctl.store.guard = guardFor(sheet, notKept);
        setState({ meta: sheet, notKept, ctl, sync });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const error = e instanceof ApiError && e.status === 404 ? 'This spreadsheet does not exist or was deleted.' : String((e as Error).message ?? e);
        setState({ error });
        sheetFailed(id!, error);
      });
    return () => {
      cancelled = true;
      stopSync();
      if (ctl) {
        void ctl.saver.flush();
        ctl.dispose();
      }
    };
  }, [id, sheetFailed]);

  if (!state) return <div className="page-loading">Loading spreadsheet…</div>;
  if ('error' in state) {
    return (
      <div className="page-error">
        <p>{state.error}</p>
        <Link to="/" className="btn primary">
          Back to spreadsheets
        </Link>
      </div>
    );
  }
  return <Workbench key={state.meta.id} initialMeta={state.meta} initialNotKept={state.notKept} ctl={state.ctl} sync={state.sync} />;
}

type Dialog =
  | { kind: 'rename' }
  | { kind: 'deleteSheet' }
  | { kind: 'deleteTab'; tabId: string }
  | { kind: 'branch' }
  | { kind: 'csvCopy' }
  /** Convert a CSV file to a spreadsheet: asked from the File menu, or because a change needs it (then `reason` and `retry` are set). */
  | { kind: 'convert'; reason?: string; retry?: () => void }
  /** Allow editing an Excel file that holds things the app cannot keep: asked from its Read-only chip, or by the first change (then `retry` is set). */
  | { kind: 'editExcel'; retry?: () => void }
  | null;

function Workbench({ initialMeta, initialNotKept, ctl, sync }: { initialMeta: SheetMeta; initialNotKept?: string[]; ctl: SheetController; sync: RevisionSync<Workbook> }) {
  useController(ctl);
  const navigate = useNavigate();
  const location = useLocation();
  // Notes from an Excel import: arrive via navigation state (home-page import) or from File → Import.
  const [importWarnings, setImportWarnings] = useState<string[]>(
    () => (location.state as { importWarnings?: string[] } | null)?.importWarnings ?? [],
  );
  const dismissImportWarnings = () => {
    setImportWarnings([]);
    if (location.state) navigate(location.pathname, { replace: true, state: null });
  };
  const [meta, setMeta] = useState(initialMeta);
  // What saving this Excel file would remove, until the user allows editing it.
  const [notKept, setNotKept] = useState(initialNotKept);
  useRegisterSheet(ctl, meta);
  useFavicon('sheet');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [, setSaveTick] = useState(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => ctl.saver.subscribe(() => setSaveTick((t) => t + 1)), [ctl]);

  // A CSV or Excel file: when a change needs something the file cannot store, offer to convert it and then
  // make the change. An Excel file not yet allowed editing asks for that first.
  useEffect(() => {
    ctl.onRefused = (reason, retry) => setDialog(reason === EDIT_NOT_ALLOWED ? { kind: 'editExcel', retry } : { kind: 'convert', reason, retry });
    return () => {
      ctl.onRefused = null;
    };
  }, [ctl]);

  const convertToSpreadsheet = async () => {
    if (ctl.edit) ctl.commitEdit();
    await ctl.saver.flush();
    const { sheet } = await api.convertSheet(meta.id);
    // Converting is a new revision with the same content: the edit that asked for it saves on top of it.
    sync.rev = sheet.updatedAt;
    // A CSV file may have become an Excel file (desktop app), which has its own limits.
    ctl.store.guard = guardFor(sheet, undefined);
    setMeta(sheet);
  };

  // Branches can be compared with their original; refresh metadata (e.g. the original's title) on each fetch.
  useEffect(() => {
    ctl.compareLoader = meta.branch
      ? async () => {
          const r = await api.compareSheet(meta.id);
          setMeta(r.meta);
          return { base: r.base, original: r.original, parentTitle: r.meta.branch?.parentTitle ?? '', fetchedAt: Date.now() };
        }
      : null;
  }, [ctl, meta.id, meta.branch]);

  useEffect(() => {
    document.title = `${meta.title} - ${appName()}`;
    return () => {
      document.title = appName();
    };
  }, [meta.title]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (ctl.edit) ctl.commitEdit();
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
  // The file was saved somewhere else (another tab, the ChatGPT plugin) and the editor took that version.
  useEffect(
    () =>
      sync.onTaken((t) => {
        setMeta(t.meta);
        if (t.changed) notify(takenMessage(t));
      }),
    [sync, notify],
  );

  const renameSheet = async (t: string) => {
    const { sheet } = await api.renameSheet(meta.id, t);
    setMeta(sheet);
  };

  const host: CommandHost = useMemo(
    () => ({
      ctl,
      notify,
      renameSheet: () => setDialog({ kind: 'rename' }),
      createBranch: () => setDialog({ kind: 'branch' }),
      compareWithOriginal: () => void ctl.openCompare(),
      isBranch: !!meta.branch,
      deleteSheet: () => setDialog({ kind: 'deleteSheet' }),
      deleteTab: (tabId) => setDialog({ kind: 'deleteTab', tabId }),
      newSheet: async () => {
        const { sheet } = await api.createSheet('Untitled spreadsheet');
        window.open(`/s/${sheet.id}`, '_blank');
      },
      goHome: () => navigate('/'),
      openConnectors: () => navigate('/connectors'),
      importXlsx: async () => {
        const file = await pickExcelFile();
        if (!file) return;
        const problem = checkExcelFile(file);
        if (problem) return notify(problem);
        notify(`Importing “${file.name}”…`);
        try {
          const { workbook, warnings } = await api.convertXlsx(file);
          const renamed = ctl.importTabs(workbook.tabs);
          const n = workbook.tabs.length;
          const notes = [...warnings];
          if (renamed.length) {
            notes.push(`Renamed to avoid clashing with existing sheets: ${renamed.map((r) => `"${r.from}" → "${r.to}"`).join(', ')}.`);
          }
          setImportWarnings(notes);
          notify(`Added ${n} sheet${n === 1 ? '' : 's'} from “${file.name}”. Press ${navigator.platform.includes('Mac') ? '⌘Z' : 'Ctrl+Z'} to undo.`);
        } catch (e) {
          notify(e instanceof Error ? e.message : String(e));
        }
      },
      importCsv: async () => {
        const file = await pickCsvFile();
        if (!file) return;
        const problem = checkCsvFile(file);
        if (problem) return notify(problem);
        try {
          const [tab] = csvToWorkbook(await file.text()).tabs;
          // Sheet names cannot contain [ ] * ? / \ : and are at most 100 characters.
          const name = csvTitle(file.name).replace(/[[\]*?/\\:]/g, ' ').trim().slice(0, 100) || 'Imported CSV';
          const before = ctl.store.workbook.tabs.length;
          ctl.importTabs([{ ...tab, name: uniqueTabName(ctl.store.workbook.tabs, name) }]);
          // In a CSV file the new sheet waits for the answer to "Convert to a spreadsheet?".
          if (ctl.store.workbook.tabs.length > before) notify(`Added “${file.name}” as a new sheet. Press ${isMac ? '⌘Z' : 'Ctrl+Z'} to undo.`);
        } catch (e) {
          notify(e instanceof Error ? e.message : String(e));
        }
      },
      saveCopyAsCsv: () => setDialog({ kind: 'csvCopy' }),
      download: (kind) => {
        if (kind === 'json') downloadFile(nameWithExt(meta.title, 'json'), 'application/json', JSON.stringify(ctl.store.workbook, null, 2));
        // Excel is written on the server from the saved workbook, so pending edits are flushed first.
        else if (kind === 'xlsx') void ctl.saver.flush().then(() => window.location.assign(`/api/files/${meta.id}/export?format=xlsx`));
        // A CSV file downloads as the file itself (raw values), written by the server from the saved copy.
        else if (meta.format === 'csv') void ctl.saver.flush().then(() => window.location.assign(`/api/files/${meta.id}/export?format=csv`));
        else downloadFile(`${meta.title} - ${ctl.tab.name}.csv`, 'text/csv', toCSV(ctl));
      },
      convertToSpreadsheet: meta.format === 'csv' ? () => setDialog({ kind: 'convert' }) : undefined,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctl, notify, meta.title, meta.branch, meta.format],
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
        // ⌘F / Ctrl+F opens the spreadsheet's find bar instead of the browser's page search.
        e.preventDefault();
        ctl.openSearch();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ctl]);

  const openInTab = useOpenInTab();
  const menus: { key: string; label: string; items: () => MenuItem[] }[] = [
    { key: 'file', label: 'File', items: () => [...openInTab.items, ...fileItems(host)] },
    { key: 'edit', label: 'Edit', items: () => editItems(host) },
    { key: 'view', label: 'View', items: () => viewItems(host) },
    { key: 'insert', label: 'Insert', items: () => insertItems(host) },
    { key: 'format', label: 'Format', items: () => formatItems(host) },
    { key: 'data', label: 'Data', items: () => dataItems(host) },
  ];

  const saveLabel = {
    saved: 'All changes saved',
    dirty: 'Unsaved changes',
    saving: 'Saving…',
    error: `Save failed — retrying${ctl.saver.error ? ` (${ctl.saver.error})` : ''}`,
  }[ctl.saver.status];

  const ctxMenu = ctl.menu;
  const ctxItems = ctxMenu ? (ctxMenu.kind === 'tab' ? tabContextItems(host, ctxMenu.tabId) : cellContextItems(host, ctxMenu.kind)) : null;
  const deletingTab = dialog?.kind === 'deleteTab' ? ctl.store.getTab(dialog.tabId) : null;

  return (
    <div className="workbench">
      {openInTab.dialog}
      <header className="wb-header">
        <Link to={lastListingHref()} className="wb-logo" title="Back to the file list" onClick={() => void ctl.saver.flush()}>
          <Logo size={32} />
        </Link>
        <div className="wb-titles">
          <div className="wb-title-row">
            <FavoriteStar kind="sheet" id={meta.id} onError={notify} />
            <FolderCrumbs folder={meta.folder} onLeave={() => void ctl.saver.flush()} />
            <TitleInput title={meta.title} label="Spreadsheet name" onRename={renameSheet} onError={notify} />
            <span className={`save-status ${ctl.saver.status}`}>{saveLabel}</span>
            {meta.format === 'csv' && (
              <span className="format-chip" title="This is a CSV file: edits are saved as CSV. Formatting, more sheets and other spreadsheet features need it converted to a spreadsheet (File → Convert to spreadsheet).">
                CSV
              </span>
            )}
            {meta.format === 'xlsx' &&
              (notKept ? (
                <button className="format-chip locked" title={`This Excel file has things ${appName()} can't keep: ${notKept.join(', ')}. Click to allow editing.`} onClick={() => setDialog({ kind: 'editExcel' })}>
                  Excel · Read-only
                </button>
              ) : (
                <span className="format-chip" title="This is an Excel file: edits are saved to it as an Excel file.">
                  Excel
                </span>
              ))}
            {meta.branch && (
              <span className="branch-chip" title={`Branched ${new Date(meta.branch.branchedAt).toLocaleString()}`}>
                <BranchIcon />
                Branch of{' '}
                {meta.branch.detached ? (
                  <em>“{meta.branch.parentTitle}” (deleted)</em>
                ) : (
                  <Link to={`/s/${meta.branch.parentId}`} onClick={() => void ctl.saver.flush()}>
                    {meta.branch.parentTitle}
                  </Link>
                )}
              </span>
            )}
            {meta.branch && (
              <button className={`btn compare-btn${ctl.compare ? ' active' : ''}`} onClick={() => (ctl.compare ? ctl.closeCompare() : void ctl.openCompare())}>
                {ctl.compare ? 'Close comparison' : 'Compare with original'}
              </button>
            )}
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
        <div className="wb-user">
          <FileSearchButton />
          <AgentButton />
          <Account before={() => ctl.saver.flush()} />
        </div>
      </header>
      <Toolbar host={host} />
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
      <FormulaBar ctl={ctl} />
      <div className="grid-area">
        <div className="grid-main">
          <Grid ctl={ctl} notify={notify} />
          {ctl.search && <FindBar ctl={ctl} />}
        </div>
        {ctl.compare && <ComparePanel ctl={ctl} />}
        {ctl.chartEditor && <ChartEditor ctl={ctl} />}
      </div>
      <TabBar host={host} />

      {ctxMenu && ctxItems && (
        <div onMouseDown={(e) => e.stopPropagation()}>
          <MenuList items={ctxItems} onDone={() => ctl.openMenu(null)} style={{ position: 'fixed', left: ctxMenu.x, top: ctxMenu.y }} />
        </div>
      )}
      {ctl.filterMenu && ctl.tab.filter && <FilterMenu key={`${ctl.tab.id}:${ctl.filterMenu.col}`} ctl={ctl} />}

      {dialog?.kind === 'branch' && (
        <PromptModal
          title="Create branch"
          label="Branch name"
          initial={`${meta.title} (branch)`}
          confirmText="Create branch"
          onConfirm={async (t) => {
            if (ctl.edit) ctl.commitEdit();
            await ctl.saver.flush();
            const { sheet } = await api.branchSheet(meta.id, t);
            navigate(`/s/${sheet.id}`);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'editExcel' && (
        <ConfirmModal
          title="Edit this Excel file?"
          message={
            <>
              “{meta.title}” has things {appName()} can't keep: {(notKept ?? []).join(', ')}. If you edit it, they are removed from the file when it saves. A copy of
              the file as it is now is kept in the app's trash folder.
            </>
          }
          confirmText="Edit anyway"
          onConfirm={() => {
            ctl.store.guard = xlsxGuard;
            setNotKept(undefined);
            dialog.retry?.();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'convert' && meta.format === 'xlsx' && (
        <ConfirmModal
          title={`Keep as a ${appName()} spreadsheet?`}
          message={
            <>
              {dialog.reason ?? 'Some things'} cannot be saved in an Excel file. Keeping “{meta.title}” as a {appName()} spreadsheet instead lets it hold them. It will no longer
              be an Excel file, and you can still download it as Excel.
            </>
          }
          confirmText="Keep as spreadsheet"
          onConfirm={async () => {
            await convertToSpreadsheet();
            dialog.retry?.();
            notify(`Kept as a ${appName()} spreadsheet.`);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'convert' && meta.format !== 'xlsx' && (
        <ConfirmModal
          title="Convert to a spreadsheet?"
          message={
            <>
              {dialog.reason ? `${dialog.reason} cannot be saved in a CSV file. ` : 'A CSV file holds plain cell values only. '}
              Converting “{meta.title}” to a spreadsheet lets it keep formatting, column sizes, filters, images and more sheets. It will no longer be a CSV file, and
              you can still download it as CSV.
            </>
          }
          confirmText="Convert"
          onConfirm={async () => {
            await convertToSpreadsheet();
            dialog.retry?.();
            notify('Converted to a spreadsheet.');
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'csvCopy' && (
        <PromptModal
          title="Save a copy as CSV file"
          label="Name for the CSV copy (current sheet, values only)"
          initial={ctl.store.workbook.tabs.length > 1 && ctl.tab.name !== meta.title ? `${meta.title} - ${ctl.tab.name}` : meta.title}
          confirmText="Save copy"
          onConfirm={async (t) => {
            if (ctl.edit) ctl.commitEdit();
            const { sheet } = await api.importCsv(t, toCSV(ctl));
            window.open(`/s/${sheet.id}`, '_blank');
            notify(`Saved “${sheet.title}” as a CSV file.`);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'rename' && (
        <PromptModal title="Rename spreadsheet" label="Name" initial={meta.title} confirmText="Rename" onConfirm={renameSheet} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'deleteSheet' && (
        <ConfirmModal
          title="Delete spreadsheet?"
          message={<>“{meta.title}” will be permanently deleted. This cannot be undone.</>}
          confirmText="Delete"
          danger
          onConfirm={async () => {
            ctl.saver.dispose();
            await api.deleteSheet(meta.id);
            navigate('/');
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {deletingTab && (
        <ConfirmModal
          title="Delete sheet?"
          message={<>Delete the sheet “{deletingTab.name}”? You can undo this with {navigator.platform.includes('Mac') ? '⌘Z' : 'Ctrl+Z'}.</>}
          confirmText="Delete"
          danger
          onConfirm={() => ctl.deleteTab(deletingTab.id)}
          onClose={() => setDialog(null)}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function BranchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="4" cy="3" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="4" cy="13" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="12" cy="5" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4 4.8v6.4M12 6.8c0 3-8 2-8 4.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}
