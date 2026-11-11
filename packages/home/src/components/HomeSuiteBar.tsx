// The suite bar on Home (packages/suite-bar), as Admin's draws it: the organization switcher, the apps (Home's tab
// active, with Chat's and Mail's numbers as Home counts them), notifications and the account menu. What belongs to Chat
// (adding an organization, invitations, notifications, the profile) opens Chat at `/chat/?open=…`.
import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { APP_MANIFESTS, AWAY_STATUS, intent, isAway, StatusDialog, statusPatch, SuiteBar, suiteTabsFrom, type ChatPage, type StatusOption } from '@flow/suite-bar';
import { chooseOrganization, useOrganizations } from '../hooks/organization';
import { suite, type SuiteUser } from '../suite';

const REFRESH_MS = 60_000;
const toChat = (page: ChatPage) => intent.open(page);

export function HomeSuiteBar({ chatUnread, mailUnread }: { chatUnread: number; mailUnread: number }) {
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
        home={{ href: import.meta.env.BASE_URL }}
        tabs={suiteTabsFrom(APP_MANIFESTS, 'home', { 'chat-unread': chatUnread, 'mail-unread': mailUnread }, { activeHref: import.meta.env.BASE_URL })}
        organization={{
          name: active?.name ?? '',
          entries: list.map((o) => ({ id: o.id, name: o.name, unread: o.unreadCount ?? 0, active: o.id === active?.id, avatarUrl: o.avatarUrl })),
          onSelect: chooseOrganization,
          onAdd: () => toChat('chooser'),
          ...(active ? { onSettings: () => intent.admin(), onAutomations: () => intent.admin('automations') } : {}),
          ...(active ? { onInvite: () => toChat('invite') } : {}),
        }}
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

          onSettings: () => toChat('profile'),
          onLogout: () => void suite.logout().finally(() => window.location.assign('/')),
        }}
      />
      {statusOpen && <StatusDialog current={status} busy={statusBusy} error={statusError} onPick={(o) => void setStatus(o)} onClear={() => void setStatus(null)} onClose={() => setStatusOpen(false)} />}
    </>
  );
}
