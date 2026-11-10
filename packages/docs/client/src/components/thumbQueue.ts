// The thumbnail view's loads, a few at a time. A browser gives one host about six connections, and in the desktop
// app each window holds one or two of them open for its event streams (the folder's changes, the agent's tool
// calls), so a page of cards asking for forty previews, PDFs and videos at once leaves every card blank until the
// queue drains. Here at most LANES loads run at once, the newest first (what just scrolled into view), and a card that
// goes away before its turn, or while it loads, is dropped.

export const LANES = 3;

interface Job {
  run(signal: AbortSignal): Promise<unknown>;
  controller: AbortController;
}

const waiting: Job[] = [];
let running = 0;

function next() {
  while (running < LANES && waiting.length) {
    const job = waiting.pop()!;
    if (job.controller.signal.aborted) continue;
    running++;
    void job
      .run(job.controller.signal)
      .catch(() => undefined)
      .finally(() => {
        running--;
        next();
      });
  }
}

/**
 * Queues a load. `run` gets a signal that is aborted when the load is cancelled, and should stop then (pass it to
 * fetch, destroy a pdf.js task); the lane is free once its promise settles. Returns the way to cancel it.
 */
export function schedule(run: (signal: AbortSignal) => Promise<unknown>): () => void {
  const job: Job = { run, controller: new AbortController() };
  waiting.push(job);
  next();
  return () => {
    job.controller.abort();
    const i = waiting.indexOf(job);
    if (i >= 0) waiting.splice(i, 1);
  };
}

/** For tests: what is queued and running. */
export const queueState = () => ({ waiting: waiting.length, running });
