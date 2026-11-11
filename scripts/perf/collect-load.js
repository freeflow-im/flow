// One page load's numbers, for the suite's tab-switching work (scripts/perf/README.md). Paste into the console of a
// signed-in app page (or run through a browser automation tool) right after the page loads; it waits for the network to
// go quiet, then returns one object. Query strings are left out of what it prints: they carry ids.
(async () => {
  const QUIET_MS = 1500, MIN_MS = 4000, MAX_MS = 12000;
  const fetches = () => performance.getEntriesByType('resource').filter((e) => e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest');
  const started = performance.now();
  for (;;) {
    const last = Math.max(0, ...fetches().map((e) => e.responseEnd));
    // A call still in flight is not in the list yet (Docs waits about 2 s on its first one), so never stop before MIN_MS.
    if ((performance.now() > MIN_MS && performance.now() - last > QUIET_MS) || performance.now() - started > MAX_MS) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const lcp = await new Promise((resolve) => {
    new PerformanceObserver((l) => { const e = l.getEntries(); resolve(Math.round(e[e.length - 1].startTime)); }).observe({ type: 'largest-contentful-paint', buffered: true });
    setTimeout(() => resolve(null), 500);
  });
  const nav = performance.getEntriesByType('navigation')[0];
  const path = (e) => new URL(e.name).pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id');
  const api = fetches().filter((e) => new URL(e.name).origin === location.origin && !e.name.includes('/cdn-cgi/') && !/\/avatars\//.test(e.name));
  const code = performance.getEntriesByType('resource').filter((e) => /\.(js|css)$/.test(new URL(e.name).pathname) && new URL(e.name).origin === location.origin);
  const seen = new Map();
  for (const e of api) seen.set(e.name, (seen.get(e.name) ?? 0) + 1);
  const repeats = new Map();
  for (const [name, n] of seen) if (n > 1) repeats.set(path({ name }), Math.max(n, repeats.get(path({ name })) ?? 0));
  return {
    app: location.pathname.split('/')[1],
    lcp,
    html: Math.round(nav.responseStart),
    codeDownloaded: code.reduce((n, e) => n + e.transferSize, 0),
    codeEnd: Math.round(Math.max(0, ...code.map((e) => e.responseEnd))),
    firstCall: Math.round(Math.min(...api.map((e) => e.startTime))),
    lastCallEnd: Math.round(Math.max(...api.map((e) => e.responseEnd))),
    calls: api.length,
    repeated: [...repeats].map(([p, n]) => `${p} x${n}`),
    slow: api.filter((e) => e.duration > 400).map((e) => `${path(e)} ${Math.round(e.startTime)}+${Math.round(e.duration)}`),
  };
})()
