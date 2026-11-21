// Desktop notifications of access codes (Taskboard task 21's follow-up). The server looks for a sign-in or verification
// code in new INBOX mail as it prefetches the body (imap/accessCode.ts); a code found before the person opened the
// message is kept as a code alert. The Mail page asks for them, also while it is hidden, and shows each new one as a
// desktop notification that stays until it is closed, once across this browser's tabs (where the suite's desktop
// notifications are allowed and on), and as an alert card under the suite bar, with Copy code and Open message, until it
// is closed, used, or CODE_ALERT_WINDOW_MS has passed. Clicking the notification copies the code and opens the message.
// Nothing for an account whose setting is off.
import { useQueries } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { claimNotification, useDesktopOff, useDesktopPermission, type SuiteAlert } from '@flow/suite-bar';
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
      // A code is wanted now: the banner stays until the person closes or clicks it.
      requireInteraction: true,
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

export interface CodeAlertHandlers {
  /** The notification was clicked: copy the code and show the message. */
  onOpen(ref: MessageRef, alert: CodeAlert): void;
  /** The card's Copy code. */
  onCopy(alert: CodeAlert): void;
  /** The card's Open message. */
  onShow(ref: MessageRef): void;
}

/**
 * Shows new code alerts of `accounts` as desktop notifications, and returns them as alert cards for the suite bar
 * (`id` is the same in every tab, so closing one closes it everywhere).
 */
export function useCodeAlerts(accounts: readonly MailAccount[], handlers: CodeAlertHandlers): SuiteAlert[] {
  const [permission] = useDesktopPermission();
  const [off] = useDesktopOff();
  const notify = permission === 'granted' && !off;
  const watched = accounts.filter((a) => a.codeAlerts !== false);
  // Cards used here (copied or opened): gone from this tab.
  const [used, setUsed] = useState<ReadonlySet<string>>(new Set());
  const results = useQueries({
    queries: watched.map((a) => ({
      queryKey: ['mail', 'code-alerts', a.id] as const,
      queryFn: () => mailApi.codeAlerts(a.id, Date.now() - CODE_ALERT_WINDOW_MS),
      refetchInterval: CODE_ALERT_POLL_MS,
      refetchIntervalInBackground: true,
      retry: false,
    })),
  });
  const tried = useRef(new Set<string>());
  const on = useRef(handlers);
  on.current = handlers;
  const seen = results.map((r) => r.dataUpdatedAt).join(',');
  useEffect(() => {
    if (!notify) return;
    results.forEach((r, i) => {
      const account = watched[i];
      if (!account) return;
      for (const alert of r.data ?? []) {
        const id = `mail-code:${account.id}:${alert.key}`;
        if (tried.current.has(id)) continue;
        tried.current.add(id);
        if (Date.now() - alert.foundAt > CODE_ALERT_WINDOW_MS) continue;
        void claimNotification(id).then((mine) => {
          if (mine) showCodeNotification(alert, id, () => { setUsed((u) => new Set(u).add(id)); on.current.onOpen({ account: account.id, folder: alert.folder, uid: alert.uid }, alert); });
        });
      }
    });
    // `seen` changes when any account's alerts were read again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seen, notify]);

  const now = Date.now();
  return results.flatMap((r, i) => {
    const account = watched[i];
    if (!account) return [];
    return (r.data ?? []).flatMap((alert): SuiteAlert[] => {
      const id = `mail-code:${account.id}:${alert.key}`;
      if (used.has(id) || now - alert.foundAt > CODE_ALERT_WINDOW_MS) return [];
      const ref = { account: account.id, folder: alert.folder, uid: alert.uid };
      const done = () => setUsed((u) => new Set(u).add(id));
      return [{
        id,
        kind: 'Sign-in code',
        title: alert.code,
        lines: [[alert.from, alert.subject].filter(Boolean).join(': ')],
        actions: [
          { label: 'Copy code', primary: true, onClick: () => { done(); on.current.onCopy(alert); } },
          { label: 'Open message', onClick: () => { done(); on.current.onShow(ref); } },
        ],
      }];
    });
  });
}
