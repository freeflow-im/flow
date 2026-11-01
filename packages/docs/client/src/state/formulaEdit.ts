// Helpers for editing formulas in the cell editor: reference insertion, highlighting, autocomplete, hints.
import { refToString, tokenize, type RefInfo } from '../../../shared/formula/tokenizer.ts';
import { FUNCTION_DOCS, FUNCTION_NAMES } from '../../../shared/formula/functions.ts';

export const REF_COLORS = ['#1a73e8', '#d93025', '#7e57c2', '#0b8043', '#f09300', '#00838f', '#c2185b', '#6d4c41'];

const INSERT_AFTER = new Set(['=', '(', ',', '+', '-', '*', '/', '^', '&', '<', '>', ':', '%']);

/** Whether a reference can be inserted at the caret (e.g. right after "=", "(", "," or an operator). */
export function isRefInsertPoint(text: string, caret: number): boolean {
  if (!text.startsWith('=')) return false;
  let i = caret - 1;
  while (i >= 0 && text[i] === ' ') i--;
  if (i < 0 || !INSERT_AFTER.has(text[i])) return false;
  const after = text.slice(caret).trimStart();
  return after === '' || /^[),+\-*/^&<>=:%]/.test(after);
}

export interface FormulaRef {
  ref: RefInfo;
  start: number; // offsets in the full text (including "=")
  end: number;
  color: string;
}

/** References in a formula with stable per-reference colors (for grid highlighting). */
export function formulaRefs(text: string): FormulaRef[] {
  if (!text.startsWith('=')) return [];
  const out: FormulaRef[] = [];
  const colorByText = new Map<string, string>();
  for (const t of tokenize(text.slice(1))) {
    if (t.type !== 'ref' || !t.ref) continue;
    const key = t.text.toUpperCase().replace(/\$/g, '');
    let color = colorByText.get(key);
    if (!color) {
      color = REF_COLORS[colorByText.size % REF_COLORS.length];
      colorByText.set(key, color);
    }
    out.push({ ref: t.ref, start: t.start + 1, end: t.end + 1, color });
  }
  return out;
}

/** Uppercase function names/refs and close any unbalanced parentheses, as Sheets does on commit. */
export function normalizeFormula(text: string): string {
  if (!text.startsWith('=') || text.length < 2) return text;
  const toks = tokenize(text.slice(1));
  let out = '=';
  let depth = 0;
  let inString = false;
  toks.forEach((t, i) => {
    const next = toks[i + 1];
    if (t.type === 'ident' && next?.type === 'lparen') out += t.text.toUpperCase();
    else if (t.type === 'ref' && t.ref) out += refToString(t.ref);
    else out += t.text;
    if (t.type === 'lparen') depth++;
    if (t.type === 'rparen') depth--;
    if (t.type === 'unknown' && t.text.startsWith('"')) inString = true;
  });
  if (inString) out += '"';
  while (depth-- > 0) out += ')';
  return out;
}

export interface Autocomplete {
  start: number;
  prefix: string;
  matches: string[];
}

export function autocompleteAt(text: string, caret: number): Autocomplete | null {
  if (!text.startsWith('=')) return null;
  const before = text.slice(0, caret);
  const m = /[A-Za-z][A-Za-z0-9.]*$/.exec(before);
  if (!m) return null;
  const start = caret - m[0].length;
  if (!isRefInsertPoint(text.slice(0, start) + text.slice(caret), start)) return null;
  if (/^[A-Za-z0-9.(]/.test(text.slice(caret))) return null;
  const prefix = m[0].toUpperCase();
  const matches = FUNCTION_NAMES.filter((n) => n.startsWith(prefix) && FUNCTION_DOCS[n]).slice(0, 8);
  if (!matches.length || (matches.length === 1 && matches[0] === prefix)) return null;
  return { start, prefix, matches };
}

/** The innermost function call surrounding the caret, and which argument the caret is in. */
export function functionHint(text: string, caret: number): { name: string; syntax: string; desc: string; arg: number } | null {
  if (!text.startsWith('=')) return null;
  const toks = tokenize(text.slice(1, caret));
  const stack: { name: string | null; arg: number }[] = [];
  toks.forEach((t, i) => {
    if (t.type === 'lparen') {
      const prev = toks.slice(0, i).reverse().find((x) => x.type !== 'ws');
      stack.push({ name: prev?.type === 'ident' ? prev.text.toUpperCase() : null, arg: 0 });
    } else if (t.type === 'rparen') stack.pop();
    else if (t.type === 'comma' && stack.length) stack[stack.length - 1].arg++;
  });
  for (let i = stack.length - 1; i >= 0; i--) {
    const f = stack[i];
    if (f.name && FUNCTION_DOCS[f.name]) return { name: f.name, ...FUNCTION_DOCS[f.name], arg: f.arg };
  }
  return null;
}
