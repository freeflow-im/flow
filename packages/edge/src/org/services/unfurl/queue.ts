// Phase 11 §9: the worker queue.
//
// IN-MEMORY BY DECISION (operator call, 2026-07-22). Jobs do not survive a
// restart or deploy: anything in flight is dropped, and those links stay
// un-unfurled until the message is edited. That is the accepted trade for not
// adding JetStream or a jobs table. Everything here is therefore best-effort
// and must never block or fail a message send.
import { hostMatchesDomain } from './urls.js';

/** §3: max concurrent connections to one host. */
export const MAX_CONCURRENT_PER_HOST = 4;
/** §3: per-host rate limit. */
export const HOST_RATE_LIMIT = 10;
export const HOST_RATE_WINDOW_MS = 60_000;
/** §9: retries on transient failure, exponential backoff. */
export const RETRY_DELAYS_MS = [5_000, 30_000];
/** §9: total budget for one job including retries. */
export const JOB_BUDGET_MS = 20_000;
/** Backstop so a burst of links can't grow the queue without bound. */
export const MAX_QUEUE_DEPTH = 1_000;

export interface Job<T = unknown> {
  /** Dedup key — `(message_id, url_hash)` per §1. */
  key: string;
  /** Host the job will hit, for per-host limits. */
  host: string;
  run: (attempt: number) => Promise<T>;
  /** True when the failure is worth retrying (5xx/timeout, per §9). */
  retryable: (err: unknown) => boolean;
  onError?: (err: unknown) => void;
}

interface HostState {
  active: number;
  /** Timestamps of recent starts, for the rate limit window. */
  recent: number[];
}

export class UnfurlQueue {
  private pending: Job[] = [];
  private readonly inFlight = new Set<string>();
  private readonly hosts = new Map<string, HostState>();
  private draining = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;

  /** Test seam: overridable clock/sleep so retries don't slow the suite. */
  constructor(
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms).unref?.()),
    private readonly now: () => number = () => Date.now(),
  ) {}

  get depth(): number {
    return this.pending.length + this.inFlight.size;
  }

  /** Enqueue unless the same key is already queued/running, or we're full. */
  enqueue(job: Job): boolean {
    if (this.stopped) return false;
    if (this.inFlight.has(job.key) || this.pending.some((j) => j.key === job.key)) return false;
    if (this.depth >= MAX_QUEUE_DEPTH) return false;
    this.pending.push(job);
    void this.drain();
    return true;
  }

  private hostState(host: string): HostState {
    let state = this.hosts.get(host);
    if (!state) {
      state = { active: 0, recent: [] };
      this.hosts.set(host, state);
    }
    return state;
  }

  /** §3: is this host under both its concurrency and rate limits? */
  private hostAvailable(host: string): boolean {
    const state = this.hostState(host);
    if (state.active >= MAX_CONCURRENT_PER_HOST) return false;
    const cutoff = this.now() - HOST_RATE_WINDOW_MS;
    state.recent = state.recent.filter((t) => t > cutoff);
    return state.recent.length < HOST_RATE_LIMIT;
  }

  private async drain(): Promise<void> {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      for (;;) {
        // Pick the first job whose host has capacity, so one saturated domain
        // can't head-of-line block the rest of the queue (§9).
        const index = this.pending.findIndex((j) => this.hostAvailable(j.host));
        if (index === -1) break;
        const job = this.pending.splice(index, 1)[0]!;
        const state = this.hostState(job.host);
        state.active += 1;
        state.recent.push(this.now());
        this.inFlight.add(job.key);
        void this.runJob(job).finally(() => {
          state.active -= 1;
          this.inFlight.delete(job.key);
          void this.drain();
        });
      }
    } finally {
      this.draining = false;
    }
    // Jobs may be waiting only on a host's rate-limit window; re-check soon.
    if (this.pending.length > 0 && !this.timer && !this.stopped) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.drain();
      }, 1_000);
      this.timer.unref?.();
    }
  }

  private async runJob(job: Job): Promise<void> {
    const deadline = this.now() + JOB_BUDGET_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        await job.run(attempt);
        return;
      } catch (err) {
        const canRetry =
          attempt < RETRY_DELAYS_MS.length &&
          job.retryable(err) &&
          this.now() + RETRY_DELAYS_MS[attempt]! < deadline;
        if (!canRetry) {
          job.onError?.(err);
          return;
        }
        await this.sleep(RETRY_DELAYS_MS[attempt]!);
        if (this.stopped || this.now() > deadline) {
          job.onError?.(err);
          return;
        }
      }
    }
  }

  /** Drop everything pending; in-flight jobs finish on their own. */
  stop(): void {
    this.stopped = true;
    this.pending = [];
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/** §10: does this host match any denylist domain? */
export function isDenied(host: string, denylist: string[]): boolean {
  return denylist.some((d) => hostMatchesDomain(host, d));
}

/** §10 allowlist mode: null/empty allowlist means "allow everything". */
export function isAllowedByAllowlist(host: string, allowlist: string[] | null | undefined): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  return allowlist.some((d) => hostMatchesDomain(host, d));
}
