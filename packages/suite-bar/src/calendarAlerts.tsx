// The suite bar's reconnect label (Taskboard task 38): a connected calendar that stopped letting FreeFlow in (the
// account's status is `auth_failed`, set by Calendar's own sync when Google refuses to renew access or a CalDAV server
// refuses the password) shows a short amber label that slides down under the bar, in its middle, on every page, until it
// is reconnected or closed. A Google account's Reconnect goes straight to Google's consent page and comes back to the
// same page; another account's opens Calendar, where its password is entered again.
import { useEffect, useMemo, useState } from 'react';

/** What a label needs of a calendar account (GET /v1/calendar/accounts). */
export interface AlertCalendarAccount {
  id: string;
  kind: 'caldav' | 'google' | 'native';
  email: string;
  status: 'ok' | 'auth_failed' | 'connect_failed';
}

/** One label: the account it is for, and its button (a link for a CalDAV account, an action for Google). */
export interface ReconnectNotice { id: string; email: string; label: string; href?: string; onClick?: () => void }

/** The accounts are read again this often (and when the page is shown again). */
const READ_EVERY_MS = 5 * 60_000;

export const calendarAlertId = (accountId: string) => `calendar-reconnect:${accountId}`;

/**
 * Sends the browser to Google's consent page for this address, coming back to this page (GET /v1/calendar/google/start).
 * The callback replaces the account's refresh token, so the same account is fixed, not a second one added.
 */
export async function reconnectGoogle(email: string, organizationId: string, go: (url: string) => void = (u) => window.location.assign(u)): Promise<void> {
  const q = new URLSearchParams({ return: window.location.href, email, workspace: organizationId });
  const r = await fetch(`/v1/calendar/google/start?${q}`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  const b = r.ok ? ((await r.json()) as { url?: string }) : null;
  go(b?.url ?? '/calendar/');
}

/** The labels: one per account that refuses FreeFlow, not closed. A server that cannot be reached is not one (that passes). */
export function reconnectNoticesOf(accounts: readonly AlertCalendarAccount[], closed: ReadonlySet<string>, onReconnect: (a: AlertCalendarAccount) => void): ReconnectNotice[] {
  return accounts
    .filter((a) => a.kind !== 'native' && a.status === 'auth_failed' && !closed.has(calendarAlertId(a.id)))
    .map((a) => (a.kind === 'google'
      ? { id: calendarAlertId(a.id), email: a.email, label: 'Reconnect', onClick: () => onReconnect(a) }
      : { id: calendarAlertId(a.id), email: a.email, label: 'Fix', href: '/calendar/' }));
}

/** The reconnect labels in the organization the bar shows: its accounts read now, every five minutes and when the page is shown again. */
export function useReconnectNotices(organizationId: string | null, closed: ReadonlySet<string>): ReconnectNotice[] {
  const [accounts, setAccounts] = useState<AlertCalendarAccount[]>([]);
  useEffect(() => {
    setAccounts([]);
    if (!organizationId || typeof fetch !== 'function') return;
    let live = true;
    const read = () => {
      fetch(`/v1/calendar/accounts?${new URLSearchParams({ workspace: organizationId })}`, { credentials: 'same-origin', headers: { accept: 'application/json' } })
        .then((r) => (r.ok ? (r.json() as Promise<{ accounts?: AlertCalendarAccount[] }>) : null))
        .then((b) => { if (live && b) setAccounts(Array.isArray(b.accounts) ? b.accounts : []); })
        .catch(() => undefined);
    };
    read();
    const every = setInterval(read, READ_EVERY_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') read(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { live = false; clearInterval(every); document.removeEventListener('visibilitychange', onVisible); };
  }, [organizationId]);
  return useMemo(
    () => (organizationId ? reconnectNoticesOf(accounts, closed, (a) => { void reconnectGoogle(a.email, organizationId); }) : []),
    [accounts, closed, organizationId],
  );
}

/** The labels under the bar, in its middle; each closes on ×. Nothing when there are none. */
export function ReconnectLabels({ notices, onClose }: { notices: readonly ReconnectNotice[]; onClose: (id: string) => void }) {
  if (!notices.length) return null;
  return (
    <div className="sb-reconnects" role="region" aria-label="Calendar connection">
      {notices.map((n) => (
        <div key={n.id} className="sb-reconnect" role="alert" data-testid="calendar-reconnect">
          <span className="sb-reconnect-icon" aria-hidden>⚠</span>
          <span className="sb-reconnect-text">Calendar disconnected · <span className="sb-reconnect-email">{n.email}</span></span>
          {n.href !== undefined
            ? <a className="sb-reconnect-action" href={n.href}>{n.label}</a>
            : <button type="button" className="sb-reconnect-action" onClick={n.onClick}>{n.label}</button>}
          <button type="button" className="sb-reconnect-close" aria-label="Close" title="Close" onClick={() => onClose(n.id)}>×</button>
        </div>
      ))}
    </div>
  );
}
