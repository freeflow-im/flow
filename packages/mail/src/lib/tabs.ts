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
