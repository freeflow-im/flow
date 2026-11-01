// The chart editor, beside the grid: the chart's type, its data (the labels and each series' values and name,
// typed as ranges or taken from the selection), its titles, legend and axes. Each change is an undo step of
// its own (SheetController.updateChart); a range that means nothing is not taken and says why.
import { useEffect, useState, type ReactNode } from 'react';
import { CHART_COLORS, CHART_TYPE_NAMES, CHART_TYPES, LEGEND_POSITIONS, refText, resolveRef, type Chart, type ChartSeries, type ChartType, type LegendPosition } from '../../../shared/chart.ts';
import { ColorPicker } from '../components/ColorPicker.tsx';
import type { SheetController } from '../state/controller.ts';
import { useController } from '../state/useController.ts';

const LEGEND_NAMES: Record<LegendPosition, string> = { right: 'Right', bottom: 'Bottom', top: 'Top', none: 'None' };

/** A text field that is committed on Enter or when it loses the focus, and shows the value it was given meanwhile. */
function Field({ label, value, placeholder, onCommit, check, extra }: { label: string; value: string; placeholder?: string; onCommit(v: string): void; check?(v: string): string | null; extra?: ReactNode }) {
  const [draft, setDraft] = useState(value);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    setDraft(value);
    setProblem(null);
  }, [value]);
  const commit = () => {
    const v = draft.trim();
    if (v === value) return;
    const p = check?.(v) ?? null;
    setProblem(p);
    if (!p) onCommit(v);
  };
  return (
    <label className="ce-field">
      <span>{label}</span>
      <div className="ce-row">
        <input
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setDraft(value);
          }}
          aria-invalid={!!problem}
        />
        {extra}
      </div>
      {problem && <span className="ce-problem">{problem}</span>}
    </label>
  );
}

export function ChartEditor({ ctl }: { ctl: SheetController }) {
  useController(ctl);
  const chart = ctl.charts.find((c) => c.id === ctl.chartEditor);
  if (!chart) return null;
  const tab = ctl.tab;
  const wb = ctl.store.workbook;
  const update = (fn: (c: Chart) => Chart) => ctl.updateChart(chart.id, fn);
  const set = <K extends keyof Chart>(k: K, v: Chart[K] | undefined) =>
    update((c) => {
      const next = { ...c } as Chart;
      if (v === undefined || v === '' || v === false) delete next[k];
      else next[k] = v;
      return next;
    });
  const setSeries = (i: number, patch: Partial<ChartSeries>) =>
    update((c) => ({
      ...c,
      series: c.series.map((s, j) => {
        if (j !== i) return s;
        const next = { ...s, ...patch } as ChartSeries & Record<string, unknown>;
        for (const k of Object.keys(patch)) if (next[k] === undefined || next[k] === '') delete next[k];
        return next;
      }),
    }));
  const checkRange = (v: string) => {
    if (!v) return null;
    const r = resolveRef(wb, tab, v);
    return typeof r === 'string' ? r : null;
  };
  const required = (v: string) => (v ? checkRange(v) : 'A series needs a range of values');
  /** The current selection, as a reference from the chart's tab. */
  const selection = () => refText(tab, tab, ctl.primary);
  const fromSelection = (apply: (ref: string) => void) => (
    <button className="btn ce-pick" title="Use the selected cells" onMouseDown={(e) => e.preventDefault()} onClick={() => apply(selection())}>
      Selection
    </button>
  );
  const cartesian = chart.type !== 'pie';
  const stackable = chart.type === 'column' || chart.type === 'bar' || chart.type === 'area';

  return (
    <aside className="chart-editor" aria-label="Chart editor" onKeyDown={(e) => e.stopPropagation()}>
      <div className="ce-head">
        <span className="ce-title">Chart</span>
        <button className="icon-btn" title="Close" aria-label="Close" onClick={() => ctl.editChart(null)}>
          ×
        </button>
      </div>
      <div className="ce-body">
        <div className="ce-types" role="radiogroup" aria-label="Chart type">
          {CHART_TYPES.map((t: ChartType) => (
            <button key={t} role="radio" aria-checked={chart.type === t} className={chart.type === t ? 'on' : undefined} onClick={() => set('type', t)}>
              {CHART_TYPE_NAMES[t]}
            </button>
          ))}
        </div>

        <h3>Data</h3>
        <Field label={chart.type === 'scatter' ? 'X values' : chart.type === 'pie' ? 'Slice labels' : 'Labels (categories)'} value={chart.categories ?? ''} placeholder="e.g. A2:A12" check={checkRange} onCommit={(v) => set('categories', v || undefined)} extra={fromSelection((r) => set('categories', r))} />
        {chart.series.map((s, i) => (
          <div key={i} className="ce-series">
            <div className="ce-series-head">
              <ColorPicker title="Series color" icon={<span className="ce-swatch" style={{ background: s.color ?? CHART_COLORS[i % CHART_COLORS.length] }} />} value={s.color} onPick={(c) => setSeries(i, { color: c && /^#[0-9a-f]{6}$/i.test(c) ? c : undefined })} />
              <span>Series {i + 1}</span>
              <button className="link" disabled={chart.series.length <= 1} onClick={() => update((c) => ({ ...c, series: c.series.filter((_, j) => j !== i) }))}>
                Remove
              </button>
            </div>
            <Field label="Values" value={s.values} check={required} onCommit={(v) => setSeries(i, { values: v })} extra={fromSelection((r) => setSeries(i, { values: r }))} />
            <Field
              label="Name (a cell, or text)"
              value={s.nameRef ?? s.name ?? ''}
              placeholder="e.g. B1"
              onCommit={(v) => {
                // A reference names the series from its cell; anything else is the name itself.
                const ref = v && typeof resolveRef(wb, tab, v) !== 'string' && /\d/.test(v);
                setSeries(i, ref ? { nameRef: v, name: undefined } : { name: v || undefined, nameRef: undefined });
              }}
            />
          </div>
        ))}
        <button className="btn" onClick={() => update((c) => ({ ...c, series: [...c.series, { values: selection() }] }))} title="Add a series of the selected cells">
          Add series
        </button>

        <h3>Look</h3>
        <Field label="Title" value={chart.title ?? ''} onCommit={(v) => set('title', v || undefined)} />
        {cartesian && <Field label={chart.type === 'bar' ? 'Vertical axis title' : 'Horizontal axis title'} value={chart.xTitle ?? ''} onCommit={(v) => set('xTitle', v || undefined)} />}
        {cartesian && <Field label={chart.type === 'bar' ? 'Horizontal axis title' : 'Vertical axis title'} value={chart.yTitle ?? ''} onCommit={(v) => set('yTitle', v || undefined)} />}
        <label className="ce-field">
          <span>Legend</span>
          <select value={chart.legend ?? 'right'} onChange={(e) => set('legend', e.target.value as LegendPosition)}>
            {LEGEND_POSITIONS.map((p) => (
              <option key={p} value={p}>
                {LEGEND_NAMES[p]}
              </option>
            ))}
          </select>
        </label>
        {stackable && (
          <label className="ce-check">
            <input type="checkbox" checked={!!chart.stacked} onChange={(e) => set('stacked', e.target.checked || undefined)} /> Stacked
          </label>
        )}
        {cartesian && (
          <label className="ce-check">
            <input type="checkbox" checked={!!chart.logScale} onChange={(e) => set('logScale', e.target.checked || undefined)} /> Logarithmic value axis
          </label>
        )}
        <div className="ce-foot">
          <button className="btn danger" onClick={() => ctl.deleteChart(chart.id)}>
            Delete chart
          </button>
        </div>
      </div>
    </aside>
  );
}
