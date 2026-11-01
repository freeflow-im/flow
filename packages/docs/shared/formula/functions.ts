import type { NumberFormat } from '../types.ts';
import {
  CellError,
  compareScalars,
  dateToSerial,
  nowSerial,
  parseDateString,
  scalarToText,
  serialToDate,
  todaySerial,
  toNumber,
  type Scalar,
} from '../values.ts';
import { isRange, type EvalContext, type RangeVal, type Value } from './types.ts';
import type { Node } from './parser.ts';

export type Fn = (args: Node[], ctx: EvalContext) => Value;

export const VOLATILE = new Set(['NOW', 'TODAY', 'RAND', 'RANDBETWEEN']);

const DATE_RESULT: Record<string, NumberFormat> = {
  TODAY: 'date',
  DATE: 'date',
  EDATE: 'date',
  EOMONTH: 'date',
  DATEVALUE: 'date',
  NOW: 'datetime',
  TIME: 'time',
};

export function impliedFormatOfCall(name: string): NumberFormat | undefined {
  return DATE_RESULT[name];
}

// ---------------------------------------------------------------------------
// Helpers

const err = (code: CellError['code'], msg = '') => new CellError(code, msg);
const isErr = (v: unknown): v is CellError => v instanceof CellError;

function argCount(args: Node[], min: number, max: number, name: string): CellError | null {
  if (args.length < min || args.length > max) {
    const exp = min === max ? `${min}` : max === Infinity ? `at least ${min}` : `between ${min} and ${max}`;
    return err('#N/A', `Wrong number of arguments to ${name}. Expected ${exp} arguments, but got ${args.length}.`);
  }
  return null;
}

function scalarArg(ctx: EvalContext, n: Node | undefined): Scalar {
  if (!n) return null;
  return ctx.engine.toScalar(ctx.eval(n));
}

function numArg(ctx: EvalContext, n: Node | undefined, dflt?: number): number | CellError {
  if (!n || n.t === 'empty') {
    if (dflt !== undefined) return dflt;
    return 0;
  }
  return toNumber(scalarArg(ctx, n));
}

function strArg(ctx: EvalContext, n: Node | undefined): string | CellError {
  const v = scalarArg(ctx, n);
  return isErr(v) ? v : scalarToText(v);
}

function toBool(v: Scalar): boolean | CellError {
  if (v === null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (isErr(v)) return v;
  const u = v.trim().toUpperCase();
  if (u === 'TRUE') return true;
  if (u === 'FALSE') return false;
  return err('#VALUE!', `Cannot convert "${v}" to a boolean`);
}

function boolArg(ctx: EvalContext, n: Node | undefined, dflt: boolean): boolean | CellError {
  if (!n || n.t === 'empty') return dflt;
  return toBool(scalarArg(ctx, n));
}

function rangeArg(ctx: EvalContext, n: Node | undefined): RangeVal | CellError {
  if (!n) return err('#N/A', 'Missing range argument');
  const v = ctx.eval(n);
  if (isRange(v)) return v;
  if (isErr(v)) return v;
  return err('#VALUE!', 'Expected a range');
}

function rangeDims(r: RangeVal) {
  return { rows: r.r2 - r.r1 + 1, cols: r.c2 - r.c1 + 1 };
}

function cellAt(ctx: EvalContext, r: RangeVal, i: number, j: number): Scalar {
  return ctx.engine.getValue(r.tabId, r.r1 + i, r.c1 + j);
}

/** Iterate every value supplied by the arguments; `direct` is false for values that came from ranges. */
function eachValue(ctx: EvalContext, args: Node[], cb: (v: Scalar, direct: boolean) => boolean | void): void {
  for (const a of args) {
    const v = ctx.eval(a);
    if (isRange(v)) {
      for (let r = v.r1; r <= v.r2; r++) {
        for (let c = v.c1; c <= v.c2; c++) {
          if (cb(ctx.engine.getValue(v.tabId, r, c), false) === false) return;
        }
      }
    } else if (a.t !== 'empty') {
      if (cb(v, true) === false) return;
    }
  }
}

/** Numbers for aggregate functions: ranges contribute only numbers; direct args are coerced. */
function collectNumbers(ctx: EvalContext, args: Node[]): number[] | CellError {
  const out: number[] = [];
  let e: CellError | null = null;
  eachValue(ctx, args, (v, direct) => {
    if (isErr(v)) {
      e = v;
      return false;
    }
    if (typeof v === 'number') out.push(v);
    else if (direct) {
      if (v === null) return;
      const n = toNumber(v);
      if (isErr(n)) {
        e = n;
        return false;
      }
      out.push(n);
    }
  });
  return e ?? out;
}

function flatten(ctx: EvalContext, args: Node[]): Scalar[] {
  const out: Scalar[] = [];
  eachValue(ctx, args, (v) => {
    out.push(v);
  });
  return out;
}

function roundTo(x: number, digits: number, mode: 'round' | 'up' | 'down'): number {
  const f = Math.pow(10, digits);
  const scaled = Number((Math.abs(x) * f).toPrecision(15));
  const r = mode === 'round' ? Math.round(scaled) : mode === 'up' ? Math.ceil(scaled) : Math.floor(scaled);
  return (Math.sign(x) * r) / f;
}

// Wildcard pattern (* ? ~) to RegExp.
function wildcardRegex(pat: string): RegExp {
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i];
    if (ch === '~' && i + 1 < pat.length) {
      re += pat[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'is');
}

/** Build a predicate from a SUMIF/COUNTIF-style criterion (">5", "<>x", "a*", 3, TRUE). */
export function makeCriterion(crit: Scalar): (v: Scalar) => boolean {
  if (typeof crit === 'number') return (v) => typeof v === 'number' && v === crit;
  if (typeof crit === 'boolean') return (v) => v === crit;
  if (crit === null) return (v) => v === null || v === '';
  if (isErr(crit)) return (v) => isErr(v) && v.code === crit.code;
  const m = /^(<=|>=|<>|<|>|=)?(.*)$/s.exec(crit)!;
  const op = m[1] ?? '=';
  const rhs = m[2];
  if (rhs === '') {
    if (op === '=') return (v) => v === null || v === '';
    if (op === '<>') return (v) => v !== null && v !== '';
  }
  const numLit = toNumber(rhs);
  const isNum = !isErr(numLit) && rhs.trim() !== '';
  const upper = rhs.toUpperCase();
  const boolLit = upper === 'TRUE' ? true : upper === 'FALSE' ? false : null;
  if (op === '=' || op === '<>') {
    let eq: (v: Scalar) => boolean;
    if (isNum) eq = (v) => typeof v === 'number' && v === numLit;
    else if (boolLit !== null) eq = (v) => v === boolLit;
    else if (/[*?~]/.test(rhs)) {
      const re = wildcardRegex(rhs);
      eq = (v) => typeof v === 'string' && re.test(v);
    } else {
      const low = rhs.toLowerCase();
      eq = (v) => typeof v === 'string' && v.toLowerCase() === low;
    }
    return op === '=' ? eq : (v) => !eq(v);
  }
  const cmp = (v: Scalar): number | null => {
    if (isNum) return typeof v === 'number' ? v - (numLit as number) : null;
    if (typeof v !== 'string') return null;
    return compareScalars(v, rhs);
  };
  return (v) => {
    const c = cmp(v);
    if (c === null) return false;
    switch (op) {
      case '<':
        return c < 0;
      case '>':
        return c > 0;
      case '<=':
        return c <= 0;
      default:
        return c >= 0;
    }
  };
}

/**
 * Shared implementation of *IFS functions: pairs of (range, criterion) select positions in `target` range.
 * Calls cb with each matching target value.
 */
function eachMatching(
  ctx: EvalContext,
  target: RangeVal,
  pairs: [Node, Node][],
  cb: (v: Scalar) => void,
): CellError | null {
  const { rows, cols } = rangeDims(target);
  const conds: { rg: RangeVal; pred: (v: Scalar) => boolean }[] = [];
  for (const [rn, cn] of pairs) {
    const rg = rangeArg(ctx, rn);
    if (isErr(rg)) return rg;
    const d = rangeDims(rg);
    if (d.rows !== rows || d.cols !== cols) return err('#VALUE!', 'Array arguments are of different size');
    const c = scalarArg(ctx, cn);
    conds.push({ rg, pred: makeCriterion(c) });
  }
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      if (conds.every(({ rg, pred }) => pred(cellAt(ctx, rg, i, j)))) cb(cellAt(ctx, target, i, j));
    }
  }
  return null;
}

function pairsFrom(args: Node[], start: number): [Node, Node][] {
  const out: [Node, Node][] = [];
  for (let i = start; i + 1 < args.length; i += 2) out.push([args[i], args[i + 1]]);
  return out;
}

// Simple numeric-arg function builder.
function math1(name: string, f: (x: number) => number | CellError): Fn {
  return (args, ctx) => {
    const e = argCount(args, 1, 1, name);
    if (e) return e;
    const x = numArg(ctx, args[0]);
    if (isErr(x)) return x;
    const r = f(x);
    if (typeof r === 'number' && !Number.isFinite(r)) return err('#NUM!');
    return r;
  };
}

function stats(ctx: EvalContext, args: Node[]): { nums: number[]; mean: number } | CellError {
  const nums = collectNumbers(ctx, args);
  if (isErr(nums)) return nums;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  return { nums, mean };
}

function variance(ctx: EvalContext, args: Node[], sample: boolean): number | CellError {
  const s = stats(ctx, args);
  if (isErr(s)) return s;
  const n = s.nums.length;
  if (n < (sample ? 2 : 1)) return err('#DIV/0!', 'Not enough values');
  const ss = s.nums.reduce((a, x) => a + (x - s.mean) ** 2, 0);
  return ss / (sample ? n - 1 : n);
}

function lookupEqual(a: Scalar, b: Scalar): boolean {
  if (typeof a === 'string' && typeof b === 'string') {
    if (/[*?~]/.test(a)) return wildcardRegex(a).test(b);
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

/** Position of key in a 1-D list; mode 0 exact, 1 largest <= key (sorted asc), -1 smallest >= key (sorted desc). */
function findIndex(key: Scalar, values: Scalar[], mode: number): number {
  if (mode === 0) return values.findIndex((v) => lookupEqual(key, v));
  let best = -1;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null) continue;
    if (typeof v !== typeof key) continue;
    const c = compareScalars(v, key);
    if (mode > 0) {
      if (c <= 0) best = i;
      else break;
    } else {
      if (c >= 0) best = i;
      else break;
    }
  }
  return best;
}

function vectorOf(ctx: EvalContext, rg: RangeVal): Scalar[] {
  const { rows, cols } = rangeDims(rg);
  const out: Scalar[] = [];
  if (rows === 1) for (let j = 0; j < cols; j++) out.push(cellAt(ctx, rg, 0, j));
  else for (let i = 0; i < rows; i++) out.push(cellAt(ctx, rg, i, 0));
  return out;
}

function dateParts(serial: number) {
  const d = serialToDate(serial);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

function dateArg(ctx: EvalContext, n: Node | undefined): number | CellError {
  const v = scalarArg(ctx, n);
  if (typeof v === 'string') {
    const p = parseDateString(v.trim());
    if (p && typeof p.value === 'number') return p.value;
  }
  return toNumber(v);
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function textFormat(v: Scalar, fmt: string): string {
  if (typeof v !== 'number') return scalarToText(v);
  const f = fmt.trim();
  if (/[yd]|m{3,}|h|s/i.test(f) && !/^[#0.,$%]+$/.test(f)) {
    const d = serialToDate(v);
    const Y = d.getUTCFullYear();
    const M = d.getUTCMonth() + 1;
    const D = d.getUTCDate();
    const h = d.getUTCHours();
    const mi = d.getUTCMinutes();
    const s = d.getUTCSeconds();
    const ampm = /am\/pm/i.test(f);
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const p2 = (n: number) => String(n).padStart(2, '0');
    const hh = ampm ? (h % 12 === 0 ? 12 : h % 12) : h;
    let lastWasHour = false;
    return f.replace(/yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|am\/pm/gi, (tok) => {
      const t = tok.toLowerCase();
      let out: string;
      switch (t) {
        case 'yyyy': out = String(Y); break;
        case 'yy': out = p2(Y % 100); break;
        case 'mmmm': out = months[M - 1]; break;
        case 'mmm': out = months[M - 1].slice(0, 3); break;
        case 'mm': out = lastWasHour ? p2(mi) : p2(M); break;
        case 'm': out = lastWasHour ? String(mi) : String(M); break;
        case 'dddd': out = days[d.getUTCDay()]; break;
        case 'ddd': out = days[d.getUTCDay()].slice(0, 3); break;
        case 'dd': out = p2(D); break;
        case 'd': out = String(D); break;
        case 'hh': out = p2(hh); break;
        case 'h': out = String(hh); break;
        case 'ss': out = p2(s); break;
        case 's': out = String(s); break;
        default: out = h < 12 ? 'AM' : 'PM';
      }
      lastWasHour = t === 'hh' || t === 'h';
      return out;
    });
  }
  const pct = f.includes('%');
  const n = pct ? v * 100 : v;
  const dot = f.indexOf('.');
  const decimalsPart = dot >= 0 ? f.slice(dot + 1).replace(/[^0#]/g, '') : '';
  const minDp = (decimalsPart.match(/0/g) ?? []).length;
  const maxDp = decimalsPart.length;
  const grouping = f.includes(',');
  let s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: minDp, maximumFractionDigits: maxDp, useGrouping: grouping });
  const intZeros = (f.slice(0, dot >= 0 ? dot : undefined).match(/0/g) ?? []).length;
  const [ip, fp] = s.split('.');
  if (ip.replace(/,/g, '').length < intZeros) s = ip.padStart(intZeros, '0') + (fp !== undefined ? '.' + fp : '');
  const prefix = f.match(/^[^#0.,]*/)?.[0].replace(/%/g, '') ?? '';
  return (n < 0 ? '-' : '') + prefix + s + (pct ? '%' : '');
}

// ---------------------------------------------------------------------------
// Function table

const F: Record<string, Fn> = {};

// --- Aggregates -------------------------------------------------------------
F.SUM = (args, ctx) => {
  const nums = collectNumbers(ctx, args);
  return isErr(nums) ? nums : nums.reduce((a, b) => a + b, 0);
};
F.AVERAGE = (args, ctx) => {
  const nums = collectNumbers(ctx, args);
  if (isErr(nums)) return nums;
  if (!nums.length) return err('#DIV/0!', 'AVERAGE has no numeric values');
  return nums.reduce((a, b) => a + b, 0) / nums.length;
};
F.MIN = (args, ctx) => {
  const nums = collectNumbers(ctx, args);
  if (isErr(nums)) return nums;
  return nums.length ? nums.reduce((a, b) => (b < a ? b : a)) : 0;
};
F.MAX = (args, ctx) => {
  const nums = collectNumbers(ctx, args);
  if (isErr(nums)) return nums;
  return nums.length ? nums.reduce((a, b) => (b > a ? b : a)) : 0;
};
F.PRODUCT = (args, ctx) => {
  const nums = collectNumbers(ctx, args);
  if (isErr(nums)) return nums;
  return nums.length ? nums.reduce((a, b) => a * b, 1) : 0;
};
F.SUMSQ = (args, ctx) => {
  const nums = collectNumbers(ctx, args);
  return isErr(nums) ? nums : nums.reduce((a, b) => a + b * b, 0);
};
F.COUNT = (args, ctx) => {
  let n = 0;
  eachValue(ctx, args, (v, direct) => {
    if (typeof v === 'number') n++;
    else if (direct && (typeof v === 'boolean' || (typeof v === 'string' && !isErr(toNumber(v)) && v.trim() !== ''))) n++;
  });
  return n;
};
F.COUNTA = (args, ctx) => {
  let n = 0;
  eachValue(ctx, args, (v) => {
    if (v !== null && v !== '') n++;
  });
  return n;
};
F.COUNTBLANK = (args, ctx) => {
  let n = 0;
  eachValue(ctx, args, (v) => {
    if (v === null || v === '') n++;
  });
  return n;
};
F.COUNTUNIQUE = (args, ctx) => {
  const seen = new Set<string>();
  eachValue(ctx, args, (v) => {
    if (v === null || v === '') return;
    seen.add(typeof v + ':' + (typeof v === 'string' ? v.toLowerCase() : scalarToText(v)));
  });
  return seen.size;
};
F.MEDIAN = (args, ctx) => {
  const nums = collectNumbers(ctx, args);
  if (isErr(nums)) return nums;
  if (!nums.length) return err('#NUM!', 'MEDIAN has no numeric values');
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
F.MODE = (args, ctx) => {
  const nums = collectNumbers(ctx, args);
  if (isErr(nums)) return nums;
  const counts = new Map<number, number>();
  let best: number | null = null;
  let bestN = 1;
  for (const x of nums) {
    const c = (counts.get(x) ?? 0) + 1;
    counts.set(x, c);
    if (c > bestN) {
      bestN = c;
      best = x;
    }
  }
  return best ?? err('#N/A', 'No repeated values');
};
F['MODE.SNGL'] = F.MODE;
F.VAR = (args, ctx) => variance(ctx, args, true);
F['VAR.S'] = F.VAR;
F.VARP = (args, ctx) => variance(ctx, args, false);
F['VAR.P'] = F.VARP;
F.STDEV = (args, ctx) => {
  const v = variance(ctx, args, true);
  return isErr(v) ? v : Math.sqrt(v);
};
F['STDEV.S'] = F.STDEV;
F.STDEVP = (args, ctx) => {
  const v = variance(ctx, args, false);
  return isErr(v) ? v : Math.sqrt(v);
};
F['STDEV.P'] = F.STDEVP;
F.LARGE = (args, ctx) => {
  const e = argCount(args, 2, 2, 'LARGE');
  if (e) return e;
  const nums = collectNumbers(ctx, [args[0]]);
  if (isErr(nums)) return nums;
  const k = numArg(ctx, args[1]);
  if (isErr(k)) return k;
  const s = [...nums].sort((a, b) => b - a);
  return k >= 1 && k <= s.length ? s[Math.ceil(k) - 1] : err('#NUM!', 'k is out of range');
};
F.SMALL = (args, ctx) => {
  const e = argCount(args, 2, 2, 'SMALL');
  if (e) return e;
  const nums = collectNumbers(ctx, [args[0]]);
  if (isErr(nums)) return nums;
  const k = numArg(ctx, args[1]);
  if (isErr(k)) return k;
  const s = [...nums].sort((a, b) => a - b);
  return k >= 1 && k <= s.length ? s[Math.ceil(k) - 1] : err('#NUM!', 'k is out of range');
};
F.RANK = (args, ctx) => {
  const e = argCount(args, 2, 3, 'RANK');
  if (e) return e;
  const x = numArg(ctx, args[0]);
  if (isErr(x)) return x;
  const nums = collectNumbers(ctx, [args[1]]);
  if (isErr(nums)) return nums;
  const asc = numArg(ctx, args[2], 0);
  if (isErr(asc)) return asc;
  if (!nums.includes(x)) return err('#N/A', 'Value not found in range');
  return 1 + nums.filter((n) => (asc ? n < x : n > x)).length;
};
F['RANK.EQ'] = F.RANK;
F.SUMPRODUCT = (args, ctx) => {
  if (!args.length) return err('#N/A', 'SUMPRODUCT needs at least one range');
  const ranges: RangeVal[] = [];
  for (const a of args) {
    const rg = rangeArg(ctx, a);
    if (isErr(rg)) return rg;
    ranges.push(rg);
  }
  const { rows, cols } = rangeDims(ranges[0]);
  if (ranges.some((r) => rangeDims(r).rows !== rows || rangeDims(r).cols !== cols)) {
    return err('#VALUE!', 'SUMPRODUCT has mismatched range sizes');
  }
  let total = 0;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      let p = 1;
      for (const rg of ranges) {
        const v = cellAt(ctx, rg, i, j);
        if (isErr(v)) return v;
        p *= typeof v === 'number' ? v : 0;
      }
      total += p;
    }
  }
  return total;
};

// --- Conditional aggregates ------------------------------------------------
F.SUMIF = (args, ctx) => {
  const e = argCount(args, 2, 3, 'SUMIF');
  if (e) return e;
  const rg = rangeArg(ctx, args[0]);
  if (isErr(rg)) return rg;
  let target = rg;
  if (args[2]) {
    const t = rangeArg(ctx, args[2]);
    if (isErr(t)) return t;
    const d = rangeDims(rg);
    target = { ...t, r2: t.r1 + d.rows - 1, c2: t.c1 + d.cols - 1 };
  }
  const pred = makeCriterion(scalarArg(ctx, args[1]));
  let sum = 0;
  const { rows, cols } = rangeDims(rg);
  for (let i = 0; i < rows; i++)
    for (let j = 0; j < cols; j++) {
      if (pred(cellAt(ctx, rg, i, j))) {
        const v = cellAt(ctx, target, i, j);
        if (typeof v === 'number') sum += v;
      }
    }
  return sum;
};
F.SUMIFS = (args, ctx) => {
  if (args.length < 3 || args.length % 2 === 0) return err('#N/A', 'SUMIFS expects sum_range and criteria pairs');
  const target = rangeArg(ctx, args[0]);
  if (isErr(target)) return target;
  let sum = 0;
  const e = eachMatching(ctx, target, pairsFrom(args, 1), (v) => {
    if (typeof v === 'number') sum += v;
  });
  return e ?? sum;
};
F.COUNTIF = (args, ctx) => {
  const e = argCount(args, 2, 2, 'COUNTIF');
  if (e) return e;
  const rg = rangeArg(ctx, args[0]);
  if (isErr(rg)) return rg;
  const pred = makeCriterion(scalarArg(ctx, args[1]));
  let n = 0;
  const { rows, cols } = rangeDims(rg);
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) if (pred(cellAt(ctx, rg, i, j))) n++;
  return n;
};
F.COUNTIFS = (args, ctx) => {
  if (args.length < 2 || args.length % 2 !== 0) return err('#N/A', 'COUNTIFS expects criteria pairs');
  const first = rangeArg(ctx, args[0]);
  if (isErr(first)) return first;
  let n = 0;
  const e = eachMatching(ctx, first, pairsFrom(args, 0), () => {
    n++;
  });
  return e ?? n;
};
F.AVERAGEIF = (args, ctx) => {
  const e = argCount(args, 2, 3, 'AVERAGEIF');
  if (e) return e;
  const rg = rangeArg(ctx, args[0]);
  if (isErr(rg)) return rg;
  let target = rg;
  if (args[2]) {
    const t = rangeArg(ctx, args[2]);
    if (isErr(t)) return t;
    const d = rangeDims(rg);
    target = { ...t, r2: t.r1 + d.rows - 1, c2: t.c1 + d.cols - 1 };
  }
  const pred = makeCriterion(scalarArg(ctx, args[1]));
  let sum = 0;
  let n = 0;
  const { rows, cols } = rangeDims(rg);
  for (let i = 0; i < rows; i++)
    for (let j = 0; j < cols; j++) {
      if (pred(cellAt(ctx, rg, i, j))) {
        const v = cellAt(ctx, target, i, j);
        if (typeof v === 'number') {
          sum += v;
          n++;
        }
      }
    }
  return n ? sum / n : err('#DIV/0!', 'No matching numeric values');
};
function ifsAggregate(name: string, reduce: (nums: number[]) => Value): Fn {
  return (args, ctx) => {
    if (args.length < 3 || args.length % 2 === 0) return err('#N/A', `${name} expects a range and criteria pairs`);
    const target = rangeArg(ctx, args[0]);
    if (isErr(target)) return target;
    const nums: number[] = [];
    const e = eachMatching(ctx, target, pairsFrom(args, 1), (v) => {
      if (typeof v === 'number') nums.push(v);
    });
    return e ?? reduce(nums);
  };
}
F.AVERAGEIFS = ifsAggregate('AVERAGEIFS', (n) =>
  n.length ? n.reduce((a, b) => a + b, 0) / n.length : err('#DIV/0!', 'No matching numeric values'),
);
F.MAXIFS = ifsAggregate('MAXIFS', (n) => (n.length ? Math.max(...n) : 0));
F.MINIFS = ifsAggregate('MINIFS', (n) => (n.length ? Math.min(...n) : 0));

// --- Logic ----------------------------------------------------------------
F.IF = (args, ctx) => {
  const e = argCount(args, 2, 3, 'IF');
  if (e) return e;
  const c = toBool(scalarArg(ctx, args[0]));
  if (isErr(c)) return c;
  if (c) return args[1].t === 'empty' ? 0 : ctx.eval(args[1]);
  if (!args[2]) return false;
  return args[2].t === 'empty' ? 0 : ctx.eval(args[2]);
};
F.IFS = (args, ctx) => {
  if (args.length < 2 || args.length % 2) return err('#N/A', 'IFS expects condition/value pairs');
  for (let i = 0; i < args.length; i += 2) {
    const c = toBool(scalarArg(ctx, args[i]));
    if (isErr(c)) return c;
    if (c) return ctx.eval(args[i + 1]);
  }
  return err('#N/A', 'No match');
};
F.IFERROR = (args, ctx) => {
  const e = argCount(args, 1, 2, 'IFERROR');
  if (e) return e;
  const v = scalarArg(ctx, args[0]);
  return isErr(v) ? (args[1] ? ctx.eval(args[1]) : null) : v;
};
F.IFNA = (args, ctx) => {
  const e = argCount(args, 2, 2, 'IFNA');
  if (e) return e;
  const v = scalarArg(ctx, args[0]);
  return isErr(v) && v.code === '#N/A' ? ctx.eval(args[1]) : v;
};
function logical(name: string, combine: (vals: boolean[]) => boolean): Fn {
  return (args, ctx) => {
    const vals: boolean[] = [];
    let e: CellError | null = null;
    eachValue(ctx, args, (v, direct) => {
      if (isErr(v)) {
        e = v;
        return false;
      }
      if (v === null) return;
      if (typeof v === 'string' && !direct) return;
      const b = toBool(v);
      if (isErr(b)) {
        e = b;
        return false;
      }
      vals.push(b);
    });
    if (e) return e;
    if (!vals.length) return err('#VALUE!', `${name} has no logical values`);
    return combine(vals);
  };
}
F.AND = logical('AND', (v) => v.every(Boolean));
F.OR = logical('OR', (v) => v.some(Boolean));
F.XOR = logical('XOR', (v) => v.filter(Boolean).length % 2 === 1);
F.NOT = (args, ctx) => {
  const e = argCount(args, 1, 1, 'NOT');
  if (e) return e;
  const b = toBool(scalarArg(ctx, args[0]));
  return isErr(b) ? b : !b;
};
F.TRUE = () => true;
F.FALSE = () => false;
F.SWITCH = (args, ctx) => {
  if (args.length < 3) return err('#N/A', 'SWITCH expects an expression and case/value pairs');
  const v = scalarArg(ctx, args[0]);
  if (isErr(v)) return v;
  let i = 1;
  for (; i + 1 < args.length; i += 2) {
    const c = scalarArg(ctx, args[i]);
    if (compareScalars(v, c) === 0 && typeof v === typeof c) return ctx.eval(args[i + 1]);
  }
  return i < args.length ? ctx.eval(args[i]) : err('#N/A', 'No match');
};
F.CHOOSE = (args, ctx) => {
  if (args.length < 2) return err('#N/A', 'CHOOSE expects an index and choices');
  const i = numArg(ctx, args[0]);
  if (isErr(i)) return i;
  const idx = Math.floor(i);
  if (idx < 1 || idx >= args.length) return err('#VALUE!', 'Index out of range');
  return ctx.eval(args[idx]);
};

// --- Math -----------------------------------------------------------------
F.ABS = math1('ABS', Math.abs);
F.INT = math1('INT', Math.floor);
F.SIGN = math1('SIGN', Math.sign);
F.SQRT = math1('SQRT', (x) => (x < 0 ? err('#NUM!', 'SQRT of a negative number') : Math.sqrt(x)));
F.EXP = math1('EXP', Math.exp);
F.LN = math1('LN', (x) => (x <= 0 ? err('#NUM!', 'LN of a non-positive number') : Math.log(x)));
F.LOG10 = math1('LOG10', (x) => (x <= 0 ? err('#NUM!', 'LOG10 of a non-positive number') : Math.log10(x)));
F.PI = () => Math.PI;
F.RAND = () => Math.random();
F.RANDBETWEEN = (args, ctx) => {
  const e = argCount(args, 2, 2, 'RANDBETWEEN');
  if (e) return e;
  const lo = numArg(ctx, args[0]);
  const hi = numArg(ctx, args[1]);
  if (isErr(lo)) return lo;
  if (isErr(hi)) return hi;
  const a = Math.ceil(lo);
  const b = Math.floor(hi);
  if (b < a) return err('#NUM!', 'Low must be less than high');
  return a + Math.floor(Math.random() * (b - a + 1));
};
F.LOG = (args, ctx) => {
  const e = argCount(args, 1, 2, 'LOG');
  if (e) return e;
  const x = numArg(ctx, args[0]);
  const b = numArg(ctx, args[1], 10);
  if (isErr(x)) return x;
  if (isErr(b)) return b;
  if (x <= 0 || b <= 0 || b === 1) return err('#NUM!');
  return Math.log(x) / Math.log(b);
};
F.POWER = (args, ctx) => {
  const e = argCount(args, 2, 2, 'POWER');
  if (e) return e;
  const x = numArg(ctx, args[0]);
  const y = numArg(ctx, args[1]);
  if (isErr(x)) return x;
  if (isErr(y)) return y;
  const r = Math.pow(x, y);
  return Number.isFinite(r) ? r : err('#NUM!');
};
F.MOD = (args, ctx) => {
  const e = argCount(args, 2, 2, 'MOD');
  if (e) return e;
  const x = numArg(ctx, args[0]);
  const y = numArg(ctx, args[1]);
  if (isErr(x)) return x;
  if (isErr(y)) return y;
  if (y === 0) return err('#DIV/0!', 'MOD by zero');
  return x - y * Math.floor(x / y);
};
F.QUOTIENT = (args, ctx) => {
  const e = argCount(args, 2, 2, 'QUOTIENT');
  if (e) return e;
  const x = numArg(ctx, args[0]);
  const y = numArg(ctx, args[1]);
  if (isErr(x)) return x;
  if (isErr(y)) return y;
  if (y === 0) return err('#DIV/0!');
  return Math.trunc(x / y);
};
function rounder(name: string, mode: 'round' | 'up' | 'down'): Fn {
  return (args, ctx) => {
    const e = argCount(args, 1, 2, name);
    if (e) return e;
    const x = numArg(ctx, args[0]);
    const d = numArg(ctx, args[1], 0);
    if (isErr(x)) return x;
    if (isErr(d)) return d;
    return roundTo(x, Math.trunc(d), mode);
  };
}
F.ROUND = rounder('ROUND', 'round');
F.ROUNDUP = rounder('ROUNDUP', 'up');
F.ROUNDDOWN = rounder('ROUNDDOWN', 'down');
F.TRUNC = rounder('TRUNC', 'down');
function significance(name: string, f: (x: number) => number): Fn {
  return (args, ctx) => {
    const e = argCount(args, 1, 2, name);
    if (e) return e;
    const x = numArg(ctx, args[0]);
    const s = numArg(ctx, args[1], 1);
    if (isErr(x)) return x;
    if (isErr(s)) return s;
    if (s === 0) return 0;
    return Number((f(x / s) * s).toPrecision(15));
  };
}
F.CEILING = significance('CEILING', Math.ceil);
F.FLOOR = significance('FLOOR', Math.floor);
F.MROUND = significance('MROUND', Math.round);

// --- Text -----------------------------------------------------------------
function text1(name: string, f: (s: string) => Scalar): Fn {
  return (args, ctx) => {
    const e = argCount(args, 1, 1, name);
    if (e) return e;
    const s = strArg(ctx, args[0]);
    return isErr(s) ? s : f(s);
  };
}
F.LEN = text1('LEN', (s) => s.length);
F.UPPER = text1('UPPER', (s) => s.toUpperCase());
F.LOWER = text1('LOWER', (s) => s.toLowerCase());
F.PROPER = text1('PROPER', (s) => s.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_m, p, ch) => p + ch.toUpperCase()));
F.TRIM = text1('TRIM', (s) => s.trim().replace(/ {2,}/g, ' '));
F.CODE = text1('CODE', (s) => (s.length ? s.charCodeAt(0) : err('#VALUE!')));
F.VALUE = text1('VALUE', (s) => toNumber(s));
F.DATEVALUE = text1('DATEVALUE', (s) => {
  const p = parseDateString(s.trim());
  return p && typeof p.value === 'number' ? Math.floor(p.value) : err('#VALUE!', `Cannot parse "${s}" as a date`);
});
F.CHAR = (args, ctx) => {
  const e = argCount(args, 1, 1, 'CHAR');
  if (e) return e;
  const n = numArg(ctx, args[0]);
  if (isErr(n)) return n;
  return n >= 1 ? String.fromCharCode(Math.floor(n)) : err('#VALUE!');
};
F.LEFT = (args, ctx) => {
  const e = argCount(args, 1, 2, 'LEFT');
  if (e) return e;
  const s = strArg(ctx, args[0]);
  const n = numArg(ctx, args[1], 1);
  if (isErr(s)) return s;
  if (isErr(n)) return n;
  return n < 0 ? err('#VALUE!') : s.slice(0, Math.floor(n));
};
F.RIGHT = (args, ctx) => {
  const e = argCount(args, 1, 2, 'RIGHT');
  if (e) return e;
  const s = strArg(ctx, args[0]);
  const n = numArg(ctx, args[1], 1);
  if (isErr(s)) return s;
  if (isErr(n)) return n;
  if (n < 0) return err('#VALUE!');
  return Math.floor(n) === 0 ? '' : s.slice(-Math.floor(n));
};
F.MID = (args, ctx) => {
  const e = argCount(args, 3, 3, 'MID');
  if (e) return e;
  const s = strArg(ctx, args[0]);
  const start = numArg(ctx, args[1]);
  const n = numArg(ctx, args[2]);
  if (isErr(s)) return s;
  if (isErr(start)) return start;
  if (isErr(n)) return n;
  if (start < 1 || n < 0) return err('#VALUE!');
  return s.substr(Math.floor(start) - 1, Math.floor(n));
};
F.CONCATENATE = (args, ctx) => {
  let out = '';
  for (const v of flatten(ctx, args)) {
    if (isErr(v)) return v;
    out += scalarToText(v);
  }
  return out;
};
F.CONCAT = F.CONCATENATE;
F.TEXTJOIN = (args, ctx) => {
  if (args.length < 3) return err('#N/A', 'TEXTJOIN expects a delimiter, ignore_empty and values');
  const d = strArg(ctx, args[0]);
  const ignore = boolArg(ctx, args[1], true);
  if (isErr(d)) return d;
  if (isErr(ignore)) return ignore;
  const parts: string[] = [];
  for (const v of flatten(ctx, args.slice(2))) {
    if (isErr(v)) return v;
    const s = scalarToText(v);
    if (ignore && s === '') continue;
    parts.push(s);
  }
  return parts.join(d);
};
F.REPT = (args, ctx) => {
  const e = argCount(args, 2, 2, 'REPT');
  if (e) return e;
  const s = strArg(ctx, args[0]);
  const n = numArg(ctx, args[1]);
  if (isErr(s)) return s;
  if (isErr(n)) return n;
  if (n < 0 || s.length * n > 32000) return err('#VALUE!');
  return s.repeat(Math.floor(n));
};
F.EXACT = (args, ctx) => {
  const e = argCount(args, 2, 2, 'EXACT');
  if (e) return e;
  const a = strArg(ctx, args[0]);
  const b = strArg(ctx, args[1]);
  if (isErr(a)) return a;
  if (isErr(b)) return b;
  return a === b;
};
F.SUBSTITUTE = (args, ctx) => {
  const e = argCount(args, 3, 4, 'SUBSTITUTE');
  if (e) return e;
  const s = strArg(ctx, args[0]);
  const from = strArg(ctx, args[1]);
  const to = strArg(ctx, args[2]);
  if (isErr(s)) return s;
  if (isErr(from)) return from;
  if (isErr(to)) return to;
  if (!from) return s;
  if (!args[3]) return s.split(from).join(to);
  const inst = numArg(ctx, args[3]);
  if (isErr(inst)) return inst;
  let idx = -1;
  for (let k = 0; k < inst; k++) {
    idx = s.indexOf(from, idx + 1);
    if (idx < 0) return s;
  }
  return s.slice(0, idx) + to + s.slice(idx + from.length);
};
F.REPLACE = (args, ctx) => {
  const e = argCount(args, 4, 4, 'REPLACE');
  if (e) return e;
  const s = strArg(ctx, args[0]);
  const start = numArg(ctx, args[1]);
  const n = numArg(ctx, args[2]);
  const repl = strArg(ctx, args[3]);
  if (isErr(s)) return s;
  if (isErr(start)) return start;
  if (isErr(n)) return n;
  if (isErr(repl)) return repl;
  const i = Math.floor(start) - 1;
  return s.slice(0, i) + repl + s.slice(i + Math.floor(n));
};
function finder(name: string, caseInsensitive: boolean): Fn {
  return (args, ctx) => {
    const e = argCount(args, 2, 3, name);
    if (e) return e;
    let needle = strArg(ctx, args[0]);
    let hay = strArg(ctx, args[1]);
    const start = numArg(ctx, args[2], 1);
    if (isErr(needle)) return needle;
    if (isErr(hay)) return hay;
    if (isErr(start)) return start;
    if (caseInsensitive) {
      needle = needle.toLowerCase();
      hay = hay.toLowerCase();
    }
    const i = hay.indexOf(needle, Math.floor(start) - 1);
    return i < 0 ? err('#VALUE!', `${name} did not find "${needle}"`) : i + 1;
  };
}
F.FIND = finder('FIND', false);
F.SEARCH = finder('SEARCH', true);
F.TEXT = (args, ctx) => {
  const e = argCount(args, 2, 2, 'TEXT');
  if (e) return e;
  const v = scalarArg(ctx, args[0]);
  const f = strArg(ctx, args[1]);
  if (isErr(v)) return v;
  if (isErr(f)) return f;
  return textFormat(typeof v === 'string' && !isErr(toNumber(v)) ? (toNumber(v) as number) : v, f);
};

// --- Info -----------------------------------------------------------------
function is(name: string, pred: (v: Scalar) => boolean): Fn {
  return (args, ctx) => {
    const e = argCount(args, 1, 1, name);
    if (e) return e;
    return pred(scalarArg(ctx, args[0]));
  };
}
F.ISBLANK = is('ISBLANK', (v) => v === null);
F.ISNUMBER = is('ISNUMBER', (v) => typeof v === 'number');
F.ISTEXT = is('ISTEXT', (v) => typeof v === 'string');
F.ISNONTEXT = is('ISNONTEXT', (v) => typeof v !== 'string');
F.ISLOGICAL = is('ISLOGICAL', (v) => typeof v === 'boolean');
F.ISERROR = is('ISERROR', (v) => isErr(v));
F.ISERR = is('ISERR', (v) => isErr(v) && v.code !== '#N/A');
F.ISNA = is('ISNA', (v) => isErr(v) && v.code === '#N/A');
F.ISEVEN = is('ISEVEN', (v) => typeof v === 'number' && Math.floor(Math.abs(v)) % 2 === 0);
F.ISODD = is('ISODD', (v) => typeof v === 'number' && Math.floor(Math.abs(v)) % 2 === 1);
F.NA = () => err('#N/A', 'Value not available');
F.ROW = (args, ctx) => {
  if (!args.length) return ctx.row + 1;
  const rg = rangeArg(ctx, args[0]);
  return isErr(rg) ? rg : rg.r1 + 1;
};
F.COLUMN = (args, ctx) => {
  if (!args.length) return ctx.col + 1;
  const rg = rangeArg(ctx, args[0]);
  return isErr(rg) ? rg : rg.c1 + 1;
};
F.ROWS = (args, ctx) => {
  const rg = rangeArg(ctx, args[0]);
  return isErr(rg) ? rg : rangeDims(rg).rows;
};
F.COLUMNS = (args, ctx) => {
  const rg = rangeArg(ctx, args[0]);
  return isErr(rg) ? rg : rangeDims(rg).cols;
};

// --- Lookup ---------------------------------------------------------------
F.VLOOKUP = (args, ctx) => {
  const e = argCount(args, 3, 4, 'VLOOKUP');
  if (e) return e;
  const key = scalarArg(ctx, args[0]);
  if (isErr(key)) return key;
  const rg = rangeArg(ctx, args[1]);
  if (isErr(rg)) return rg;
  const col = numArg(ctx, args[2]);
  if (isErr(col)) return col;
  const sorted = boolArg(ctx, args[3], true);
  if (isErr(sorted)) return sorted;
  const { rows, cols } = rangeDims(rg);
  if (col < 1 || col > cols) return err('#REF!', `VLOOKUP column ${col} is out of range`);
  const keys: Scalar[] = [];
  for (let i = 0; i < rows; i++) keys.push(cellAt(ctx, rg, i, 0));
  const i = findIndex(key, keys, sorted ? 1 : 0);
  if (i < 0) return err('#N/A', `Did not find value '${scalarToText(key)}' in VLOOKUP evaluation.`);
  return cellAt(ctx, rg, i, Math.floor(col) - 1);
};
F.HLOOKUP = (args, ctx) => {
  const e = argCount(args, 3, 4, 'HLOOKUP');
  if (e) return e;
  const key = scalarArg(ctx, args[0]);
  if (isErr(key)) return key;
  const rg = rangeArg(ctx, args[1]);
  if (isErr(rg)) return rg;
  const row = numArg(ctx, args[2]);
  if (isErr(row)) return row;
  const sorted = boolArg(ctx, args[3], true);
  if (isErr(sorted)) return sorted;
  const { rows, cols } = rangeDims(rg);
  if (row < 1 || row > rows) return err('#REF!', `HLOOKUP row ${row} is out of range`);
  const keys: Scalar[] = [];
  for (let j = 0; j < cols; j++) keys.push(cellAt(ctx, rg, 0, j));
  const j = findIndex(key, keys, sorted ? 1 : 0);
  if (j < 0) return err('#N/A', `Did not find value '${scalarToText(key)}' in HLOOKUP evaluation.`);
  return cellAt(ctx, rg, Math.floor(row) - 1, j);
};
F.MATCH = (args, ctx) => {
  const e = argCount(args, 2, 3, 'MATCH');
  if (e) return e;
  const key = scalarArg(ctx, args[0]);
  if (isErr(key)) return key;
  const rg = rangeArg(ctx, args[1]);
  if (isErr(rg)) return rg;
  const mode = numArg(ctx, args[2], 1);
  if (isErr(mode)) return mode;
  const i = findIndex(key, vectorOf(ctx, rg), Math.sign(mode));
  return i < 0 ? err('#N/A', `Did not find value '${scalarToText(key)}' in MATCH evaluation.`) : i + 1;
};
F.INDEX = (args, ctx) => {
  const e = argCount(args, 1, 3, 'INDEX');
  if (e) return e;
  const rg = rangeArg(ctx, args[0]);
  if (isErr(rg)) return rg;
  const { rows, cols } = rangeDims(rg);
  let row = numArg(ctx, args[1], 0);
  let col = numArg(ctx, args[2], 0);
  if (isErr(row)) return row;
  if (isErr(col)) return col;
  row = Math.floor(row);
  col = Math.floor(col);
  // INDEX(single_row_range, n) indexes along the row.
  if (rows === 1 && args.length === 2) {
    col = row;
    row = 1;
  }
  if (row < 0 || col < 0 || row > rows || col > cols) return err('#REF!', 'INDEX is out of range');
  return {
    kind: 'range',
    tabId: rg.tabId,
    r1: row ? rg.r1 + row - 1 : rg.r1,
    r2: row ? rg.r1 + row - 1 : rg.r2,
    c1: col ? rg.c1 + col - 1 : rg.c1,
    c2: col ? rg.c1 + col - 1 : rg.c2,
  };
};
F.XLOOKUP = (args, ctx) => {
  const e = argCount(args, 3, 4, 'XLOOKUP');
  if (e) return e;
  const key = scalarArg(ctx, args[0]);
  if (isErr(key)) return key;
  const look = rangeArg(ctx, args[1]);
  if (isErr(look)) return look;
  const ret = rangeArg(ctx, args[2]);
  if (isErr(ret)) return ret;
  const i = findIndex(key, vectorOf(ctx, look), 0);
  if (i < 0) return args[3] ? ctx.eval(args[3]) : err('#N/A', `Did not find value '${scalarToText(key)}' in XLOOKUP evaluation.`);
  const vertical = rangeDims(look).cols === 1 && rangeDims(look).rows > 1;
  return vertical ? cellAt(ctx, ret, i, 0) : cellAt(ctx, ret, 0, i);
};

// --- Links --------------------------------------------------------------------
// Evaluates to the label; the engine reads the URL from the first argument (Engine.getLink).
F.HYPERLINK = (args, ctx) => {
  const e = argCount(args, 1, 2, 'HYPERLINK');
  if (e) return e;
  const url = scalarArg(ctx, args[0]);
  if (isErr(url)) return url;
  if (args[1] && args[1].t !== 'empty') {
    const label = scalarArg(ctx, args[1]);
    if (label !== null && label !== '') return label;
  }
  return scalarToText(url);
};

// --- Date & time ------------------------------------------------------------
F.TODAY = () => todaySerial();
F.NOW = () => nowSerial();
F.DATE = (args, ctx) => {
  const e = argCount(args, 3, 3, 'DATE');
  if (e) return e;
  const y = numArg(ctx, args[0]);
  const m = numArg(ctx, args[1]);
  const d = numArg(ctx, args[2]);
  if (isErr(y)) return y;
  if (isErr(m)) return m;
  if (isErr(d)) return d;
  const yy = y < 1900 ? y + 1900 : y;
  return dateToSerial(Math.floor(yy), Math.floor(m), Math.floor(d));
};
F.TIME = (args, ctx) => {
  const e = argCount(args, 3, 3, 'TIME');
  if (e) return e;
  const h = numArg(ctx, args[0]);
  const m = numArg(ctx, args[1]);
  const s = numArg(ctx, args[2]);
  if (isErr(h)) return h;
  if (isErr(m)) return m;
  if (isErr(s)) return s;
  const total = (Math.floor(h) * 3600 + Math.floor(m) * 60 + Math.floor(s)) / 86400;
  return total - Math.floor(total);
};
function datePart(name: string, f: (serial: number) => number): Fn {
  return (args, ctx) => {
    const e = argCount(args, 1, 1, name);
    if (e) return e;
    const s = dateArg(ctx, args[0]);
    return isErr(s) ? s : f(s);
  };
}
F.YEAR = datePart('YEAR', (s) => dateParts(s).y);
F.MONTH = datePart('MONTH', (s) => dateParts(s).m);
F.DAY = datePart('DAY', (s) => dateParts(s).d);
F.HOUR = datePart('HOUR', (s) => Math.floor(((s - Math.floor(s)) * 86400 + 0.5) / 3600) % 24);
F.MINUTE = datePart('MINUTE', (s) => Math.floor(((s - Math.floor(s)) * 86400 + 0.5) / 60) % 60);
F.SECOND = datePart('SECOND', (s) => Math.round((s - Math.floor(s)) * 86400) % 60);
F.WEEKDAY = (args, ctx) => {
  const e = argCount(args, 1, 2, 'WEEKDAY');
  if (e) return e;
  const s = dateArg(ctx, args[0]);
  const type = numArg(ctx, args[1], 1);
  if (isErr(s)) return s;
  if (isErr(type)) return type;
  const dow = serialToDate(s).getUTCDay(); // 0 = Sunday
  if (type === 2) return dow === 0 ? 7 : dow;
  if (type === 3) return dow === 0 ? 6 : dow - 1;
  return dow + 1;
};
F.EDATE = (args, ctx) => {
  const e = argCount(args, 2, 2, 'EDATE');
  if (e) return e;
  const s = dateArg(ctx, args[0]);
  const n = numArg(ctx, args[1]);
  if (isErr(s)) return s;
  if (isErr(n)) return n;
  const p = dateParts(s);
  const total = p.y * 12 + (p.m - 1) + Math.trunc(n);
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return dateToSerial(y, m, Math.min(p.d, daysInMonth(y, m)));
};
F.EOMONTH = (args, ctx) => {
  const e = argCount(args, 2, 2, 'EOMONTH');
  if (e) return e;
  const s = dateArg(ctx, args[0]);
  const n = numArg(ctx, args[1]);
  if (isErr(s)) return s;
  if (isErr(n)) return n;
  const p = dateParts(s);
  const total = p.y * 12 + (p.m - 1) + Math.trunc(n);
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return dateToSerial(y, m, daysInMonth(y, m));
};
F.DAYS = (args, ctx) => {
  const e = argCount(args, 2, 2, 'DAYS');
  if (e) return e;
  const end = dateArg(ctx, args[0]);
  const start = dateArg(ctx, args[1]);
  if (isErr(end)) return end;
  if (isErr(start)) return start;
  return Math.floor(end) - Math.floor(start);
};
F.DATEDIF = (args, ctx) => {
  const e = argCount(args, 3, 3, 'DATEDIF');
  if (e) return e;
  const s = dateArg(ctx, args[0]);
  const en = dateArg(ctx, args[1]);
  const unit = strArg(ctx, args[2]);
  if (isErr(s)) return s;
  if (isErr(en)) return en;
  if (isErr(unit)) return unit;
  if (en < s) return err('#NUM!', 'Start date must be before end date');
  const a = dateParts(s);
  const b = dateParts(en);
  let months = (b.y - a.y) * 12 + (b.m - a.m);
  if (b.d < a.d) months--;
  switch (unit.toUpperCase()) {
    case 'D':
      return Math.floor(en) - Math.floor(s);
    case 'M':
      return months;
    case 'Y':
      return Math.floor(months / 12);
    case 'YM':
      return months % 12;
    case 'MD':
      return b.d >= a.d ? b.d - a.d : b.d + daysInMonth(b.m === 1 ? b.y - 1 : b.y, b.m === 1 ? 12 : b.m - 1) - a.d;
    default:
      return err('#NUM!', `Unknown DATEDIF unit "${unit}"`);
  }
};

export const FUNCTIONS: Record<string, Fn> = F;

// ---------------------------------------------------------------------------
// Documentation used for autocomplete / signature hints in the UI.

export const FUNCTION_DOCS: Record<string, { syntax: string; desc: string }> = {
  SUM: { syntax: 'SUM(value1, [value2, ...])', desc: 'Sum of numbers.' },
  AVERAGE: { syntax: 'AVERAGE(value1, [value2, ...])', desc: 'Arithmetic mean of numbers.' },
  MIN: { syntax: 'MIN(value1, [value2, ...])', desc: 'Smallest number.' },
  MAX: { syntax: 'MAX(value1, [value2, ...])', desc: 'Largest number.' },
  COUNT: { syntax: 'COUNT(value1, [value2, ...])', desc: 'Count of numeric values.' },
  COUNTA: { syntax: 'COUNTA(value1, [value2, ...])', desc: 'Count of non-empty values.' },
  COUNTBLANK: { syntax: 'COUNTBLANK(range)', desc: 'Count of empty cells.' },
  COUNTUNIQUE: { syntax: 'COUNTUNIQUE(value1, [value2, ...])', desc: 'Count of unique values.' },
  PRODUCT: { syntax: 'PRODUCT(value1, [value2, ...])', desc: 'Product of numbers.' },
  MEDIAN: { syntax: 'MEDIAN(value1, [value2, ...])', desc: 'Median of numbers.' },
  MODE: { syntax: 'MODE(value1, [value2, ...])', desc: 'Most common value.' },
  STDEV: { syntax: 'STDEV(value1, [value2, ...])', desc: 'Sample standard deviation.' },
  STDEVP: { syntax: 'STDEVP(value1, [value2, ...])', desc: 'Population standard deviation.' },
  VAR: { syntax: 'VAR(value1, [value2, ...])', desc: 'Sample variance.' },
  VARP: { syntax: 'VARP(value1, [value2, ...])', desc: 'Population variance.' },
  LARGE: { syntax: 'LARGE(data, n)', desc: 'nth largest value.' },
  SMALL: { syntax: 'SMALL(data, n)', desc: 'nth smallest value.' },
  RANK: { syntax: 'RANK(value, data, [is_ascending])', desc: 'Rank of a value in a data set.' },
  SUMPRODUCT: { syntax: 'SUMPRODUCT(array1, [array2, ...])', desc: 'Sum of products of corresponding entries.' },
  SUMSQ: { syntax: 'SUMSQ(value1, [value2, ...])', desc: 'Sum of squares.' },
  SUMIF: { syntax: 'SUMIF(range, criterion, [sum_range])', desc: 'Conditional sum.' },
  SUMIFS: { syntax: 'SUMIFS(sum_range, criteria_range1, criterion1, ...)', desc: 'Sum with multiple criteria.' },
  COUNTIF: { syntax: 'COUNTIF(range, criterion)', desc: 'Conditional count.' },
  COUNTIFS: { syntax: 'COUNTIFS(criteria_range1, criterion1, ...)', desc: 'Count with multiple criteria.' },
  AVERAGEIF: { syntax: 'AVERAGEIF(criteria_range, criterion, [average_range])', desc: 'Conditional average.' },
  AVERAGEIFS: { syntax: 'AVERAGEIFS(average_range, criteria_range1, criterion1, ...)', desc: 'Average with multiple criteria.' },
  MAXIFS: { syntax: 'MAXIFS(range, criteria_range1, criterion1, ...)', desc: 'Maximum with criteria.' },
  MINIFS: { syntax: 'MINIFS(range, criteria_range1, criterion1, ...)', desc: 'Minimum with criteria.' },
  IF: { syntax: 'IF(condition, value_if_true, [value_if_false])', desc: 'Conditional value.' },
  IFS: { syntax: 'IFS(condition1, value1, [condition2, value2, ...])', desc: 'First value whose condition is true.' },
  IFERROR: { syntax: 'IFERROR(value, [value_if_error])', desc: 'Fallback when value is an error.' },
  IFNA: { syntax: 'IFNA(value, value_if_na)', desc: 'Fallback when value is #N/A.' },
  AND: { syntax: 'AND(logical1, [logical2, ...])', desc: 'True if all are true.' },
  OR: { syntax: 'OR(logical1, [logical2, ...])', desc: 'True if any is true.' },
  XOR: { syntax: 'XOR(logical1, [logical2, ...])', desc: 'True if an odd number are true.' },
  NOT: { syntax: 'NOT(logical)', desc: 'Logical negation.' },
  SWITCH: { syntax: 'SWITCH(expression, case1, value1, [default])', desc: 'Value for the first matching case.' },
  CHOOSE: { syntax: 'CHOOSE(index, choice1, [choice2, ...])', desc: 'Choice by index.' },
  ABS: { syntax: 'ABS(value)', desc: 'Absolute value.' },
  ROUND: { syntax: 'ROUND(value, [places])', desc: 'Round to a number of decimal places.' },
  ROUNDUP: { syntax: 'ROUNDUP(value, [places])', desc: 'Round away from zero.' },
  ROUNDDOWN: { syntax: 'ROUNDDOWN(value, [places])', desc: 'Round toward zero.' },
  TRUNC: { syntax: 'TRUNC(value, [places])', desc: 'Truncate decimals.' },
  INT: { syntax: 'INT(value)', desc: 'Round down to an integer.' },
  MOD: { syntax: 'MOD(dividend, divisor)', desc: 'Remainder after division.' },
  QUOTIENT: { syntax: 'QUOTIENT(dividend, divisor)', desc: 'Integer part of a division.' },
  POWER: { syntax: 'POWER(base, exponent)', desc: 'Raise to a power.' },
  SQRT: { syntax: 'SQRT(value)', desc: 'Square root.' },
  EXP: { syntax: 'EXP(value)', desc: 'e raised to a power.' },
  LN: { syntax: 'LN(value)', desc: 'Natural logarithm.' },
  LOG: { syntax: 'LOG(value, [base])', desc: 'Logarithm (default base 10).' },
  LOG10: { syntax: 'LOG10(value)', desc: 'Base-10 logarithm.' },
  CEILING: { syntax: 'CEILING(value, [factor])', desc: 'Round up to a multiple.' },
  FLOOR: { syntax: 'FLOOR(value, [factor])', desc: 'Round down to a multiple.' },
  MROUND: { syntax: 'MROUND(value, factor)', desc: 'Round to the nearest multiple.' },
  SIGN: { syntax: 'SIGN(value)', desc: 'Sign of a number (-1, 0, 1).' },
  PI: { syntax: 'PI()', desc: 'The number π.' },
  RAND: { syntax: 'RAND()', desc: 'Random number in [0, 1).' },
  RANDBETWEEN: { syntax: 'RANDBETWEEN(low, high)', desc: 'Random integer between two values.' },
  LEN: { syntax: 'LEN(text)', desc: 'Length of text.' },
  UPPER: { syntax: 'UPPER(text)', desc: 'Uppercase text.' },
  LOWER: { syntax: 'LOWER(text)', desc: 'Lowercase text.' },
  PROPER: { syntax: 'PROPER(text)', desc: 'Capitalize each word.' },
  TRIM: { syntax: 'TRIM(text)', desc: 'Remove extra spaces.' },
  LEFT: { syntax: 'LEFT(text, [count])', desc: 'Characters from the start.' },
  RIGHT: { syntax: 'RIGHT(text, [count])', desc: 'Characters from the end.' },
  MID: { syntax: 'MID(text, start, length)', desc: 'Characters from the middle.' },
  CONCATENATE: { syntax: 'CONCATENATE(value1, [value2, ...])', desc: 'Join values into text.' },
  CONCAT: { syntax: 'CONCAT(value1, value2)', desc: 'Join values into text.' },
  TEXTJOIN: { syntax: 'TEXTJOIN(delimiter, ignore_empty, text1, ...)', desc: 'Join values with a delimiter.' },
  SUBSTITUTE: { syntax: 'SUBSTITUTE(text, search, replacement, [occurrence])', desc: 'Replace text.' },
  REPLACE: { syntax: 'REPLACE(text, position, length, new_text)', desc: 'Replace part of text.' },
  FIND: { syntax: 'FIND(search_for, text, [start])', desc: 'Position of text (case-sensitive).' },
  SEARCH: { syntax: 'SEARCH(search_for, text, [start])', desc: 'Position of text (case-insensitive).' },
  REPT: { syntax: 'REPT(text, times)', desc: 'Repeat text.' },
  EXACT: { syntax: 'EXACT(text1, text2)', desc: 'Case-sensitive equality.' },
  TEXT: { syntax: 'TEXT(number, format)', desc: 'Format a number as text.' },
  VALUE: { syntax: 'VALUE(text)', desc: 'Convert text to a number.' },
  CHAR: { syntax: 'CHAR(number)', desc: 'Character for a code.' },
  CODE: { syntax: 'CODE(text)', desc: 'Code of the first character.' },
  ISBLANK: { syntax: 'ISBLANK(value)', desc: 'True if empty.' },
  ISNUMBER: { syntax: 'ISNUMBER(value)', desc: 'True if a number.' },
  ISTEXT: { syntax: 'ISTEXT(value)', desc: 'True if text.' },
  ISLOGICAL: { syntax: 'ISLOGICAL(value)', desc: 'True if TRUE or FALSE.' },
  ISERROR: { syntax: 'ISERROR(value)', desc: 'True if an error.' },
  ISNA: { syntax: 'ISNA(value)', desc: 'True if #N/A.' },
  ISEVEN: { syntax: 'ISEVEN(value)', desc: 'True if even.' },
  ISODD: { syntax: 'ISODD(value)', desc: 'True if odd.' },
  NA: { syntax: 'NA()', desc: 'The #N/A error.' },
  ROW: { syntax: 'ROW([cell])', desc: 'Row number.' },
  COLUMN: { syntax: 'COLUMN([cell])', desc: 'Column number.' },
  ROWS: { syntax: 'ROWS(range)', desc: 'Number of rows.' },
  COLUMNS: { syntax: 'COLUMNS(range)', desc: 'Number of columns.' },
  VLOOKUP: { syntax: 'VLOOKUP(search_key, range, index, [is_sorted])', desc: 'Vertical lookup.' },
  HLOOKUP: { syntax: 'HLOOKUP(search_key, range, index, [is_sorted])', desc: 'Horizontal lookup.' },
  XLOOKUP: { syntax: 'XLOOKUP(search_key, lookup_range, result_range, [missing_value])', desc: 'Exact-match lookup.' },
  MATCH: { syntax: 'MATCH(search_key, range, [search_type])', desc: 'Position of a value in a range.' },
  INDEX: { syntax: 'INDEX(reference, [row], [column])', desc: 'Cell at a row/column offset.' },
  HYPERLINK: { syntax: 'HYPERLINK(url, [link_label])', desc: 'A link that opens url in a new tab.' },
  TODAY: { syntax: 'TODAY()', desc: "Today's date." },
  NOW: { syntax: 'NOW()', desc: 'Current date and time.' },
  DATE: { syntax: 'DATE(year, month, day)', desc: 'Build a date.' },
  TIME: { syntax: 'TIME(hour, minute, second)', desc: 'Build a time.' },
  DATEVALUE: { syntax: 'DATEVALUE(date_string)', desc: 'Parse a date.' },
  YEAR: { syntax: 'YEAR(date)', desc: 'Year of a date.' },
  MONTH: { syntax: 'MONTH(date)', desc: 'Month of a date.' },
  DAY: { syntax: 'DAY(date)', desc: 'Day of a date.' },
  HOUR: { syntax: 'HOUR(time)', desc: 'Hour of a time.' },
  MINUTE: { syntax: 'MINUTE(time)', desc: 'Minute of a time.' },
  SECOND: { syntax: 'SECOND(time)', desc: 'Second of a time.' },
  WEEKDAY: { syntax: 'WEEKDAY(date, [type])', desc: 'Day of the week.' },
  EDATE: { syntax: 'EDATE(start_date, months)', desc: 'Date months before/after.' },
  EOMONTH: { syntax: 'EOMONTH(start_date, months)', desc: 'Last day of a month.' },
  DAYS: { syntax: 'DAYS(end_date, start_date)', desc: 'Days between dates.' },
  DATEDIF: { syntax: 'DATEDIF(start_date, end_date, unit)', desc: 'Difference between dates ("D", "M", "Y").' },
};

export const FUNCTION_NAMES = Object.keys(FUNCTIONS).sort();
