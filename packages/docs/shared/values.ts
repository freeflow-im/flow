import type { CellStyle, NumberFormat } from './types.ts';

export type ErrorCode =
  | '#DIV/0!'
  | '#VALUE!'
  | '#REF!'
  | '#NAME?'
  | '#N/A'
  | '#NUM!'
  | '#NULL!'
  | '#ERROR!';

export class CellError {
  readonly code: ErrorCode;
  readonly message: string;
  constructor(code: ErrorCode, message = '') {
    this.code = code;
    this.message = message;
  }
  toString(): string {
    return this.code;
  }
}

export type Scalar = number | string | boolean | null | CellError;

export function isError(v: unknown): v is CellError {
  return v instanceof CellError;
}

// ---------------------------------------------------------------------------
// Dates are stored as serial numbers (days since 1899-12-30), like Sheets/Excel.

const MS_PER_DAY = 86_400_000;
const EPOCH_OFFSET = 25569; // serial number of 1970-01-01

export function dateToSerial(y: number, m: number, d: number, hh = 0, mm = 0, ss = 0): number {
  return (Date.UTC(y, m - 1, d, hh, mm, ss)) / MS_PER_DAY + EPOCH_OFFSET;
}

export function serialToDate(serial: number): Date {
  return new Date(Math.round((serial - EPOCH_OFFSET) * MS_PER_DAY));
}

export function nowSerial(): number {
  const d = new Date();
  return dateToSerial(d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
}

export function todaySerial(): number {
  const d = new Date();
  return dateToSerial(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// ---------------------------------------------------------------------------
// Parsing raw input into a typed value.

export interface ParsedLiteral {
  value: Scalar;
  /** Format implied by how the value was typed ("12%" -> percent, "$5" -> currency). */
  fmt?: NumberFormat;
  dp?: number;
}

const NUM_RE = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?$/;
const ISO_DATE_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const US_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/;
const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/;

function parsePlainNumber(s: string): number | null {
  if (!s || !NUM_RE.test(s) || !/\d/.test(s)) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function decimals(s: string): number {
  const i = s.indexOf('.');
  if (i < 0) return 0;
  const m = /^\d+/.exec(s.slice(i + 1));
  return m ? m[0].length : 0;
}

function to24h(h: number, ampm: string | undefined): number {
  if (!ampm) return h;
  const pm = ampm.toLowerCase() === 'pm';
  if (h === 12) return pm ? 12 : 0;
  return pm ? h + 12 : h;
}

export function parseNumberString(raw: string): ParsedLiteral | null {
  let s = raw.trim();
  if (!s) return null;
  let neg = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    neg = true;
    s = s.slice(1, -1).trim();
  }
  if (s.endsWith('%')) {
    const n = parsePlainNumber(s.slice(0, -1).trim());
    if (n === null) return null;
    return { value: (neg ? -n : n) / 100, fmt: 'percent', dp: decimals(s) };
  }
  let sign = 1;
  if (s.startsWith('-') || s.startsWith('+')) {
    if (s[0] === '-') sign = -1;
    s = s.slice(1).trim();
  }
  if (s.startsWith('$')) {
    const n = parsePlainNumber(s.slice(1).trim());
    if (n === null) return null;
    return { value: sign * (neg ? -n : n), fmt: 'currency', dp: 2 };
  }
  const n = parsePlainNumber(s);
  if (n === null) return null;
  const hasGrouping = s.includes(',');
  return {
    value: sign * (neg ? -n : n),
    fmt: hasGrouping ? 'number' : undefined,
    dp: hasGrouping ? decimals(s) : undefined,
  };
}

export function parseDateString(s: string): ParsedLiteral | null {
  let m = ISO_DATE_RE.exec(s);
  if (m) {
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    if (!validDate(y, mo, d)) return null;
    if (m[4] !== undefined) {
      return { value: dateToSerial(y, mo, d, +m[4], +m[5], +(m[6] ?? 0)), fmt: 'datetime' };
    }
    return { value: dateToSerial(y, mo, d), fmt: 'date' };
  }
  m = US_DATE_RE.exec(s);
  if (m) {
    let y = +m[3];
    if (m[3].length === 2) y += y < 50 ? 2000 : 1900;
    const [mo, d] = [+m[1], +m[2]];
    if (!validDate(y, mo, d)) return null;
    if (m[4] !== undefined) {
      const h = to24h(+m[4], m[7]);
      return { value: dateToSerial(y, mo, d, h, +m[5], +(m[6] ?? 0)), fmt: 'datetime' };
    }
    return { value: dateToSerial(y, mo, d), fmt: 'date' };
  }
  m = TIME_RE.exec(s);
  if (m) {
    const h = to24h(+m[1], m[4]);
    const mi = +m[2];
    const sec = +(m[3] ?? 0);
    if (h > 23 || mi > 59 || sec > 59) return null;
    return { value: (h * 3600 + mi * 60 + sec) / 86400, fmt: 'time' };
  }
  return null;
}

/** Interpret raw (non-formula) cell input. */
export function parseLiteral(raw: string): ParsedLiteral {
  if (raw === '') return { value: null };
  if (raw.startsWith("'")) return { value: raw.slice(1) };
  const t = raw.trim();
  const upper = t.toUpperCase();
  if (upper === 'TRUE') return { value: true };
  if (upper === 'FALSE') return { value: false };
  return parseNumberString(t) ?? parseDateString(t) ?? { value: raw };
}

// ---------------------------------------------------------------------------
// Display formatting.

export function formatGeneralNumber(n: number): string {
  if (!Number.isFinite(n)) return '#NUM!';
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e15 || abs < 1e-9) return expo(n);
  if (Number.isInteger(n)) return String(n);
  // Up to 10 significant digits, trailing zeros removed.
  const s = parseFloat(n.toPrecision(10)).toString();
  if (s.includes('e')) return expo(n);
  return s;
}

function expo(n: number): string {
  return n.toExponential(4).replace(/\.?0+e/, 'e').toUpperCase();
}

function groupNumber(n: number, dp: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

export function formatDate(serial: number): string {
  const d = serialToDate(serial);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}

export function formatTime(serial: number): string {
  const secs = Math.round((serial - Math.floor(serial)) * 86400) % 86400;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad2(m)}:${pad2(s)} ${h < 12 ? 'AM' : 'PM'}`;
}

export function formatNumber(n: number, fmt: NumberFormat | undefined, dp?: number): string {
  switch (fmt) {
    case 'number':
      return groupNumber(n, dp ?? 2);
    case 'currency': {
      const s = groupNumber(Math.abs(n), dp ?? 2);
      return n < 0 ? `-$${s}` : `$${s}`;
    }
    case 'percent':
      return groupNumber(n * 100, dp ?? 2) + '%';
    case 'date':
      return formatDate(n);
    case 'time':
      return formatTime(n);
    case 'datetime':
      return `${formatDate(n)} ${formatTime(n)}`;
    default:
      return formatGeneralNumber(n);
  }
}

export function formatValue(v: Scalar, style?: CellStyle, implied?: { fmt?: NumberFormat; dp?: number } | null): string {
  if (v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof CellError) return v.code;
  const fmt = style?.fmt && style.fmt !== 'general' ? style.fmt : implied?.fmt;
  const dp = style?.dp ?? (style?.fmt && style.fmt !== 'general' ? undefined : implied?.dp);
  if (fmt === 'text') return formatGeneralNumber(v);
  return formatNumber(v, fmt, dp);
}

/** Convert a value to the text used when coercing to string in formulas (e.g. "&"). */
export function scalarToText(v: Scalar): string {
  if (v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof CellError) return v.code;
  return formatGeneralNumber(v);
}

// ---------------------------------------------------------------------------
// Coercion helpers used by formula evaluation

export function toNumber(v: Scalar): number | CellError {
  if (v === null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof CellError) return v;
  const t = v.trim();
  if (t === '') return 0;
  const lit = parseLiteral(t);
  if (typeof lit.value === 'number') return lit.value;
  return new CellError('#VALUE!', `Cannot convert "${v}" to a number`);
}

const TYPE_RANK = (v: Scalar) => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2);

/** Spreadsheet comparison: numbers < text < booleans; text is case-insensitive; blank equals 0/""/FALSE. */
export function compareScalars(a: Scalar, b: Scalar): number {
  if (a === null && b === null) return 0;
  if (a === null) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0;
  if (b === null) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0;
  const ra = TYPE_RANK(a);
  const rb = TYPE_RANK(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === 'number') return a < (b as number) ? -1 : a > (b as number) ? 1 : 0;
  if (typeof a === 'string') {
    const x = a.toLowerCase();
    const y = (b as string).toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return a === b ? 0 : a ? 1 : -1;
}
