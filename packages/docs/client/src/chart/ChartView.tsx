// Draws a chart (shared/chart.ts) as SVG from the data chartData reads: column, bar, line, area, pie and
// scatter, with a title, a legend, axis titles, gridlines and value axes in the values' number format. SVG
// rather than a canvas, so it draws the same on the grid, on slides, in thumbnails and in PDFs and pictures
// made from the DOM. A point's value shows on hover (an SVG <title>).
import type { ReactNode } from 'react';
import { CHART_COLORS, formatChartValue, formatTick, type Chart, type ChartData } from '../../../shared/chart.ts';
import { linearScale, logScale, type Scale } from '../../../shared/chartScale.ts';

const FONT = "Roboto, -apple-system, 'Segoe UI', Arial, sans-serif";
const TEXT = '#3c4043';
const MUTED = '#5f6368';
const GRID = '#e0e0e0';
const AXIS = '#9aa0a6';

/** About how wide text is drawn, for laying out labels without measuring them. */
const textW = (s: string, size: number) => s.length * size * 0.56;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s);

export interface ChartLook {
  /** Background; white by default. */
  background?: string;
  /** Text colors, for a dark slide. */
  text?: string;
  muted?: string;
  grid?: string;
  font?: string;
}

export function ChartView({ chart, data, width, height, look = {} }: { chart: Chart; data: ChartData; width: number; height: number; look?: ChartLook }) {
  const text = look.text ?? TEXT;
  const muted = look.muted ?? MUTED;
  const grid = look.grid ?? GRID;
  const font = look.font ?? FONT;
  const w = Math.max(40, width);
  const h = Math.max(40, height);
  const pie = chart.type === 'pie';

  // --- Title and legend take their space first; the plot gets the rest.
  let top = 10;
  const parts: ReactNode[] = [];
  if (chart.title) {
    parts.push(
      <text key="title" x={w / 2} y={24} textAnchor="middle" fontSize={15} fontWeight={500} fill={text}>
        {clip(chart.title, Math.floor((w - 20) / 8))}
      </text>,
    );
    top = 38;
  }
  const entries = pie ? data.categories.map((c, i) => ({ name: c, color: pieColor(data, i) })) : data.series.map((s) => ({ name: s.name, color: s.color }));
  const legend = chart.legend ?? (entries.length > 1 || pie ? 'right' : 'none');
  let right = w - 14;
  let bottom = h - 10;
  if (legend !== 'none' && entries.length && !data.error) {
    if (legend === 'right') {
      const lw = Math.min(w * 0.35, Math.max(...entries.map((e) => textW(e.name, 12))) + 28);
      const shown = Math.max(1, Math.floor((h - top - 10) / 20));
      const startY = top + Math.max(0, (h - top - 10 - Math.min(shown, entries.length) * 20) / 2);
      entries.slice(0, shown).forEach((e, i) => parts.push(<LegendEntry key={`lg${i}`} x={w - lw} y={startY + i * 20 + 10} color={e.color} name={clip(e.name, Math.floor((lw - 24) / 6.7))} fill={text} />));
      right = w - lw - 12;
    } else {
      // One line of entries across the top or the bottom (those that fit).
      const items: { x: number; e: (typeof entries)[number]; label: string }[] = [];
      let x = 0;
      for (const e of entries) {
        const label = clip(e.name, 24);
        const iw = textW(label, 12) + 30;
        if (x + iw > w - 20 && items.length) break;
        items.push({ x, e, label });
        x += iw;
      }
      const left0 = (w - x) / 2;
      const y = legend === 'top' ? top + 8 : h - 14;
      items.forEach((it, i) => parts.push(<LegendEntry key={`lg${i}`} x={left0 + it.x} y={y} color={it.e.color} name={it.label} fill={text} />));
      if (legend === 'top') top += 24;
      else bottom = h - 32;
    }
  }

  if (data.error) {
    return (
      <Frame w={w} h={h} bg={look.background} font={font}>
        {parts}
        <text x={w / 2} y={(top + h) / 2} textAnchor="middle" fontSize={13} fill={muted}>
          {clip(data.error, Math.floor(w / 7))}
        </text>
      </Frame>
    );
  }

  if (pie) {
    parts.push(<PieSlices key="pie" data={data} cx={(14 + right) / 2} cy={(top + bottom) / 2} r={Math.max(10, Math.min(right - 14, bottom - top) / 2 - 4)} bg={look.background ?? '#fff'} />);
    return (
      <Frame w={w} h={h} bg={look.background} font={font}>
        {parts}
      </Frame>
    );
  }

  // --- Axes
  const horizontal = chart.type === 'bar';
  const scatter = chart.type === 'scatter';
  const stacked = !!chart.stacked && (chart.type === 'column' || chart.type === 'bar' || chart.type === 'area');
  const n = Math.max(data.categories.length, ...data.series.map((s) => s.points.length));
  const values: number[] = [];
  if (stacked) {
    for (let i = 0; i < n; i++) {
      let pos = 0;
      let neg = 0;
      for (const s of data.series) {
        const v = s.points[i]?.y;
        if (v == null) continue;
        if (v >= 0) pos += v;
        else neg += v;
      }
      values.push(pos, neg);
    }
  } else for (const s of data.series) for (const p of s.points) if (p.y != null) values.push(p.y);
  const log = !!chart.logScale;
  const vScale: Scale = log ? logScale(values) : linearScale(values, chart.type !== 'line' && !scatter);
  const xs = scatter ? data.series.flatMap((s) => s.points.map((p) => p.x).filter((x): x is number => x != null)) : [];
  const xScale = scatter ? linearScale(xs, false) : null;
  const fmtV = (v: number) => formatChartValue(v, data.format);
  const fmtX = (v: number) => formatChartValue(v, data.xFormat);

  // Room for the value labels and the axis titles.
  const tickStep = (s: Scale, t: number, i: number) => (log ? t : (s.ticks[1] ?? s.hi) - (s.ticks[0] ?? s.lo) || Math.abs(t) || i);
  const vLabels = vScale.ticks.map((t, i) => formatTick(t, data.format, tickStep(vScale, t, i)));
  let left = 14;
  if (chart.yTitle) left += 18;
  if (!horizontal) left += Math.max(...vLabels.map((l) => textW(l, 11))) + 8;
  else left += Math.min(w * 0.3, Math.max(0, ...data.categories.map((c) => textW(clip(c, 24), 11)))) + 8;
  if (chart.xTitle) bottom -= 18;
  bottom -= 20;
  const pw = Math.max(10, right - left);
  const ph = Math.max(10, bottom - top);

  const valueAt = (v: number) => {
    const t = Math.max(0, Math.min(1, vScale.at(v)));
    return horizontal ? left + t * pw : bottom - t * ph;
  };
  const band = (horizontal ? ph : pw) / Math.max(1, n);
  const catAt = (i: number) => (horizontal ? top + band * (i + 0.5) : left + band * (i + 0.5));
  const xAt = (x: number) => left + Math.max(0, Math.min(1, xScale!.at(x))) * pw;

  // Gridlines and the value axis' labels.
  vScale.ticks.forEach((t, i) => {
    const p = valueAt(t);
    parts.push(horizontal ? <line key={`g${i}`} x1={p} x2={p} y1={top} y2={bottom} stroke={grid} /> : <line key={`g${i}`} x1={left} x2={right} y1={p} y2={p} stroke={grid} />);
    parts.push(
      horizontal ? (
        <text key={`vt${i}`} x={p} y={bottom + 15} textAnchor="middle" fontSize={11} fill={muted}>
          {vLabels[i]}
        </text>
      ) : (
        <text key={`vt${i}`} x={left - 6} y={p + 4} textAnchor="end" fontSize={11} fill={muted}>
          {vLabels[i]}
        </text>
      ),
    );
  });
  // The category (or x) axis and its labels, as many as fit.
  parts.push(horizontal ? <line key="axis" x1={left} x2={left} y1={top} y2={bottom} stroke={AXIS} /> : <line key="axis" x1={left} x2={right} y1={bottom} y2={bottom} stroke={AXIS} />);
  if (scatter && xScale) {
    xScale.ticks.forEach((t, i) =>
      parts.push(
        <text key={`xt${i}`} x={xAt(t)} y={bottom + 15} textAnchor="middle" fontSize={11} fill={muted}>
          {formatTick(t, data.xFormat, tickStep(xScale, t, i))}
        </text>,
      ),
    );
  } else if (horizontal) {
    const step = Math.max(1, Math.ceil(16 / band));
    data.categories.forEach((c, i) => {
      if (i % step) return;
      parts.push(
        <text key={`ct${i}`} x={left - 6} y={catAt(i) + 4} textAnchor="end" fontSize={11} fill={muted}>
          {clip(c, 24)}
        </text>,
      );
    });
  } else {
    const longest = Math.max(1, ...data.categories.map((c) => textW(clip(c, 16), 11)));
    const step = Math.max(1, Math.ceil((longest + 8) / band));
    data.categories.forEach((c, i) => {
      if (i % step) return;
      parts.push(
        <text key={`ct${i}`} x={catAt(i)} y={bottom + 15} textAnchor="middle" fontSize={11} fill={muted}>
          {clip(c, 16)}
        </text>,
      );
    });
  }
  if (chart.yTitle) {
    const cy = horizontal ? undefined : (top + bottom) / 2;
    parts.push(
      horizontal ? (
        <text key="yt" x={(left + right) / 2} y={h - 8} textAnchor="middle" fontSize={12} fill={text}>
          {chart.yTitle}
        </text>
      ) : (
        <text key="yt" x={14} y={cy} textAnchor="middle" fontSize={12} fill={text} transform={`rotate(-90 14 ${cy})`}>
          {chart.yTitle}
        </text>
      ),
    );
  }
  if (chart.xTitle) {
    const cy = (top + bottom) / 2;
    parts.push(
      horizontal ? (
        <text key="xtt" x={14} y={cy} textAnchor="middle" fontSize={12} fill={text} transform={`rotate(-90 14 ${cy})`}>
          {chart.xTitle}
        </text>
      ) : (
        <text key="xtt" x={(left + right) / 2} y={bottom + 34} textAnchor="middle" fontSize={12} fill={text}>
          {chart.xTitle}
        </text>
      ),
    );
  }

  // --- The series
  const base = valueAt(log ? vScale.lo : Math.max(vScale.lo, Math.min(0, vScale.hi)));
  if (chart.type === 'column' || chart.type === 'bar') {
    const k = data.series.length;
    const inner = band * 0.72;
    const each = stacked ? inner : inner / Math.max(1, k);
    const pos = new Array<number>(n).fill(0);
    const neg = new Array<number>(n).fill(0);
    data.series.forEach((s, si) =>
      s.points.forEach((p, i) => {
        if (p.y == null || (log && p.y <= 0)) return;
        let a: number;
        let b: number;
        if (stacked) {
          const from = p.y >= 0 ? pos[i] : neg[i];
          const to = from + p.y;
          if (p.y >= 0) pos[i] = to;
          else neg[i] = to;
          [a, b] = [valueAt(from), valueAt(to)];
        } else [a, b] = [base, valueAt(p.y)];
        const off = catAt(i) - inner / 2 + (stacked ? 0 : si * each);
        const rect = horizontal ? { x: Math.min(a, b), y: off, width: Math.abs(b - a), height: Math.max(1, each - 1) } : { x: off, y: Math.min(a, b), width: Math.max(1, each - 1), height: Math.abs(b - a) };
        parts.push(
          <rect key={`b${si}-${i}`} {...rect} fill={s.color}>
            <title>{`${s.name} · ${data.categories[i] ?? i + 1}: ${fmtV(p.y)}`}</title>
          </rect>,
        );
      }),
    );
  } else if (chart.type === 'line' || chart.type === 'area') {
    const acc = new Array<number>(n).fill(0);
    data.series.forEach((s, si) => {
      const pts = s.points.map((p, i) => {
        if (p.y == null || (log && p.y <= 0)) return null;
        const from = stacked ? acc[i] : 0;
        const v = from + p.y;
        if (stacked) acc[i] = v;
        return { x: catAt(i), y: valueAt(v), y0: stacked ? valueAt(from) : base, v: p.y, i };
      });
      // A gap (an empty cell) breaks the line.
      const runs: NonNullable<(typeof pts)[number]>[][] = [];
      let run: NonNullable<(typeof pts)[number]>[] = [];
      for (const p of pts) {
        if (p) run.push(p);
        else if (run.length) (runs.push(run), (run = []));
      }
      if (run.length) runs.push(run);
      runs.forEach((r, ri) => {
        const d = r.map((p, j) => `${j ? 'L' : 'M'}${p.x},${p.y}`).join('');
        if (chart.type === 'area') {
          const back = [...r].reverse().map((p) => `L${p.x},${p.y0}`).join('');
          parts.push(<path key={`a${si}-${ri}`} d={`${d}${back}Z`} fill={s.color} fillOpacity={stacked ? 0.75 : 0.35} stroke="none" />);
        }
        parts.push(<path key={`l${si}-${ri}`} d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />);
      });
      if (chart.type === 'line' && n <= 60) {
        for (const p of pts) {
          if (!p) continue;
          parts.push(
            <circle key={`m${si}-${p.i}`} cx={p.x} cy={p.y} r={3} fill={s.color}>
              <title>{`${s.name} · ${data.categories[p.i] ?? p.i + 1}: ${fmtV(p.v)}`}</title>
            </circle>,
          );
        }
      }
    });
  } else if (scatter && xScale) {
    data.series.forEach((s, si) =>
      s.points.forEach((p, i) => {
        if (p.y == null || p.x == null || (log && p.y <= 0)) return;
        parts.push(
          <circle key={`s${si}-${i}`} cx={xAt(p.x)} cy={valueAt(p.y)} r={4} fill={s.color} fillOpacity={0.85}>
            <title>{`${s.name}: (${fmtX(p.x)}, ${fmtV(p.y)})`}</title>
          </circle>,
        );
      }),
    );
  }

  return (
    <Frame w={w} h={h} bg={look.background} font={font}>
      {parts}
    </Frame>
  );
}

function Frame({ w, h, bg, font, children }: { w: number; h: number; bg?: string; font: string; children: ReactNode }) {
  return (
    <svg className="chart-svg" width={w} height={h} viewBox={`0 0 ${w} ${h}`} fontFamily={font} role="img">
      <rect width={w} height={h} fill={bg ?? '#ffffff'} />
      {children}
    </svg>
  );
}

function LegendEntry({ x, y, color, name, fill }: { x: number; y: number; color: string; name: string; fill: string }) {
  return (
    <g>
      <rect x={x} y={y - 5} width={14} height={10} rx={2} fill={color} />
      <text x={x + 20} y={y + 4} fontSize={12} fill={fill}>
        {name}
      </text>
    </g>
  );
}

/** A pie's slices take the palette in turn (one series, a color per category). */
function pieColor(data: ChartData, i: number): string {
  return i === 0 && data.series[0] ? data.series[0].color : CHART_COLORS[i % CHART_COLORS.length];
}

function PieSlices({ data, cx, cy, r, bg }: { data: ChartData; cx: number; cy: number; r: number; bg: string }) {
  const s = data.series[0];
  const vals = (s?.points ?? []).map((p) => (p.y != null && p.y > 0 ? p.y : 0));
  const total = vals.reduce((a, b) => a + b, 0);
  if (!total) return null;
  let angle = -Math.PI / 2;
  return (
    <g>
      {vals.map((v, i) => {
        if (!v) return null;
        const a0 = angle;
        const a1 = angle + (v / total) * Math.PI * 2;
        angle = a1;
        const large = a1 - a0 > Math.PI ? 1 : 0;
        const p0 = [cx + r * Math.cos(a0), cy + r * Math.sin(a0)];
        const p1 = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)];
        const mid = (a0 + a1) / 2;
        const share = v / total;
        const d = share >= 0.9999 ? `M${cx - r},${cy}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0` : `M${cx},${cy}L${p0[0]},${p0[1]}A${r},${r} 0 ${large} 1 ${p1[0]},${p1[1]}Z`;
        return (
          <g key={i}>
            <path d={d} fill={pieColor(data, i)} stroke={bg} strokeWidth={1.5}>
              <title>{`${data.categories[i] ?? i + 1}: ${formatChartValue(v, data.format)} (${Math.round(share * 100)}%)`}</title>
            </path>
            {share >= 0.06 && (
              <text x={cx + r * 0.65 * Math.cos(mid)} y={cy + r * 0.65 * Math.sin(mid) + 4} textAnchor="middle" fontSize={11} fill="#fff" fontWeight={500}>
                {`${Math.round(share * 100)}%`}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}
