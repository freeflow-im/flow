// The suite bar's calendar alerts (Taskboard task 38): a connected calendar that stopped letting FreeFlow in (the
// account's status is `auth_failed`, set by Calendar's own sync when Google refuses to renew access or a CalDAV server
// refuses the password) shows a card at the top of every page, until it is reconnected or closed. A Google account's
// card has Reconnect, which goes straight to Google's consent page and comes back to the same page; another account's
// card opens Calendar, where its password is entered again.
import { useEffect, useMemo, useState } from 'react';
import type { SuiteAlert } from './alerts';

/** What an alert needs of a calendar account (GET /v1/calendar/accounts). */
export interface AlertCalendarAccount {
  id: string;
  kind: 'caldav' | 'google' | 'native';
  email: string;
  status: 'ok' | 'auth_failed' | 'connect_failed';
}

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

/** The calendar alerts: one per account that refuses FreeFlow, not closed. A server that cannot be reached is not one (that passes). */
export function calendarAlertsOf(accounts: readonly AlertCalendarAccount[], closed: ReadonlySet<string>, onReconnect: (a: AlertCalendarAccount) => void): SuiteAlert[] {
  return accounts
    .filter((a) => a.kind !== 'native' && a.status === 'auth_failed' && !closed.has(calendarAlertId(a.id)))
    .map((a) => ({
      id: calendarAlertId(a.id),
      kind: 'Calendar',
      title: 'Reconnect your calendar',
      lines: [a.kind === 'google' ? `Google stopped giving FreeFlow access to ${a.email}.` : `The calendar server stopped accepting the password for ${a.email}.`],
      actions: a.kind === 'google'
        ? [{ label: 'Reconnect', primary: true, onClick: () => onReconnect(a) }]
        : [{ label: 'Open Calendar', href: '/calendar/', primary: true }],
    }));
}

/** The calendar alerts in the organization the bar shows: its accounts read now, every five minutes and when the page is shown again. */
export function useCalendarAlerts(organizationId: string | null, closed: ReadonlySet<string>): SuiteAlert[] {
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
    () => (organizationId ? calendarAlertsOf(accounts, closed, (a) => { void reconnectGoogle(a.email, organizationId); }) : []),
    [accounts, closed, organizationId],
  );
}
