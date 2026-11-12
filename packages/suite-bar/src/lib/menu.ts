// An app's menu in Home's sidebar (docs/specs/home.md §2.1). Inside Home an app hides its own sidebar and sends Home its
// "critical menu" instead: the few places a person goes most (Mail's folders, Docs' lists, Calendar's calendars). Home
// draws them under the app's row and sends a click back; the app switches in place, as its own sidebar would.
//
//   app  → Home  { type: 'flow:menu',   v: 1, app, items, selected, href?, picker? }   on load, and whenever any of it changes
//   Home → app   { type: 'flow:select', v: 1, app, id }                       the person clicked an item
//
// The app owns the menu: Home loads none of the apps' data for it. Home keeps the last menu each app sent, so the menu
// shows at once the next time, before the app's frame has loaded; an item clicked before then opens its `href`.
import { useEffect, useRef } from 'react';
import { isInHome } from './embed';

/** The icons an item may name. Home draws each; an app names one, never sends a picture. */
export const SUITE_MENU_ICONS = [
  'inbox',
  'star',
  'draft',
  'send',
  'archive',
  'mail',
  'spam',
  'trash',
  'folder',
  'plus',
  'pen',
  'clock',
  'share',
  'people',
  'lock',
  'calendar',
  'today',
  'dot',
  'settings',
  'user',
] as const;
export type SuiteMenuIcon = (typeof SUITE_MENU_ICONS)[number];

export interface SuiteMenuItem {
  /** Stable within the app: `folder:INBOX`, `compose`, `calendar:<id>`. */
  id: string;
  label: string;
  icon?: SuiteMenuIcon;
  /** A number beside the label (unread mail, drafts). */
  count?: number;
  /** A colour for the `dot` icon (a calendar's colour), as CSS. */
  color?: string;
  /** Shown as switched on or off (a calendar shown or hidden); absent for an item that is not a switch. */
  on?: boolean;
  /** The app's own address for this item, opened when the app is not loaded yet (and so reload and Back work). */
  href?: string;
  /**
   * The items below this one, shown when it is opened. An item with an `href` is a place itself (Docs' Organization
   * files, with its folders below); one without is only a heading that opens ("More folders").
   */
  children?: SuiteMenuItem[];
}

/**
 * A choice drawn on the app's own row in Home's sidebar (`Mail ▾`), above its menu: Mail's accounts. A click on one is
 * sent back as `flow:select` with its id, as a menu item's is.
 */
export interface SuiteMenuPicker {
  items: SuiteMenuItem[];
  /** The one the app shows now (checked in the list). */
  selected: string | null;
  /** A short name for it, shown on the row beside the app's name (`Mail gmail.com ▾`). */
  label?: string;
}

export interface SuiteMenuMessage {
  type: 'flow:menu';
  v: 1;
  app: string;
  items: SuiteMenuItem[];
  /** The item the app is showing now, so Home marks it. */
  selected: string | null;
  /** The app's address now, so Home's own address follows it (reload comes back to it). */
  href?: string;
  /** A choice on the app's row (Mail's accounts), when there is one to make. */
  picker?: SuiteMenuPicker;
}

export interface SuiteSelectMessage {
  type: 'flow:select';
  v: 1;
  app: string;
  id: string;
}

export function isMenuMessage(data: unknown): data is SuiteMenuMessage {
  const m = data as SuiteMenuMessage | null;
  return !!m && typeof m === 'object' && m.type === 'flow:menu' && m.v === 1 && typeof m.app === 'string' && Array.isArray(m.items);
}

export function isSelectMessage(data: unknown): data is SuiteSelectMessage {
  const m = data as SuiteSelectMessage | null;
  return !!m && typeof m === 'object' && m.type === 'flow:select' && m.v === 1 && typeof m.app === 'string' && typeof m.id === 'string';
}

/** Every item, children too, by id. */
export function findMenuItem(items: SuiteMenuItem[], id: string): SuiteMenuItem | null {
  for (const i of items) {
    if (i.id === id) return i;
    const c = i.children && findMenuItem(i.children, id);
    if (c) return c;
  }
  return null;
}

/**
 * Inside Home: sends Home this app's menu (and its row's `picker`, if any) whenever it changes, and calls `onSelect` with
 * the id of an item clicked there. Does nothing outside Home. `items` may be rebuilt on every render: only a change in what it says is sent.
 */
export function useHomeMenu(
  app: string,
  items: SuiteMenuItem[] | null,
  selected: string | null,
  onSelect: (id: string) => void,
  href?: string,
  picker?: SuiteMenuPicker | null,
): void {
  const inHome = useRef<boolean | null>(null);
  if (inHome.current === null) inHome.current = isInHome();
  const select = useRef(onSelect);
  select.current = onSelect;

  const message: SuiteMenuMessage | null = items ? { type: 'flow:menu', v: 1, app, items, selected, ...(href ? { href } : {}), ...(picker ? { picker } : {}) } : null;
  const text = message ? JSON.stringify(message) : null;
  useEffect(() => {
    if (!inHome.current || !text) return;
    window.top?.postMessage(JSON.parse(text) as SuiteMenuMessage, window.location.origin);
  }, [text]);

  useEffect(() => {
    if (!inHome.current) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== window.top || !isSelectMessage(e.data) || e.data.app !== app) return;
      select.current(e.data.id);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [app]);
}
