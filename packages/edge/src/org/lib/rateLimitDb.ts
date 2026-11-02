// Rate limits in the object's own database. The same contract as lib/rateLimit.ts `rateAllow`.
import { sql } from 'drizzle-orm';
import { db } from '../db/index';

export async function rateAllowDb(key: string, limit: number, windowMs: number): Promise<boolean> {
  const now = Date.now();
  const rows = db.all<{ count: number }>(sql`
    INSERT INTO rate_limit_windows (key, window_start, count) VALUES (${key}, ${now}, 1)
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN window_start <= ${now - windowMs} THEN 1 ELSE count + 1 END,
      window_start = CASE WHEN window_start <= ${now - windowMs} THEN ${now} ELSE window_start END
    RETURNING count`);
  const count = rows[0]?.count;
  return count === undefined || count <= limit;
}
export async function purgeStaleRateWindows(): Promise<void> {
  const cutoff = Date.now() - 86_400_000;
  db.run(sql`DELETE FROM rate_limit_windows WHERE window_start < ${cutoff}`);
}
