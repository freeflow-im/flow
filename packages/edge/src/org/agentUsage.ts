// AI usage per agent (Taskboard #22): the tokens an agent's model calls used, per hour, in its organization's SQLite.
// Two writers: a hosted agent's runtime after every model call (assistant/object.ts), and an agent on the bridge after
// every turn its CLI reports (POST /v1/workspaces/:id/agents/me/usage). One reader: Admin › Members › Usage, which asks
// for the last day by hour or the last 7 or 30 days by day, in thousands of tokens. Raw tokens only, no prices.
//
// Input is kept in its three billing kinds, since a provider charges them very differently: uncached input, prompt-cache
// writes and prompt-cache reads. `input_tokens` is the uncached part; rows written before the split (and reports from a
// bridge older than 0.44) carry the whole input there.
//
// Rows are per model too (agents may run on different ones): the model id the provider answered as, or '' where it is
// not known (rows from before models were counted, a Codex bridge with no model set).
import type { AgentUsageDTO, AgentUsageRange } from '@flow/shared';

/** Created by the Org object on start (object.ts), beside its migrations. Keyed by the agent's account here, the hour and
 * the model. Replaces `_agent_usage_hourly`, which had no model (ensureAgentUsageTable moves its rows). */
export const AGENT_USAGE_DDL = 'CREATE TABLE IF NOT EXISTS _agent_usage (account_id TEXT NOT NULL, hour INTEGER NOT NULL, model TEXT NOT NULL DEFAULT \'\', requests INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account_id, hour, model))';

export interface UsageSql { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } }

/** The table, with the rows of the one before models (which may predate the cache columns too) moved in as model ''. */
export function ensureAgentUsageTable(sql: UsageSql): void {
  sql.exec(AGENT_USAGE_DDL);
  if (!sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_agent_usage_hourly'").toArray().length) return;
  const have = new Set(sql.exec('PRAGMA table_info(_agent_usage_hourly)').toArray().map((c) => c.name as string));
  const col = (c: string) => (have.has(c) ? c : '0');
  sql.exec(
    `INSERT OR IGNORE INTO _agent_usage (account_id, hour, model, requests, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens)
     SELECT account_id, hour, '', requests, input_tokens, output_tokens, ${col('cache_write_tokens')}, ${col('cache_read_tokens')} FROM _agent_usage_hourly`);
  sql.exec('DROP TABLE _agent_usage_hourly');
}

/** One model call's or one turn's tokens, on one model. `input` is the uncached input. `requests` may be 0: a turn
 * reported as one entry per model counts as one call on the first entry alone. */
export interface UsageReport { input: number; output: number; cacheWrite?: number; cacheRead?: number; requests?: number; model?: string }

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

/** A model id as stored: trimmed, at most 120 characters, '' when unknown. */
export const modelKey = (m: unknown): string => (typeof m === 'string' ? m.trim().slice(0, 120) : '');

const clean = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), MAX_TOKENS) : 0);

/** Adds one model call's (or one turn's) tokens to the agent's current hour, and drops rows past the longest range. */
export function recordAgentUsage(sql: UsageSql, accountId: string, usage: UsageReport, now = Date.now()): void {
  const input = clean(usage.input), output = clean(usage.output), write = clean(usage.cacheWrite), read = clean(usage.cacheRead);
  const requests = usage.requests === undefined ? 1 : clean(usage.requests);
  if (!accountId || input + output + write + read === 0) return;
  const hour = Math.floor(now / HOUR) * HOUR;
  sql.exec(
    `INSERT INTO _agent_usage (account_id, hour, model, requests, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (account_id, hour, model) DO UPDATE SET requests = requests + excluded.requests, input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens, cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
       cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens`,
    accountId, hour, modelKey(usage.model), requests, input, output, write, read);
  sql.exec('DELETE FROM _agent_usage WHERE hour < ?', hour - KEEP_MS);
}

/** Thousands, to one decimal place. */
const thousands = (n: number) => Math.round(n / 100) / 10;

interface Sums { uncached: number; cacheWrite: number; cacheRead: number; output: number; requests: number }
const zero = (): Sums => ({ uncached: 0, cacheWrite: 0, cacheRead: 0, output: 0, requests: 0 });
const inK = (s: Sums) => ({
  inputK: thousands(s.uncached + s.cacheWrite + s.cacheRead),
  uncachedK: thousands(s.uncached),
  cacheWriteK: thousands(s.cacheWrite),
  cacheReadK: thousands(s.cacheRead),
  outputK: thousands(s.output),
  requests: s.requests,
});

/**
 * The agent's usage over a range, oldest bucket first, ending with the current (partial) one, for every model or for one
 * (`model`: its id, '' for the unknown); and each model's totals over the range, the most input first, whatever the
 * filter. `tzOffsetMinutes` is the viewer's offset east of UTC, so a day bucket starts at their midnight; hour buckets
 * are the stored UTC hours.
 */
export function agentUsageSeries(sql: UsageSql, accountId: string, range: AgentUsageRange, tzOffsetMinutes = 0, now = Date.now(), model: string | null = null): AgentUsageDTO {
  const { bucket, count } = RANGES[range];
  const off = bucket === DAY ? Math.max(-14 * 60, Math.min(14 * 60, Math.round(tzOffsetMinutes))) * 60_000 : 0;
  const lastStart = Math.floor((now + off) / bucket) * bucket - off;
  const firstStart = lastStart - (count - 1) * bucket;
  const buckets = Array.from({ length: count }, (_, i) => ({ start: firstStart + i * bucket, sums: zero() }));
  const total = zero();
  const models = new Map<string, Sums>();
  const want = model === null ? null : modelKey(model);
  const rows = sql.exec('SELECT hour, model, requests, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens FROM _agent_usage WHERE account_id = ? AND hour >= ? ORDER BY hour', accountId, firstStart).toArray();
  for (const r of rows) {
    const i = Math.floor((Number(r.hour) - firstStart) / bucket);
    const b = buckets[i];
    if (!b) continue;
    const m = String(r.model ?? '');
    if (!models.has(m)) models.set(m, zero());
    const sums = [models.get(m)!];
    if (want === null || want === m) sums.push(b.sums, total);
    for (const s of sums) {
      s.uncached += Number(r.input_tokens);
      s.cacheWrite += Number(r.cache_write_tokens);
      s.cacheRead += Number(r.cache_read_tokens);
      s.output += Number(r.output_tokens);
      s.requests += Number(r.requests);
    }
  }
  const byModel = [...models].map(([m, s]) => ({ model: m, ...inK(s) })).sort((a, b) => b.inputK - a.inputK || b.outputK - a.outputK || a.model.localeCompare(b.model));
  return {
    range,
    bucket: bucket === HOUR ? 'hour' : 'day',
    model: want,
    buckets: buckets.map((b) => ({ start: new Date(b.start).toISOString(), ...inK(b.sums) })),
    total: inK(total),
    models: byModel,
  };
}
