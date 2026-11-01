import { cellKey, parseCellKey } from '../cellref.ts';
import { autoLinkUrl, safeLinkUrl } from '../links.ts';
import type { NumberFormat, Tab, Workbook } from '../types.ts';
import { CellError, compareScalars, parseLiteral, scalarToText, toNumber, type ParsedLiteral, type Scalar } from '../values.ts';
import { isFormula } from './adjust.ts';
import { FUNCTIONS, VOLATILE, impliedFormatOfCall } from './functions.ts';
import { collectRefs, parseFormula, ParseError, type Node } from './parser.ts';
import type { RefInfo } from './tokenizer.ts';
import { isRange, type EvalContext, type RangeVal, type Value } from './types.ts';

export { isRange, type EvalContext, type RangeVal, type Value };

interface Dep {
  tabId: string;
  r1: number;
  c1: number;
  r2: number; // may be Infinity for whole-column refs
  c2: number;
  fid: string;
}

interface FormulaInfo {
  fid: string;
  tabId: string;
  r: number;
  c: number;
  src: string;
  ast: Node | null;
  error?: CellError;
  deps: Dep[];
  volatile: boolean;
}

export interface ImpliedFormat {
  fmt?: NumberFormat;
  dp?: number;
}

const fidOf = (tabId: string, key: string) => tabId + '!' + key;

function containsVolatile(n: Node): boolean {
  switch (n.t) {
    case 'call':
      return VOLATILE.has(n.name) || n.args.some(containsVolatile);
    case 'un':
    case 'pct':
      return containsVolatile(n.a);
    case 'bin':
      return containsVolatile(n.a) || containsVolatile(n.b);
    default:
      return false;
  }
}

/**
 * Evaluates a workbook's formulas. Values are cached and invalidated incrementally
 * through a dependency index built from each formula's references.
 */
export class Engine {
  private tabById = new Map<string, Tab>();
  private tabByName = new Map<string, Tab>();
  private values = new Map<string, Scalar>();
  private formats = new Map<string, ImpliedFormat>();
  private links = new Map<string, string>();
  private formulas = new Map<string, FormulaInfo>();
  private cellDeps = new Map<string, Set<string>>();
  private rangeDeps = new Map<string, Set<Dep>>(); // tabId -> multi-cell deps
  private computing = new Set<string>();
  private extents = new Map<string, { rows: number; cols: number }>();
  private literalCache = new Map<string, ParsedLiteral>();
  private astCache = new Map<string, Node | ParseError>();

  constructor(wb?: Workbook) {
    if (wb) this.load(wb);
  }

  // -------------------------------------------------------------------------
  // Public API

  /** Full rebuild: call after structural changes (tabs added/removed/renamed, rows inserted, ...). */
  load(wb: Workbook): void {
    this.tabById.clear();
    this.tabByName.clear();
    this.values.clear();
    this.formats.clear();
    this.links.clear();
    this.formulas.clear();
    this.cellDeps.clear();
    this.rangeDeps.clear();
    this.extents.clear();
    for (const tab of wb.tabs) {
      this.tabById.set(tab.id, tab);
      this.tabByName.set(tab.name.toLowerCase(), tab);
      let rows = 0;
      let cols = 0;
      for (const key in tab.cells) {
        const p = parseCellKey(key);
        if (!p) continue;
        if (p.r + 1 > rows) rows = p.r + 1;
        if (p.c + 1 > cols) cols = p.c + 1;
        if (isFormula(tab.cells[key].v)) this.register(tab, key, p.r, p.c);
      }
      this.extents.set(tab.id, { rows, cols });
    }
    this.computeAll([...this.formulas.keys()]);
  }

  /** Incremental recalculation after the given cells changed (content only, same tab structure). */
  update(changes: { tabId: string; key: string }[]): void {
    const changedIds: { tabId: string; r: number; c: number; fid: string }[] = [];
    for (const { tabId, key } of changes) {
      const tab = this.tabById.get(tabId);
      const p = parseCellKey(key);
      if (!tab || !p) continue;
      const fid = fidOf(tabId, key);
      this.unregister(fid);
      if (isFormula(tab.cells[key]?.v)) this.register(tab, key, p.r, p.c);
      const ext = this.extents.get(tabId)!;
      if (tab.cells[key]) {
        ext.rows = Math.max(ext.rows, p.r + 1);
        ext.cols = Math.max(ext.cols, p.c + 1);
      }
      changedIds.push({ tabId, r: p.r, c: p.c, fid });
    }

    // Find all transitive dependents.
    const dirty = new Set<string>();
    const queue = [...changedIds];
    while (queue.length) {
      const { tabId, r, c, fid } = queue.pop()!;
      if (this.formulas.has(fid)) dirty.add(fid);
      for (const dep of this.dependentsOf(tabId, r, c, fid)) {
        if (dirty.has(dep)) continue;
        dirty.add(dep);
        const f = this.formulas.get(dep);
        if (f) queue.push({ tabId: f.tabId, r: f.r, c: f.c, fid: dep });
      }
    }
    for (const f of this.formulas.values()) if (f.volatile) dirty.add(f.fid);
    for (const fid of dirty) {
      this.values.delete(fid);
      this.formats.delete(fid);
      this.links.delete(fid);
    }
    for (const { fid } of changedIds) {
      this.values.delete(fid);
      this.formats.delete(fid);
      this.links.delete(fid);
    }
    this.computeAll([...dirty]);
  }

  getTabByName(name: string): Tab | undefined {
    return this.tabByName.get(name.toLowerCase());
  }

  getTab(id: string): Tab | undefined {
    return this.tabById.get(id);
  }

  extent(tabId: string): { rows: number; cols: number } {
    return this.extents.get(tabId) ?? { rows: 0, cols: 0 };
  }

  /** Evaluated value of a cell. */
  getValue(tabId: string, r: number, c: number): Scalar {
    const tab = this.tabById.get(tabId);
    if (!tab) return new CellError('#REF!', 'Sheet not found');
    const key = cellKey(r, c);
    const cell = tab.cells[key];
    if (!cell || cell.v === '') return null;
    if (isFormula(cell.v)) return this.computeFormula(fidOf(tabId, key));
    return this.literal(cell.v).value;
  }

  /** Number format implied by the cell's input or formula (used when the cell has no explicit format). */
  getImpliedFormat(tabId: string, r: number, c: number): ImpliedFormat | undefined {
    const tab = this.tabById.get(tabId);
    const key = cellKey(r, c);
    const cell = tab?.cells[key];
    if (!cell) return undefined;
    if (isFormula(cell.v)) {
      const fid = fidOf(tabId, key);
      this.computeFormula(fid);
      return this.formats.get(fid);
    }
    const lit = this.literal(cell.v);
    return lit.fmt ? lit : undefined;
  }

  /**
   * URL the cell links to, or null: a =HYPERLINK(url, ...) formula, or plain text that is a full http(s) URL.
   * Only http(s) and mailto URLs are returned.
   */
  getLink(tabId: string, r: number, c: number): string | null {
    const tab = this.tabById.get(tabId);
    const key = cellKey(r, c);
    const cell = tab?.cells[key];
    if (!cell || cell.v === '') return null;
    if (isFormula(cell.v)) {
      const fid = fidOf(tabId, key);
      this.computeFormula(fid);
      return this.links.get(fid) ?? null;
    }
    const v = this.literal(cell.v).value;
    return typeof v === 'string' ? autoLinkUrl(v) : null;
  }

  /** Error message for a cell holding an error value (for tooltips). */
  getErrorMessage(tabId: string, r: number, c: number): string | null {
    const v = this.getValue(tabId, r, c);
    return v instanceof CellError ? v.message || v.code : null;
  }

  /** Evaluate a standalone formula in the context of a cell (used by tests and tools). */
  evaluate(formula: string, tabId: string, r = 0, c = 0): Scalar {
    const ast = this.parse(formula.startsWith('=') ? formula.slice(1) : formula);
    if (ast instanceof ParseError) return new CellError('#ERROR!', ast.message);
    return this.toScalar(this.evalNode(ast, this.makeCtx(tabId, r, c)));
  }

  // -------------------------------------------------------------------------
  // Values & coercion used by functions

  literal(raw: string): ParsedLiteral {
    let lit = this.literalCache.get(raw);
    if (!lit) {
      if (this.literalCache.size > 50_000) this.literalCache.clear();
      lit = parseLiteral(raw);
      this.literalCache.set(raw, lit);
    }
    return lit;
  }

  toScalar(v: Value): Scalar {
    if (!isRange(v)) return v;
    if (v.r1 === v.r2 && v.c1 === v.c2) return this.getValue(v.tabId, v.r1, v.c1);
    return new CellError('#VALUE!', 'Expected a single value but got a range');
  }

  // -------------------------------------------------------------------------
  // Internals

  private parse(body: string): Node | ParseError {
    let ast = this.astCache.get(body);
    if (!ast) {
      try {
        ast = parseFormula(body);
      } catch (e) {
        ast = e instanceof ParseError ? e : new ParseError(String(e));
      }
      if (this.astCache.size > 20_000) this.astCache.clear();
      this.astCache.set(body, ast);
    }
    return ast;
  }

  private register(tab: Tab, key: string, r: number, c: number): void {
    const fid = fidOf(tab.id, key);
    const src = tab.cells[key].v;
    const parsed = this.parse(src.slice(1));
    const info: FormulaInfo = { fid, tabId: tab.id, r, c, src, ast: null, deps: [], volatile: false };
    if (parsed instanceof ParseError) {
      info.error = new CellError('#ERROR!', `Formula parse error: ${parsed.message}`);
    } else {
      info.ast = parsed;
      info.volatile = containsVolatile(parsed);
      for (const ref of collectRefs(parsed)) {
        const dep = this.refToDep(ref, tab.id, fid);
        if (dep) info.deps.push(dep);
      }
    }
    this.formulas.set(fid, info);
    for (const d of info.deps) {
      if (d.r1 === d.r2 && d.c1 === d.c2) {
        const id = fidOf(d.tabId, cellKey(d.r1, d.c1));
        let set = this.cellDeps.get(id);
        if (!set) this.cellDeps.set(id, (set = new Set()));
        set.add(fid);
      } else {
        let set = this.rangeDeps.get(d.tabId);
        if (!set) this.rangeDeps.set(d.tabId, (set = new Set()));
        set.add(d);
      }
    }
  }

  private unregister(fid: string): void {
    const info = this.formulas.get(fid);
    if (!info) return;
    for (const d of info.deps) {
      if (d.r1 === d.r2 && d.c1 === d.c2) {
        this.cellDeps.get(fidOf(d.tabId, cellKey(d.r1, d.c1)))?.delete(fid);
      } else {
        this.rangeDeps.get(d.tabId)?.delete(d);
      }
    }
    this.formulas.delete(fid);
  }

  private refToDep(ref: RefInfo, ownTabId: string, fid: string): Dep | null {
    const tab = ref.sheet !== undefined ? this.tabByName.get(ref.sheet.toLowerCase()) : this.tabById.get(ownTabId);
    if (!tab) return null;
    switch (ref.kind) {
      case 'cols':
        return { tabId: tab.id, r1: 0, r2: Infinity, c1: Math.min(ref.c1, ref.c2), c2: Math.max(ref.c1, ref.c2), fid };
      case 'rows':
        return { tabId: tab.id, c1: 0, c2: Infinity, r1: Math.min(ref.r1, ref.r2), r2: Math.max(ref.r1, ref.r2), fid };
      default:
        return {
          tabId: tab.id,
          r1: Math.min(ref.r1, ref.r2),
          r2: Math.max(ref.r1, ref.r2),
          c1: Math.min(ref.c1, ref.c2),
          c2: Math.max(ref.c1, ref.c2),
          fid,
        };
    }
  }

  private *dependentsOf(tabId: string, r: number, c: number, fid: string): Iterable<string> {
    const direct = this.cellDeps.get(fid);
    if (direct) yield* direct;
    const list = this.rangeDeps.get(tabId);
    if (list) {
      for (const d of list) {
        if (r >= d.r1 && r <= d.r2 && c >= d.c1 && c <= d.c2) yield d.fid;
      }
    }
  }

  private computeAll(fids: string[]): void {
    // Evaluate top-to-bottom, left-to-right so typical downward chains hit the cache instead of recursing deeply.
    const infos = fids.map((f) => this.formulas.get(f)).filter((f): f is FormulaInfo => !!f);
    infos.sort((a, b) => a.r - b.r || a.c - b.c);
    for (const f of infos) this.computeFormula(f.fid);
  }

  private computeFormula(fid: string): Scalar {
    const cached = this.values.get(fid);
    if (cached !== undefined) return cached;
    const info = this.formulas.get(fid);
    if (!info) return null;
    if (this.computing.has(fid)) return new CellError('#REF!', 'Circular dependency detected');
    let result: Scalar;
    if (info.error) {
      result = info.error;
    } else {
      this.computing.add(fid);
      try {
        const ctx = this.makeCtx(info.tabId, info.r, info.c);
        result = this.toScalar(this.evalNode(info.ast!, ctx));
        const ast = info.ast!;
        if (ast.t === 'call' && ast.name === 'HYPERLINK' && ast.args[0] && !(result instanceof CellError)) {
          const url = this.toScalar(this.evalNode(ast.args[0], ctx));
          const safe = typeof url === 'string' ? safeLinkUrl(url) : null;
          if (safe) this.links.set(fid, safe);
        }
        const fmt = this.impliedFormat(info.ast!, info.tabId, 0);
        if (fmt) this.formats.set(fid, fmt);
      } catch (e) {
        result =
          e instanceof RangeError
            ? new CellError('#REF!', 'Formula chain too deep to evaluate')
            : new CellError('#ERROR!', String(e instanceof Error ? e.message : e));
      } finally {
        this.computing.delete(fid);
      }
    }
    if (typeof result === 'number' && !Number.isFinite(result)) result = new CellError('#NUM!', 'Result is not a finite number');
    // A cycle error seen while this cell was mid-evaluation elsewhere is only cached once the outer evaluation settles.
    this.values.set(fid, result);
    return result;
  }

  private makeCtx(tabId: string, row: number, col: number): EvalContext {
    const ctx: EvalContext = {
      engine: this,
      tabId,
      row,
      col,
      eval: (n: Node) => this.evalNode(n, ctx),
    };
    return ctx;
  }

  resolveRef(ref: RefInfo, ownTabId: string): RangeVal | CellError {
    const tab = ref.sheet !== undefined ? this.tabByName.get(ref.sheet.toLowerCase()) : this.tabById.get(ownTabId);
    if (!tab) return new CellError('#REF!', `Unresolved sheet name '${ref.sheet}'`);
    const ext = this.extents.get(tab.id) ?? { rows: 0, cols: 0 };
    switch (ref.kind) {
      case 'cols':
        return {
          kind: 'range',
          tabId: tab.id,
          r1: 0,
          r2: Math.max(0, Math.min(tab.rows, ext.rows) - 1),
          c1: Math.min(ref.c1, ref.c2),
          c2: Math.max(ref.c1, ref.c2),
        };
      case 'rows':
        return {
          kind: 'range',
          tabId: tab.id,
          c1: 0,
          c2: Math.max(0, Math.min(tab.cols, ext.cols) - 1),
          r1: Math.min(ref.r1, ref.r2),
          r2: Math.max(ref.r1, ref.r2),
        };
      default:
        return {
          kind: 'range',
          tabId: tab.id,
          r1: Math.min(ref.r1, ref.r2),
          r2: Math.max(ref.r1, ref.r2),
          c1: Math.min(ref.c1, ref.c2),
          c2: Math.max(ref.c1, ref.c2),
        };
    }
  }

  private evalNode(n: Node, ctx: EvalContext): Value {
    switch (n.t) {
      case 'num':
      case 'str':
      case 'bool':
        return n.v;
      case 'err':
        return new CellError(n.v);
      case 'empty':
        return null;
      case 'ref':
        return this.resolveRef(n.ref, ctx.tabId);
      case 'name':
        return new CellError('#NAME?', `Unknown range name: '${n.name}'`);
      case 'un': {
        const v = toNumber(this.toScalar(this.evalNode(n.a, ctx)));
        if (v instanceof CellError) return v;
        return n.op === '-' ? -v : v;
      }
      case 'pct': {
        const v = toNumber(this.toScalar(this.evalNode(n.a, ctx)));
        return v instanceof CellError ? v : v / 100;
      }
      case 'bin':
        return this.evalBinary(n.op, this.toScalar(this.evalNode(n.a, ctx)), this.toScalar(this.evalNode(n.b, ctx)));
      case 'call': {
        const fn = FUNCTIONS[n.name];
        if (!fn) return new CellError('#NAME?', `Unknown function: ${n.name}`);
        return fn(n.args, ctx);
      }
    }
  }

  private evalBinary(op: string, a: Scalar, b: Scalar): Scalar {
    if (op === '&') {
      if (a instanceof CellError) return a;
      if (b instanceof CellError) return b;
      return scalarToText(a) + scalarToText(b);
    }
    if (op === '=' || op === '<>' || op === '<' || op === '>' || op === '<=' || op === '>=') {
      if (a instanceof CellError) return a;
      if (b instanceof CellError) return b;
      const cmp = compareScalars(a, b);
      switch (op) {
        case '=':
          return cmp === 0;
        case '<>':
          return cmp !== 0;
        case '<':
          return cmp < 0;
        case '>':
          return cmp > 0;
        case '<=':
          return cmp <= 0;
        default:
          return cmp >= 0;
      }
    }
    const x = toNumber(a);
    if (x instanceof CellError) return x;
    const y = toNumber(b);
    if (y instanceof CellError) return y;
    switch (op) {
      case '+':
        return x + y;
      case '-':
        return x - y;
      case '*':
        return x * y;
      case '/':
        return y === 0 ? new CellError('#DIV/0!', 'Division by zero') : x / y;
      case '^': {
        const r = Math.pow(x, y);
        return Number.isFinite(r) ? r : new CellError('#NUM!', 'Invalid exponentiation');
      }
    }
    return new CellError('#ERROR!', `Unknown operator ${op}`);
  }

  private impliedFormat(n: Node, tabId: string, depth: number): ImpliedFormat | undefined {
    if (depth > 8) return undefined;
    switch (n.t) {
      case 'ref': {
        const rg = this.resolveRef(n.ref, tabId);
        if (rg instanceof CellError) return undefined;
        return this.getImpliedFormat(rg.tabId, rg.r1, rg.c1);
      }
      case 'bin':
        if (n.op === '+' || n.op === '-' || n.op === '*' || n.op === '/') {
          const left = this.impliedFormat(n.a, tabId, depth + 1);
          if (left?.fmt && (n.op === '+' || n.op === '-' || left.fmt === 'currency')) {
            // date - date is a number of days, not a date
            if (n.op === '-' && (left.fmt === 'date' || left.fmt === 'datetime')) {
              const right = this.impliedFormat(n.b, tabId, depth + 1);
              if (right?.fmt === 'date' || right?.fmt === 'datetime') return undefined;
            }
            return left;
          }
          if (n.op === '+' || n.op === '*') return this.impliedFormat(n.b, tabId, depth + 1);
        }
        return undefined;
      case 'call': {
        const own = impliedFormatOfCall(n.name);
        if (own) return { fmt: own };
        if (['SUM', 'AVERAGE', 'MIN', 'MAX', 'MEDIAN', 'ROUND', 'SUMIF', 'SUMIFS', 'AVERAGEIF', 'AVERAGEIFS', 'MAXIFS', 'MINIFS', 'IF', 'IFERROR'].includes(n.name)) {
          const idx = n.name === 'SUMIF' || n.name === 'AVERAGEIF' ? 2 : n.name === 'IF' ? 1 : 0;
          const arg = n.args[idx] ?? n.args[0];
          return arg ? this.impliedFormat(arg, tabId, depth + 1) : undefined;
        }
        return undefined;
      }
      default:
        return undefined;
    }
  }
}

