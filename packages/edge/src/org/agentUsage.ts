// AI usage per agent (Taskboard #22): the tokens an agent's model calls used, per hour, in its organization's SQLite.
// Two writers: a hosted agent's runtime after every model call (assistant/object.ts), and an agent on the bridge after
// every turn its CLI reports (POST /v1/workspaces/:id/agents/me/usage). One reader: Admin › Members › Usage, which asks
// for the last day by hour or the last 7 or 30 days by day, in thousands of tokens. Raw tokens only, no prices: input
// counts cache reads and writes too, as the assistant's own daily count does (docs/server/agent/store.ts recordUsage).
import type { AgentUsageDTO, AgentUsageRange } from '@flow/shared';

/** Created by the Org object on start (object.ts), beside its migrations. Keyed by the agent's account here. */
export const AGENT_USAGE_DDL = 'CREATE TABLE IF NOT EXISTS _agent_usage_hourly (account_id TEXT NOT NULL, hour INTEGER NOT NULL, requests INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account_id, hour))';

export interface UsageSql { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } }

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Rows older than this go: the longest range is 30 days, plus a day for a far-off time zone. */
const KEEP_MS = 32 * DAY;
/** One report's ceiling: a bad or hostile client cannot write a number that swamps every chart. */
const MAX_TOKENS = 50_000_000;

const RANGES: Record<AgentUsageRange, { bucket: number; count: number }> = {
  '1d': { bucket: HOUR, count: 24 },
  '7d': { bucket: DAY, count: 7 },
  '30d': { bucket: DAY, count: 30 },
};

export const isUsageRange = (r: unknown): r is AgentUsageRange => typeof r === 'string' && r in RANGES;

const clean = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), MAX_TOKENS) : 0);

/** Adds one model call's (or one turn's) tokens to the agent's current hour, and drops rows past the longest range. */
export function recordAgentUsage(sql: UsageSql, accountId: string, usage: { input: number; output: number; requests?: number }, now = Date.now()): void {
  const input = clean(usage.input), output = clean(usage.output), requests = Math.max(1, clean(usage.requests ?? 1));
  if (!accountId || (input === 0 && output === 0)) return;
  const hour = Math.floor(now / HOUR) * HOUR;
  sql.exec(
    `INSERT INTO _agent_usage_hourly (account_id, hour, requests, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (account_id, hour) DO UPDATE SET requests = requests + excluded.requests, input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens`,
    accountId, hour, requests, input, output);
  sql.exec('DELETE FROM _agent_usage_hourly WHERE hour < ?', hour - KEEP_MS);
}

/** Thousands, to one decimal place. */
const thousands = (n: number) => Math.round(n / 100) / 10;

/**
 * The agent's usage over a range, oldest bucket first, ending with the current (partial) one. `tzOffsetMinutes` is the
 * viewer's offset east of UTC, so a day bucket starts at their midnight; hour buckets are the stored UTC hours.
 */
export function agentUsageSeries(sql: UsageSql, accountId: string, range: AgentUsageRange, tzOffsetMinutes = 0, now = Date.now()): AgentUsageDTO {
  const { bucket, count } = RANGES[range];
  const off = bucket === DAY ? Math.max(-14 * 60, Math.min(14 * 60, Math.round(tzOffsetMinutes))) * 60_000 : 0;
  const lastStart = Math.floor((now + off) / bucket) * bucket - off;
  const firstStart = lastStart - (count - 1) * bucket;
  const buckets = Array.from({ length: count }, (_, i) => ({ start: firstStart + i * bucket, input: 0, output: 0, requests: 0 }));
  const rows = sql.exec('SELECT hour, requests, input_tokens, output_tokens FROM _agent_usage_hourly WHERE account_id = ? AND hour >= ? ORDER BY hour', accountId, firstStart).toArray();
  for (const r of rows) {
    const i = Math.floor((Number(r.hour) - firstStart) / bucket);
    const b = buckets[i];
    if (!b) continue;
    b.input += Number(r.input_tokens);
    b.output += Number(r.output_tokens);
    b.requests += Number(r.requests);
  }
  const total = buckets.reduce((t, b) => ({ input: t.input + b.input, output: t.output + b.output, requests: t.requests + b.requests }), { input: 0, output: 0, requests: 0 });
  return {
    range,
    bucket: bucket === HOUR ? 'hour' : 'day',
    buckets: buckets.map((b) => ({ start: new Date(b.start).toISOString(), inputK: thousands(b.input), outputK: thousands(b.output), requests: b.requests })),
    total: { inputK: thousands(total.input), outputK: thousands(total.output), requests: total.requests },
  };
}
