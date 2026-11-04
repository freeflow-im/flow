// Gmail's inbox tabs on the client: which tabs an account shows, the one in the address (`&tab=`) and what each is called.
// The server sorts the mail (docs/specs/mail-api.md, Inbox tabs); this is only what the tab bar needs.
import type { Category, MailAccount, TabCategory, TabStatus } from '../api';

export const TAB_ORDER: readonly TabCategory[] = ['promotions', 'social', 'updates', 'forums'];

export interface TabInfo {
  id: Category;
  label: string;
  /** What goes there, for the settings. */
  description: string;
}
export const TAB_INFO: Record<Category, TabInfo> = {
  primary: { id: 'primary', label: 'Primary', description: 'Mail from people, and anything not sorted into another tab.' },
  promotions: { id: 'promotions', label: 'Promotions', description: 'Deals, offers, newsletters and other marketing mail.' },
  social: { id: 'social', label: 'Social', description: 'Messages from social networks and media-sharing sites.' },
  updates: { id: 'updates', label: 'Updates', description: 'Receipts, orders, bills, statements, alerts and notifications.' },
  forums: { id: 'forums', label: 'Forums', description: 'Mailing lists, discussion groups and online forums.' },
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

/**
 * Why a message is in the tab it shows in, in plain words, from its `categoryReason` (see api.ts): "Gmail puts this in
 * Updates", "You moved mail from this sender to Primary", "Gmail gives this no category", "Sorted by its headers:
 * newsletter". `shown` is the tab it shows in: a category whose tab is off shows in Primary, and the words say so.
 */
export function reasonText(reason: string | undefined, shown: Category): string {
  const label = (c: string) => TAB_INFO[c as Category]?.label ?? c;
  const offNote = (c: string) => (c !== shown && shown === 'primary' ? `; the ${label(c)} tab is off, so it is in Primary` : '');
  if (!reason) return `No reason recorded for why this is in ${label(shown)}`;
  const moved = /^sender moved to (\w+)$/.exec(reason)?.[1];
  if (moved) return `You moved mail from this sender to ${label(moved)}${offNote(moved)}`;
  const gmail = /^Gmail category:(\w+)$/.exec(reason)?.[1];
  if (gmail) return `Gmail puts this in ${label(gmail)}${offNote(gmail)}`;
  if (reason === 'Gmail: no category') return 'Gmail gives this no category, so it is in Primary';
  return `Sorted by its headers: ${reason}`;
}

/** The newest message (UID) the person has seen in each tab, per account, in this browser: what "N new" counts from. */
export type TabSeen = Partial<Record<Category, number>>;
const seenKey = (accountId: string) => `flow.mail.tabs.seen.${accountId}`;

export function readTabSeen(accountId: string): TabSeen {
  try {
    const raw = localStorage.getItem(seenKey(accountId));
    const v = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const out: TabSeen = {};
    for (const [k, n] of Object.entries(v)) if (typeof n === 'number' && n > 0) out[k as Category] = n;
    return out;
  } catch {
    return {};
  }
}

/** Remembers that the person has seen up to `uid` in a tab (never moving backwards). Returns the new map, or the same when nothing changed. */
export function markTabSeen(accountId: string, seen: TabSeen, tab: Category, uid: number): TabSeen {
  if (!uid || (seen[tab] ?? 0) >= uid) return seen;
  const next = { ...seen, [tab]: uid };
  try { localStorage.setItem(seenKey(accountId), JSON.stringify(next)); } catch { /* storage may be off */ }
  return next;
}

/** The badge on a tab that is not open: "2 new", or nothing. */
export function tabBadge(status: TabStatus | undefined): string | null {
  return status && status.new > 0 ? `${status.new > 99 ? '99+' : status.new} new` : null;
}

/** The line under a tab with news: the newest message's sender and subject, as Gmail shows them. */
export function tabPreview(status: TabStatus | undefined): string | null {
  const m = status?.newest;
  if (!m) return null;
  const who = m.from?.name || m.from?.address || '';
  return [who, m.subject || '(no subject)'].filter(Boolean).join(' — ');
}

/** Gmail's badge colours by tab. */
export const TAB_BADGE_CLASS: Record<Category, string> = {
  primary: 'bg-[#1a73e8]', promotions: 'bg-[#1e8e3e]', social: 'bg-[#1a73e8]', updates: 'bg-[#e37400]', forums: 'bg-[#a142f4]',
};
