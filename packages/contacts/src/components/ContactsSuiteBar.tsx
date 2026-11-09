// The suite bar on Contacts (packages/suite-bar), as Mail's MailSuiteBar draws it: the organization switcher, the apps with
// Contacts active (from the manifests), the search (which filters the list), notifications and the account menu. What
// belongs to Chat (organizations, invitations, notifications, the profile) opens Chat at `/?open=…`.
import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { APP_MANIFESTS, AWAY_STATUS, intent, isAway, StatusDialog, statusPatch, SuiteBar, suiteTabsFrom, type ChatPage, type StatusOption } from '@flow/suite-bar';
import { chooseOrganization, useOrganizations } from '../hooks/organization';
import { suite, type SuiteUser } from '../suite';

const REFRESH_MS = 60_000;
const toChat = (page: ChatPage) => intent.open(page);

export function ContactsSuiteBar({ search }: { search: { value: string; onChange(q: string): void; onSubmit(q: string): void; placeholder: string } }) {
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
        tabs={suiteTabsFrom(APP_MANIFESTS, 'contacts', { 'chat-unread': active?.unreadCount ?? 0 }, { activeHref: import.meta.env.BASE_URL })}
        organization={{
          name: active?.name ?? '',
          entries: list.map((o) => ({ id: o.id, name: o.name, unread: o.unreadCount ?? 0, active: o.id === active?.id, avatarUrl: o.avatarUrl })),
          onSelect: chooseOrganization,
          onAdd: () => toChat('chooser'),
          ...(active?.role === 'owner' || active?.role === 'admin' ? { onSettings: () => intent.admin() } : {}),
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
          // Contacts has no settings of its own: the person's, in Chat.
          onSettings: () => toChat('profile'),
          onLogout: () => void suite.logout().finally(() => window.location.assign('/')),
        }}
      />
      {statusOpen && <StatusDialog current={status} busy={statusBusy} error={statusError} onPick={(o) => void setStatus(o)} onClear={() => void setStatus(null)} onClose={() => setStatusOpen(false)} />}
    </>
  );
}
