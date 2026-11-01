import type { Scalar } from '../values.ts';
import type { Engine } from './engine.ts';
import type { Node } from './parser.ts';

/** A resolved rectangular block of cells on a tab. Bounds are inclusive and finite. */
export interface RangeVal {
  kind: 'range';
  tabId: string;
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export type Value = Scalar | RangeVal;

export function isRange(v: Value): v is RangeVal {
  return typeof v === 'object' && v !== null && (v as RangeVal).kind === 'range';
}

export interface EvalContext {
  engine: Engine;
  tabId: string;
  row: number;
  col: number;
  eval(n: Node): Value;
}
