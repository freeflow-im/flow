// The suite bar on Calendar (packages/suite-bar), as Mail's MailSuiteBar draws it: the organization switcher, the apps
// with Calendar active (⌘4), the search (which searches the calendars), notifications and the account menu. The Assistant
// comes with Calendar's assistant panel (docs/specs/calendar.md §7, PR 2).
// What belongs to Chat (organizations, invitations, notifications, the profile) opens Chat at `/?open=…`.
import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AWAY_STATUS, isAway, StatusDialog, statusPatch, SuiteBar, type StatusOption } from '@flow/suite-bar';
import { chooseOrganization, useOrganizations } from '../hooks/organization';
import { suite, type SuiteUser } from '../suite';

const REFRESH_MS = 60_000;
const toChat = (open?: string) => window.location.assign(open ? `/?open=${open}` : '/');

export interface CalendarSuiteBarProps {
  /** The search: what is being searched for in the calendars, and how to change it. */
  search: { value: string; onChange(q: string): void; onSubmit(q: string): void; placeholder: string };
  /** The logo and the Calendar tab: back to today. */
  onHome?: (() => void) | undefined;
  onSettings(): void;
}

export function CalendarSuiteBar({ search, onSettings, onHome }: CalendarSuiteBarProps) {
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
        tabs={[
          { id: 'docs', label: 'Docs', href: '/workspace' },
          { id: 'chat', label: 'Chat', href: '/', badge: active?.unreadCount ?? 0 },
          { id: 'mail', label: 'Mail', href: '/mail' },
          { id: 'calendar', label: 'Calendar', href: import.meta.env.BASE_URL, active: true, onSelect: () => onHome?.() },
        ]}
        organization={{
          name: active?.name ?? '',
          entries: list.map((o) => ({ id: o.id, name: o.name, unread: o.unreadCount ?? 0, active: o.id === active?.id, avatarUrl: o.avatarUrl })),
          onSelect: chooseOrganization,
          onAdd: () => toChat('chooser'),
          ...(active?.role === 'owner' || active?.role === 'admin' ? { onSettings: () => toChat('admin') } : {}),
          ...(active ? { onInvite: () => toChat('invite') } : {}),
        }}
        search={search}
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
