// Convert an uploaded .xlsx file into the native workbook format.
import { randomUUID } from 'node:crypto';
import { readXlsxCharts } from './xlsxCharts.ts';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { cellKey, parseRangeString, MAX_COLS } from '../shared/cellref.ts';
import { renameSheetRefs, shiftFormula } from '../shared/formula/adjust.ts';
import { FUNCTIONS } from '../shared/formula/functions.ts';
import { parseFormula } from '../shared/formula/parser.ts';
import { tokenize } from '../shared/formula/tokenizer.ts';
import { DEFAULT_COLS, DEFAULT_ROWS, type CellData, type CellStyle, type NumberFormat, type Tab, type Workbook } from '../shared/types.ts';
import { formatDate, formatTime, parseLiteral } from '../shared/values.ts';

export class ImportError extends Error {}

export const IMPORT_LIMITS = {
  maxUncompressedBytes: 300 * 1024 * 1024,
  maxZipEntries: 5000,
  maxCells: 1_000_000,
  maxRows: 500_000,
};

const DEFAULT_ROW_PX = 21;

export interface ImportResult {
  workbook: Workbook;
  warnings: string[];
  /**
   * What the file holds that the workbook does not (named for the user, e.g. "Charts"), so writing the
   * workbook back over the file would remove it. Found by looking through the file's parts, so it errs on
   * the side of listing a thing.
   */
  lost: string[];
}

/** Reject zip bombs before handing the archive to the xlsx parser. */
async function checkArchive(buf: Buffer): Promise<JSZip> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    throw new ImportError('This file is not a valid .xlsx workbook.');
  }
  const entries = Object.values(zip.files);
  if (entries.length > IMPORT_LIMITS.maxZipEntries) throw new ImportError('This workbook contains too many parts to import.');
  let total = 0;
  for (const f of entries) {
    // JSZip exposes sizes from the central directory without decompressing.
    const size = (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    total += size;
  }
  if (total > IMPORT_LIMITS.maxUncompressedBytes) throw new ImportError('This workbook is too large to import.');
  if (!zip.file('xl/workbook.xml')) throw new ImportError('This file is not a valid .xlsx workbook.');
  return zip;
}

/**
 * The file for ExcelJS without the sheets' drawings (charts and pictures), which the import reads itself
 * (server/xlsxCharts.ts) or leaves out: ExcelJS fails on some it cannot place (a drawing named by an absolute
 * path, as openpyxl writes them), and then on the whole workbook.
 */
async function withoutDrawings(zip: JSZip, buf: Buffer): Promise<Buffer> {
  const sheets = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n));
  const copy = await JSZip.loadAsync(buf);
  let changed = false;
  for (const n of sheets) {
    const xml = await zip.file(n)!.async('string');
    const next = xml.replace(/<drawing\b[^>]*\/>/g, '');
    if (next === xml) continue;
    copy.file(n, next);
    changed = true;
  }
  // ExcelJS reads every drawing part there is, whether a sheet shows it or not (but not the VML ones notes are drawn with).
  for (const n of Object.keys(zip.files).filter((f) => /^xl\/drawings\/(_rels\/)?drawing\d*\.xml(\.rels)?$/.test(f))) {
    copy.remove(n);
    changed = true;
  }
  return changed ? copy.generateAsync({ type: 'nodebuffer' }) : buf;
}

/** Parts of a workbook the import leaves out, by the files that hold them. */
const LOST_PARTS: [RegExp, string][] = [
  [/^xl\/media\//, 'Pictures'],
  [/^xl\/(comments\d*\.xml|threadedComments\/)/, 'Comments'],
  [/^xl\/pivotTables\//, 'Pivot tables'],
  [/^xl\/tables\//, 'Tables'],
  [/^xl\/externalLinks\//, 'Links to other workbooks'],
  [/^xl\/vbaProject\.bin$/, 'Macros'],
];
/** What a worksheet's XML holds that the import leaves out, by the elements that hold it. */
const LOST_IN_SHEETS: [RegExp, string][] = [
  [/<(\w+:)?conditionalFormatting[ >]/, 'Conditional formatting'],
  [/<(\w+:)?dataValidations[ >]/, 'Data validation'],
  [/<hyperlink /, 'Links'],
  [/<(row|col) [^>]*hidden="(1|true)"/, 'Hidden rows and columns'],
  [/<(row|col) [^>]*outlineLevel="[1-9]/, 'Grouped rows and columns'],
  [/<sheetProtection /, 'Sheet protection'],
];

/** What writing the imported workbook back over the file would remove (see ImportResult.lost). */
async function lostParts(zip: JSZip): Promise<string[]> {
  const lost = new Set<string>();
  const names = Object.keys(zip.files);
  for (const [re, label] of LOST_PARTS) if (names.some((n) => re.test(n))) lost.add(label);
  for (const n of names.filter((n) => /^xl\/worksheets\/sheet\d*\.xml$/.test(n))) {
    const xml = await zip.file(n)!.async('string');
    for (const [re, label] of LOST_IN_SHEETS) if (re.test(xml)) lost.add(label);
  }
  // Drawings hold charts and pictures (named above by their own parts) and shapes.
  for (const n of names.filter((n) => /^xl\/drawings\/drawing\d*\.xml$/.test(n))) {
    if (/<(\w+:)?sp[ >]/.test(await zip.file(n)!.async('string'))) lost.add('Shapes and text boxes');
  }
  const workbook = await zip.file('xl/workbook.xml')!.async('string');
  // Excel's own names (print areas, the filter's range) are not the user's.
  if ([...workbook.matchAll(/<definedName [^>]*name="([^"]+)"/g)].some((m) => !m[1].startsWith('_xlnm.'))) lost.add('Named ranges');
  const styles = (await zip.file('xl/styles.xml')?.async('string')) ?? '';
  const borders = /<borders[^>]*>([\s\S]*?)<\/borders>/.exec(styles)?.[1] ?? '';
  if (/ style="(?!none")/.test(borders)) lost.add('Cell borders');
  const fonts = /<fonts[^>]*>([\s\S]*?)<\/fonts>/.exec(styles)?.[1] ?? '';
  // A font that only makes text bold, say, leaves out the size and name it keeps.
  const sizes = new Set([...fonts.matchAll(/<sz val="([^"]+)"/g)].map((m) => m[1]));
  const faces = new Set([...fonts.matchAll(/<name val="([^"]+)"/g)].map((m) => m[1]));
  if (sizes.size > 1 || faces.size > 1) lost.add('Fonts and text sizes');
  return [...lost];
}

function argbToHex(c: Partial<ExcelJS.Color> | undefined): string | undefined {
  const argb = c?.argb;
  if (typeof argb !== 'string' || !/^[0-9A-Fa-f]{8}$/.test(argb)) return undefined;
  return '#' + argb.slice(2).toLowerCase();
}

function decimalsIn(fmt: string): number {
  const m = /\.([0#]+)/.exec(fmt);
  return m ? m[1].length : 0;
}

/** Map an Excel number format code onto the formats the app supports. */
export function mapNumFmt(code: string | undefined): { fmt?: NumberFormat; dp?: number } {
  if (!code || /^general$/i.test(code)) return {};
  if (code === '@') return { fmt: 'text' };
  const first = code.split(';')[0];
  // Drop quoted literals, escapes and bracketed sections ([Red], [$-409], [$$-409]) before classifying.
  const bare = first.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[(?!\$\$)[^\]]*\]/g, '');
  if (/\[\$\$|\$/.test(first)) return { fmt: 'currency', dp: decimalsIn(bare) };
  if (bare.includes('%')) return { fmt: 'percent', dp: decimalsIn(bare) };
  const hasDate = /[dy]/i.test(bare) || /m{3,}/i.test(bare) || (/m/i.test(bare) && !/[hs]/i.test(bare));
  const hasTime = /[hs]/i.test(bare);
  if (hasDate && hasTime) return { fmt: 'datetime' };
  if (hasDate) return { fmt: 'date' };
  if (hasTime) return { fmt: 'time' };
  if (/[0#]/.test(bare) && (bare.includes(',') || bare.includes('.'))) return { fmt: 'number', dp: decimalsIn(bare) };
  return {};
}

function styleOf(cell: ExcelJS.Cell): CellStyle | undefined {
  const st: CellStyle = {};
  const f = cell.font;
  if (f?.bold) st.b = true;
  if (f?.italic) st.i = true;
  if (f?.underline) st.u = true;
  if (f?.strike) st.s = true;
  const color = argbToHex(f?.color);
  if (color && color !== '#000000') st.color = color;
  const fill = cell.fill;
  if (fill?.type === 'pattern' && fill.pattern === 'solid') {
    const bg = argbToHex(fill.fgColor);
    if (bg && bg !== '#ffffff') st.bg = bg;
  }
  const h = cell.alignment?.horizontal;
  if (h === 'left' || h === 'center' || h === 'right') st.align = h;
  else if (h === 'centerContinuous') st.align = 'center';
  const nf = mapNumFmt(cell.numFmt);
  if (nf.fmt) st.fmt = nf.fmt;
  if (nf.dp !== undefined && (nf.fmt === 'number' || nf.fmt === 'currency' || nf.fmt === 'percent')) st.dp = nf.dp;
  return Object.keys(st).length ? st : undefined;
}

/** Text that would be re-interpreted (numbers, dates, booleans, formulas) gets a leading apostrophe. */
function textInput(s: string): string {
  if (s === '') return '';
  if (s.startsWith('=') || s.startsWith("'")) return "'" + s;
  const lit = parseLiteral(s);
  return typeof lit.value === 'string' && lit.value === s ? s : "'" + s;
}

function dateInput(d: Date): string {
  const serial = d.getTime() / 86_400_000 + 25569;
  if (serial < 1 && serial >= 0) return formatTime(serial);
  if (Math.abs(serial - Math.round(serial)) < 1e-9) return formatDate(Math.round(serial));
  return `${formatDate(serial)} ${formatTime(serial)}`;
}

function cleanFormula(f: string): string {
  return f.replace(/_xlfn\.|_xlws\.|_xludf\./gi, '');
}

function richTextToString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && Array.isArray((v as ExcelJS.CellRichTextValue).richText)) {
    return (v as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join('');
  }
  return v === null || v === undefined ? '' : String(v);
}

function sanitizeTabName(name: string, used: Set<string>): string {
  let n = name.replace(/[[\]*?/\\:]/g, ' ').trim().slice(0, 100) || 'Sheet';
  const base = n;
  for (let i = 2; used.has(n.toLowerCase()); i++) n = `${base} ${i}`;
  used.add(n.toLowerCase());
  return n;
}

// Legacy .xls files (and encrypted .xlsx files) are OLE compound documents.
const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/** Convert a legacy .xls workbook to .xlsx so it can go through the same importer. */
function xlsToXlsx(buf: Buffer): Buffer {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buf, { type: 'buffer', cellFormula: true, cellNF: true, cellStyles: true, sheetRows: IMPORT_LIMITS.maxRows });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/password|encrypt/i.test(msg)) throw new ImportError('This file is password-protected. Remove the password in Excel and try again.');
    throw new ImportError('This .xls file could not be read.');
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer;
}

/** Import an Excel workbook in either .xlsx or legacy .xls format (detected from the file contents). */
export async function importExcel(buf: Buffer): Promise<ImportResult> {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(CFB_MAGIC)) {
    const result = await importXlsx(xlsToXlsx(buf));
    result.warnings.unshift(
      'This is an older .xls file: values, formulas, number formats and column widths were imported, but fonts, colors and alignment were not.',
    );
    return result;
  }
  if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) return importXlsx(buf);
  throw new ImportError('This file is not an Excel workbook (.xlsx or .xls).');
}

export async function importXlsx(buf: Buffer): Promise<ImportResult> {
  const zip = await checkArchive(buf);
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load((await withoutDrawings(zip, buf)) as unknown as ArrayBuffer);
  } catch {
    throw new ImportError('This file could not be read as an .xlsx workbook.');
  }

  const warnings: string[] = [];
  const unsupportedFns = new Map<string, number>();
  let badFormulas = 0;
  let merged = 0;
  let totalCells = 0;
  const hidden: string[] = [];
  const renamed: string[] = [];
  const usedNames = new Set<string>();
  const tabs: Tab[] = [];

  // First pass: sanitize names so formulas can be rewritten if a sheet name had to change.
  const sheets = wb.worksheets;
  if (!sheets.length) throw new ImportError('This workbook has no worksheets.');
  const nameMap = new Map<string, string>();
  for (const ws of sheets) {
    const n = sanitizeTabName(ws.name, usedNames);
    nameMap.set(ws.name, n);
    if (n !== ws.name) renamed.push(`"${ws.name}" → "${n}"`);
  }

  for (const ws of sheets) {
    const tabName = nameMap.get(ws.name)!;
    if (ws.state && ws.state !== 'visible') hidden.push(tabName);
    const cells: Record<string, CellData> = {};
    const masters = new Map<string, string>(); // shared-formula master address -> formula
    let maxRow = 0;
    let maxCol = 0;

    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > IMPORT_LIMITS.maxRows) return;
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        if (colNumber > MAX_COLS) return;
        if (cell.type === ExcelJS.ValueType.Merge) return;
        if (++totalCells > IMPORT_LIMITS.maxCells) throw new ImportError(`This workbook has more than ${IMPORT_LIMITS.maxCells.toLocaleString()} cells, which is the import limit.`);
        const r = rowNumber - 1;
        const c = colNumber - 1;
        const st = styleOf(cell);
        let v = '';
        const val = cell.value;
        switch (cell.type) {
          case ExcelJS.ValueType.Number:
            v = String(val);
            break;
          case ExcelJS.ValueType.String:
          case ExcelJS.ValueType.SharedString:
            v = textInput(String(val));
            break;
          case ExcelJS.ValueType.RichText:
            v = textInput(richTextToString(val));
            break;
          case ExcelJS.ValueType.Hyperlink:
            v = textInput(richTextToString((val as ExcelJS.CellHyperlinkValue).text));
            break;
          case ExcelJS.ValueType.Boolean:
            v = val ? 'TRUE' : 'FALSE';
            break;
          case ExcelJS.ValueType.Date:
            v = dateInput(val as Date);
            break;
          case ExcelJS.ValueType.Error:
            v = '=' + (val as ExcelJS.CellErrorValue).error;
            break;
          case ExcelJS.ValueType.Formula: {
            const fv = val as ExcelJS.CellFormulaValue & ExcelJS.CellSharedFormulaValue;
            let f: string | undefined = fv.formula;
            if (f) masters.set(cellKey(r, c), f);
            if (!f && fv.sharedFormula) {
              const translated = (cell as unknown as { formula?: string }).formula;
              const master = masters.get(fv.sharedFormula.replace(/\$/g, ''));
              if (translated) f = translated;
              else if (master) {
                const m = /^([A-Z]+)(\d+)$/.exec(fv.sharedFormula.replace(/\$/g, ''))!;
                const mr = parseInt(m[2], 10) - 1;
                const mc = ws.getColumn(m[1]).number - 1;
                f = shiftFormula('=' + master, r - mr, c - mc).slice(1);
              }
            }
            if (!f) break;
            v = '=' + cleanFormula(f);
            try {
              parseFormula(v.slice(1));
              const toks = tokenize(v.slice(1));
              toks.forEach((t, i) => {
                const name = t.text.toUpperCase();
                if (t.type === 'ident' && toks[i + 1]?.type === 'lparen' && !FUNCTIONS[name]) {
                  unsupportedFns.set(name, (unsupportedFns.get(name) ?? 0) + 1);
                }
              });
            } catch {
              badFormulas++;
            }
            break;
          }
          default:
            break;
        }
        if (!v && !st) return;
        cells[cellKey(r, c)] = st ? { v, st } : { v };
        if (r + 1 > maxRow) maxRow = r + 1;
        if (c + 1 > maxCol) maxCol = c + 1;
      });
    });

    // Column widths (Excel character units) and custom row heights (points).
    const colWidths: Record<string, number> = {};
    const colCount = Math.max(maxCol, ws.columnCount);
    for (let c = 1; c <= Math.min(colCount, MAX_COLS); c++) {
      const w = ws.getColumn(c).width;
      if (w && w > 0) colWidths[c - 1] = Math.max(20, Math.round(w * 7 + 5));
    }
    const rowHeights: Record<string, number> = {};
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      if (row.height && n <= IMPORT_LIMITS.maxRows) {
        const px = Math.round((row.height * 96) / 72);
        if (Math.abs(px - DEFAULT_ROW_PX) > 2) rowHeights[n - 1] = Math.max(12, px);
      }
    });

    const tab: Tab = {
      id: randomUUID(),
      name: tabName,
      rows: Math.min(IMPORT_LIMITS.maxRows, Math.max(DEFAULT_ROWS, maxRow + 100)),
      cols: Math.min(MAX_COLS, Math.max(DEFAULT_COLS, maxCol)),
      cells,
      colWidths,
      rowHeights,
    };

    const view = ws.views?.[0] as Partial<ExcelJS.WorksheetViewFrozen> | undefined;
    if (view?.state === 'frozen') {
      if (view.ySplit) tab.frozenRows = Math.min(view.ySplit, tab.rows - 1);
      if (view.xSplit) tab.frozenCols = Math.min(view.xSplit, tab.cols - 1);
    }

    const af = ws.autoFilter as unknown;
    const afRef = typeof af === 'string' ? af : af && typeof af === 'object' && 'ref' in af ? String((af as { ref: string }).ref) : null;
    if (afRef) {
      const rg = parseRangeString(afRef, tab.rows, tab.cols);
      if (rg && rg.r2 > rg.r1) tab.filter = { ...rg, cols: {} };
    }

    merged += ((ws.model as { merges?: string[] }).merges ?? []).length;
    tabs.push(tab);
  }

  // Formulas refer to sheets by their Excel names; rewrite any that had to be renamed.
  const renames = [...nameMap].filter(([a, b]) => a !== b);
  if (renames.length) {
    for (const t of tabs)
      for (const key in t.cells) {
        let v = t.cells[key].v;
        if (!v.startsWith('=')) continue;
        for (const [from, to] of renames) v = renameSheetRefs(v, from, to);
        t.cells[key] = { ...t.cells[key], v };
      }
  }

  if (unsupportedFns.size) {
    const list = [...unsupportedFns].sort((a, b) => b[1] - a[1]).map(([n, k]) => `${n} (${k})`);
    warnings.push(`Unsupported functions will show #NAME?: ${list.slice(0, 10).join(', ')}${list.length > 10 ? ', …' : ''}.`);
  }
  if (badFormulas) warnings.push(`${badFormulas} formula${badFormulas === 1 ? '' : 's'} use syntax this app can't read (such as table references or links to other files) and will show #ERROR!.`);
  if (merged) warnings.push(`${merged} merged cell range${merged === 1 ? ' was' : 's were'} unmerged; the value is kept in the top-left cell.`);
  if (hidden.length) warnings.push(`Hidden sheets are shown as normal tabs: ${hidden.join(', ')}.`);
  if (renamed.length) warnings.push(`Some sheet names were changed: ${renamed.join(', ')}.`);

  // Charts ExcelJS does not read: those ours can be are put on their tabs, the others are lost on saving.
  const droppedCharts = await readXlsxCharts(zip, tabs, new Map(renames));
  if (droppedCharts) warnings.push(`${droppedCharts} chart${droppedCharts === 1 ? ' is' : 's are'} of a kind this app cannot show (such as combination, radar or stock charts) and ${droppedCharts === 1 ? 'was' : 'were'} left out.`);
  const lost = await lostParts(zip);
  if (droppedCharts) lost.unshift('Charts');
  if (merged) lost.push('Merged cells');
  if (hidden.length) lost.push('Hidden sheets');
  return { workbook: { version: 1, tabs }, warnings, lost };
}
