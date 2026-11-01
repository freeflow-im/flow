// Rewriting references inside formula text (copy/fill, row/column insert & delete, sheet rename).
import { MAX_COLS, MAX_ROWS } from '../cellref.ts';
import { refToString, tokenize, type RefInfo } from './tokenizer.ts';

export function isFormula(raw: string | undefined): boolean {
  return !!raw && raw.length > 1 && raw[0] === '=';
}

/**
 * Rewrite every reference in a formula. `fn` receives the ref and the name of the sheet it points at
 * (its explicit sheet or `ownSheet`); returning null replaces the reference with #REF!.
 */
export function transformRefs(
  raw: string,
  ownSheet: string,
  fn: (ref: RefInfo, targetSheet: string) => RefInfo | null,
): string {
  if (!isFormula(raw)) return raw;
  const body = raw.slice(1);
  const toks = tokenize(body);
  let out = '=';
  let changed = false;
  for (const t of toks) {
    if (t.type === 'ref' && t.ref) {
      const next = fn({ ...t.ref }, t.ref.sheet ?? ownSheet);
      if (next === null) {
        out += '#REF!';
        changed = true;
      } else {
        const s = refToString(next);
        if (s !== t.text) changed = true;
        out += s;
      }
    } else {
      out += t.text;
    }
  }
  return changed ? out : raw;
}

/** Shift relative references by (dr, dc) as when copying a formula. Out-of-bounds refs become #REF!. */
export function shiftFormula(raw: string, dr: number, dc: number): string {
  if (!isFormula(raw) || (dr === 0 && dc === 0)) return raw;
  return transformRefs(raw, '', (ref) => {
    if (ref.kind !== 'cols') {
      if (!ref.ar1) ref.r1 += dr;
      if (!ref.ar2) ref.r2 += dr;
    }
    if (ref.kind !== 'rows') {
      if (!ref.ac1) ref.c1 += dc;
      if (!ref.ac2) ref.c2 += dc;
    }
    if (ref.kind === 'cell') {
      ref.r2 = ref.r1;
      ref.c2 = ref.c1;
    }
    const rowsOk = ref.kind === 'cols' || (ref.r1 >= 0 && ref.r2 >= 0 && ref.r1 < MAX_ROWS && ref.r2 < MAX_ROWS);
    const colsOk = ref.kind === 'rows' || (ref.c1 >= 0 && ref.c2 >= 0 && ref.c1 < MAX_COLS && ref.c2 < MAX_COLS);
    return rowsOk && colsOk ? ref : null;
  });
}

export type Axis = 'row' | 'col';

function axisKeys(axis: Axis) {
  return axis === 'row'
    ? ({ a: 'r1', b: 'r2', whole: 'cols' } as const)
    : ({ a: 'c1', b: 'c2', whole: 'rows' } as const);
}

/** Adjust refs pointing at `sheet` for `count` rows/cols inserted before index `at`. */
export function adjustForInsert(raw: string, ownSheet: string, sheet: string, axis: Axis, at: number, count: number): string {
  const k = axisKeys(axis);
  const target = sheet.toLowerCase();
  return transformRefs(raw, ownSheet, (ref, s) => {
    if (s.toLowerCase() !== target || ref.kind === k.whole) return ref;
    if (ref[k.a] >= at) ref[k.a] += count;
    if (ref[k.b] >= at) ref[k.b] += count;
    return ref;
  });
}

/** Adjust refs pointing at `sheet` for rows/cols [from, to] (inclusive) being deleted. */
export function adjustForDelete(raw: string, ownSheet: string, sheet: string, axis: Axis, from: number, to: number): string {
  const k = axisKeys(axis);
  const target = sheet.toLowerCase();
  const n = to - from + 1;
  return transformRefs(raw, ownSheet, (ref, s) => {
    if (s.toLowerCase() !== target || ref.kind === k.whole) return ref;
    const a = ref[k.a];
    const b = ref[k.b];
    if (ref.kind === 'cell') {
      if (a >= from && a <= to) return null;
      if (a > to) {
        ref[k.a] -= n;
        ref[k.b] -= n;
      }
      return ref;
    }
    let na = a;
    let nb = b;
    if (a > to) na = a - n;
    else if (a >= from) na = from;
    if (b > to) nb = b - n;
    else if (b >= from) nb = from - 1;
    if (nb < na) return null;
    ref[k.a] = na;
    ref[k.b] = nb;
    return ref;
  });
}

/**
 * A move of rows/cols [from, to] (inclusive) to just before index `before` (indexes before the move;
 * `before` outside [from, to + 1]). The lines in between shift over by the size of the block.
 */
export interface LineMove {
  from: number;
  to: number;
  before: number;
}

/** New index of every line after a move. */
export function moveIndexMap({ from, to, before }: LineMove): (i: number) => number {
  const n = to - from + 1;
  const start = before < from ? before : before - n;
  return (i) => (i >= from && i <= to ? i - from + start : before < from && i >= before && i < from ? i + n : before > to && i > to && i < before ? i - n : i);
}

/**
 * New span of the lines [a, b] after a move. If the lines are still next to each other the span covers them all.
 * Otherwise the moved lines left the span (like a delete), or landed inside it (like an insert, which widens it).
 */
export function moveSpan(a: number, b: number, mv: LineMove): [number, number] {
  const map = moveIndexMap(mv);
  let lo = Infinity;
  let hi = -Infinity;
  let sLo = Infinity;
  let sHi = -Infinity;
  // The map is increasing on each piece (the block, the shifted lines, the rest), so the extremes are at the
  // ends of [a, b] or next to piece boundaries.
  const cands = new Set([a, b]);
  for (const x of [mv.from, mv.to, mv.before]) for (const d of [-1, 0, 1]) if (x + d >= a && x + d <= b) cands.add(x + d);
  for (const i of cands) {
    const m = map(i);
    lo = Math.min(lo, m);
    hi = Math.max(hi, m);
    if (i < mv.from || i > mv.to) (sLo = Math.min(sLo, m)), (sHi = Math.max(sHi, m));
  }
  const overlaps = a <= mv.to && b >= mv.from;
  if (!overlaps || hi - lo === b - a || sLo === Infinity) return [lo, hi];
  return [sLo, sHi];
}

/** Adjust refs pointing at `sheet` for a move of rows/cols (see moveSpan for how ranges are adjusted). */
export function adjustForMove(raw: string, ownSheet: string, sheet: string, axis: Axis, mv: LineMove): string {
  const k = axisKeys(axis);
  const target = sheet.toLowerCase();
  const map = moveIndexMap(mv);
  return transformRefs(raw, ownSheet, (ref, s) => {
    if (s.toLowerCase() !== target || ref.kind === k.whole) return ref;
    const [na, nb] = ref.kind === 'cell' ? [map(ref[k.a]), map(ref[k.a])] : moveSpan(ref[k.a], ref[k.b], mv);
    ref[k.a] = na;
    ref[k.b] = nb;
    return ref;
  });
}

/** Rename sheet references (case-insensitive match on the old name). */
export function renameSheetRefs(raw: string, oldName: string, newName: string): string {
  const target = oldName.toLowerCase();
  return transformRefs(raw, '', (ref) => {
    if (ref.sheet !== undefined && ref.sheet.toLowerCase() === target) ref.sheet = newName;
    return ref;
  });
}
