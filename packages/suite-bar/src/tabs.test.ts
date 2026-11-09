import { describe, expect, it } from 'vitest';
import { APP_MANIFESTS } from '@flow/shared/manifests';
import { GUEST_TABS_NOTE, guestTabs, suiteTabsFrom } from './tabs';

describe('guestTabs', () => {
  it('leaves a member every tab, and a guest only Chat', () => {
    const member = suiteTabsFrom(APP_MANIFESTS, 'mail', {}, { unavailable: guestTabs(false) });
    expect(member.every((t) => !t.disabled)).toBe(true);
    const guest = suiteTabsFrom(APP_MANIFESTS, 'chat', {}, { unavailable: guestTabs(true) });
    expect(guest.find((t) => t.id === 'chat')!.disabled).toBeFalsy();
    for (const t of guest.filter((t) => t.id !== 'chat')) {
      expect(t.disabled).toBe(true);
      expect(t.title).toBe(GUEST_TABS_NOTE);
    }
  });
});
