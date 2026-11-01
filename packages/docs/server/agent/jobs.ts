// Jobs that change the app's own source code. The assistant files one (request_app_change) or a user asks
// for a revert on the Changes page; after the current turn ends the runner starts a detached worker process
// (server/agent/worker.ts) that drives Claude Code in the repository, verifies the result, restarts the app
// in production, publishes the change to GitHub, and records progress here. The worker is detached because
// editing files under server/ or shared/ restarts the dev server, and the job must survive that.
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { JOB_ACTIVE_STATUSES, type AgentJob, type AgentJobStatus } from '../../shared/agent/protocol.ts';
import type { DB } from '../db.ts';

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

const ACTIVE = [...JOB_ACTIVE_STATUSES];
/** A job that has not finished after this long is considered dead. */
const STALE_MS = 45 * 60 * 1000;
const MAX_LOG_LINES = 300;

interface Row {
  id: string;
  user_id: string;
  kind: 'change' | 'revert' | 'research';
  title: string;
  sheet_id: string | null;
  spec: string;
  status: AgentJobStatus;
  pid: number | null;
  log: string;
  summary: string | null;
  error: string | null;
  files: string | null;
  cost_usd: number | null;
  requested_by: string | null;
  branch: string | null;
  commit_sha: string | null;
  pr_number: number | null;
  pr_url: string | null;
  merged_sha: string | null;
  patch: string | null;
  reverts_job_id: string | null;
  reverted_by_job_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  acknowledged_at: string | null;
}

export interface JobRecord extends AgentJob {
  userId: string;
  pid: number | null;
  patch?: string;
}

export interface JobPatch {
  pid?: number;
  summary?: string;
  error?: string;
  files?: string[];
  costUsd?: number;
  branch?: string;
  commitSha?: string;
  prNumber?: number;
  prUrl?: string;
  mergedSha?: string;
  patch?: string;
}

const now = () => new Date().toISOString();
const opt = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

function toJob(r: Row): JobRecord {
  return {
    id: r.id,
    userId: r.user_id,
    kind: r.kind,
    title: r.title,
    spec: r.spec,
    sheetId: opt(r.sheet_id),
    status: r.status,
    pid: r.pid,
    log: JSON.parse(r.log) as string[],
    summary: opt(r.summary),
    error: opt(r.error),
    files: r.files ? (JSON.parse(r.files) as string[]) : undefined,
    costUsd: opt(r.cost_usd),
    requestedBy: opt(r.requested_by),
    branch: opt(r.branch),
    commitSha: opt(r.commit_sha),
    prNumber: opt(r.pr_number),
    prUrl: opt(r.pr_url),
    mergedSha: opt(r.merged_sha),
    patch: opt(r.patch),
    revertsJobId: opt(r.reverts_job_id),
    revertedByJobId: opt(r.reverted_by_job_id),
    createdAt: r.created_at,
    startedAt: opt(r.started_at),
    finishedAt: opt(r.finished_at),
    acknowledged: !!r.acknowledged_at,
  };
}

/** The part of a job the browser sees. */
export function publicJob(j: JobRecord): AgentJob {
  const { userId: _u, pid: _p, patch: _patch, ...pub } = j;
  return pub;
}

export class JobStore {
  private db: DB;

  constructor(db: DB) {
    this.db = db;
  }

  create(userId: string, title: string, spec: string, opts: { kind?: 'change' | 'revert' | 'research'; requestedBy?: string; revertsJobId?: string; sheetId?: string } = {}): JobRecord {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO agent_jobs (id, user_id, kind, title, spec, status, requested_by, reverts_job_id, sheet_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, userId, opts.kind ?? 'change', title, spec, 'queued', opts.requestedBy ?? null, opts.revertsJobId ?? null, opts.sheetId ?? null, now());
    return this.get(id)!;
  }

  get(id: string): JobRecord | null {
    const row = this.db.prepare('SELECT * FROM agent_jobs WHERE id = ?').get(id) as Row | undefined;
    return row ? toJob(row) : null;
  }

  /** The user's most recent job. */
  latest(userId: string): JobRecord | null {
    const row = this.db.prepare('SELECT * FROM agent_jobs WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(userId) as Row | undefined;
    return row ? toJob(row) : null;
  }

  /** Every job, newest first: the app's change history. */
  list(limit = 200): JobRecord[] {
    return (this.db.prepare('SELECT * FROM agent_jobs ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit) as unknown as Row[]).map(toJob);
  }

  /** The job that is queued or running, if any. Only one job at a time: they all edit the same working tree. */
  active(): JobRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM agent_jobs WHERE status IN (${ACTIVE.map(() => '?').join(',')}) ORDER BY created_at, rowid LIMIT 1`)
      .get(...ACTIVE) as Row | undefined;
    return row ? toJob(row) : null;
  }

  /** Atomically take the oldest queued job, marking it as starting. */
  claimQueued(): JobRecord | null {
    const row = this.db.prepare("SELECT id FROM agent_jobs WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1").get() as { id: string } | undefined;
    if (!row) return null;
    const res = this.db.prepare("UPDATE agent_jobs SET status = 'starting', started_at = ? WHERE id = ? AND status = 'queued'").run(now(), row.id);
    return res.changes ? this.get(row.id) : null;
  }

  setStatus(id: string, status: AgentJobStatus, patch: JobPatch = {}): void {
    const finished = status === 'done' || status === 'failed';
    this.db
      .prepare(
        `UPDATE agent_jobs SET status = ?, pid = COALESCE(?, pid), summary = COALESCE(?, summary), error = COALESCE(?, error),
         files = COALESCE(?, files), cost_usd = COALESCE(?, cost_usd), branch = COALESCE(?, branch), commit_sha = COALESCE(?, commit_sha),
         pr_number = COALESCE(?, pr_number), pr_url = COALESCE(?, pr_url), merged_sha = COALESCE(?, merged_sha), patch = COALESCE(?, patch),
         finished_at = CASE WHEN ? THEN ? ELSE finished_at END WHERE id = ?`,
      )
      .run(
        status,
        patch.pid ?? null,
        patch.summary ?? null,
        patch.error ?? null,
        patch.files ? JSON.stringify(patch.files) : null,
        patch.costUsd ?? null,
        patch.branch ?? null,
        patch.commitSha ?? null,
        patch.prNumber ?? null,
        patch.prUrl ?? null,
        patch.mergedSha ?? null,
        patch.patch ?? null,
        finished ? 1 : 0,
        now(),
        id,
      );
  }

  /** Record that a change has been undone by a revert job. */
  markReverted(id: string, byJobId: string): void {
    this.db.prepare('UPDATE agent_jobs SET reverted_by_job_id = ? WHERE id = ?').run(byJobId, id);
  }

  appendLog(id: string, line: string): void {
    const job = this.get(id);
    if (!job) return;
    const log = [...job.log, line].slice(-MAX_LOG_LINES);
    this.db.prepare('UPDATE agent_jobs SET log = ? WHERE id = ?').run(JSON.stringify(log), id);
  }

  acknowledge(id: string, userId: string): boolean {
    const res = this.db.prepare('UPDATE agent_jobs SET acknowledged_at = ? WHERE id = ? AND user_id = ? AND acknowledged_at IS NULL').run(now(), id, userId);
    return res.changes > 0;
  }
}

/** Starts a job's worker process; returns its pid. Swappable so tests don't run Claude Code. */
export type Launcher = (job: JobRecord) => number | undefined;

export function workerLauncher(dataDir: string): Launcher {
  return (job) => {
    const logDir = path.join(dataDir, 'jobs');
    mkdirSync(logDir, { recursive: true });
    const out = openSync(path.join(logDir, `${job.id}.log`), 'a');
    const child = spawn(process.execPath, [path.join(import.meta.dirname, 'worker.ts'), job.id], {
      cwd: REPO_ROOT,
      detached: true,
      stdio: ['ignore', out, out],
      // The worker asks this server to restart once the change is verified (production only).
      env: { ...process.env, DATA_DIR: dataDir, AGENT_SERVER_PID: String(process.pid) },
    });
    child.unref();
    return child.pid;
  };
}

export class JobRunner {
  private store: JobStore;
  private launch: Launcher;

  constructor(store: JobStore, launch: Launcher) {
    this.store = store;
    this.launch = launch;
  }

  /** Start the next queued job unless one is already running. Called after each assistant turn and at startup. */
  startQueued(): void {
    const active = this.store.active();
    if (active && active.status !== 'queued') return;
    const job = this.store.claimQueued();
    if (!job) return;
    try {
      const pid = this.launch(job);
      this.store.setStatus(job.id, 'starting', pid === undefined ? {} : { pid });
      this.store.appendLog(job.id, 'Starting the coding agent…');
    } catch (e) {
      this.store.setStatus(job.id, 'failed', { error: `Could not start the coding agent: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  /** On startup: fail jobs whose worker is gone (the machine or process died), then start anything queued. */
  reconcile(): void {
    const job = this.store.active();
    if (job && job.status !== 'queued') {
      const alive = job.pid !== null && isAlive(job.pid);
      const stale = Date.now() - new Date(job.startedAt ?? job.createdAt).getTime() > STALE_MS;
      if (!alive || stale) {
        this.store.setStatus(job.id, 'failed', { error: alive ? 'The job took too long and was abandoned.' : 'The coding agent stopped unexpectedly.' });
      }
    }
    this.startQueued();
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
