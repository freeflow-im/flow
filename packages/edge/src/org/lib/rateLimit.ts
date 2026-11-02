// Tiny fixed-window in-memory rate limiter for the handful of unauthenticated
// endpoints that can trigger user-visible side effects (agent registration
// prompts) or credential guessing (agent login). Single-node, best-effort —
// matches the single-node presence model.
const windows = new Map<string, { count: number; resetAt: number }>();

/** true = allowed. Key by endpoint + caller identity (e.g. `agent-reg:${ip}`). */
export function rateAllow(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const w = windows.get(key);
  if (!w || w.resetAt <= now) {
    // opportunistic sweep so the map can't grow unbounded under churn
    if (windows.size > 10_000) {
      for (const [k, v] of windows) if (v.resetAt <= now) windows.delete(k);
    }
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  w.count += 1;
  return w.count <= limit;
}

/** Test hook: drop every window so a suite can exercise a limiter twice
 * without waiting one out. Never called from production code. */
export function _resetRateLimitsForTests(): void {
  windows.clear();
}
