// Home's Settings page (docs/specs/home.md §2.2): the person's profile, and their notifications and privacy, as two tabs
// with their own addresses (`/home/settings`, `/home/settings/notifications`), which every app's account menu opens
// ("My profile", "Settings"). The form is the suite's one (@flow/suite-bar/account-settings); a save is kept as the
// person Home's suite bar draws, and the server's `user.updated` tells Chat and every other open app.
import { useQueryClient } from '@tanstack/react-query';
import { settingsAddress, type SettingsSection } from '@flow/suite-bar';
import { AccountSettings, type AccountSettingsApi } from '@flow/suite-bar/account-settings';
import type { UserDTO } from '@flow/shared';
import { suite } from '../suite';

export const SETTINGS_TABS: { id: SettingsSection; label: string }[] = [
  { id: 'profile', label: 'Profile' },
  { id: 'notifications', label: 'Notifications & privacy' },
];

const api: AccountSettingsApi = { patchMe: suite.patchMe, uploadAvatar: suite.uploadAvatar, deleteAccount: suite.deleteAccount };

export function SettingsPage({ user, section, address }: { user: UserDTO | null; section: SettingsSection; address: string | null }) {
  const qc = useQueryClient();
  const onUser = (me: UserDTO) => {
    qc.setQueryData(['suite', 'me'], me);
    // The sidebar's agents and the cards' names come from the member list, which the profile feeds.
    void qc.invalidateQueries({ queryKey: ['home', 'members'] });
  };
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5" data-testid="home-settings">
      <header>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-muted">Your profile, notifications and privacy, for every app in FreeFlow.</p>
      </header>
      <nav aria-label="Settings" className="flex gap-1 border-b border-hairline" role="tablist">
        {SETTINGS_TABS.map((t) => (
          <a
            key={t.id}
            href={settingsAddress(t.id)}
            role="tab"
            aria-selected={t.id === section}
            data-testid={`home-settings-tab-${t.id}`}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${t.id === section ? 'border-primary text-primary' : 'border-transparent text-muted hover:text-ink'}`}
          >
            {t.label}
          </a>
        ))}
      </nav>
      <section className="rounded-xl border border-hairline bg-white p-6" role="tabpanel">
        {user ? (
          <AccountSettings
            // A new person (another tab signed in as someone else) starts the form again.
            key={user.id}
            user={user}
            sections={[section]}
            api={api}
            avatarSrc={user.avatarUrl}
            address={address}
            serverOrigin={window.location.origin}
            persistentBanners
            onUser={onUser}
            onDeleted={() => window.location.assign('/')}
          />
        ) : (
          <div className="h-40 animate-pulse rounded bg-track" />
        )}
      </section>
    </div>
  );
}
