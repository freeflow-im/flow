import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { UserDTO } from '@flow/shared';
import { AccountSettings, type AccountSettingsApi } from './AccountSettings';

const user = {
  id: 'u1',
  email: 'ann@x.test',
  displayName: 'Ann',
  avatarUrl: null,
  timezone: 'UTC',
  statusEmoji: '',
  statusText: '',
  website: '',
  bio: '',
  title: '',
  isAgent: false,
  privacyMode: false,
  notificationPrefs: { dm: true, sound: false },
} as unknown as UserDTO;

function draw(sections: ('profile' | 'notifications')[], over: Partial<AccountSettingsApi> = {}) {
  const api: AccountSettingsApi = {
    patchMe: vi.fn(async (patch) => ({ ...user, ...patch, notificationPrefs: { ...user.notificationPrefs, ...patch.notificationPrefs } }) as UserDTO),
    uploadAvatar: vi.fn(async () => ({ ...user, avatarUrl: '/v1/avatars/a.webp' })),
    deleteAccount: vi.fn(async () => {}),
    ...over,
  };
  const onUser = vi.fn();
  const onDeleted = vi.fn();
  render(<AccountSettings user={user} sections={sections} api={api} avatarSrc={null} address="ann@acme.test" serverOrigin="https://x.test" persistentBanners onUser={onUser} onDeleted={onDeleted} />);
  return { api, onUser, onDeleted };
}

afterEach(cleanup);

describe('AccountSettings', () => {
  it('draws only the sections asked for', () => {
    draw(['profile']);
    expect(screen.getByTestId('profile-name')).toBeTruthy();
    expect(screen.getByTestId('profile-address').textContent).toBe('ann@acme.test');
    expect(screen.queryByTestId('pref-dm')).toBeNull();
    cleanup();
    draw(['notifications']);
    expect(screen.queryByTestId('profile-name')).toBeNull();
    expect(screen.getByTestId('profile-email').textContent).toBe('ann@x.test');
    expect((screen.getByTestId('pref-dm') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('pref-sound') as HTMLInputElement).checked).toBe(false);
  });

  it('saves the profile with one PATCH and hands the saved person back', async () => {
    const { api, onUser } = draw(['profile']);
    const save = screen.getByTestId('profile-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true); // nothing changed yet
    fireEvent.change(screen.getByTestId('profile-name'), { target: { value: 'Ann B' } });
    fireEvent.change(screen.getByTestId('profile-title'), { target: { value: '  Lead  ' } });
    fireEvent.click(save);
    await waitFor(() => expect(onUser).toHaveBeenCalled());
    expect(api.patchMe).toHaveBeenCalledWith({ displayName: 'Ann B', title: 'Lead', timezone: 'UTC', website: '', bio: '' });
  });

  it('refuses a website that is not a full http(s) link', () => {
    draw(['profile']);
    fireEvent.change(screen.getByTestId('profile-website'), { target: { value: 'example.com' } });
    expect((screen.getByTestId('profile-save') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('profile-website-error').textContent).toMatch(/http/);
  });

  it('saves each notification pref and privacy mode as it is flipped', async () => {
    const { api, onUser } = draw(['notifications']);
    fireEvent.click(screen.getByTestId('pref-mention'));
    await waitFor(() => expect(api.patchMe).toHaveBeenCalledWith({ notificationPrefs: { mention: false } }));
    fireEvent.click(screen.getByTestId('pref-privacy-mode'));
    await waitFor(() => expect(api.patchMe).toHaveBeenCalledWith({ privacyMode: true }));
    expect(onUser).toHaveBeenCalledTimes(2);
  });

  it('says why a save failed', async () => {
    draw(['notifications'], { patchMe: vi.fn(async () => Promise.reject(new Error('offline'))) });
    fireEvent.click(screen.getByTestId('pref-dm'));
    expect((await screen.findByTestId('account-settings-error')).textContent).toBe('offline');
  });

  it('deletes the account only after the second click', async () => {
    const { api, onDeleted } = draw(['notifications']);
    fireEvent.click(screen.getByTestId('profile-delete'));
    expect(api.deleteAccount).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('profile-delete-really'));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
  });
});
