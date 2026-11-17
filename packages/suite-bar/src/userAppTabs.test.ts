import { describe, expect, it } from 'vitest';
import { APP_MANIFESTS } from '@flow/shared/manifests';
import { suiteTabsFrom } from './tabs';
import { userAppTabs } from './userAppTabs';

const apps = [
  { name: 'taskboard', label: 'Tasks', icon: '🗂️', usable: true, hasScreen: true },
  { name: 'crm', label: 'CRM', usable: false, hasScreen: true },
  { name: 'bot', label: 'Bot', usable: true, hasScreen: false },
];

describe("installed apps' tabs (user-apps.md §6)", () => {
  it('shows the apps the person may open that have a screen, after the built-in tabs and with no ⌘ digit', () => {
    const tabs = suiteTabsFrom(APP_MANIFESTS, 'chat', {}, { extra: userAppTabs(apps, 'taskboard') });
    const last = tabs.at(-1)!;
    expect(last).toEqual({ id: 'app:taskboard', label: '🗂️ Tasks', href: '/apps/taskboard', active: true });
    expect(tabs.filter((t) => t.id.startsWith('app:'))).toHaveLength(1);
    expect(last.shortcut).toBeUndefined();
  });
});
