// The suite bar on the Docs app (packages/suite-bar; docs/specs/freeflow-suite.md §2.5), above every signed-in page
// when the app is hosted in the FreeFlow suite (main.tsx). Its data comes from the suite's API (suite.ts); what
// belongs to Chat (adding an organization, its settings, inviting people, notifications, the profile) opens Chat at
// `/?open=…`, which Chat's App.tsx honours.
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AWAY_STATUS, isAway, StatusDialog, statusPatch, SuiteBar, type StatusOption } from '@flow/suite-bar';
import { useAgent } from '../agent/AgentProvider.tsx';
import { useAuth } from '../auth.tsx';
import { finishBeforeLeave, readActiveOrganization, setOrganizationState, suite, writeActiveOrganization, type SuiteOrganization, type SuiteUser } from '../suite.ts';

/** How often the organizations' unread counts are asked again. */
const REFRESH_MS = 60_000;

/** A page of Chat (the suite's root, outside this app's base path). */
const toChat = (open?: string) => window.location.assign(open ? `/?open=${open}` : '/');

export function DocsSuiteBar() {
  const { user, logout } = useAuth();
  const agent = useAgent();
  const navigate = useNavigate();
  const [me, setMe] = useState<SuiteUser | null>(null);
  const [orgs, setOrgs] = useState<SuiteOrganization[]>([]);
  const [activeId, setActiveId] = useState(readActiveOrganization);
  const [statusOpen, setStatusOpen] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [u, o] = await Promise.allSettled([suite.me(), suite.organizations()]);
    if (u.status === 'fulfilled') setMe(u.value);
    if (o.status === 'fulfilled') setOrgs(o.value);
    setLoaded(true);
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    // Chat in another tab selecting an organization moves this bar too.
    const onStorage = () => setActiveId(readActiveOrganization());
    window.addEventListener('storage', onStorage);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('storage', onStorage);
    };
  }, [load]);

  const [loaded, setLoaded] = useState(false);
  const active = orgs.find((o) => o.id === activeId) ?? orgs[0];
  // The rest of the app lists and makes files in the organization shown here (suite.ts): Chat's last choice until the
  // list arrives, then the one the bar shows.
  useEffect(() => {
    setOrganizationState(
      loaded
        ? { active: active ? { id: active.id, name: active.name } : null, organizations: orgs.map((o) => ({ id: o.id, name: o.name })), ready: true }
        : { active: activeId ? { id: activeId, name: '' } : null, organizations: [], ready: false },
    );
  }, [loaded, active, activeId, orgs]);
  const status = me && (me.statusEmoji || me.statusText) ? { emoji: me.statusEmoji, text: me.statusText } : null;
  const away = isAway(status);

  const setStatus = async (option: StatusOption | null) => {
    setStatusBusy(true);
    setStatusError(null);
    try {
      setMe(await suite.setStatus(statusPatch(option)));
      setStatusOpen(false);
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : String(e));
    } finally {
      setStatusBusy(false);
    }
  };

  return (
    <>
      <SuiteBar
        tabs={[
          { id: 'docs', label: 'Docs', href: `${import.meta.env.BASE_URL}`, active: true, onSelect: () => navigate('/') },
          // Chat's count: the selected organization's unread notifications, as Chat's own tab shows them.
          { id: 'chat', label: 'Chat', href: '/', badge: active?.unreadCount ?? 0 },
          { id: 'mail', label: 'Mail', href: '', disabled: true },
          { id: 'calendar', label: 'Calendar', href: '', disabled: true },
        ]}
        organization={{
          name: active?.name ?? '',
          entries: orgs.map((o) => ({ id: o.id, name: o.name, unread: o.unreadCount ?? 0, active: o.id === active?.id, avatarUrl: o.avatarUrl })),
          onSelect: (id) => {
            writeActiveOrganization(id);
            setActiveId(id);
          },
          onAdd: () => toChat('chooser'),
          ...(active?.role === 'owner' || active?.role === 'admin' ? { onSettings: () => toChat('admin') } : {}),
          ...(active ? { onInvite: () => toChat('invite') } : {}),
        }}
        search={{
          placeholder: 'Search files',
          // The home page's file search, in every folder (its address keeps it: ?q=…&find=1).
          onSubmit: (q) => navigate(`/?${new URLSearchParams({ q, find: '1' })}`),
        }}
        // The file's chat on a file's page, the home chat on the home page: the panel shows the page's own.
        assistant={{ onOpen: () => agent.setOpen(!agent.open), active: agent.open }}
        notifications={{ onOpen: () => toChat('activity') }}
        account={{
          name: me?.displayName || user?.email || '',
          email: me?.email ?? user?.email ?? '',
          avatarUrl: me?.avatarUrl ?? null,
          status,
          presence: { active: !away, onToggle: () => void setStatus(away ? null : AWAY_STATUS) },
          onSetStatus: () => {
            setStatusError(null);
            setStatusOpen(true);
          },
          onProfile: () => toChat('profile'),
          onSettings: () => navigate('/settings'),
          onLogout: () => void finishBeforeLeave().then(logout),
        }}
      />
      {statusOpen && (
        <StatusDialog current={status} busy={statusBusy} error={statusError} onPick={(o) => void setStatus(o)} onClear={() => void setStatus(null)} onClose={() => setStatusOpen(false)} />
      )}
    </>
  );
}
