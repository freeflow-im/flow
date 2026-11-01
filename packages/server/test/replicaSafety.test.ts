// Phase 18 M1 (replica-readiness groundwork): the hard-state pieces that must
// stay correct when two server replicas run the same code — serialized boot
// migrations, a shared rate-limit window, and the sweep singleton lock.
// (The exactly-once outbox claiming case went with the Slack-compatible Events
// API; pushOutbox.test.ts covers the same claiming pattern for push.)
// DB-backed — scratch database on the dev postgres (docker compose in
// packages/infra, host port 5442).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';

process.env.DATABASE_URL = process.env.FLOW_TEST_DATABASE_URL
  ?? 'postgres://flow:flow_dev@localhost:5442/flow_replica_test';
process.env.FLOW_DATA_KEY = randomBytes(32).toString('base64');

{
  const { default: postgres } = await import('postgres');
  const url = new URL(process.env.DATABASE_URL);
  const dbName = url.pathname.slice(1);
  url.pathname = '/postgres';
  const admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE "${dbName}"`).catch(() => {}); // 42P04 duplicate_database
  await admin.end();
}

// dynamic imports so the env above is set before config/db read it
const { migrate } = await import('../src/db/migrate.js');
const { db, schema, closeDb } = await import('../src/db/index.js');
const { rateAllowDb, purgeStaleRateWindows } = await import('../src/lib/rateLimitDb.js');
const { runExclusive } = await import('../src/lib/singleton.js');
const { eq } = await import('drizzle-orm');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await migrate(process.env.DATABASE_URL!);
  await db.execute(`TRUNCATE users, workspaces, sessions, invites, pending_signups, rate_limit_windows RESTART IDENTITY CASCADE` as never);
});

afterAll(async () => {
  await closeDb();
});

describe('concurrent migrate() is serialized by the advisory lock', () => {
  // 30s: creates a database and runs the full migration chain twice, while the
  // rest of the suite loads the same postgres.
  it('two racers on a fresh database each apply every migration exactly once', { timeout: 30_000 }, async () => {
    const url = new URL(process.env.DATABASE_URL!);
    const dbName = `flow_replica_migrate_${randomUUID().slice(0, 8)}`;
    url.pathname = '/postgres';
    const { default: postgres } = await import('postgres');
    const admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    url.pathname = `/${dbName}`;
    const freshUrl = url.toString();
    try {
      const [a, b] = await Promise.all([migrate(freshUrl), migrate(freshUrl)]);
      // Between them every migration ran, and none ran twice: the loser waited
      // on the lock, then saw the winner's schema_migrations rows and no-oped.
      expect(a.length + b.length).toBeGreaterThan(0);
      expect(a.filter((f) => b.includes(f))).toEqual([]);
      const check = postgres(freshUrl, { max: 1, onnotice: () => {} });
      const rows = await check`SELECT name, count(*) AS n FROM schema_migrations GROUP BY name HAVING count(*) > 1`;
      await check.end();
      expect(rows.length).toBe(0);
    } finally {
      const drop = postgres(url.toString().replace(`/${dbName}`, '/postgres'), { max: 1, onnotice: () => {} });
      await drop.unsafe(`DROP DATABASE "${dbName}" WITH (FORCE)`).catch(() => {});
      await drop.end();
    }
  });
});

describe('DB-backed fixed-window rate limiter', () => {
  it('counts every caller against one shared window', async () => {
    const key = `test:${randomUUID()}`;
    expect(await rateAllowDb(key, 2, 60_000)).toBe(true);
    expect(await rateAllowDb(key, 2, 60_000)).toBe(true);
    expect(await rateAllowDb(key, 2, 60_000)).toBe(false);
  });

  it('opens a new window after the old one lapses', async () => {
    const key = `test:${randomUUID()}`;
    expect(await rateAllowDb(key, 1, 150)).toBe(true);
    expect(await rateAllowDb(key, 1, 150)).toBe(false);
    await sleep(200);
    expect(await rateAllowDb(key, 1, 150)).toBe(true);
  });

  it('purge drops only stale windows', async () => {
    const key = `test:${randomUUID()}`;
    await rateAllowDb(key, 5, 60_000);
    await purgeStaleRateWindows();
    const kept = await db
      .select({ key: schema.rateLimitWindows.key })
      .from(schema.rateLimitWindows)
      .where(eq(schema.rateLimitWindows.key, key));
    expect(kept.length).toBe(1); // fresh window survives the daily purge
  });
});

describe('singleton sweep lock', () => {
  it('admits exactly one of two concurrent runners, then frees the lock', async () => {
    const key = 0x466c6f77000000ffn; // test-only key
    let runs = 0;
    const job = async () => {
      runs += 1;
      await sleep(200);
      return runs;
    };
    const [a, b] = await Promise.all([runExclusive(key, job), runExclusive(key, job)]);
    expect(runs).toBe(1);
    expect([a.ran, b.ran].sort()).toEqual([false, true]);
    // released: a later round runs again
    const again = await runExclusive(key, job);
    expect(again.ran).toBe(true);
    expect(runs).toBe(2);
  });
});
