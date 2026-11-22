// AI usage per agent (Taskboard #22): tokens added to the agent's hour, read back by hour for a day or by day for 7 or 30,
// in thousands, with the viewer's midnight as a day's start; other agents' rows and rows past the range stay out.
import { describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { AGENT_USAGE_DDL, agentUsageSeries, isUsageRange, recordAgentUsage, type UsageSql } from './agentUsage';

function sqlOf(): UsageSql {
  const db = new DatabaseSync(':memory:');
  db.exec(AGENT_USAGE_DDL);
  // Runs at once, as the runtime's exec does.
  return {
    exec: (q, ...b) => {
      const st = db.prepare(q), args = b as SQLInputValue[];
      const rows = q.trim().startsWith('SELECT') ? (st.all(...args) as Record<string, unknown>[]) : (st.run(...args), []);
      return { toArray: () => rows };
    },
  };
}

const H = 3_600_000;
const NOW = Date.parse('2026-11-21T15:30:00Z');

describe('agent usage', () => {
  it('adds calls in the same hour together and reads a day by hour, the current hour last', () => {
    const sql = sqlOf();
    recordAgentUsage(sql, 'a1', { input: 12_000, output: 800 }, NOW);
    recordAgentUsage(sql, 'a1', { input: 3_000, output: 200 }, NOW + 60_000);
    recordAgentUsage(sql, 'a1', { input: 5_000, output: 1_000 }, NOW - 2 * H);
    recordAgentUsage(sql, 'other', { input: 99_000, output: 99_000 }, NOW);
    const u = agentUsageSeries(sql, 'a1', '1d', 0, NOW);
    expect(u.bucket).toBe('hour');
    expect(u.buckets).toHaveLength(24);
    expect(u.buckets.at(-1)).toEqual({ start: '2026-11-21T15:00:00.000Z', inputK: 15, outputK: 1, requests: 2 });
    expect(u.buckets.at(-3)).toMatchObject({ start: '2026-11-21T13:00:00.000Z', inputK: 5, outputK: 1 });
    expect(u.total).toEqual({ inputK: 20, outputK: 2, requests: 3 });
  });

  it('reads 7 and 30 days by day from the viewer’s midnight, leaving out older hours', () => {
    const sql = sqlOf();
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
    const sql = sqlOf();
    recordAgentUsage(sql, 'a1', { input: 1_234, output: 56 }, NOW);
    recordAgentUsage(sql, 'a1', { input: 0, output: 0 }, NOW);
    recordAgentUsage(sql, 'a1', { input: Number.NaN, output: -5 }, NOW);
    expect(agentUsageSeries(sql, 'a1', '1d', 0, NOW).total).toEqual({ inputK: 1.2, outputK: 0.1, requests: 1 });
    recordAgentUsage(sql, 'old', { input: 1_000, output: 1_000 }, NOW - 40 * 24 * H);
    recordAgentUsage(sql, 'a1', { input: 1, output: 1 }, NOW);
    expect(sql.exec("SELECT * FROM _agent_usage_hourly WHERE account_id = 'old'").toArray()).toEqual([]);
  });

  it('knows its ranges', () => {
    expect(['1d', '7d', '30d'].every(isUsageRange)).toBe(true);
    expect(isUsageRange('90d')).toBe(false);
  });
});
