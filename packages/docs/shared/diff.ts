// Three-way comparison of a branch against the current original, relative to the snapshot (base)
// taken when the branch was created. Rows are aligned like a text diff so inserted/deleted rows
// don't make everything below them look changed; columns are compared by position.
import { parseCellKey } from './cellref.ts';
import { isFormula } from './formula/adjust.ts';
import { refToString, tokenize } from './formula/tokenizer.ts';
import type { CellData, Tab, Workbook } from './types.ts';

/** Who changed something relative to the base. */
export type Side = 'mine' | 'theirs' | 'conflict';

export interface CellDiff {
  side: Side;
  /** Position in the branch. */
  r: number;
  c: number;
  base?: CellData;
  branch?: CellData;
  original?: CellData;
  /** Only formatting differs (the value/formula is the same). */
  formatOnly: boolean;
}

export interface RowDiff {
  side: Side;
  kind: 'added' | 'removed';
  /** True when the row exists in the branch (added by me, or a row the original removed). */
  inBranch: boolean;
  /** Branch row of the row itself, or for rows not in the branch, the branch row it sits before. */
  at: number;
  /** Row number in the version that has the row (branch if inBranch, else original or base). */
  sourceRow: number;
  /** Non-empty cells of the row, by column, from the version that has it. */
  cells: Record<number, CellData>;
}

export type TabChange = 'added' | 'removed' | 'renamed' | null;

export interface TabDiff {
  tabId: string;
  /** Name in the branch if present, otherwise in the original/base. */
  name: string;
  names: { base?: string; branch?: string; original?: string };
  /** Tab-level change and who made it (null when the tab exists everywhere with the same name). */
  change: TabChange;
  changeSide?: Side;
  cells: CellDiff[];
  rows: RowDiff[];
}

export interface WorkbookDiff {
  tabs: TabDiff[];
  counts: Record<Side, number>;
}

// ---------------------------------------------------------------------------
// Sequence alignment (Myers diff with prefix/suffix trimming)

type Pair = [number | null, number | null];

/** Edit script of equal/delete/insert ops, or null when the edit distance exceeds maxD. */
function myers(a: string[], b: string[], maxD: number): ({ k: 'eq'; a: number; b: number } | { k: 'del'; a: number } | { k: 'ins'; b: number })[] | null {
  const n = a.length;
  const m = b.length;
  const vs: Int32Array[] = [];
  const get = (v: Int32Array, d: number, k: number) => v[k + d];
  let found = -1;
  for (let d = 0; d <= Math.min(n + m, maxD); d++) {
    const prev = vs[d - 1];
    const cur = new Int32Array(2 * d + 1);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (d === 0) x = 0;
      else if (k === -d || (k !== d && get(prev, d - 1, k - 1) < get(prev, d - 1, k + 1))) x = get(prev, d - 1, k + 1);
      else x = get(prev, d - 1, k - 1) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      cur[k + d] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    vs.push(cur);
    if (found >= 0) break;
  }
  if (found < 0) return null;

  const ops: ({ k: 'eq'; a: number; b: number } | { k: 'del'; a: number } | { k: 'ins'; b: number })[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = vs[d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && get(prev, d - 1, k - 1) < get(prev, d - 1, k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = get(prev, d - 1, prevK);
    const prevY = prevX - prevK;
    const startX = down ? prevX : prevX + 1;
    while (x > startX) {
      x--;
      y--;
      ops.push({ k: 'eq', a: x, b: y });
    }
    if (down) ops.push({ k: 'ins', b: prevY });
    else ops.push({ k: 'del', a: prevX });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ k: 'eq', a: x, b: y });
  }
  return ops.reverse();
}

/**
 * Align two sequences of row signatures. Within each run of deletions+insertions, rows are paired
 * as "modified" when counts match (positional) or by content similarity otherwise.
 */
export function alignRows(a: string[], b: string[], similarity: (i: number, j: number) => number, maxD = 2000): Pair[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);

  const out: Pair[] = [];
  for (let i = 0; i < pre; i++) out.push([i, i]);

  const ops = myers(am, bm, maxD);
  if (!ops) {
    // Too different to align meaningfully: compare by position.
    const len = Math.max(am.length, bm.length);
    for (let i = 0; i < len; i++) out.push([i < am.length ? pre + i : null, i < bm.length ? pre + i : null]);
  } else {
    let dels: number[] = [];
    let ins: number[] = [];
    const flush = () => {
      for (const p of pairHunk(dels, ins, similarity)) out.push(p);
      dels = [];
      ins = [];
    };
    for (const op of ops) {
      if (op.k === 'eq') {
        flush();
        out.push([pre + op.a, pre + op.b]);
      } else if (op.k === 'del') dels.push(pre + op.a);
      else ins.push(pre + op.b);
    }
    flush();
  }

  for (let i = 0; i < suf; i++) out.push([a.length - suf + i, b.length - suf + i]);
  return out;
}

function pairHunk(dels: number[], ins: number[], similarity: (i: number, j: number) => number): Pair[] {
  if (!dels.length) return ins.map((j) => [null, j]);
  if (!ins.length) return dels.map((i) => [i, null]);
  if (dels.length === ins.length) return dels.map((i, n) => [i, ins[n]]);
  if (dels.length * ins.length > 40_000) {
    const n = Math.min(dels.length, ins.length);
    return [...dels.slice(0, n).map((i, k): Pair => [i, ins[k]]), ...dels.slice(n).map((i): Pair => [i, null]), ...ins.slice(n).map((j): Pair => [null, j])];
  }
  // Monotone matching maximizing total similarity (only pairs with similarity > 0).
  const D = dels.length;
  const I = ins.length;
  const score: number[][] = Array.from({ length: D + 1 }, () => new Array(I + 1).fill(0));
  for (let i = D - 1; i >= 0; i--)
    for (let j = I - 1; j >= 0; j--) {
      const s = similarity(dels[i], ins[j]);
      score[i][j] = Math.max(score[i + 1][j], score[i][j + 1], s > 0 ? s + score[i + 1][j + 1] : -1);
    }
  const out: Pair[] = [];
  let i = 0;
  let j = 0;
  while (i < D && j < I) {
    const s = similarity(dels[i], ins[j]);
    if (s > 0 && score[i][j] === s + score[i + 1][j + 1]) {
      out.push([dels[i], ins[j]]);
      i++;
      j++;
    } else if (score[i][j] === score[i + 1][j]) out.push([dels[i++], null]);
    else out.push([null, ins[j++]]);
  }
  while (i < D) out.push([dels[i++], null]);
  while (j < I) out.push([null, ins[j++]]);
  return out;
}

// ---------------------------------------------------------------------------
// Per-tab row model

interface TabRows {
  tab: Tab;
  rows: Map<number, Map<number, CellData>>;
  count: number; // used rows
}

function rowsOf(tab: Tab): TabRows {
  const rows = new Map<number, Map<number, CellData>>();
  let count = 0;
  for (const key in tab.cells) {
    const cell = tab.cells[key];
    if (!cell.v && !cell.st && !cell.img) continue;
    const p = parseCellKey(key);
    if (!p) continue;
    let row = rows.get(p.r);
    if (!row) rows.set(p.r, (row = new Map()));
    row.set(p.c, cell);
    if (p.r + 1 > count) count = p.r + 1;
  }
  return { tab, rows, count };
}

/** Formula text with relative refs written as offsets, so a row moved by an insert keeps its signature. */
function relativeForm(v: string, r: number, c: number): string {
  if (!isFormula(v)) return v;
  let out = '=';
  for (const t of tokenize(v.slice(1))) {
    if (t.type !== 'ref' || !t.ref) {
      out += t.text;
      continue;
    }
    const f = t.ref;
    const rr = (row: number, abs: boolean) => (abs ? `R${row}` : `R[${row - r}]`);
    const cc = (col: number, abs: boolean) => (abs ? `C${col}` : `C[${col - c}]`);
    out += `${f.sheet ?? ''}!${f.kind}:${rr(f.r1, f.ar1)}${cc(f.c1, f.ac1)}:${rr(f.r2, f.ar2)}${cc(f.c2, f.ac2)}`;
  }
  return out;
}

function styleKey(st: CellData['st']): string {
  if (!st) return '';
  return JSON.stringify(Object.keys(st).sort().map((k) => [k, (st as Record<string, unknown>)[k]]));
}

function rowSignature(t: TabRows, r: number): string {
  const row = t.rows.get(r);
  if (!row) return '';
  return [...row.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([c, cell]) => `${c}\u0001${relativeForm(cell.v, r, c)}\u0001${styleKey(cell.st)}`)
    .join('\u0002');
}

function rowSimilarity(a: TabRows, ra: number, b: TabRows, rb: number): number {
  const x = a.rows.get(ra);
  const y = b.rows.get(rb);
  if (!x || !y) return 0;
  let same = 0;
  for (const [c, cell] of x) {
    const o = y.get(c);
    if (o && relativeForm(o.v, rb, c) === relativeForm(cell.v, ra, c)) same++;
  }
  return same;
}

/** Row mapping between base and another version of a tab. */
interface RowMap {
  toBase: (number | null)[]; // version row -> base row
  fromBase: (number | null)[]; // base row -> version row
  inserted: number[]; // version rows with no base counterpart
}

function mapRows(base: TabRows, other: TabRows): RowMap {
  const sa = Array.from({ length: base.count }, (_, r) => rowSignature(base, r));
  const sb = Array.from({ length: other.count }, (_, r) => rowSignature(other, r));
  const pairs = alignRows(sa, sb, (i, j) => rowSimilarity(base, i, other, j));
  const toBase: (number | null)[] = new Array(other.count).fill(null);
  const fromBase: (number | null)[] = new Array(base.count).fill(null);
  const inserted: number[] = [];
  for (const [i, j] of pairs) {
    if (i !== null && j !== null) {
      toBase[j] = i;
      fromBase[i] = j;
    } else if (j !== null) inserted.push(j);
  }
  return { toBase, fromBase, inserted };
}

// ---------------------------------------------------------------------------
// Formula normalization: rewrite refs into base row coordinates so edits caused purely by
// row inserts/deletes elsewhere compare equal.

interface VersionCtx {
  wb: Workbook;
  /** Row maps for each tab id (identity when absent). */
  maps: Map<string, RowMap>;
  byName: Map<string, Tab>;
}

/**
 * `ctx` maps the formula's own row numbers to base rows (empty for the base itself).
 * `deletions` gives the row maps of the version being compared, so ranges are widened over the rows
 * that version deleted at a range's edge (deleting rows there shrinks ranges as a side effect).
 */
function normalizeFormula(v: string, ownTabId: string, ctx: VersionCtx, deletions: Map<string, RowMap>): string {
  if (!isFormula(v)) return v;
  let out = '=';
  for (const t of tokenize(v.slice(1))) {
    if (t.type !== 'ref' || !t.ref) {
      out += t.text;
      continue;
    }
    const ref = { ...t.ref };
    const target = ref.sheet !== undefined ? ctx.byName.get(ref.sheet.toLowerCase()) : undefined;
    const tabId = ref.sheet !== undefined ? (target?.id ?? `?${ref.sheet.toLowerCase()}`) : ownTabId;
    if (ref.kind !== 'cols') {
      const map = ctx.maps.get(tabId);
      const conv = (row: number) =>
        !map ? row : row < map.toBase.length ? (map.toBase[row] ?? -1) : row - map.toBase.length + map.fromBase.length;
      let r1 = conv(Math.min(ref.r1, ref.r2));
      let r2 = conv(Math.max(ref.r1, ref.r2));
      const del = deletions.get(tabId);
      if (del && ref.kind !== 'cell' && r1 >= 0 && r2 >= 0) {
        while (r1 > 0 && r1 - 1 < del.fromBase.length && del.fromBase[r1 - 1] === null) r1--;
        while (r2 + 1 < del.fromBase.length && del.fromBase[r2 + 1] === null) r2++;
      }
      ref.r1 = r1;
      ref.r2 = r2;
    }
    // Refer to sheets by id so renames don't register as formula edits.
    const sheet = ref.sheet !== undefined ? `{${tabId}}` : '';
    ref.sheet = undefined;
    out += sheet + (ref.r1 < 0 || ref.r2 < 0 ? '#ROW' : refToString(ref));
  }
  return out;
}

function cellEq(a: CellData | undefined, b: CellData | undefined, na: (v: string) => string, nb: (v: string) => string): { value: boolean; style: boolean } {
  const va = a?.v ?? '';
  const vb = b?.v ?? '';
  return { value: na(va) === nb(vb), style: styleKey(a?.st) === styleKey(b?.st) };
}

// ---------------------------------------------------------------------------

/**
 * Compare `branch` and `original` against their common `base`.
 * For a branch whose original is gone, pass `original = base` (everything shows as "mine").
 */
export function diffWorkbooks(base: Workbook, branch: Workbook, original: Workbook): WorkbookDiff {
  const byId = (wb: Workbook) => new Map(wb.tabs.map((t) => [t.id, t]));
  const baseTabs = byId(base);
  const branchTabs = byId(branch);
  const origTabs = byId(original);
  const ctx = (wb: Workbook): VersionCtx => ({ wb, maps: new Map(), byName: new Map(wb.tabs.map((t) => [t.name.toLowerCase(), t])) });
  const baseCtx = ctx(base);
  const branchCtx = ctx(branch);
  const origCtx = ctx(original);

  // Row models and maps for tabs present in base and the other version.
  const rowModels = new Map<string, { base: TabRows; branch?: TabRows; original?: TabRows }>();
  for (const [id, bt] of baseTabs) {
    const m: { base: TabRows; branch?: TabRows; original?: TabRows } = { base: rowsOf(bt) };
    const br = branchTabs.get(id);
    const or = origTabs.get(id);
    if (br) {
      m.branch = rowsOf(br);
      branchCtx.maps.set(id, mapRows(m.base, m.branch));
    }
    if (or) {
      m.original = or === bt ? m.base : rowsOf(or);
      origCtx.maps.set(id, mapRows(m.base, m.original));
    }
    rowModels.set(id, m);
  }

  const norm = (c: VersionCtx, tabId: string, deletions: Map<string, RowMap>) => (v: string) => normalizeFormula(v, tabId, c, deletions);
  const counts: Record<Side, number> = { mine: 0, theirs: 0, conflict: 0 };
  const tabs: TabDiff[] = [];

  // Order: branch tab order, then tabs only in the original/base.
  const order = [...branch.tabs.map((t) => t.id), ...original.tabs.map((t) => t.id), ...base.tabs.map((t) => t.id)].filter((id, i, a) => a.indexOf(id) === i);

  for (const tabId of order) {
    const bt = baseTabs.get(tabId);
    const brt = branchTabs.get(tabId);
    const ort = origTabs.get(tabId);
    const names = { base: bt?.name, branch: brt?.name, original: ort?.name };
    const td: TabDiff = { tabId, name: brt?.name ?? ort?.name ?? bt!.name, names, change: null, cells: [], rows: [] };

    if (!bt) {
      // Added after the branch was made.
      td.change = 'added';
      td.changeSide = brt && ort ? 'conflict' : brt ? 'mine' : 'theirs';
      counts[td.changeSide]++;
      tabs.push(td);
      continue;
    }

    const m = rowModels.get(tabId)!;
    const bMap = branchCtx.maps.get(tabId);
    const oMap = origCtx.maps.get(tabId);
    // Base formulas are normalized against whichever version they are compared with.
    const nBaseVsBranch = norm(baseCtx, tabId, branchCtx.maps);
    const nBaseVsOrig = norm(baseCtx, tabId, origCtx.maps);
    const nBranch = norm(branchCtx, tabId, branchCtx.maps);
    const nOrig = norm(origCtx, tabId, origCtx.maps);

    const rowChanged = (other: TabRows, otherRow: number, n: (v: string) => string, baseRow: number) => {
      const nBase = other === m.branch ? nBaseVsBranch : nBaseVsOrig;
      const cols = new Set([...(m.base.rows.get(baseRow)?.keys() ?? []), ...(other.rows.get(otherRow)?.keys() ?? [])]);
      for (const c of cols) {
        const e = cellEq(m.base.rows.get(baseRow)?.get(c), other.rows.get(otherRow)?.get(c), nBase, n);
        if (!e.value || !e.style) return true;
      }
      return false;
    };

    if (!brt || !ort) {
      // Removed on one or both sides.
      if (!brt && !ort) continue;
      td.change = 'removed';
      const survivor = brt ? m.branch! : m.original!;
      const survivorMap = brt ? bMap! : oMap!;
      const n = brt ? nBranch : nOrig;
      // Removing a tab the other side edited is a conflict.
      let edited = false;
      for (let r = 0; r < m.base.count && !edited; r++) {
        const vr = survivorMap.fromBase[r];
        if (vr === null || rowChanged(survivor, vr, n, r)) edited = true;
      }
      if (survivorMap.inserted.length) edited = true;
      td.changeSide = edited ? 'conflict' : brt ? 'theirs' : 'mine';
      counts[td.changeSide]++;
      tabs.push(td);
      continue;
    }

    // Renames
    if (brt.name !== bt.name || ort.name !== bt.name) {
      const mine = brt.name !== bt.name;
      const theirs = ort.name !== bt.name;
      if (!(mine && theirs && brt.name === ort.name)) {
        td.change = 'renamed';
        td.changeSide = mine && theirs ? 'conflict' : mine ? 'mine' : 'theirs';
        counts[td.changeSide]++;
      }
    }

    const br = m.branch!;
    const or = m.original!;
    const anchorInBranch = (baseRow: number) => {
      // Branch row of the first surviving base row at or after baseRow (or the end).
      for (let r = baseRow; r < m.base.count; r++) {
        const x = bMap!.fromBase[r];
        if (x !== null) return x;
      }
      return br.count;
    };
    const cellsOf = (t: TabRows, r: number): Record<number, CellData> => Object.fromEntries(t.rows.get(r) ?? []);

    // Base rows: modified, or removed on one/both sides.
    for (let r = 0; r < m.base.count; r++) {
      const bR = bMap!.fromBase[r];
      const oR = oMap!.fromBase[r];
      if (bR === null && oR === null) continue; // both removed it
      if (bR === null || oR === null) {
        const otherEdited = bR === null ? rowChanged(or, oR!, nOrig, r) : rowChanged(br, bR, nBranch, r);
        const side: Side = otherEdited ? 'conflict' : bR === null ? 'mine' : 'theirs';
        if (!m.base.rows.has(r) && !otherEdited) continue; // an empty row was removed: not interesting
        td.rows.push({
          side,
          kind: 'removed',
          inBranch: bR !== null,
          at: bR ?? anchorInBranch(r),
          sourceRow: bR ?? r,
          cells: bR !== null ? cellsOf(br, bR) : cellsOf(m.base, r),
        });
        counts[side]++;
        continue;
      }
      const cols = new Set([...(m.base.rows.get(r)?.keys() ?? []), ...(br.rows.get(bR)?.keys() ?? []), ...(or.rows.get(oR)?.keys() ?? [])]);
      for (const c of [...cols].sort((a, b) => a - b)) {
        const bc = m.base.rows.get(r)?.get(c);
        const brc = br.rows.get(bR)?.get(c);
        const orc = or.rows.get(oR)?.get(c);
        const mine = cellEq(bc, brc, nBaseVsBranch, nBranch);
        const theirs = cellEq(bc, orc, nBaseVsOrig, nOrig);
        const mineChanged = !mine.value || !mine.style;
        const theirsChanged = !theirs.value || !theirs.style;
        if (!mineChanged && !theirsChanged) continue;
        let side: Side;
        let formatOnly: boolean;
        if (mineChanged && theirsChanged) {
          const same = cellEq(brc, orc, nBranch, nOrig);
          if (same.value && same.style) continue; // both made the same change
          side = 'conflict';
          formatOnly = mine.value && theirs.value;
        } else {
          side = mineChanged ? 'mine' : 'theirs';
          formatOnly = mineChanged ? mine.value : theirs.value;
        }
        td.cells.push({ side, r: bR, c, base: bc, branch: brc, original: orc, formatOnly });
        counts[side]++;
      }
    }

    // Rows inserted in the branch.
    for (const r of bMap!.inserted) {
      if (!br.rows.has(r)) continue;
      td.rows.push({ side: 'mine', kind: 'added', inBranch: true, at: r, sourceRow: r, cells: cellsOf(br, r) });
      counts.mine++;
    }
    // Rows inserted in the original: anchor before the branch row matching the next aligned base row.
    for (const r of oMap!.inserted) {
      if (!or.rows.has(r)) continue;
      let next: number | null = null;
      for (let x = r + 1; x < oMap!.toBase.length; x++) {
        if (oMap!.toBase[x] !== null) {
          next = oMap!.toBase[x];
          break;
        }
      }
      td.rows.push({ side: 'theirs', kind: 'added', inBranch: false, at: next === null ? br.count : anchorInBranch(next), sourceRow: r, cells: cellsOf(or, r) });
      counts.theirs++;
    }

    td.rows.sort((a, b) => a.at - b.at || Number(b.inBranch) - Number(a.inBranch));
    if (td.change || td.cells.length || td.rows.length) tabs.push(td);
  }

  return { tabs, counts };
}
