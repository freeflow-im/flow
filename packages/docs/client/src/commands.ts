// Menu definitions shared by the menu bar and context menus.
import { colToName } from '../../shared/cellref.ts';
import type { NumberFormat } from '../../shared/types.ts';
import { pickImageFile, uploadImageFile } from './cellImage.ts';
import type { MenuItem } from './components/Menu.tsx';
import type { SheetController } from './state/controller.ts';

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? '⌘' : 'Ctrl+';
const SHIFT = isMac ? '⇧' : 'Shift+';

export interface CommandHost {
  ctl: SheetController;
  notify(msg: string): void;
  renameSheet(): void;
  deleteSheet(): void;
  newSheet(): void;
  importXlsx(): void;
  /** Add a CSV file as a new sheet. */
  importCsv?: () => void;
  /** Save the current sheet as a new CSV file in the app (values only). */
  saveCopyAsCsv?: () => void;
  createBranch(): void;
  compareWithOriginal(): void;
  isBranch: boolean;
  goHome(): void;
  openConnectors(): void;
  download(kind: 'csv' | 'json' | 'xlsx'): void;
  /** Set while the open file is a CSV file: converts it to a native spreadsheet (after asking). */
  convertToSpreadsheet?: () => void;
  deleteTab(tabId: string): void;
}

export async function pasteFromSystem(host: CommandHost, valuesOnly = false): Promise<void> {
  const { ctl } = host;
  try {
    const text = await navigator.clipboard.readText();
    ctl.paste(text, valuesOnly);
  } catch {
    const internal = ctl.internalClipboardText();
    if (internal !== null) ctl.paste(internal, valuesOnly);
    else host.notify(`Use ${MOD}V to paste from the system clipboard.`);
  }
}

function copyVia(host: CommandHost, cut: boolean) {
  // Triggers the grid's copy/cut handler (the grid's editor keeps focus while menus are open).
  if (!document.execCommand(cut ? 'cut' : 'copy')) {
    const { text } = host.ctl.copy(cut);
    void navigator.clipboard?.writeText(text).catch(() => {});
  }
}

function sel(ctl: SheetController) {
  const rg = ctl.primary;
  const t = ctl.tab;
  return {
    rg,
    nRows: rg.r2 - rg.r1 + 1,
    nCols: rg.c2 - rg.c1 + 1,
    wholeRows: rg.c1 === 0 && rg.c2 === t.cols - 1,
    wholeCols: rg.r1 === 0 && rg.r2 === t.rows - 1,
  };
}

const plural = (n: number, word: string) => (n === 1 ? `1 ${word}` : `${n} ${word}s`);

export function editItems(host: CommandHost): MenuItem[] {
  const { ctl } = host;
  const s = sel(ctl);
  return [
    { label: 'Undo', shortcut: `${MOD}Z`, action: () => ctl.undo(), disabled: !ctl.store.canUndo() },
    { label: 'Redo', shortcut: `${MOD}${isMac ? SHIFT + 'Z' : 'Y'}`, action: () => ctl.redo(), disabled: !ctl.store.canRedo() },
    'sep',
    { label: 'Find…', shortcut: `${MOD}F`, action: () => ctl.openSearch() },
    'sep',
    { label: 'Cut', shortcut: `${MOD}X`, action: () => copyVia(host, true) },
    { label: 'Copy', shortcut: `${MOD}C`, action: () => copyVia(host, false) },
    { label: 'Paste', shortcut: `${MOD}V`, action: () => void pasteFromSystem(host) },
    { label: 'Paste values only', shortcut: `${MOD}${SHIFT}V`, action: () => void pasteFromSystem(host, true) },
    'sep',
    { label: 'Delete values', shortcut: 'Del', action: () => ctl.clearSelection() },
    { label: `Delete ${s.nRows === 1 ? 'row' : `rows ${s.rg.r1 + 1} - ${s.rg.r2 + 1}`}`, action: () => ctl.deleteRows() },
    { label: `Delete ${s.nCols === 1 ? 'column' : `columns ${colToName(s.rg.c1)} - ${colToName(s.rg.c2)}`}`, action: () => ctl.deleteCols() },
  ];
}

export function insertItems(host: CommandHost): MenuItem[] {
  const { ctl } = host;
  const s = sel(ctl);
  return [
    { label: `Insert ${plural(s.nRows, 'row')} above`, action: () => ctl.insertRows('above') },
    { label: `Insert ${plural(s.nRows, 'row')} below`, action: () => ctl.insertRows('below') },
    'sep',
    { label: `Insert ${plural(s.nCols, 'column')} left`, action: () => ctl.insertCols('left') },
    { label: `Insert ${plural(s.nCols, 'column')} right`, action: () => ctl.insertCols('right') },
    'sep',
    { label: 'Upload image in cell…', action: () => void uploadImage(host) },
    { label: 'Chart', action: () => insertChart(host) },
    'sep',
    { label: 'New sheet tab', shortcut: `${SHIFT}F11`, action: () => ctl.addTab() },
  ];
}

/** Chart the selection (or the data around the active cell) and open the chart editor. */
export function insertChart(host: CommandHost): void {
  const problem = host.ctl.insertChart();
  if (problem) host.notify(problem);
}

/** Pick an image file and place it in the active cell. */
export async function uploadImage(host: CommandHost): Promise<void> {
  const { ctl } = host;
  const at = { tabId: ctl.tab.id, ...ctl.sel.active };
  const file = await pickImageFile();
  if (!file) return;
  try {
    const src = await uploadImageFile(file);
    const problem = ctl.insertImage(src, at);
    if (problem) host.notify(problem);
  } catch (e) {
    host.notify(e instanceof Error ? e.message : String(e));
  }
}

const FORMATS: { fmt: NumberFormat; label: string; example: string }[] = [
  { fmt: 'general', label: 'Automatic', example: '' },
  { fmt: 'text', label: 'Plain text', example: '' },
  { fmt: 'number', label: 'Number', example: '1,000.12' },
  { fmt: 'percent', label: 'Percent', example: '10.12%' },
  { fmt: 'currency', label: 'Currency', example: '$1,000.12' },
  { fmt: 'date', label: 'Date', example: '9/26/2008' },
  { fmt: 'time', label: 'Time', example: '3:59:00 PM' },
  { fmt: 'datetime', label: 'Date time', example: '9/26/2008 15:59:00' },
];

export function numberFormatItems(ctl: SheetController): MenuItem[] {
  const cur = ctl.activeCellStyle().fmt ?? 'general';
  return [
    ...FORMATS.map((f): MenuItem => ({
      label: f.label,
      shortcut: f.example,
      checked: cur === f.fmt,
      action: () => ctl.setStyle({ fmt: f.fmt === 'general' ? undefined : f.fmt, dp: undefined }),
    })),
    'sep',
    { label: 'Increase decimal places', action: () => ctl.adjustDecimals(1) },
    { label: 'Decrease decimal places', action: () => ctl.adjustDecimals(-1) },
  ];
}

export function formatItems(host: CommandHost): MenuItem[] {
  const { ctl } = host;
  const st = ctl.activeCellStyle();
  return [
    { label: 'Number', submenu: numberFormatItems(ctl) },
    'sep',
    { label: 'Bold', shortcut: `${MOD}B`, checked: !!st.b, action: () => ctl.toggleStyle('b') },
    { label: 'Italic', shortcut: `${MOD}I`, checked: !!st.i, action: () => ctl.toggleStyle('i') },
    { label: 'Underline', shortcut: `${MOD}U`, checked: !!st.u, action: () => ctl.toggleStyle('u') },
    { label: 'Strikethrough', shortcut: isMac ? `${MOD}${SHIFT}X` : 'Alt+Shift+5', checked: !!st.s, action: () => ctl.toggleStyle('s') },
    'sep',
    {
      label: 'Alignment',
      submenu: [
        { label: 'Left', checked: st.align === 'left', action: () => ctl.setStyle({ align: 'left' }) },
        { label: 'Center', checked: st.align === 'center', action: () => ctl.setStyle({ align: 'center' }) },
        { label: 'Right', checked: st.align === 'right', action: () => ctl.setStyle({ align: 'right' }) },
        'sep',
        { label: 'Automatic', checked: !st.align, action: () => ctl.setStyle({ align: undefined }) },
      ],
    },
    { label: 'Wrap text', checked: !!st.wrap, action: () => ctl.toggleStyle('wrap') },
    'sep',
    { label: 'Clear formatting', shortcut: `${MOD}\\`, action: () => ctl.clearFormatting() },
  ];
}

export function dataItems(host: CommandHost): MenuItem[] {
  const { ctl } = host;
  const col = colToName(ctl.sel.active.c);
  const hasFilter = !!ctl.tab.filter;
  return [
    { label: `Sort sheet by column ${col} (A → Z)`, action: () => ctl.sortSheetByColumn(ctl.sel.active.c, true) },
    { label: `Sort sheet by column ${col} (Z → A)`, action: () => ctl.sortSheetByColumn(ctl.sel.active.c, false) },
    'sep',
    { label: `Sort range by column ${col} (A → Z)`, action: () => ctl.sortSelection(true) },
    { label: `Sort range by column ${col} (Z → A)`, action: () => ctl.sortSelection(false) },
    'sep',
    hasFilter ? { label: 'Remove filter', action: () => ctl.removeFilter() } : { label: 'Create a filter', action: () => ctl.createFilter() },
  ];
}

export function viewItems(host: CommandHost): MenuItem[] {
  const { ctl } = host;
  const t = ctl.tab;
  const fr = t.frozenRows ?? 0;
  const fc = t.frozenCols ?? 0;
  const { r, c } = ctl.sel.active;
  return [
    {
      label: 'Freeze',
      submenu: [
        { label: 'No rows', checked: fr === 0, action: () => ctl.setFrozen(0, undefined) },
        { label: '1 row', checked: fr === 1, action: () => ctl.setFrozen(1, undefined) },
        { label: '2 rows', checked: fr === 2, action: () => ctl.setFrozen(2, undefined) },
        { label: `Up to row ${r + 1}`, checked: fr === r + 1 && r > 1, action: () => ctl.setFrozen(r + 1, undefined), disabled: r < 2 },
        'sep',
        { label: 'No columns', checked: fc === 0, action: () => ctl.setFrozen(undefined, 0) },
        { label: '1 column', checked: fc === 1, action: () => ctl.setFrozen(undefined, 1) },
        { label: '2 columns', checked: fc === 2, action: () => ctl.setFrozen(undefined, 2) },
        { label: `Up to column ${colToName(c)}`, checked: fc === c + 1 && c > 1, action: () => ctl.setFrozen(undefined, c + 1), disabled: c < 2 },
      ],
    },
  ];
}

export function fileItems(host: CommandHost): MenuItem[] {
  return [
    { label: 'New spreadsheet', action: () => host.newSheet() },
    { label: 'Open…', action: () => host.goHome() },
    { label: 'Import Excel file (.xlsx, .xls)…', action: () => host.importXlsx() },
    ...(host.importCsv ? [{ label: 'Import CSV file (.csv)…', action: host.importCsv } as MenuItem] : []),
    { label: 'Data connectors…', action: () => host.openConnectors() },
    'sep',
    { label: 'Rename', action: () => host.renameSheet() },
    ...(host.convertToSpreadsheet ? [{ label: 'Convert to spreadsheet…', action: host.convertToSpreadsheet } as MenuItem] : []),
    ...(host.saveCopyAsCsv ? [{ label: 'Save a copy as CSV file…', action: host.saveCopyAsCsv } as MenuItem] : []),
    { label: 'Create branch…', action: () => host.createBranch() },
    ...(host.isBranch ? [{ label: 'Compare with original', action: () => host.compareWithOriginal() } as MenuItem] : []),
    {
      label: 'Download',
      submenu: [
        { label: 'Excel workbook (.xlsx)', action: () => host.download('xlsx') },
        { label: 'Comma-separated values (.csv, current sheet)', action: () => host.download('csv') },
        { label: 'Workbook (.json)', action: () => host.download('json') },
      ],
    },
    'sep',
    { label: 'Delete spreadsheet', danger: true, action: () => host.deleteSheet() },
  ];
}

export function cellContextItems(host: CommandHost, kind: 'cell' | 'row' | 'col' | 'corner'): MenuItem[] {
  const { ctl } = host;
  const s = sel(ctl);
  const clip: MenuItem[] = [
    { label: 'Cut', shortcut: `${MOD}X`, action: () => copyVia(host, true) },
    { label: 'Copy', shortcut: `${MOD}C`, action: () => copyVia(host, false) },
    { label: 'Paste', shortcut: `${MOD}V`, action: () => void pasteFromSystem(host) },
    { label: 'Paste values only', shortcut: `${MOD}${SHIFT}V`, action: () => void pasteFromSystem(host, true) },
  ];
  const rows: MenuItem[] = [
    { label: `Insert ${plural(s.nRows, 'row')} above`, action: () => ctl.insertRows('above') },
    { label: `Insert ${plural(s.nRows, 'row')} below`, action: () => ctl.insertRows('below') },
  ];
  const cols: MenuItem[] = [
    { label: `Insert ${plural(s.nCols, 'column')} left`, action: () => ctl.insertCols('left') },
    { label: `Insert ${plural(s.nCols, 'column')} right`, action: () => ctl.insertCols('right') },
  ];
  const delRow: MenuItem = { label: s.nRows === 1 ? 'Delete row' : `Delete rows ${s.rg.r1 + 1} - ${s.rg.r2 + 1}`, action: () => ctl.deleteRows() };
  const delCol: MenuItem = {
    label: s.nCols === 1 ? 'Delete column' : `Delete columns ${colToName(s.rg.c1)} - ${colToName(s.rg.c2)}`,
    action: () => ctl.deleteCols(),
  };
  const filter: MenuItem = ctl.tab.filter ? { label: 'Remove filter', action: () => ctl.removeFilter() } : { label: 'Create a filter', action: () => ctl.createFilter() };
  if (kind === 'row') {
    return [...clip, 'sep', ...rows, 'sep', delRow, { label: 'Clear row' + (s.nRows > 1 ? 's' : ''), action: () => ctl.clearSelection() }, 'sep', {
      label: 'Resize row' + (s.nRows > 1 ? 's' : '') + ' to default',
      action: () => ctl.setRowHeight(Array.from({ length: s.nRows }, (_, i) => s.rg.r1 + i), 21),
    }];
  }
  if (kind === 'col') {
    const c = ctl.sel.active.c;
    return [
      ...clip,
      'sep',
      ...cols,
      'sep',
      delCol,
      { label: 'Clear column' + (s.nCols > 1 ? 's' : ''), action: () => ctl.clearSelection() },
      'sep',
      { label: 'Sort sheet A → Z', action: () => ctl.sortSheetByColumn(c, true) },
      { label: 'Sort sheet Z → A', action: () => ctl.sortSheetByColumn(c, false) },
      'sep',
      filter,
    ];
  }
  return [
    ...clip,
    'sep',
    ...rows,
    ...cols,
    'sep',
    delRow,
    delCol,
    { label: 'Delete values', action: () => ctl.clearSelection() },
    { label: 'Upload image in cell…', action: () => void uploadImage(host) },
    { label: 'Chart', action: () => insertChart(host) },
    'sep',
    { label: 'Sort range A → Z', action: () => ctl.sortSelection(true) },
    { label: 'Sort range Z → A', action: () => ctl.sortSelection(false) },
    filter,
    'sep',
    { label: 'Clear formatting', shortcut: `${MOD}\\`, action: () => ctl.clearFormatting() },
  ];
}

export function tabContextItems(host: CommandHost, tabId: string): MenuItem[] {
  const { ctl } = host;
  const tabs = ctl.store.workbook.tabs;
  const idx = tabs.findIndex((t) => t.id === tabId);
  return [
    { label: 'Delete', danger: true, disabled: tabs.length <= 1, action: () => host.deleteTab(tabId) },
    { label: 'Duplicate', action: () => ctl.duplicateTab(tabId) },
    { label: 'Rename', action: () => ctl.setRenamingTab(tabId) },
    'sep',
    { label: 'Move left', disabled: idx <= 0, action: () => ctl.moveTab(idx, idx - 1) },
    { label: 'Move right', disabled: idx >= tabs.length - 1, action: () => ctl.moveTab(idx, idx + 1) },
  ];
}
