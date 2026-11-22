// An agent's AI usage (Taskboard #22), reached from Members › Usage: the model tokens its calls used over the last day by
// hour, or the last 7 or 30 days by day, in thousands. No prices, only raw tokens, but input comes in its three billing
// kinds (uncached, cache writes, cache reads), stacked, because a provider charges them very differently. Input runs about
// a hundred times output, so output is a second chart with its own axis (never one chart with two scales), under a row
// of totals; every column has a tooltip, and the table view has every number. Below, a table of each model's totals
// over the range; the model filter (or a row of that table) narrows the totals, charts and table to one model.
import { useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AgentUsageAmounts, AgentUsageDTO, AgentUsageRange, WorkspaceDTO } from '@flow/shared';
import { ArrowLeft } from 'lucide-react';
import { adminApi } from '../api';
import { Card, ErrorLine, Select } from '../components/ui';

const RANGES: { id: AgentUsageRange; label: string }[] = [
  { id: '1d', label: '1 day' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
];

interface Series { key: keyof AgentUsageAmounts; label: string; color: string }

/**
 * The reference palette's categorical hues on a light surface (the Admin app has no dark mode), checked with the dataviz
 * validator: the input stack bottom to top (cache reads, uncached, cache writes) passes every adjacent check, and output,
 * its own chart, keeps orange. Aqua and magenta sit under 3:1 on white, so the legend, tooltips and table carry the
 * numbers and a 2px gap separates the segments.
 */
const INPUT_STACK: Series[] = [
  { key: 'cacheReadK', label: 'Cache reads', color: '#1baf7a' },
  { key: 'uncachedK', label: 'Uncached input', color: '#2a78d6' },
  { key: 'cacheWriteK', label: 'Cache writes', color: '#e87ba4' },
];
const OUTPUT: Series[] = [{ key: 'outputK', label: 'Output', color: '#eb6834' }];

/** A model as the page names it: its id, or what usage with no model known is called. */
export const modelLabel = (m: string): string => m || 'Unknown model';

/** The Select's value for a model filter: `*` for every model (a model id is never `*`). */
const ALL = '*';

/** Thousands of tokens as a reader says them: 0.4K, 12.3K, 1.2M. */
export function formatK(k: number): string {
  if (k >= 1000) return `${(k / 1000).toLocaleString(undefined, { maximumFractionDigits: k >= 10_000 ? 0 : 1 })}M`;
  return `${k.toLocaleString(undefined, { maximumFractionDigits: k >= 100 ? 0 : 1 })}K`;
}

/** A bucket's name: the hour for a day's chart, the date for 7 or 30 days. */
export function bucketLabel(start: string, bucket: AgentUsageDTO['bucket'], long = false): string {
  const d = new Date(start);
  if (bucket === 'hour') {
    const t = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return long ? `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}, ${t}` : t;
  }
  return d.toLocaleDateString(undefined, long ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' });
}

/** Clean axis ticks from zero up past the largest value: 1, 2 or 5 times a power of ten, at most five steps. */
export function niceTicks(max: number): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  const ticks: number[] = [];
  for (let v = 0; v < max + step; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(640);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth || 640);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e!.contentRect.width) || 640));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** A column: a 4px rounded data-end, square at the baseline. */
function columnPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

const HEIGHT = 168;
const PAD = { top: 10, right: 8, bottom: 24, left: 44 };

/** Columns on their own axis, one series or a stack (bottom first), with a tooltip per column listing every series. */
function ColumnChart({ title, series, data, bucket, testid }: { title: string; series: Series[]; data: ({ start: string } & AgentUsageAmounts)[]; bucket: AgentUsageDTO['bucket']; testid: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const totalOf = (d: AgentUsageAmounts) => series.reduce((t, s) => t + d[s.key], 0);
  const max = Math.max(0, ...data.map(totalOf));
  const ticks = niceTicks(max);
  const top = ticks.at(-1)!;
  const plotW = Math.max(60, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const band = plotW / data.length;
  // Capped at 24px, with at least a 2px gap of surface between neighbours.
  const barW = Math.max(1, Math.min(24, band - 2));
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const labelEvery = Math.ceil(data.length / Math.max(1, Math.floor(plotW / 56)));
  const shown = hover !== null ? data[hover] : null;
  const tipX = hover !== null ? PAD.left + band * hover + band / 2 : 0;
  return (
    <div className="flex flex-col gap-1" data-testid={testid}>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h3 className="text-sm font-medium">{title}</h3>
        {series.length > 1 && (
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted" data-testid={`${testid}-legend`}>
            {series.slice().reverse().map((s) => (
              <li key={s.key} className="inline-flex items-center gap-1.5">
                <span className="inline-block size-2.5 rounded-sm" style={{ background: s.color }} />
                {s.label}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div ref={ref} className="relative w-full">
        <svg width={width} height={HEIGHT} role="img" aria-label={`${title}, ${data.length} ${bucket === 'hour' ? 'hours' : 'days'}`} className="block overflow-visible">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} stroke="var(--color-hairline)" strokeWidth={1} />
              <text x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted text-[10px] tabular-nums">
                {t === 0 ? '0' : formatK(t)}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const x = PAD.left + band * i + (band - barW) / 2;
            // The segments bottom up, each above the last with a 2px gap; the topmost gets the rounded end.
            const parts = series.map((s) => ({ s, v: d[s.key] })).filter((p) => p.v > 0);
            let base = 0;
            const marks = parts.map((p, j) => {
              const y0 = y(base), y1 = y(base + p.v);
              base += p.v;
              const gap = j > 0 ? 2 : 0;
              const h = Math.max(0, y0 - y1 - gap);
              if (h <= 0) return null;
              const last = j === parts.length - 1;
              return last ? (
                <path key={p.s.key} d={columnPath(x, y1, barW, h)} fill={p.s.color} />
              ) : (
                <rect key={p.s.key} x={x} y={y1} width={barW} height={h} fill={p.s.color} />
              );
            });
            return (
              <g key={d.start}>
                <g opacity={hover === null || hover === i ? 1 : 0.55}>{marks}</g>
                {/* The hit target is the whole band, taller than the mark. */}
                <rect
                  x={PAD.left + band * i}
                  y={PAD.top}
                  width={band}
                  height={plotH}
                  fill="transparent"
                  tabIndex={0}
                  aria-label={`${bucketLabel(d.start, bucket, true)}: ${series.map((s) => `${s.label} ${formatK(d[s.key])}`).join(', ')}`}
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover((v) => (v === i ? null : v))}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover((v) => (v === i ? null : v))}
                  data-testid={`${testid}-bar-${i}`}
                />
                {i % labelEvery === (data.length - 1) % labelEvery && (
                  <text x={PAD.left + band * i + band / 2} y={HEIGHT - 6} textAnchor="middle" className="fill-muted text-[10px]">
                    {bucketLabel(d.start, bucket)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {shown && (
          <div
            role="tooltip"
            className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-md border border-hairline bg-white px-2.5 py-1.5 text-xs whitespace-nowrap shadow-md"
            style={{ left: Math.min(Math.max(tipX, 90), width - 90), top: 0 }}
            data-testid={`${testid}-tooltip`}
          >
            <div className="mb-0.5 text-muted">{bucketLabel(shown.start, bucket, true)}</div>
            {series.slice().reverse().map((s) => (
              <div key={s.key} className="flex items-center gap-1.5">
                <span className="inline-block h-0.5 w-3 rounded" style={{ background: s.color }} />
                <strong className="tabular-nums">{formatK(shown[s.key])}</strong>
                <span className="text-muted">{s.label.toLowerCase()}</span>
              </div>
            ))}
            {series.length > 1 && (
              <div className="mt-0.5 border-t border-hairline pt-0.5">
                <strong className="tabular-nums">{formatK(totalOf(shown))}</strong> <span className="text-muted">in all</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, testid }: { label: string; value: string; testid: string }) {
  return (
    <div className="flex flex-col rounded-lg border border-hairline px-4 py-3" data-testid={testid}>
      <span className="text-xs text-muted">{label}</span>
      <span className="text-xl font-semibold tabular-nums">{value}</span>
    </div>
  );
}

/** Each model's totals over the range, all models whatever the filter; a row narrows the page to its model, and the
 * selected row's again widens it to all. */
function ByModel({ models, selected, onSelect }: { models: AgentUsageDTO['models']; selected: string | null; onSelect(m: string | null): void }) {
  const num = 'px-3 py-1 text-right tabular-nums';
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-sm font-medium">By model</h3>
      <div className="overflow-x-auto rounded-lg border border-hairline">
        <table className="w-full text-sm" data-testid="usage-by-model">
          <thead>
            <tr className="border-b border-hairline bg-panel text-left text-xs text-faint uppercase">
              <th className="px-3 py-1.5 font-semibold">Model</th>
              <th className="px-3 py-1.5 text-right font-semibold">Uncached (K)</th>
              <th className="px-3 py-1.5 text-right font-semibold">Cache writes (K)</th>
              <th className="px-3 py-1.5 text-right font-semibold">Cache reads (K)</th>
              <th className="px-3 py-1.5 text-right font-semibold">Output (K)</th>
              <th className="px-3 py-1.5 text-right font-semibold">Calls</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => {
              const on = selected === m.model;
              return (
                <tr key={m.model} className={`border-b border-hairline last:border-0 ${on ? 'bg-selected-blue' : ''}`} data-testid={`usage-model-row-${m.model || 'unknown'}`}>
                  <td className="px-3 py-1">
                    <button type="button" className={`text-left hover:underline ${m.model ? 'font-mono text-xs' : 'text-muted'} ${on ? 'font-semibold text-primary' : ''}`} title={on ? 'Show all models' : `Show only ${modelLabel(m.model)}`} onClick={() => onSelect(on ? null : m.model)}>
                      {modelLabel(m.model)}
                    </button>
                  </td>
                  <td className={num}>{m.uncachedK.toLocaleString()}</td>
                  <td className={num}>{m.cacheWriteK.toLocaleString()}</td>
                  <td className={num}>{m.cacheReadK.toLocaleString()}</td>
                  <td className={num}>{m.outputK.toLocaleString()}</td>
                  <td className={num}>{m.requests.toLocaleString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function AgentUsage({ org, userId, name, onBack }: { org: WorkspaceDTO; userId: string; name: string; onBack(): void }) {
  const [range, setRange] = useState<AgentUsageRange>('7d');
  const [table, setTable] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const usage = useQuery({
    queryKey: ['agent-usage', org.id, userId, range, model],
    queryFn: () => adminApi.agentUsage(org.id, userId, range, model),
    refetchInterval: 60_000,
    // The page keeps the last answer while another range or model loads, rather than blinking to "Loading…".
    placeholderData: (prev) => prev,
  });
  const u = usage.data;
  const empty = !!u && u.total.requests === 0;
  return (
    <>
      <div className="flex items-center gap-3">
        <button type="button" className="inline-flex items-center gap-1 text-sm text-primary hover:underline" onClick={onBack} data-testid="usage-back">
          <ArrowLeft className="size-4" aria-hidden="true" />
          Members
        </button>
      </div>
      <Card title={`${name} · AI usage`} intro="Tokens the agent’s model calls used, in thousands. Input is split by how providers bill it: uncached input, prompt-cache writes and prompt-cache reads (usually far cheaper)." testid="card-usage">
        <div className="flex flex-wrap items-center gap-2 text-xs" role="tablist" aria-label="Range">
          {RANGES.map((r) => (
            <button key={r.id} type="button" role="tab" aria-selected={range === r.id} className={`rounded-full px-2.5 py-0.5 ${range === r.id ? 'bg-primary text-white' : 'bg-panel text-muted hover:bg-hover'}`} onClick={() => setRange(r.id)} data-testid={`usage-range-${r.id}`}>
              {r.label}
            </button>
          ))}
          <span className="flex-1" />
          {u && (u.models.length > 1 || model !== null) && (
            <Select
              compact
              label="Model"
              value={model ?? ALL}
              options={[{ value: ALL, label: 'All models' }, ...[...new Set([...u.models.map((m) => m.model), ...(model !== null ? [model] : [])])].map((m) => ({ value: m, label: modelLabel(m) }))]}
              onChange={(v) => setModel(v === ALL ? null : v)}
              testid="usage-model"
            />
          )}
          <button type="button" className="text-primary hover:underline" onClick={() => setTable((t) => !t)} data-testid="usage-table-toggle">
            {table ? 'Show charts' : 'Show table'}
          </button>
        </div>
        {usage.isError && <ErrorLine error={usage.error instanceof Error ? usage.error.message : String(usage.error)} />}
        {!u ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Stat label="Uncached input" value={formatK(u.total.uncachedK)} testid="usage-total-uncached" />
              <Stat label="Cache writes" value={formatK(u.total.cacheWriteK)} testid="usage-total-cache-write" />
              <Stat label="Cache reads" value={formatK(u.total.cacheReadK)} testid="usage-total-cache-read" />
              <Stat label="Output" value={formatK(u.total.outputK)} testid="usage-total-output" />
              <Stat label="Model calls" value={u.total.requests.toLocaleString()} testid="usage-total-requests" />
            </div>
            {empty && (
              <p className="text-xs text-muted" data-testid="usage-empty">
                No usage in this range. Hosted agents report every model call; agents on the Flow bridge report each turn from version 0.43 (per model from 0.44). An agent connected over MCP alone runs its model elsewhere, so nothing is counted here.
              </p>
            )}
            {table ? (
              <div className="max-h-96 overflow-y-auto rounded-lg border border-hairline">
                <table className="w-full text-sm" data-testid="usage-table">
                  <thead>
                    <tr className="border-b border-hairline bg-panel text-left text-xs text-faint uppercase">
                      <th className="px-3 py-1.5 font-semibold">{u.bucket === 'hour' ? 'Hour' : 'Day'}</th>
                      <th className="px-3 py-1.5 text-right font-semibold">Uncached (K)</th>
                      <th className="px-3 py-1.5 text-right font-semibold">Cache writes (K)</th>
                      <th className="px-3 py-1.5 text-right font-semibold">Cache reads (K)</th>
                      <th className="px-3 py-1.5 text-right font-semibold">Output (K)</th>
                      <th className="px-3 py-1.5 text-right font-semibold">Calls</th>
                    </tr>
                  </thead>
                  <tbody>
                    {u.buckets.slice().reverse().map((b) => (
                      <tr key={b.start} className="border-b border-hairline last:border-0">
                        <td className="px-3 py-1">{bucketLabel(b.start, u.bucket, true)}</td>
                        <td className="px-3 py-1 text-right tabular-nums">{b.uncachedK.toLocaleString()}</td>
                        <td className="px-3 py-1 text-right tabular-nums">{b.cacheWriteK.toLocaleString()}</td>
                        <td className="px-3 py-1 text-right tabular-nums">{b.cacheReadK.toLocaleString()}</td>
                        <td className="px-3 py-1 text-right tabular-nums">{b.outputK.toLocaleString()}</td>
                        <td className="px-3 py-1 text-right tabular-nums">{b.requests.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="flex flex-col gap-5">
                <ColumnChart title="Input tokens" series={INPUT_STACK} data={u.buckets} bucket={u.bucket} testid="usage-chart-input" />
                <ColumnChart title="Output tokens" series={OUTPUT} data={u.buckets} bucket={u.bucket} testid="usage-chart-output" />
              </div>
            )}
            {u.models.length > 0 && <ByModel models={u.models} selected={model} onSelect={setModel} />}
          </>
        )}
      </Card>
    </>
  );
}
