// Intents (docs/specs/platform.md §5.3, phase 6.4): the small verbs one app asks of another, `open`, `create` and
// `share`, instead of each building the other's URL by hand. Each is an address from @flow/shared/addresses (the table
// the server reads too), followed in this tab, or in a new one. The receiving app reads the address in one place
// (Chat's App.tsx, Docs' HomePage, Calendar's App.tsx).
import type { Reference } from '@flow/shared';
import { addressOf, adminAddress, CHAT_PAGES, chatPageAddress, createAddress, shareAddressOf, type AdminSection, type ChatPage, type CreateFields, type ReferenceTarget } from '@flow/shared/addresses';

export { addressOf, adminAddress, chatPageAddress, createAddress, iconOf, kindLabelOf, referenceOf, shareAddressOf, ADMIN_SECTIONS, CHAT_PAGES } from '@flow/shared/addresses';
export type { AddressedReference, AdminSection, Attendee, ChatPage, CreateFields, ReferenceTarget, ResolvedReference } from '@flow/shared/addresses';

/** How an intent is followed: in this tab (the default), a new one, or by the caller (an app's own router, a test). */
export interface IntentOptions { newTab?: boolean; navigate?: (url: string) => void }

function go(url: string, opts: IntentOptions = {}): void {
  if (opts.navigate) opts.navigate(url);
  else if (opts.newTab) window.open(url, '_blank', 'noopener');
  else window.location.assign(url);
}

const isChatPage = (t: unknown): t is ChatPage => typeof t === 'string' && (CHAT_PAGES as readonly string[]).includes(t);

export const intent = {
  /** Opens an object where its app shows it, or one of Chat's pages (`admin`, `invite`, …). False when it has no page. */
  open(target: Reference | ReferenceTarget | ChatPage, opts?: IntentOptions): boolean {
    const url = isChatPage(target) ? chatPageAddress(target) : addressOf(target);
    if (url) go(url, opts);
    return !!url;
  },
  /** Opens the Admin app (docs/specs/workspace-admin.md §2), at a section or at its first one. */
  admin(section?: AdminSection, opts?: IntentOptions): void {
    go(adminAddress(section), opts);
  },
  /** Asks an app to make something, filled in: a Calendar event (`calendar`), a Chat message (`chat-message`). */
  create<K extends keyof CreateFields>(what: K, fields: CreateFields[K], opts?: IntentOptions): void {
    go(createAddress(what, fields), opts);
  },
  /** Opens the owning app's Share dialog on an object. False for an app that shares nothing (Mail). */
  share(ref: Reference, opts?: IntentOptions): boolean {
    const url = shareAddressOf(ref);
    if (url) go(url, opts);
    return !!url;
  },
};
