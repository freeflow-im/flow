// The value scales of a chart (client/src/chart/ChartView.tsx): round tick values that span the data, on a
// linear or a logarithmic axis.

export interface Scale {
  lo: number;
  hi: number;
  ticks: number[];
  /** Where a value is, 0 at lo and 1 at hi. */
  at(v: number): number;
}

/** 1, 2, 2.5 or 5 times a power of ten: the step between about `count` ticks over [lo, hi]. */
function niceStep(span: number, count: number): number {
  const raw = span / Math.max(1, count);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
}

/** A linear scale over the values, with zero in it when `zero` (bars start at zero). */
export function linearScale(values: number[], zero: boolean, count = 5): Scale {
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (!values.length || !Number.isFinite(min) || !Number.isFinite(max)) [min, max] = [0, 1];
  if (zero) {
    min = Math.min(0, min);
    max = Math.max(0, max);
  }
  if (min === max) {
    const pad = Math.abs(min) || 1;
    [min, max] = [min - (zero && min === 0 ? 0 : pad), max + pad];
  }
  const step = niceStep(max - min, count);
  const lo = Math.floor(min / step + 1e-9) * step;
  const hi = Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return { lo, hi, ticks, at: (v) => (hi === lo ? 0 : (v - lo) / (hi - lo)) };
}

/** A base-10 logarithmic scale over the positive values, a tick at each power of ten. */
export function logScale(values: number[]): Scale {
  const pos = values.filter((v) => v > 0);
  const min = pos.length ? Math.min(...pos) : 1;
  const max = pos.length ? Math.max(...pos) : 10;
  let a = Math.floor(Math.log10(min));
  let b = Math.ceil(Math.log10(max));
  if (a === b) [a, b] = [a, a + 1];
  const ticks: number[] = [];
  for (let e = a; e <= b; e++) ticks.push(Number((10 ** e).toPrecision(12)));
  const lo = 10 ** a;
  const hi = 10 ** b;
  return { lo, hi, ticks, at: (v) => (v <= 0 ? -1 : (Math.log10(v) - a) / (b - a)) };
}
