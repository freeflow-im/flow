// Desktop notifications of access codes (Taskboard task 21's follow-up). The server looks for a sign-in or verification
// code in new INBOX mail as it prefetches the body (imap/accessCode.ts); a code found before the person opened the
// message is kept as a code alert. The Mail page asks for them, also while it is hidden, and shows each new one as a
// desktop notification, once across this browser's tabs. Clicking it copies the code and opens the message. Off for an
// account whose setting is off, and wherever the suite's desktop notifications are not allowed or are switched off.
import { useQueries } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { claimNotification, useDesktopOff, useDesktopPermission } from '@flow/suite-bar';
import { mailApi, type CodeAlert, type MailAccount } from '../api';
import type { MessageRef } from './assistant';

/** Asked this often: a read of the server's cache, so cheap. */
export const CODE_ALERT_POLL_MS = 30_000;
/** A code found longer ago than this is not notified: it has likely expired, or the person has seen it. */
export const CODE_ALERT_WINDOW_MS = 10 * 60_000;

/** The notification for one code: the code as the title, who sent it and the subject under it. */
export function showCodeNotification(alert: CodeAlert, tag: string, onClick: () => void): Notification | null {
  try {
    const banner = new window.Notification(`Code ${alert.code}`, {
      body: [alert.from, alert.subject].filter(Boolean).join(': ') + '\nClick to copy the code and open the message.',
      tag,
    });
    banner.onclick = () => {
      window.focus();
      banner.close();
      onClick();
    };
    return banner;
  } catch {
    return null; // a browser that notifies only from a service worker: the card in the message is enough
  }
}

/** Shows new code alerts of `accounts` as desktop notifications; `onOpen` copies the code and shows the message. */
export function useCodeAlertNotifications(accounts: readonly MailAccount[], onOpen: (ref: MessageRef, alert: CodeAlert) => void): void {
  const [permission] = useDesktopPermission();
  const [off] = useDesktopOff();
  const enabled = permission === 'granted' && !off;
  const watched = accounts.filter((a) => a.codeAlerts !== false);
  const results = useQueries({
    queries: watched.map((a) => ({
      queryKey: ['mail', 'code-alerts', a.id] as const,
      queryFn: () => mailApi.codeAlerts(a.id, Date.now() - CODE_ALERT_WINDOW_MS),
      enabled,
      refetchInterval: CODE_ALERT_POLL_MS,
      refetchIntervalInBackground: true,
      retry: false,
    })),
  });
  const tried = useRef(new Set<string>());
  const open = useRef(onOpen);
  open.current = onOpen;
  const seen = results.map((r) => r.dataUpdatedAt).join(',');
  useEffect(() => {
    if (!enabled) return;
    results.forEach((r, i) => {
      const account = watched[i];
      if (!account) return;
      for (const alert of r.data ?? []) {
        const id = `mail-code:${account.id}:${alert.key}`;
        if (tried.current.has(id)) continue;
        tried.current.add(id);
        if (Date.now() - alert.foundAt > CODE_ALERT_WINDOW_MS) continue;
        void claimNotification(id).then((mine) => {
          if (mine) showCodeNotification(alert, id, () => open.current({ account: account.id, folder: alert.folder, uid: alert.uid }, alert));
        });
      }
    });
    // `seen` changes when any account's alerts were read again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seen, enabled]);
}
