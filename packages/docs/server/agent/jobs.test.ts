import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../db.ts';
import { JobRunner, JobStore, publicJob, type JobRecord } from './jobs.ts';

let dir: string;
let db: DB;
let store: JobStore;
const userId = 'u1';

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sheetsweb-jobs-test-'));
  db = openDb(path.join(dir, 'app.db'));
  db.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)').run(userId, 'j@x.com', 'x', new Date().toISOString());
  store = new JobStore(db);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('app-change jobs', () => {
  it('runs one job at a time, in order', () => {
    const launched: string[] = [];
    const runner = new JobRunner(store, (job: JobRecord) => {
      launched.push(job.id);
      return process.pid; // a pid that is alive
    });
    const a = store.create(userId, 'First', 'spec a');
    const b = store.create(userId, 'Second', 'spec b');
    expect(store.active()?.id).toBe(a.id);

    runner.startQueued();
    expect(launched).toEqual([a.id]);
    expect(store.get(a.id)?.status).toBe('starting');
    expect(store.get(a.id)?.log).toEqual(['Starting the coding agent…']);

    runner.startQueued(); // a is still running: b waits
    expect(launched).toEqual([a.id]);
    expect(store.get(b.id)?.status).toBe('queued');

    store.setStatus(a.id, 'coding');
    store.appendLog(a.id, 'Edited server/agent/tools.ts');
    store.setStatus(a.id, 'done', { summary: 'Added set_filter_values.', files: ['server/agent/tools.ts'], costUsd: 0.42 });
    const done = store.get(a.id)!;
    expect(done.status).toBe('done');
    expect(done.finishedAt).toBeTruthy();
    expect(done.summary).toBe('Added set_filter_values.');
    expect(done.files).toEqual(['server/agent/tools.ts']);
    expect(done.log).toHaveLength(2);

    runner.startQueued();
    expect(launched).toEqual([a.id, b.id]);
    store.setStatus(b.id, 'failed', { error: 'boom' });
    expect(store.latest(userId)?.id).toBe(b.id);
  });

  it('fails a job whose worker is gone when the server starts', () => {
    const job = store.create(userId, 'Orphan', 'spec');
    const runner = new JobRunner(store, () => 2_147_483_000); // no such process
    runner.startQueued();
    expect(store.get(job.id)?.status).toBe('starting');
    runner.reconcile();
    expect(store.get(job.id)?.status).toBe('failed');
    expect(store.get(job.id)?.error).toMatch(/stopped unexpectedly/);
  });

  it('acknowledges only the owner’s job and hides internals from the browser', () => {
    const job = store.create(userId, 'Ack', 'spec');
    store.setStatus(job.id, 'failed', { error: 'x' });
    expect(store.acknowledge(job.id, 'someone-else')).toBe(false);
    expect(store.acknowledge(job.id, userId)).toBe(true);
    expect(store.acknowledge(job.id, userId)).toBe(false);
    const pub = publicJob(store.get(job.id)!) as unknown as Record<string, unknown>;
    expect(pub.acknowledged).toBe(true);
    expect(pub.spec).toBe('spec'); // shown on the Changes page
    expect(pub.pid).toBeUndefined();
    expect(pub.userId).toBeUndefined();
  });

  it('records the change and links a revert to it', () => {
    const job = store.create(userId, 'Images', 'spec', { requestedBy: 'j@x.com' });
    expect(job.kind).toBe('change');
    expect(job.requestedBy).toBe('j@x.com');
    store.setStatus(job.id, 'publishing', { branch: 'assistant/x', commitSha: 'c1', patch: 'diff --git a b' });
    store.setStatus(job.id, 'publishing', { prNumber: 3, prUrl: 'https://github.com/a/b/pull/3' });
    store.setStatus(job.id, 'done', { mergedSha: 'm1' });
    const done = store.get(job.id)!;
    expect(done).toMatchObject({ branch: 'assistant/x', commitSha: 'c1', prNumber: 3, mergedSha: 'm1', patch: 'diff --git a b' });
    expect((publicJob(done) as unknown as Record<string, unknown>).patch).toBeUndefined();

    const revert = store.create(userId, job.title, 'Revert', { kind: 'revert', revertsJobId: job.id, requestedBy: 'j@x.com' });
    expect(revert.kind).toBe('revert');
    expect(revert.revertsJobId).toBe(job.id);
    store.markReverted(job.id, revert.id);
    expect(store.get(job.id)?.revertedByJobId).toBe(revert.id);
    expect(store.list().map((j) => j.id)).toContain(revert.id);
    expect(store.list()[0].id).toBe(revert.id); // newest first
  });
});
