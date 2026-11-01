// A1-notation helpers. Rows and columns are zero-based internally.

export interface CellPos {
  r: number;
  c: number;
}

/** Inclusive, normalized (r1 <= r2, c1 <= c2) rectangular range. */
export interface Range {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export const MAX_COLS = 18278; // "ZZZ"
export const MAX_ROWS = 1_000_000;

const colNameCache: string[] = [];

export function colToName(c: number): string {
  if (c < 1024 && colNameCache[c] !== undefined) return colNameCache[c];
  let s = '';
  let n = c + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  if (c < 1024) colNameCache[c] = s;
  return s;
}

export function nameToCol(name: string): number {
  let c = 0;
  for (let i = 0; i < name.length; i++) {
    c = c * 26 + (name.toUpperCase().charCodeAt(i) - 64);
  }
  return c - 1;
}

export function cellKey(r: number, c: number): string {
  return colToName(c) + (r + 1);
}

const KEY_RE = /^([A-Z]{1,3})(\d+)$/;

export function parseCellKey(key: string): CellPos | null {
  const m = KEY_RE.exec(key);
  if (!m) return null;
  return { r: parseInt(m[2], 10) - 1, c: nameToCol(m[1]) };
}

export function normRange(r1: number, c1: number, r2: number, c2: number): Range {
  return {
    r1: Math.min(r1, r2),
    c1: Math.min(c1, c2),
    r2: Math.max(r1, r2),
    c2: Math.max(c1, c2),
  };
}

export function rangeFromPoints(a: CellPos, b: CellPos): Range {
  return normRange(a.r, a.c, b.r, b.c);
}

export function rangeContains(rg: Range, r: number, c: number): boolean {
  return r >= rg.r1 && r <= rg.r2 && c >= rg.c1 && c <= rg.c2;
}

export function rangesIntersect(a: Range, b: Range): boolean {
  return a.r1 <= b.r2 && b.r1 <= a.r2 && a.c1 <= b.c2 && b.c1 <= a.c2;
}

export function rangeSize(rg: Range): { rows: number; cols: number } {
  return { rows: rg.r2 - rg.r1 + 1, cols: rg.c2 - rg.c1 + 1 };
}

export function rangeToString(rg: Range): string {
  const a = cellKey(rg.r1, rg.c1);
  if (rg.r1 === rg.r2 && rg.c1 === rg.c2) return a;
  return `${a}:${cellKey(rg.r2, rg.c2)}`;
}

/** Parse "B3", "A1:C9", "C:E" or "4:8" (used by the name box). Whole rows/cols are clamped to the given size. */
export function parseRangeString(s: string, rows: number, cols: number): Range | null {
  const t = s.trim().toUpperCase().replace(/\$/g, '');
  let m = /^([A-Z]{1,3})(\d+)(?::([A-Z]{1,3})(\d+))?$/.exec(t);
  if (m) {
    const r1 = parseInt(m[2], 10) - 1;
    const c1 = nameToCol(m[1]);
    const r2 = m[4] ? parseInt(m[4], 10) - 1 : r1;
    const c2 = m[3] ? nameToCol(m[3]) : c1;
    if (r1 < 0 || r2 < 0) return null;
    return normRange(r1, c1, r2, c2);
  }
  m = /^([A-Z]{1,3}):([A-Z]{1,3})$/.exec(t);
  if (m) return normRange(0, nameToCol(m[1]), rows - 1, nameToCol(m[2]));
  m = /^(\d+):(\d+)$/.exec(t);
  if (m) {
    const r1 = parseInt(m[1], 10) - 1;
    const r2 = parseInt(m[2], 10) - 1;
    if (r1 < 0 || r2 < 0) return null;
    return normRange(r1, 0, r2, cols - 1);
  }
  return null;
}
