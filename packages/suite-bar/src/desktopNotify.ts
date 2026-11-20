// Desktop notifications for the suite bar's alerts (Taskboard task 15). When a meeting alert appears, the browser's
// Notification API raises one banner for it, once across every open Flow tab: the first tab to claim the alert's id
// (under a Web Lock, in localStorage) shows it, the others do not. Clicking the banner focuses the tab and opens the
// meeting's Join link. Permission is asked only from a click (the account menu's row, the alert card's button), never
// on page load. The desktop shell grants it itself, and its banners are the OS's own.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SuiteAlert } from './alerts';

export type DesktopPermission = NotificationPermission | 'unsupported';

const hasNotifications = () => typeof window !== 'undefined' && typeof window.Notification === 'function';

const readPermission = (): DesktopPermission => (hasNotifications() ? window.Notification.permission : 'unsupported');

/** The page's notification permission, and the way to ask for it (call it from a click). */
export function useDesktopPermission(): [DesktopPermission, () => void] {
  const [permission, setPermission] = useState<DesktopPermission>(readPermission);
  useEffect(() => {
    // Granted in another tab, or changed in the browser's site settings: seen here too where the browser says so.
    let status: PermissionStatus | null = null;
    const again = () => setPermission(readPermission());
    navigator.permissions?.query({ name: 'notifications' as PermissionName }).then((s) => { status = s; s.addEventListener('change', again); }, () => undefined);
    window.addEventListener('focus', again);
    return () => { status?.removeEventListener('change', again); window.removeEventListener('focus', again); };
  }, []);
  const ask = useCallback(() => {
    if (!hasNotifications() || window.Notification.permission !== 'default') return;
    // Older Safari answers through a callback rather than a promise.
    const done = (p: NotificationPermission) => setPermission(p);
    const asked = window.Notification.requestPermission(done) as Promise<NotificationPermission> | undefined;
    void asked?.then(done, () => undefined);
  }, []);
  return [permission, ask];
}

// ---- once across tabs ----

const NOTIFIED_KEY = 'suite-alerts-notified';
/** A notified alert is remembered for a day, as a closed one is. */
const NOTIFIED_FOR_MS = 24 * 60 * 60_000;

function readNotified(): Record<string, number> {
  try {
    const all = JSON.parse(localStorage.getItem(NOTIFIED_KEY) ?? '{}') as Record<string, number>;
    const now = Date.now();
    return Object.fromEntries(Object.entries(all).filter(([, at]) => typeof at === 'number' && now - at < NOTIFIED_FOR_MS));
  } catch {
    return {};
  }
}

function takeClaim(id: string): boolean {
  const notified = readNotified();
  if (id in notified) return false;
  try {
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify({ ...notified, [id]: Date.now() }));
  } catch { /* storage unavailable: this tab decides alone */ }
  return true;
}

/**
 * True for the one tab that should notify about `id`: the check and the mark run under a Web Lock, so two tabs whose
 * clocks tick together cannot both take it; where there are no locks, localStorage alone (a near tie may show two).
 */
export function claimNotification(id: string): Promise<boolean> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks?.request) return locks.request('suite-alerts-notify', () => takeClaim(id)).catch(() => takeClaim(id));
  return Promise.resolve(takeClaim(id));
}

// ---- the banners ----

/** Show `alert` as a banner: its title, its lines, and on click the tab in front and its Join link opened. */
export function showAlertNotification(alert: SuiteAlert): Notification | null {
  try {
    const join = alert.actions.find((a) => a.primary)?.href ?? null;
    const banner = new window.Notification(alert.title, {
      body: [`${alert.kind}`, ...alert.lines].join('\n'),
      tag: alert.id,
      requireInteraction: true,
    });
    banner.onclick = () => {
      window.focus();
      banner.close();
      if (join) window.open(join, '_blank', 'noopener');
    };
    return banner;
  } catch {
    return null; // a browser that only notifies from a service worker (Chrome on Android): the card is enough
  }
}

/**
 * Raise a desktop notification for each alert as it appears, once across tabs, while permission is granted; take a
 * banner down when its alert goes (closed in any tab, or its time is over).
 */
export function useAlertNotifications(alerts: readonly SuiteAlert[], permission: DesktopPermission): void {
  const tried = useRef(new Set<string>());
  const shown = useRef(new Map<string, Notification>());
  useEffect(() => {
    const ids = new Set(alerts.map((a) => a.id));
    for (const [id, banner] of shown.current) if (!ids.has(id)) { banner.close(); shown.current.delete(id); }
    if (permission !== 'granted') return;
    for (const alert of alerts) {
      if (tried.current.has(alert.id)) continue;
      tried.current.add(alert.id);
      void claimNotification(alert.id).then((mine) => {
        if (!mine) return;
        const banner = showAlertNotification(alert);
        if (banner) shown.current.set(alert.id, banner);
      });
    }
  }, [alerts, permission]);
}
