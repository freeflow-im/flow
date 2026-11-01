import type { ErrorCode } from '../values.ts';
import { errorTokenCode, tokenize, type RefInfo, type Token } from './tokenizer.ts';

export type Node =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'err'; v: ErrorCode }
  | { t: 'empty' }
  | { t: 'ref'; ref: RefInfo }
  | { t: 'name'; name: string }
  | { t: 'un'; op: '-' | '+'; a: Node }
  | { t: 'pct'; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'call'; name: string; args: Node[] };

export class ParseError extends Error {}

const BINARY_PREC: Record<string, number> = {
  '=': 1,
  '<>': 1,
  '<': 1,
  '>': 1,
  '<=': 1,
  '>=': 1,
  '&': 2,
  '+': 3,
  '-': 3,
  '*': 4,
  '/': 4,
  '^': 5,
};
const PREFIX_PREC = 6;

class Parser {
  private toks: Token[];
  private pos = 0;
  constructor(toks: Token[]) {
    this.toks = toks.filter((t) => t.type !== 'ws');
  }

  private peek(): Token | undefined {
    return this.toks[this.pos];
  }

  private next(): Token {
    const t = this.toks[this.pos++];
    if (!t) throw new ParseError('Unexpected end of formula');
    return t;
  }

  parseFormula(): Node {
    if (this.toks.length === 0) throw new ParseError('Empty formula');
    const n = this.expr(0);
    const t = this.peek();
    if (t) throw new ParseError(`Unexpected "${t.text}"`);
    return n;
  }

  private expr(minPrec: number): Node {
    let left = this.prefix();
    for (;;) {
      const t = this.peek();
      if (!t || t.type !== 'op') break;
      if (t.text === '%') {
        this.pos++;
        left = { t: 'pct', a: left };
        continue;
      }
      const prec = BINARY_PREC[t.text];
      if (prec === undefined || prec <= minPrec) break;
      this.pos++;
      const right = this.expr(prec);
      left = { t: 'bin', op: t.text, a: left, b: right };
    }
    return left;
  }

  private prefix(): Node {
    const t = this.next();
    switch (t.type) {
      case 'num':
        return { t: 'num', v: Number(t.text) };
      case 'str':
        return { t: 'str', v: t.text.slice(1, -1).replace(/""/g, '"') };
      case 'err':
        return { t: 'err', v: errorTokenCode(t.text) };
      case 'ref':
        return { t: 'ref', ref: t.ref! };
      case 'op':
        if (t.text === '-' || t.text === '+') {
          const a = this.expr(PREFIX_PREC - 1 + 0.5);
          return { t: 'un', op: t.text, a };
        }
        throw new ParseError(`Unexpected "${t.text}"`);
      case 'lparen': {
        const n = this.expr(0);
        const close = this.next();
        if (close.type !== 'rparen') throw new ParseError('Expected ")"');
        return n;
      }
      case 'ident': {
        const nt = this.peek();
        if (nt?.type === 'lparen') {
          this.pos++;
          return { t: 'call', name: t.text.toUpperCase(), args: this.args() };
        }
        const up = t.text.toUpperCase();
        if (up === 'TRUE') return { t: 'bool', v: true };
        if (up === 'FALSE') return { t: 'bool', v: false };
        return { t: 'name', name: t.text };
      }
      default:
        throw new ParseError(`Unexpected "${t.text}"`);
    }
  }

  private args(): Node[] {
    const args: Node[] = [];
    if (this.peek()?.type === 'rparen') {
      this.pos++;
      return args;
    }
    for (;;) {
      const t = this.peek();
      if (t?.type === 'comma' || t?.type === 'rparen') {
        args.push({ t: 'empty' });
      } else {
        args.push(this.expr(0));
      }
      const sep = this.next();
      if (sep.type === 'rparen') return args;
      if (sep.type !== 'comma') throw new ParseError(`Unexpected "${sep.text}"`);
    }
  }
}

/** Parse a formula body (without the leading "="). Throws ParseError. */
export function parseFormula(body: string): Node {
  const toks = tokenize(body);
  const bad = toks.find((t) => t.type === 'unknown');
  if (bad) throw new ParseError(`Unexpected "${bad.text}"`);
  return new Parser(toks).parseFormula();
}

/** Collect all references in an AST. */
export function collectRefs(n: Node, out: RefInfo[] = []): RefInfo[] {
  switch (n.t) {
    case 'ref':
      out.push(n.ref);
      break;
    case 'un':
    case 'pct':
      collectRefs(n.a, out);
      break;
    case 'bin':
      collectRefs(n.a, out);
      collectRefs(n.b, out);
      break;
    case 'call':
      for (const a of n.args) collectRefs(a, out);
      break;
  }
  return out;
}
