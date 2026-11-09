// The suite bar on Calendar (packages/suite-bar), as Mail's MailSuiteBar draws it: the organization switcher, the apps
// with Calendar active (⌘4), the search (which searches the calendars), the Assistant (Calendar's panel), notifications and
// the account menu.
// What belongs to Chat (organizations, invitations, notifications, the profile) opens Chat at `/?open=…`.
import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { APP_MANIFESTS, AWAY_STATUS, guestTabs, intent, isAway, StatusDialog, statusPatch, SuiteBar, suiteTabsFrom, type ChatPage, type StatusOption } from '@flow/suite-bar';
import { chooseOrganization, useOrganizations } from '../hooks/organization';
import { suite, type SuiteUser } from '../suite';

const REFRESH_MS = 60_000;
const toChat = (page: ChatPage) => intent.open(page);

export interface CalendarSuiteBarProps {
  /** The search: what is being searched for in the calendars, and how to change it. */
  search: { value: string; onChange(q: string): void; onSubmit(q: string): void; placeholder: string };
  /** The logo and the Calendar tab: back to today. */
  onHome?: (() => void) | undefined;
  onSettings(): void;
  /** The Assistant button: opens and closes Calendar's assistant panel. */
  assistant: { open: boolean; onToggle(): void };
  /** The caller is a guest in the organization shown: the other apps' tabs cannot be followed (docs/specs/workspace-admin.md §6.5). */
  guest?: boolean;
}

export function CalendarSuiteBar({ search, onSettings, onHome, assistant, guest = false }: CalendarSuiteBarProps) {
  const me = useQuery({ queryKey: ['suite', 'me'], queryFn: suite.me, refetchInterval: REFRESH_MS });
  const { list, active } = useOrganizations();
  const [user, setUser] = useState<SuiteUser | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  useEffect(() => {
    if (me.data) setUser(me.data);
  }, [me.data]);
  const status = user && (user.statusEmoji || user.statusText) ? { emoji: user.statusEmoji, text: user.statusText } : null;
  const away = isAway(status);

  const setStatus = useCallback(async (option: StatusOption | null) => {
    setStatusBusy(true);
    setStatusError(null);
    try {
      setUser(await suite.setStatus(statusPatch(option)));
      setStatusOpen(false);
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : String(e));
    } finally {
      setStatusBusy(false);
    }
  }, []);

  return (
    <>
      <SuiteBar
        home={{ href: import.meta.env.BASE_URL, onSelect: () => onHome?.() }}
        tabs={suiteTabsFrom(APP_MANIFESTS, 'calendar', { 'chat-unread': active?.unreadCount ?? 0 }, { activeHref: import.meta.env.BASE_URL, onSelect: () => onHome?.(), unavailable: guestTabs(guest) })}
        organization={{
          name: active?.name ?? '',
          entries: list.map((o) => ({ id: o.id, name: o.name, unread: o.unreadCount ?? 0, active: o.id === active?.id, avatarUrl: o.avatarUrl })),
          onSelect: chooseOrganization,
          onAdd: () => toChat('chooser'),
          ...(active?.role === 'owner' || active?.role === 'admin' ? { onSettings: () => intent.admin() } : {}),
          ...(active ? { onInvite: () => toChat('invite') } : {}),
        }}
        search={search}
        assistant={{ onOpen: assistant.onToggle, active: assistant.open }}
        notifications={{ onOpen: () => toChat('activity') }}
        account={{
          name: user?.displayName || user?.email || '',
          email: user?.email ?? '',
          avatarUrl: user?.avatarUrl ?? null,
          status,
          presence: { active: !away, onToggle: () => void setStatus(away ? null : AWAY_STATUS) },
          onSetStatus: () => {
            setStatusError(null);
            setStatusOpen(true);
          },
          onProfile: () => toChat('profile'),
          // Calendar's own settings: the connected accounts.
          onSettings,
          onLogout: () => void suite.logout().finally(() => window.location.assign('/')),
        }}
      />
      {statusOpen && (
        <StatusDialog current={status} busy={statusBusy} error={statusError} onPick={(o) => void setStatus(o)} onClear={() => void setStatus(null)} onClose={() => setStatusOpen(false)} />
      )}
    </>
  );
}
