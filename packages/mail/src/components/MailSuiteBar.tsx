// The suite bar on Mail (packages/suite-bar), as Docs' DocsSuiteBar and Chat's ChatSuiteBar draw it: the organization
// switcher, the apps with Mail active, the search (which searches the open folder), notifications and the account menu.
// What belongs to Chat (organizations, invitations, notifications, the profile) opens Chat at `/?open=…`.
import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { APP_MANIFESTS, AWAY_STATUS, intent, isAway, StatusDialog, statusPatch, SuiteBar, suiteTabsFrom, type ChatPage, type StatusOption } from '@flow/suite-bar';
import { chooseOrganization, useOrganizations } from '../hooks/organization';
import { suite, type SuiteUser } from '../suite';

const REFRESH_MS = 60_000;
const toChat = (page: ChatPage) => intent.open(page);

export interface MailSuiteBarProps {
  /** The search: what is being searched for in the open folder, and how to change it. */
  search: { value: string; onChange(q: string): void; onSubmit(q: string): void; placeholder: string };
  /** The logo and the Mail tab: back to the inbox list. */
  onHome?: (() => void) | undefined;
  unread: number;
  onSettings(): void;
  /** The Assistant button: opens and closes Mail's assistant panel. */
  assistant: { open: boolean; onToggle(): void };
}

export function MailSuiteBar({ search, unread, onSettings, onHome, assistant }: MailSuiteBarProps) {
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
        tabs={suiteTabsFrom(APP_MANIFESTS, 'mail', { 'chat-unread': active?.unreadCount ?? 0, 'mail-unread': unread }, { activeHref: import.meta.env.BASE_URL, onSelect: () => onHome?.() })}
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
