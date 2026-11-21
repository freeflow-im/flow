// How long what a person does in Mail takes, from its start until its result is on screen: opening a list, a
// conversation, an attachment, an invitation's card. Each timing goes to POST /v1/perf (packages/edge/src/perf.ts) with
// the calls made meanwhile, from the browser's resource timing, each with the server's own split of its time
// (Server-Timing: lock wait, IMAP, cache) and the ray id that finds its server record in the Worker's logs.
// Nothing names what was acted on: an action is a name, a call is a path whose ids the server takes out.
// The last timings are on `window.__flowPerf` too, for a look in the console.
import { useEffect, useRef } from 'react';

export interface Call {
  path: string;
  ms: number;
  queuedMs?: number;
  waitMs?: number;
  status?: number;
  server?: Record<string, number>;
  ray?: string;
  cache?: string;
  bytes?: number;
  read?: 'kept' | 'stored' | 'part' | 'whole';
}

export interface PerfEvent {
  app: 'mail' | 'calendar';
  action: string;
  ms: number;
  ok: boolean;
  cached?: boolean;
  /** The page was hidden at the start or the end: the browser slows a hidden page, so its times run long. */
  hidden?: boolean;
  calls: Call[];
}

const FLUSH_MS = 15_000;
const KEEP_ENTRIES_MS = 120_000;
const MAX_QUEUE = 50;
const ASSET = /\/assets\/|\.(js|css|woff2?|svg|png|ico)$/;

/** The calls an action can have made: the same origin's, not the app's own files. */
const ofInterest = (e: PerformanceResourceTiming) => {
  try {
    const u = new URL(e.name);
    return u.origin === window.location.origin && !ASSET.test(u.pathname);
  } catch {
    return false;
  }
};

/** One resource timing as a call: total time, time held by the browser, time waiting for the server, the server's split. */
export function toCall(e: PerformanceResourceTiming): Call {
  const u = new URL(e.name);
  const call: Call = { path: u.pathname, ms: round(e.duration) };
  if (e.requestStart > 0) {
    call.queuedMs = round(Math.max(0, e.requestStart - e.startTime));
    if (e.responseStart > 0) call.waitMs = round(Math.max(0, e.responseStart - e.requestStart));
  }
  const status = (e as PerformanceResourceTiming & { responseStatus?: number }).responseStatus;
  if (status) call.status = status;
  if (e.encodedBodySize > 0) call.bytes = e.encodedBodySize;
  // Answered from the browser's own cache: nothing crossed the network, and its Server-Timing is the stored one.
  if (e.transferSize === 0 && e.encodedBodySize > 0) {
    call.cache = 'browser';
    return call;
  }
  for (const t of e.serverTiming ?? []) {
    if (t.name === 'ray' && /^[\w-]{1,40}$/.test(t.description)) call.ray = t.description;
    else if (t.name === 'cache' && /^\w{1,10}$/.test(t.description)) call.cache = t.description;
    else if (t.name === 'read' && /^(kept|stored|part|whole)$/.test(t.description)) call.read = t.description as Call['read'];
    else if (t.name === 'bytes') continue; // the browser's own size is the one kept
    else if (t.duration > 0 || t.name === 'total') (call.server ??= {})[t.name.slice(0, 20)] = round(t.duration);
  }
  return call;
}

const round = (n: number) => Math.round(n * 10) / 10;

// The recent calls, from an observer: resource timing's own buffer fills up (Mail polls) and then drops new entries.
let recent: PerformanceResourceTiming[] = [];
let observing = false;
function observe(): boolean {
  if (observing) return true;
  if (typeof PerformanceObserver !== 'function' || !PerformanceObserver.supportedEntryTypes?.includes('resource')) return false;
  new PerformanceObserver((list) => {
    const now = performance.now();
    recent = recent.filter((e) => e.responseEnd > now - KEEP_ENTRIES_MS);
    for (const e of list.getEntries() as PerformanceResourceTiming[]) if (ofInterest(e)) recent.push(e);
  }).observe({ type: 'resource', buffered: true });
  observing = true;
  return true;
}

let queue: PerfEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
const shown: PerfEvent[] = [];

function send(): void {
  timer = null;
  if (!queue.length) return;
  const events = queue;
  queue = [];
  try {
    navigator.sendBeacon('/v1/perf', new Blob([JSON.stringify({ events })], { type: 'application/json' }));
  } catch {
    // A timing is never worth an error.
  }
}

function enqueue(e: PerfEvent): void {
  shown.push(e);
  if (shown.length > 50) shown.shift();
  (window as unknown as { __flowPerf?: PerfEvent[] }).__flowPerf = shown;
  if (queue.length < MAX_QUEUE) queue.push(e);
  timer ??= setTimeout(send, FLUSH_MS);
}

let listening = false;
function listen(): void {
  if (listening) return;
  listening = true;
  // A page being left or hidden sends what it has: sendBeacon still goes once the page is gone.
  window.addEventListener('pagehide', send);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && send());
}

/** Timing is on in a browser that can both see its calls and send a beacon (not in tests). */
const enabled = () => typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function' && observe();

export interface Action {
  /** The result is on screen (or failed): it is timed to the next frame painted, with the calls made since it began. */
  end(ok?: boolean): void;
  /** Nothing to time after all: another action took its place. */
  cancel(): void;
}

const NOOP: Action = { end() {}, cancel() {} };

/** Starts timing an action of Mail's (`list.folder`, `thread.open`, …). */
export function startAction(action: string, opts: { cached?: boolean; app?: PerfEvent['app']; t0?: number } = {}): Action {
  if (!enabled()) return NOOP;
  listen();
  const t0 = opts.t0 ?? performance.now();
  const hiddenAtStart = document.visibilityState === 'hidden';
  let done = false;
  return {
    end(ok = true) {
      if (done) return;
      done = true;
      // At the next paint (the frame that shows the result), or within 100 ms: a hidden page paints no frames.
      let recorded = false;
      const record = () => {
        if (recorded) return;
        recorded = true;
        const t1 = performance.now();
        // Every call that ran during the action, including one a query began a moment before it.
        const calls = recent.filter((e) => e.responseEnd >= t0 && e.startTime <= t1).slice(0, 30).map(toCall);
        const hidden = hiddenAtStart || document.visibilityState === 'hidden';
        enqueue({ app: opts.app ?? 'mail', action, ms: round(t1 - t0), ok, ...(opts.cached ? { cached: true } : {}), ...(hidden ? { hidden: true } : {}), calls });
      };
      requestAnimationFrame(() => setTimeout(record, 0));
      setTimeout(record, 100);
    },
    cancel() {
      done = true;
    },
  };
}

/**
 * Times a view's load: each new `key` starts an action, ended once `state` is no longer 'loading'. A key that changes
 * first cancels the action before it; a key already loaded when it comes counts as `cached`. A null key times nothing.
 */
export function useTimedLoad(action: string, key: string | null, state: 'loading' | 'ok' | 'error'): void {
  // The start is the render that brings the new key, not the effect after it: a query's fetch can begin before that.
  const began = useRef<{ key: string | null; t0: number }>({ key: null, t0: 0 });
  if (began.current.key !== key) began.current = { key, t0: typeof performance === 'undefined' ? 0 : performance.now() };
  const current = useRef<{ key: string; a: Action | null } | null>(null);
  useEffect(() => {
    if (key === null) {
      current.current?.a?.cancel();
      current.current = null;
      return;
    }
    if (current.current?.key !== key) {
      current.current?.a?.cancel();
      current.current = { key, a: startAction(action, { cached: state !== 'loading', t0: began.current.t0 }) };
    }
    if (state !== 'loading' && current.current.a) {
      current.current.a.end(state === 'ok');
      current.current.a = null;
    }
  }, [action, key, state]);
}
