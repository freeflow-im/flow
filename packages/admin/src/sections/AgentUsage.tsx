// An agent's AI usage (Taskboard #22), reached from Members › Usage: the model tokens its calls used over the last day by
// hour, or the last 7 or 30 days by day, in thousands. No prices, only raw input and output tokens. Input runs about a
// hundred times output, so they are two charts with their own axes (never one chart with two scales), under a row of
// totals; every bar has a tooltip, and the table view has every number.
import { useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AgentUsageDTO, AgentUsageRange, WorkspaceDTO } from '@flow/shared';
import { ArrowLeft } from 'lucide-react';
import { adminApi } from '../api';
import { Card, ErrorLine } from '../components/ui';

const RANGES: { id: AgentUsageRange; label: string }[] = [
  { id: '1d', label: '1 day' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
];

/** Categorical slots 1 and 2 of the reference palette, validated as a pair on a light surface (the Admin app has no dark mode). */
const INPUT_COLOR = '#2a78d6';
const OUTPUT_COLOR = '#eb6834';

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

/** One series as columns on its own axis, with a tooltip per column (hover or keyboard focus). */
function ColumnChart({ title, data, color, bucket, testid }: { title: string; data: { start: string; value: number }[]; color: string; bucket: AgentUsageDTO['bucket']; testid: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(0, ...data.map((d) => d.value));
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
      <h3 className="text-sm font-medium">{title}</h3>
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
            const h = Math.max(0, PAD.top + plotH - y(d.value));
            const x = PAD.left + band * i + (band - barW) / 2;
            return (
              <g key={d.start}>
                {h > 0 && <path d={columnPath(x, y(d.value), barW, h)} fill={color} opacity={hover === null || hover === i ? 1 : 0.55} />}
                {/* The hit target is the whole band, taller than the mark. */}
                <rect
                  x={PAD.left + band * i}
                  y={PAD.top}
                  width={band}
                  height={plotH}
                  fill="transparent"
                  tabIndex={0}
                  aria-label={`${bucketLabel(d.start, bucket, true)}: ${formatK(d.value)} tokens`}
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
            style={{ left: Math.min(Math.max(tipX, 70), width - 70), top: 0 }}
            data-testid={`${testid}-tooltip`}
          >
            <div className="flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-3 rounded" style={{ background: color }} />
              <strong className="tabular-nums">{formatK(shown.value)}</strong>
              <span className="text-muted">tokens</span>
            </div>
            <div className="text-muted">{bucketLabel(shown.start, bucket, true)}</div>
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

export function AgentUsage({ org, userId, name, onBack }: { org: WorkspaceDTO; userId: string; name: string; onBack(): void }) {
  const [range, setRange] = useState<AgentUsageRange>('7d');
  const [table, setTable] = useState(false);
  const usage = useQuery({ queryKey: ['agent-usage', org.id, userId, range], queryFn: () => adminApi.agentUsage(org.id, userId, range), refetchInterval: 60_000 });
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
      <Card title={`${name} · AI usage`} intro="Tokens the agent’s model calls used, in thousands. Input includes prompt-cache reads and writes." testid="card-usage">
        <div className="flex flex-wrap items-center gap-2 text-xs" role="tablist" aria-label="Range">
          {RANGES.map((r) => (
            <button key={r.id} type="button" role="tab" aria-selected={range === r.id} className={`rounded-full px-2.5 py-0.5 ${range === r.id ? 'bg-primary text-white' : 'bg-panel text-muted hover:bg-hover'}`} onClick={() => setRange(r.id)} data-testid={`usage-range-${r.id}`}>
              {r.label}
            </button>
          ))}
          <span className="flex-1" />
          <button type="button" className="text-primary hover:underline" onClick={() => setTable((t) => !t)} data-testid="usage-table-toggle">
            {table ? 'Show charts' : 'Show table'}
          </button>
        </div>
        {usage.isError && <ErrorLine error={usage.error instanceof Error ? usage.error.message : String(usage.error)} />}
        {!u ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Stat label="Input tokens" value={formatK(u.total.inputK)} testid="usage-total-input" />
              <Stat label="Output tokens" value={formatK(u.total.outputK)} testid="usage-total-output" />
              <Stat label="Model calls" value={u.total.requests.toLocaleString()} testid="usage-total-requests" />
            </div>
            {empty && (
              <p className="text-xs text-muted" data-testid="usage-empty">
                No usage in this range. Hosted agents report every model call; agents on the Flow bridge report each turn from version 0.43. An agent connected over MCP alone runs its model elsewhere, so nothing is counted here.
              </p>
            )}
            {table ? (
              <div className="max-h-96 overflow-y-auto rounded-lg border border-hairline">
                <table className="w-full text-sm" data-testid="usage-table">
                  <thead>
                    <tr className="border-b border-hairline bg-panel text-left text-xs text-faint uppercase">
                      <th className="px-3 py-1.5 font-semibold">{u.bucket === 'hour' ? 'Hour' : 'Day'}</th>
                      <th className="px-3 py-1.5 text-right font-semibold">Input (K)</th>
                      <th className="px-3 py-1.5 text-right font-semibold">Output (K)</th>
                      <th className="px-3 py-1.5 text-right font-semibold">Calls</th>
                    </tr>
                  </thead>
                  <tbody>
                    {u.buckets.slice().reverse().map((b) => (
                      <tr key={b.start} className="border-b border-hairline last:border-0">
                        <td className="px-3 py-1">{bucketLabel(b.start, u.bucket, true)}</td>
                        <td className="px-3 py-1 text-right tabular-nums">{b.inputK.toLocaleString()}</td>
                        <td className="px-3 py-1 text-right tabular-nums">{b.outputK.toLocaleString()}</td>
                        <td className="px-3 py-1 text-right tabular-nums">{b.requests.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="flex flex-col gap-5">
                <ColumnChart title="Input tokens" data={u.buckets.map((b) => ({ start: b.start, value: b.inputK }))} color={INPUT_COLOR} bucket={u.bucket} testid="usage-chart-input" />
                <ColumnChart title="Output tokens" data={u.buckets.map((b) => ({ start: b.start, value: b.outputK }))} color={OUTPUT_COLOR} bucket={u.bucket} testid="usage-chart-output" />
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );
}
