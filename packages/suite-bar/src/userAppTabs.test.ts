import { describe, expect, it } from 'vitest';
import { APP_MANIFESTS } from '@flow/shared/manifests';
import { suiteTabsFrom } from './tabs';
import { userAppTabs } from './userAppTabs';

const apps = [
  { name: 'taskboard', label: 'Tasks', icon: '🗂️', usable: true, hasScreen: true },
  { name: 'crm', label: 'CRM', usable: false, hasScreen: true },
  { name: 'bot', label: 'Bot', usable: true, hasScreen: false },
  { name: 'board', label: 'Board', iconUrl: '/v1/workspaces/o/apps/board/icon?v=2', usable: true, hasScreen: true },
];

describe("the Apps tab (user-apps.md §6)", () => {
  it('comes after the built-in tabs with no ⌘ digit, its menu the apps the person may open and Build an app', () => {
    const tabs = suiteTabsFrom(APP_MANIFESTS, 'chat', {}, { extra: userAppTabs(apps, 'taskboard') });
    const last = tabs.at(-1)!;
    expect(last).toMatchObject({ id: 'apps', label: 'Apps', href: '/apps/', active: true });
    expect(last.shortcut).toBeUndefined();
    expect(last.menu!.map((m) => [m.label, m.href, !!m.current])).toEqual([
      ['Tasks', '/apps/taskboard', true],
      ['Board', '/apps/board', false],
      ['', '', false],
      ['Build an app', '/apps/', false],
    ]);
  });

  it("carries each app's emoji or image icon beside its name (§4)", () => {
    const menu = userAppTabs(apps, 'taskboard')[0]!.menu!;
    expect(menu[0]).toMatchObject({ label: 'Tasks', icon: '🗂️' });
    expect(menu[1]).toMatchObject({ label: 'Board', iconUrl: '/v1/workspaces/o/apps/board/icon?v=2' });
    expect(menu[1]!.icon).toBeUndefined();
  });

  it('offers Build an app with no app installed, and nothing to a guest', () => {
    expect(userAppTabs([], undefined, true)[0]!.menu!.map((m) => m.label)).toEqual(['Build an app']);
    expect(userAppTabs([], undefined, true)[0]!.active).toBeUndefined();
    expect(userAppTabs([], '', true)[0]!.menu![0]!.current).toBe(true);
    expect(userAppTabs([], undefined, false)).toEqual([]);
  });
});
