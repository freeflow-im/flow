// The suite bar on Mail (packages/suite-bar), as Docs' DocsSuiteBar and Chat's ChatSuiteBar draw it: the organization
// switcher, the apps with Mail active, the search (which searches the open folder), notifications and the account menu.
// What belongs to Chat (organizations, invitations, notifications, the profile) opens Chat at `/?open=…`.
import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AWAY_STATUS, isAway, StatusDialog, statusPatch, SuiteBar, type StatusOption } from '@flow/suite-bar';
import { readActiveOrganization, suite, writeActiveOrganization, type SuiteUser } from '../suite';

const REFRESH_MS = 60_000;
const toChat = (open?: string) => window.location.assign(open ? `/?open=${open}` : '/');

export interface MailSuiteBarProps {
  /** The search: what is being searched for in the open folder, and how to change it. */
  search: { value: string; onChange(q: string): void; onSubmit(q: string): void; placeholder: string };
  unread: number;
  onSettings(): void;
}

export function MailSuiteBar({ search, unread, onSettings }: MailSuiteBarProps) {
  const me = useQuery({ queryKey: ['suite', 'me'], queryFn: suite.me, refetchInterval: REFRESH_MS });
  const orgs = useQuery({ queryKey: ['suite', 'organizations'], queryFn: suite.organizations, refetchInterval: REFRESH_MS });
  const [activeId, setActiveId] = useState(readActiveOrganization);
  const [user, setUser] = useState<SuiteUser | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  useEffect(() => {
    if (me.data) setUser(me.data);
  }, [me.data]);
  useEffect(() => {
    // Chat in another tab selecting an organization moves this bar too.
    const onStorage = () => setActiveId(readActiveOrganization());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const list = orgs.data ?? [];
  const active = list.find((o) => o.id === activeId) ?? list[0];
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
        tabs={[
          { id: 'docs', label: 'Docs', href: '/workspace' },
          { id: 'chat', label: 'Chat', href: '/', badge: active?.unreadCount ?? 0 },
          { id: 'mail', label: 'Mail', href: import.meta.env.BASE_URL, active: true, badge: unread, onSelect: () => {} },
          { id: 'calendar', label: 'Calendar', href: '', disabled: true },
        ]}
        organization={{
          name: active?.name ?? '',
          entries: list.map((o) => ({ id: o.id, name: o.name, unread: o.unreadCount ?? 0, active: o.id === active?.id, avatarUrl: o.avatarUrl })),
          onSelect: (id) => {
            writeActiveOrganization(id);
            setActiveId(id);
          },
          onAdd: () => toChat('chooser'),
          ...(active?.role === 'owner' || active?.role === 'admin' ? { onSettings: () => toChat('admin') } : {}),
          ...(active ? { onInvite: () => toChat('invite') } : {}),
        }}
        search={search}
        assistant={{ onOpen: () => window.location.assign('/workspace?assistant') }}
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
          // Mail's own settings: the connected accounts.
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
