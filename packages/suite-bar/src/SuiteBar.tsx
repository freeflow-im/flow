// The suite bar (docs/specs/freeflow-suite.md §2.5): one 56px bar above every signed-in page of Chat and Docs.
// Left, where you are: the mark, "FreeFlow", the organization's name with its switcher. Centre, which app: Docs,
// Chat, then Mail and Calendar as placeholders. Right, tools then you: search (opens in place, ⌘K), the Assistant,
// notifications, the account menu. Presentational: every app passes its data and callbacks, the bar fetches nothing.
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { SuiteMark } from './SuiteMark';
import './suite-bar.css';

export interface SuiteTab {
  id: string;
  label: string;
  /** Where the tab goes. A disabled tab has none to go to. */
  href: string;
  active?: boolean;
  /** An unread count, drawn as a blue pill after the label when above 0. */
  badge?: number;
  /** A placeholder: grey, not clickable, "Coming soon" on hover (or `title`). */
  disabled?: boolean;
  title?: string;
  /** Instead of following `href` (an app's own router, or nothing for the tab you are on). */
  onSelect?: () => void;
}

export interface SuiteOrganizationEntry {
  id: string;
  name: string;
  unread: number;
  active: boolean;
  avatarUrl?: string | null;
  /** The server it lives on; rows are grouped by it when there is more than one. */
  group?: string;
}

export interface SuiteOrganization {
  /** The selected organization's name ('' for none). */
  name: string;
  entries: SuiteOrganizationEntry[];
  onSelect(id: string): void;
  /** "Add an organization…" (create, join, or answer an invitation). */
  onAdd(): void;
  /** A count on "Add an organization…" (pending invitations). */
  addBadge?: number;
  /** "Organization settings", for someone who may change them. */
  onSettings?: () => void;
  /** "Invite people". */
  onInvite?: () => void;
}

export interface SuiteSearch {
  placeholder: string;
  onSubmit(query: string): void;
}

export interface SuiteAccount {
  name: string;
  email: string;
  avatarUrl?: string | null;
  /** The user's status, shown on the avatar and in the menu. */
  status?: { emoji: string; text: string } | null;
  /** The presence row: Active (with Set away) or Away (with Set active). */
  presence?: { active: boolean; onToggle(): void };
  onSetStatus?: () => void;
  onProfile(): void;
  onSettings(): void;
  onLogout(): void;
  /** More rows after Settings (Chat's Help). */
  extra?: { label: string; onSelect(): void }[];
}

export interface SuiteBarProps {
  tabs: SuiteTab[];
  organization?: SuiteOrganization;
  search?: SuiteSearch;
  assistant?: { onOpen(): void; active?: boolean };
  notifications?: { onOpen(): void; badge?: number };
  account: SuiteAccount;
}

type Menu = 'org' | 'account' | null;

/** Initials for an avatar without a picture: the first letters of the first two words (one for a single word). */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? '?').slice(0, 1)).toUpperCase();
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

function Badge({ count, label }: { count: number | undefined; label?: string }) {
  if (!count || count <= 0) return null;
  return (
    <span className="sb-badge" aria-label={label ?? `${count} unread`}>
      {count > 99 ? '99+' : count}
    </span>
  );
}

function Picture({ src, name, className }: { src?: string | null | undefined; name: string; className: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return (
    <span className={className} aria-hidden="true">
      {src && !failed ? <img src={src} alt="" onError={() => setFailed(true)} /> : initials(name)}
    </span>
  );
}

const Caret = ({ up }: { up?: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" className="sb-caret">
    <path d={up ? 'M4 10l4-4 4 4' : 'M4 6l4 4 4-4'} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const SearchIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
    <path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);
const Spark = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="sb-spark">
    <path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z" fill="currentColor" />
    <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" fill="currentColor" />
  </svg>
);
const Bell = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4l2-2z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    <path d="M10 20a2 2 0 0 0 4 0" fill="none" stroke="currentColor" strokeWidth="2" />
  </svg>
);
const Check = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="sb-check">
    <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const ICONS: Record<string, ReactNode> = {
  status: (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="9" cy="10" r="1.2" fill="currentColor" />
      <circle cx="15" cy="10" r="1.2" fill="currentColor" />
    </svg>
  ),
  profile: (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M4 21a8 8 0 0 1 16 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  settings: (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <path
        d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  ),
  help: (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="17" r="1.1" fill="currentColor" />
    </svg>
  ),
  logout: (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M16 17l5-5-5-5M21 12H9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};

/** ⌘ on a Mac, Ctrl elsewhere: the modifier the bar's shortcuts use. */
function isMod(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
}

function followTab(tab: SuiteTab): void {
  if (tab.disabled) return;
  if (tab.onSelect) tab.onSelect();
  else if (!tab.active) window.location.assign(tab.href);
}

export function SuiteBar({ tabs, organization, search, assistant, notifications, account }: SuiteBarProps) {
  const [menu, setMenu] = useState<Menu>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const orgRef = useRef<HTMLDivElement>(null);
  const accountRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const closeSearch = () => {
    setSearching(false);
    setQuery('');
  };

  // ⌘1 to ⌘4 switch apps, ⌘K opens the search. An app that already used the key (an editor's own ⌘K) wins.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isMod(e)) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= 4) {
        const tab = tabsRef.current[n - 1];
        if (!tab || tab.disabled) return;
        e.preventDefault();
        followTab(tab);
      } else if (search && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setMenu(null);
        setSearching(true);
        inputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [search]);

  // A click elsewhere closes the open menu and the search field.
  useEffect(() => {
    if (!menu && !searching) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menu === 'org' && !orgRef.current?.contains(t)) setMenu(null);
      if (menu === 'account' && !accountRef.current?.contains(t)) setMenu(null);
      if (searching && !searchRef.current?.contains(t)) closeSearch();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menu, searching]);

  useEffect(() => {
    if (searching) inputRef.current?.focus();
  }, [searching]);

  const onMenuKey = (e: ReactKeyboardEvent, trigger: HTMLElement | null) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setMenu(null);
      trigger?.focus();
    }
  };

  /** A menu row's click: the menu closes first, then the row acts. */
  const pick = (action: () => void) => () => {
    setMenu(null);
    action();
  };

  const groups = organization ? [...new Set(organization.entries.map((e) => e.group ?? ''))] : [];
  const grouped = groups.length > 1;
  const away = account.presence && !account.presence.active;

  return (
    <header className="sb-bar" data-testid="suite-bar">
      <div className="sb-left">
        <SuiteMark />
        <span className="sb-wordmark">FreeFlow</span>
        {organization && (
          <>
            <span className="sb-divider" aria-hidden="true" />
            <div className="sb-org" ref={orgRef} onKeyDown={(e) => onMenuKey(e, orgRef.current?.querySelector('button') ?? null)}>
              <button
                type="button"
                className="sb-org-btn"
                aria-label={`Switch organization${organization.name ? ` (${organization.name})` : ''}`}
                aria-haspopup="menu"
                aria-expanded={menu === 'org'}
                data-testid="suite-org-button"
                title={organization.name || undefined}
                onClick={() => setMenu(menu === 'org' ? null : 'org')}
              >
                <span className="sb-org-name">{organization.name || 'Choose an organization'}</span>
                <Caret up={menu === 'org'} />
              </button>
              {menu === 'org' && (
                <div className="sb-menu sb-org-menu" role="menu" aria-label="Organizations" data-testid="suite-org-menu">
                  {groups.map((group) => (
                    <div key={group} role="group" aria-label={grouped ? group : 'Your organizations'}>
                      <div className="sb-menu-label">{grouped ? group : 'Your organizations'}</div>
                      {organization.entries
                        .filter((e) => (e.group ?? '') === group)
                        .map((e) => (
                          <button
                            key={e.id}
                            type="button"
                            role="menuitemradio"
                            aria-checked={e.active}
                            className={`sb-menu-item sb-org-entry${e.active ? ' active' : ''}`}
                            data-testid={`suite-org-${e.id}`}
                            onClick={pick(() => !e.active && organization.onSelect(e.id))}
                          >
                            <Picture src={e.avatarUrl} name={e.name} className="sb-org-mark" />
                            <span className="sb-menu-text">{e.name}</span>
                            {e.active ? <Check /> : <Badge count={e.unread} />}
                          </button>
                        ))}
                    </div>
                  ))}
                  {organization.entries.length > 0 && <div className="sb-menu-sep" role="separator" />}
                  <button type="button" role="menuitem" className="sb-menu-item" data-testid="suite-org-add" onClick={pick(organization.onAdd)}>
                    <span className="sb-menu-text">Add an organization…</span>
                    <Badge count={organization.addBadge} label={`${organization.addBadge} invitation${organization.addBadge === 1 ? '' : 's'}`} />
                  </button>
                  {organization.onSettings && (
                    <button type="button" role="menuitem" className="sb-menu-item" data-testid="suite-org-settings" onClick={pick(organization.onSettings)}>
                      Organization settings
                    </button>
                  )}
                  {organization.onInvite && (
                    <button type="button" role="menuitem" className="sb-menu-item" data-testid="suite-org-invite" onClick={pick(organization.onInvite)}>
                      Invite people
                    </button>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <nav className="sb-tabs" aria-label="Apps">
        {tabs.map((tab, i) =>
          tab.disabled ? (
            <a key={tab.id} className="sb-tab" aria-disabled="true" title={tab.title ?? 'Coming soon'} data-testid={`suite-tab-${tab.id}`}>
              {tab.label}
            </a>
          ) : (
            <a
              key={tab.id}
              className="sb-tab"
              href={tab.href}
              aria-current={tab.active ? 'page' : undefined}
              title={i < 4 ? `${tab.title ?? tab.label} (⌘${i + 1})` : (tab.title ?? tab.label)}
              data-testid={`suite-tab-${tab.id}`}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // a new tab or window: the browser's
                if (tab.onSelect || tab.active) {
                  e.preventDefault();
                  tab.onSelect?.();
                }
              }}
            >
              {tab.label}
              <Badge count={tab.badge} label={`${tab.badge} unread`} />
            </a>
          ),
        )}
      </nav>

      <div className="sb-right">
        {search &&
          (searching ? (
            <form
              ref={searchRef}
              className="sb-search"
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                const q = query.trim();
                if (!q) return;
                closeSearch();
                search.onSubmit(q);
              }}
            >
              <SearchIcon size={18} />
              <input
                ref={inputRef}
                type="search"
                aria-label="Search"
                placeholder={search.placeholder}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Escape') return;
                  e.preventDefault();
                  e.stopPropagation();
                  closeSearch();
                }}
              />
              <kbd className="sb-kbd">esc</kbd>
            </form>
          ) : (
            <button type="button" className="sb-icon-btn sb-search-btn" aria-label="Search" title="Search (⌘K)" data-testid="suite-search" onClick={() => { setMenu(null); setSearching(true); }}>
              <SearchIcon />
            </button>
          ))}
        {assistant && (
          <button type="button" className="sb-assistant" aria-pressed={!!assistant.active} aria-label="Assistant" data-testid="suite-assistant" onClick={assistant.onOpen}>
            <Spark />
            <span className="sb-assistant-label">Assistant</span>
          </button>
        )}
        {notifications && (
          <button type="button" className="sb-icon-btn sb-notifications" aria-label="Notifications" title="Notifications" data-testid="suite-notifications" onClick={notifications.onOpen}>
            <Bell />
            {!!notifications.badge && <span className="sb-dot" aria-label={`${notifications.badge} unread`} />}
          </button>
        )}
        <div className="sb-account" ref={accountRef} onKeyDown={(e) => onMenuKey(e, accountRef.current?.querySelector('button') ?? null)}>
          <button
            type="button"
            className="sb-account-btn"
            aria-label="Account menu"
            aria-haspopup="menu"
            aria-expanded={menu === 'account'}
            data-testid="suite-account-button"
            onClick={() => setMenu(menu === 'account' ? null : 'account')}
          >
            <span className="sb-avatar-wrap">
              <Picture src={account.avatarUrl} name={account.name} className="sb-avatar" />
              {account.status?.emoji && <span className="sb-avatar-status" aria-hidden="true">{account.status.emoji}</span>}
            </span>
            <span className="sb-account-name">{firstName(account.name)}</span>
          </button>
          {menu === 'account' && (
            <div className="sb-menu sb-account-menu" role="menu" aria-label="Account" data-testid="suite-account-menu">
              <div className="sb-account-head">
                <Picture src={account.avatarUrl} name={account.name} className="sb-avatar sb-avatar-lg" />
                <div className="sb-account-who">
                  <div className="sb-account-full">{account.name}</div>
                  {account.email && <div className="sb-account-email">{account.email}</div>}
                </div>
              </div>
              {(account.presence || account.onSetStatus) && <div className="sb-menu-sep" role="separator" />}
              {account.presence && (
                <button type="button" role="menuitem" className="sb-menu-item" data-testid="suite-presence" onClick={pick(account.presence.onToggle)}>
                  <span className="sb-menu-icon" aria-hidden="true">
                    <span className={`sb-presence-dot${away ? ' away' : ''}`} />
                  </span>
                  <span className="sb-menu-text">{away ? 'Away' : 'Active'}</span>
                  <span className="sb-menu-hint">{away ? 'Set active' : 'Set away'}</span>
                </button>
              )}
              {account.onSetStatus && (
                <button type="button" role="menuitem" className="sb-menu-item" data-testid="suite-set-status" onClick={pick(account.onSetStatus)}>
                  <span className="sb-menu-icon">{account.status?.emoji && !away ? <span className="sb-status-emoji">{account.status.emoji}</span> : ICONS.status}</span>
                  <span className="sb-menu-text">{account.status?.text && !away ? account.status.text : 'Set a status…'}</span>
                  {account.status?.text && !away && <span className="sb-menu-hint">Change</span>}
                </button>
              )}
              <div className="sb-menu-sep" role="separator" />
              <button type="button" role="menuitem" className="sb-menu-item" data-testid="suite-profile" onClick={pick(account.onProfile)}>
                <span className="sb-menu-icon">{ICONS.profile}</span>
                My profile
              </button>
              <button type="button" role="menuitem" className="sb-menu-item" data-testid="suite-settings" onClick={pick(account.onSettings)}>
                <span className="sb-menu-icon">{ICONS.settings}</span>
                Settings
              </button>
              {account.extra?.map((x) => (
                <button key={x.label} type="button" role="menuitem" className="sb-menu-item" onClick={pick(x.onSelect)}>
                  <span className="sb-menu-icon">{ICONS[x.label.toLowerCase()] ?? null}</span>
                  {x.label}
                </button>
              ))}
              <div className="sb-menu-sep" role="separator" />
              <button type="button" role="menuitem" className="sb-menu-item" data-testid="suite-logout" onClick={pick(account.onLogout)}>
                <span className="sb-menu-icon">{ICONS.logout}</span>
                Log out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
