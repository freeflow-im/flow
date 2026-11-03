// Gmail's inbox tabs on the client: which tabs an account shows, the one in the address (`&tab=`), when each was last
// opened (localStorage, for the "N new" pills) and what each tab's button says. The server sorts the mail
// (docs/specs/mail-api.md, Inbox tabs); this is only what the tab bar needs.
import { useSyncExternalStore } from 'react';
import type { Category, MailAccount, TabCategory, TabCount } from '../api';

export const TAB_ORDER: readonly TabCategory[] = ['promotions', 'social', 'updates', 'forums'];

export interface TabInfo {
  id: Category;
  label: string;
  /** What goes there, for the settings. */
  description: string;
  /** The "N new" pill's colours. */
  pill: string;
}
export const TAB_INFO: Record<Category, TabInfo> = {
  primary: { id: 'primary', label: 'Primary', description: 'Mail from people, and anything not sorted into another tab.', pill: 'bg-primary text-white' },
  promotions: { id: 'promotions', label: 'Promotions', description: 'Deals, offers, newsletters and other marketing mail.', pill: 'bg-[#188038] text-white' },
  social: { id: 'social', label: 'Social', description: 'Messages from social networks and media-sharing sites.', pill: 'bg-[#1a73e8] text-white' },
  updates: { id: 'updates', label: 'Updates', description: 'Receipts, orders, bills, statements, alerts and notifications.', pill: 'bg-[#e8710a] text-white' },
  forums: { id: 'forums', label: 'Forums', description: 'Mailing lists, discussion groups and online forums.', pill: 'bg-[#9334e6] text-white' },
};

/** The tabs the bar shows: Primary and the enabled ones in order, or none when the account has tabs off. */
export function tabsOf(account: Pick<MailAccount, 'tabs'> | null | undefined): Category[] {
  const on = new Set(account?.tabs ?? []);
  const enabled = TAB_ORDER.filter((t) => on.has(t));
  return enabled.length ? ['primary', ...enabled] : [];
}

/** The tab in the address, if the account shows it; Primary otherwise. */
export function tabFromParam(value: string | null | undefined, tabs: readonly Category[]): Category {
  return value && tabs.includes(value as Category) ? (value as Category) : 'primary';
}

/** Adds the tab to the address's parameters; Primary, the default, is left out. */
export function writeTabParam(params: URLSearchParams, tab: Category | null): void {
  if (tab && tab !== 'primary') params.set('tab', tab);
  else params.delete('tab');
}

// ---- when each tab was last opened ----------------------------------------------------------------------------------

const KEY = 'mail.tabsOpened';
type Opened = Record<string, Partial<Record<Category, number>>>;
const listeners = new Set<() => void>();
let snapshot: Opened = read();

function read(): Opened {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as Opened) : {};
  } catch {
    return {};
  }
}

export function lastOpened(accountId: string, tab: Category): number | undefined {
  return snapshot[accountId]?.[tab];
}

/** Remembers that the user had `tab` open at `at`: its mail up to then is no longer new. */
export function markOpened(accountId: string, tab: Category, at = Date.now()): void {
  snapshot = { ...snapshot, [accountId]: { ...snapshot[accountId], [tab]: at } };
  try {
    localStorage.setItem(KEY, JSON.stringify(snapshot));
  } catch {
    // Not remembered past this page.
  }
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    snapshot = read();
    l();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener('storage', onStorage);
  };
}

/** The counts route's `since`: `promotions:<ms>,social:<ms>` for the tabs that have been opened. */
export function sinceParam(accountId: string, tabs: readonly Category[], opened: Opened = snapshot): string {
  return tabs.flatMap((t) => (opened[accountId]?.[t] ? [`${t}:${opened[accountId]![t]}`] : [])).join(',');
}

/** `sinceParam`, re-read when a tab is opened (here or in another browser tab). */
export function useSince(accountId: string | null, tabs: readonly Category[]): string {
  const opened = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  return accountId ? sinceParam(accountId, tabs, opened) : '';
}

// ---- what a tab's button says ---------------------------------------------------------------------------------------

export interface TabBadge {
  /** Primary: its unread count. Another tab: "N new", in its colour. */
  text: string;
  kind: 'count' | 'new';
}

/** Primary shows its unread count; another tab, while not the open one, the mail new since it was last opened. */
export function badgeFor(count: TabCount | undefined, active: boolean): TabBadge | null {
  if (!count) return null;
  if (count.id === 'primary') return count.unread > 0 ? { text: count.unread > 999 ? '999+' : String(count.unread), kind: 'count' } : null;
  if (active || count.new <= 0) return null;
  return { text: `${count.new > 99 ? '99+' : count.new} new`, kind: 'new' };
}

/** Under a tab with new mail, as Gmail does: who sent the latest message and its subject. */
export function latestLine(count: TabCount | undefined): string | null {
  const l = count?.latest;
  if (!l) return null;
  const who = l.from ? l.from.name || l.from.address : '';
  const subject = l.subject || '(no subject)';
  return who ? `${who} — ${subject}` : subject;
}
