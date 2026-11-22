// AI usage per agent (Taskboard #22): tokens added to the agent's hour, read back by hour for a day or by day for 7 or 30,
// in thousands, with the viewer's midnight as a day's start; other agents' rows and rows past the range stay out.
import { describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { agentUsageSeries, ensureAgentUsageTable, isUsageRange, recordAgentUsage, type UsageSql } from './agentUsage';

function sqlOf(ddl?: string): UsageSql {
  const db = new DatabaseSync(':memory:');
  if (ddl) db.exec(ddl);
  // Runs at once, as the runtime's exec does.
  return {
    exec: (q, ...b) => {
      const st = db.prepare(q), args = b as SQLInputValue[];
      const rows = /^(SELECT|PRAGMA)/.test(q.trim()) ? (st.all(...args) as Record<string, unknown>[]) : (st.run(...args), []);
      return { toArray: () => rows };
    },
  };
}

const table = (ddl?: string) => {
  const sql = sqlOf(ddl);
  ensureAgentUsageTable(sql);
  return sql;
};

const H = 3_600_000;
const NOW = Date.parse('2026-11-21T15:30:00Z');

describe('agent usage', () => {
  it('adds calls in the same hour together and reads a day by hour, the current hour last', () => {
    const sql = table();
    recordAgentUsage(sql, 'a1', { input: 12_000, output: 800 }, NOW);
    recordAgentUsage(sql, 'a1', { input: 3_000, output: 200 }, NOW + 60_000);
    recordAgentUsage(sql, 'a1', { input: 5_000, output: 1_000 }, NOW - 2 * H);
    recordAgentUsage(sql, 'other', { input: 99_000, output: 99_000 }, NOW);
    const u = agentUsageSeries(sql, 'a1', '1d', 0, NOW);
    expect(u.bucket).toBe('hour');
    expect(u.buckets).toHaveLength(24);
    expect(u.buckets.at(-1)).toEqual({ start: '2026-11-21T15:00:00.000Z', inputK: 15, uncachedK: 15, cacheWriteK: 0, cacheReadK: 0, outputK: 1, requests: 2 });
    expect(u.buckets.at(-3)).toMatchObject({ start: '2026-11-21T13:00:00.000Z', inputK: 5, outputK: 1 });
    expect(u.total).toMatchObject({ inputK: 20, outputK: 2, requests: 3 });
  });

  it('reads 7 and 30 days by day from the viewer’s midnight, leaving out older hours', () => {
    const sql = table();
    recordAgentUsage(sql, 'a1', { input: 1_000, output: 100 }, NOW);
    // 23:30 UTC the day before is the 21st already at UTC+2, so it lands in today's bucket there.
    recordAgentUsage(sql, 'a1', { input: 2_000, output: 200 }, Date.parse('2026-11-20T23:30:00Z'));
    recordAgentUsage(sql, 'a1', { input: 4_000, output: 400 }, NOW - 10 * 24 * H);
    const utc = agentUsageSeries(sql, 'a1', '7d', 0, NOW);
    expect(utc.buckets).toHaveLength(7);
    expect(utc.buckets.at(-1)).toMatchObject({ start: '2026-11-21T00:00:00.000Z', inputK: 1 });
    expect(utc.buckets.at(-2)).toMatchObject({ start: '2026-11-20T00:00:00.000Z', inputK: 2 });
    expect(utc.total.inputK).toBe(3);
    const east = agentUsageSeries(sql, 'a1', '7d', 120, NOW);
    expect(east.buckets.at(-1)).toMatchObject({ start: '2026-11-20T22:00:00.000Z', inputK: 3 });
    const month = agentUsageSeries(sql, 'a1', '30d', 0, NOW);
    expect(month.buckets).toHaveLength(30);
    expect(month.total.inputK).toBe(7);
  });

  it('keeps one decimal of thousands, ignores nothing-reports and junk, and drops rows past the longest range', () => {
    const sql = table();
    recordAgentUsage(sql, 'a1', { input: 1_234, output: 56 }, NOW);
    recordAgentUsage(sql, 'a1', { input: 0, output: 0 }, NOW);
    recordAgentUsage(sql, 'a1', { input: Number.NaN, output: -5 }, NOW);
    expect(agentUsageSeries(sql, 'a1', '1d', 0, NOW).total).toMatchObject({ inputK: 1.2, outputK: 0.1, requests: 1 });
    recordAgentUsage(sql, 'old', { input: 1_000, output: 1_000 }, NOW - 40 * 24 * H);
    recordAgentUsage(sql, 'a1', { input: 1, output: 1 }, NOW);
    expect(sql.exec("SELECT * FROM _agent_usage_hourly WHERE account_id = 'old'").toArray()).toEqual([]);
  });

  it('keeps cache writes and reads apart from uncached input, and inputK is all three', () => {
    const sql = table();
    recordAgentUsage(sql, 'a1', { input: 2_000, cacheWrite: 30_000, cacheRead: 400_000, output: 1_500 }, NOW);
    recordAgentUsage(sql, 'a1', { input: 1_000, cacheRead: 100_000, output: 500 }, NOW);
    expect(agentUsageSeries(sql, 'a1', '1d', 0, NOW).total).toEqual({ inputK: 533, uncachedK: 3, cacheWriteK: 30, cacheReadK: 500, outputK: 2, requests: 2 });
  });

  it('adds the cache columns to a table made before the split, keeping its rows as uncached input', () => {
    const sql = table('CREATE TABLE _agent_usage_hourly (account_id TEXT NOT NULL, hour INTEGER NOT NULL, requests INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account_id, hour))');
    ensureAgentUsageTable(sql);
    recordAgentUsage(sql, 'a1', { input: 5_000, cacheRead: 7_000, output: 100 }, NOW);
    expect(agentUsageSeries(sql, 'a1', '1d', 0, NOW).total).toMatchObject({ uncachedK: 5, cacheReadK: 7, inputK: 12 });
  });

  it('knows its ranges', () => {
    expect(['1d', '7d', '30d'].every(isUsageRange)).toBe(true);
    expect(isUsageRange('90d')).toBe(false);
  });
});
