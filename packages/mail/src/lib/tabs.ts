// Gmail's inbox tabs on the client: which tabs an account shows, the one in the address (`&tab=`) and what each is called.
// The server sorts the mail (docs/specs/mail-api.md, Inbox tabs); this is only what the tab bar needs.
import type { Category, MailAccount, TabCategory } from '../api';

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
