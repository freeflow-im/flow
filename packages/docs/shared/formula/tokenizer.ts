import { colToName, nameToCol } from '../cellref.ts';
import type { ErrorCode } from '../values.ts';

export type RefKind = 'cell' | 'range' | 'cols' | 'rows';

/**
 * A reference as written in a formula. For 'cols' refs r1/r2 are unused (whole columns);
 * for 'rows' refs c1/c2 are unused. Absolute flags track "$".
 */
export interface RefInfo {
  sheet?: string;
  kind: RefKind;
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  ar1: boolean;
  ac1: boolean;
  ar2: boolean;
  ac2: boolean;
}

export type TokenType =
  | 'num'
  | 'str'
  | 'err'
  | 'ref'
  | 'ident'
  | 'op'
  | 'lparen'
  | 'rparen'
  | 'comma'
  | 'ws'
  | 'unknown';

export interface Token {
  type: TokenType;
  text: string;
  start: number;
  end: number;
  ref?: RefInfo;
}

const SHEET_RE = /('(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!/y;
const RANGE_RE = /(\$?)([A-Za-z]{1,3})(\$?)(\d+):(\$?)([A-Za-z]{1,3})(\$?)(\d+)/y;
const CELL_RE = /(\$?)([A-Za-z]{1,3})(\$?)(\d+)/y;
const COLS_RE = /(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})/y;
const ROWS_RE = /(\$?)(\d+):(\$?)(\d+)/y;
const NUM_RE = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/y;
const ERR_RE = /#(?:DIV\/0!|VALUE!|REF!|NAME\?|N\/A|NUM!|NULL!|ERROR!)/y;
const IDENT_RE = /[A-Za-z_][A-Za-z0-9_.]*/y;
const WS_RE = /\s+/y;
const IDENT_CHAR = /[A-Za-z0-9_.(!]/;

function execAt(re: RegExp, s: string, i: number): RegExpExecArray | null {
  re.lastIndex = i;
  return re.exec(s);
}

function refBoundaryOk(s: string, end: number): boolean {
  return end >= s.length || !IDENT_CHAR.test(s[end]);
}

function tryRef(s: string, i: number): { ref: RefInfo; end: number } | null {
  let m = execAt(RANGE_RE, s, i);
  if (m && refBoundaryOk(s, i + m[0].length)) {
    const r1 = +m[4] - 1;
    const r2 = +m[8] - 1;
    if (r1 >= 0 && r2 >= 0) {
      return {
        end: i + m[0].length,
        ref: {
          kind: 'range',
          c1: nameToCol(m[2]),
          r1,
          c2: nameToCol(m[6]),
          r2,
          ac1: !!m[1],
          ar1: !!m[3],
          ac2: !!m[5],
          ar2: !!m[7],
        },
      };
    }
  }
  m = execAt(CELL_RE, s, i);
  if (m && refBoundaryOk(s, i + m[0].length)) {
    const r = +m[4] - 1;
    if (r >= 0) {
      const c = nameToCol(m[2]);
      return {
        end: i + m[0].length,
        ref: { kind: 'cell', c1: c, r1: r, c2: c, r2: r, ac1: !!m[1], ar1: !!m[3], ac2: !!m[1], ar2: !!m[3] },
      };
    }
  }
  m = execAt(COLS_RE, s, i);
  if (m && refBoundaryOk(s, i + m[0].length)) {
    return {
      end: i + m[0].length,
      ref: {
        kind: 'cols',
        c1: nameToCol(m[2]),
        c2: nameToCol(m[4]),
        r1: 0,
        r2: 0,
        ac1: !!m[1],
        ac2: !!m[3],
        ar1: false,
        ar2: false,
      },
    };
  }
  m = execAt(ROWS_RE, s, i);
  if (m && refBoundaryOk(s, i + m[0].length)) {
    const r1 = +m[2] - 1;
    const r2 = +m[4] - 1;
    if (r1 >= 0 && r2 >= 0) {
      return {
        end: i + m[0].length,
        ref: { kind: 'rows', r1, r2, c1: 0, c2: 0, ar1: !!m[1], ar2: !!m[3], ac1: false, ac2: false },
      };
    }
  }
  return null;
}

export function unquoteSheet(s: string): string {
  if (s.startsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

export function quoteSheet(name: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name) && !/^(TRUE|FALSE)$/i.test(name)) {
    return name;
  }
  return `'${name.replace(/'/g, "''")}'`;
}

/** Tokenize a formula body (the text after the leading "="). Never throws. */
export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const push = (type: TokenType, end: number, ref?: RefInfo) => {
    out.push({ type, text: src.slice(i, end), start: i, end, ref });
    i = end;
  };
  while (i < src.length) {
    const ch = src[i];
    let m: RegExpExecArray | null;

    if ((m = execAt(WS_RE, src, i))) {
      push('ws', i + m[0].length);
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= src.length) {
          push('unknown', src.length);
          break;
        }
        if (src[j] === '"') {
          if (src[j + 1] === '"') {
            j += 2;
            continue;
          }
          push('str', j + 1);
          break;
        }
        j++;
      }
      continue;
    }
    if (ch === '#' && (m = execAt(ERR_RE, src, i))) {
      push('err', i + m[0].length);
      continue;
    }
    // Sheet-qualified reference: Sheet1!A1, 'My Sheet'!A1:B2
    if ((ch === "'" || /[A-Za-z_]/.test(ch)) && (m = execAt(SHEET_RE, src, i))) {
      const afterSheet = i + m[0].length;
      const r = tryRef(src, afterSheet);
      if (r) {
        r.ref.sheet = unquoteSheet(m[1]);
        push('ref', r.end, r.ref);
        continue;
      }
      push('unknown', afterSheet);
      continue;
    }
    if (/[A-Za-z$0-9]/.test(ch)) {
      const r = tryRef(src, i);
      if (r) {
        push('ref', r.end, r.ref);
        continue;
      }
    }
    if ((m = execAt(NUM_RE, src, i))) {
      push('num', i + m[0].length);
      continue;
    }
    if ((m = execAt(IDENT_RE, src, i))) {
      push('ident', i + m[0].length);
      continue;
    }
    if (ch === '(') {
      push('lparen', i + 1);
      continue;
    }
    if (ch === ')') {
      push('rparen', i + 1);
      continue;
    }
    if (ch === ',') {
      push('comma', i + 1);
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '<>') {
      push('op', i + 2);
      continue;
    }
    if ('+-*/^&=<>%'.includes(ch)) {
      push('op', i + 1);
      continue;
    }
    push('unknown', i + 1);
  }
  return out;
}

export function errorTokenCode(text: string): ErrorCode {
  return text.toUpperCase() as ErrorCode;
}

/** Render a reference back to A1 text (with sheet prefix if present). */
export function refToString(ref: RefInfo): string {
  const prefix = ref.sheet !== undefined ? quoteSheet(ref.sheet) + '!' : '';
  const d = (abs: boolean) => (abs ? '$' : '');
  const cell = (r: number, c: number, ar: boolean, ac: boolean) => `${d(ac)}${colToName(c)}${d(ar)}${r + 1}`;
  switch (ref.kind) {
    case 'cell':
      return prefix + cell(ref.r1, ref.c1, ref.ar1, ref.ac1);
    case 'range':
      return prefix + cell(ref.r1, ref.c1, ref.ar1, ref.ac1) + ':' + cell(ref.r2, ref.c2, ref.ar2, ref.ac2);
    case 'cols':
      return `${prefix}${d(ref.ac1)}${colToName(ref.c1)}:${d(ref.ac2)}${colToName(ref.c2)}`;
    case 'rows':
      return `${prefix}${d(ref.ar1)}${ref.r1 + 1}:${d(ref.ar2)}${ref.r2 + 1}`;
  }
}
