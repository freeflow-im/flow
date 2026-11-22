// The server's alerts for the suite bar (shared/alerts.ts): an agent's show_alert, for this person only. The page reads
// the open ones (GET /v1/alerts) when it loads, when it is shown again and after each reconnect, and keeps a socket
// to the organization (`/v1/ws`, `{op: 'auth', alerts: true}`, signed in by the session cookie) that pushes each new
// `alert.created` and `alert.closed` as it happens. Closing one closes it on the server, so every tab and device closes it.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ALERT_CLOSED, ALERT_CREATED, type AlertDTO, type AlertFrame } from '@flow/shared';
import type { SuiteAlert } from './alerts';

/** The socket's backoff after a drop, and the most it waits. */
const RETRY_FIRST_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/** The server wants the client to ping (Durable Objects hibernate between messages). */
const PING_EVERY_MS = 30_000;
/** How often ended alerts are dropped. */
const TICK_MS = 15_000;

/** An alert from the server, as the bar's card shows it. */
export function toSuiteAlert(a: AlertDTO): SuiteAlert {
  return {
    id: a.alertId,
    kind: a.kind,
    title: a.title,
    lines: a.from ? [...a.lines, `From ${a.from}`] : a.lines,
    actions: a.actions.map((x) => ({ label: x.label, href: x.href, ...(x.primary ? { primary: true } : {}) })),
  };
}

/** The open alerts after one pushed frame. */
export function applyAlertFrame(open: readonly AlertDTO[], frame: Pick<AlertFrame, 'type' | 'data'>): AlertDTO[] {
  const id = (frame.data as { alertId?: unknown }).alertId;
  if (typeof id !== 'string') return [...open];
  const rest = open.filter((a) => a.alertId !== id);
  return frame.type === ALERT_CREATED ? [...rest, frame.data as AlertDTO] : frame.type === ALERT_CLOSED ? rest : [...open];
}

const socketUrl = (organizationId: string) => {
  const { protocol, host } = window.location;
  return `${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}/v1/ws?workspace=${encodeURIComponent(organizationId)}`;
};

/**
 * This person's alerts from the server in the organization the bar shows, and the way to close one. Nothing without an
 * organization, or where the page has no fetch or WebSocket (tests, old browsers).
 */
export function useServerAlerts(organizationId: string | null): [SuiteAlert[], (id: string) => boolean] {
  const [open, setOpen] = useState<AlertDTO[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const ids = useRef(new Set<string>());
  ids.current = new Set(open.map((a) => a.alertId));

  useEffect(() => {
    setOpen([]);
    if (!organizationId || typeof fetch !== 'function') return;
    let live = true;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    let backoff = RETRY_FIRST_MS;
    const q = `workspace=${encodeURIComponent(organizationId)}`;
    const read = () => {
      fetch(`/v1/alerts?${q}`, { credentials: 'same-origin', headers: { accept: 'application/json' } })
        .then((r) => (r.ok ? (r.json() as Promise<{ alerts?: AlertDTO[] }>) : null))
        .then((b) => { if (live && b) setOpen(Array.isArray(b.alerts) ? b.alerts : []); })
        .catch(() => undefined);
    };
    const connect = () => {
      if (!live || typeof WebSocket !== 'function') return;
      const s = new WebSocket(socketUrl(organizationId));
      ws = s;
      s.onopen = () => s.send(JSON.stringify({ op: 'auth', alerts: true }));
      s.onmessage = (m) => {
        let frame: { op?: string; type?: AlertFrame['type']; data?: AlertFrame['data'] };
        try { frame = JSON.parse(String(m.data)); } catch { return; }
        if (frame.op === 'hello') {
          // Signed in: what came while the socket was down is read again, and pings keep it.
          backoff = RETRY_FIRST_MS;
          read();
          clearInterval(ping);
          ping = setInterval(() => { if (s.readyState === WebSocket.OPEN) s.send('{"op":"ping"}'); }, PING_EVERY_MS);
        } else if (frame.op === 'alert' && frame.type && frame.data) {
          setOpen((cur) => applyAlertFrame(cur, frame as AlertFrame));
        }
      };
      s.onclose = (e) => {
        clearInterval(ping);
        if (ws !== s) return;
        ws = null;
        // Refused (signed out, not a member): no retry until the page loads again.
        if (!live || e.code === 4003) return;
        retry = setTimeout(connect, Math.round(backoff * (0.75 + Math.random() * 0.5)));
        backoff = Math.min(backoff * 2, RETRY_MAX_MS);
      };
    };
    read();
    connect();
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      read();
      // A sleeping laptop's socket may have died without a close: one that is not open is replaced now.
      if (!ws || ws.readyState === WebSocket.CLOSED) { clearTimeout(retry); backoff = RETRY_FIRST_MS; connect(); }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      clearTimeout(retry);
      clearInterval(ping);
      document.removeEventListener('visibilitychange', onVisible);
      const s = ws;
      ws = null;
      s?.close();
    };
  }, [organizationId]);

  useEffect(() => {
    if (!open.length) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(tick);
  }, [open]);

  const shown = useMemo(() => open.filter((a) => Date.parse(a.endsAt) > now).map(toSuiteAlert), [open, now]);

  /** Closes a server alert here at once and on the server; false for an id that is not one (a meeting's, the page's). */
  const close = useCallback((id: string): boolean => {
    if (!organizationId || !ids.current.has(id)) return false;
    setOpen((cur) => cur.filter((a) => a.alertId !== id));
    void fetch(`/v1/alerts/${encodeURIComponent(id)}/close?workspace=${encodeURIComponent(organizationId)}`, { method: 'POST', credentials: 'same-origin' }).catch(() => undefined);
    return true;
  }, [organizationId]);

  return [shown, close];
}
