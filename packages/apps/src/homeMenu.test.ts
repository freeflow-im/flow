import { describe, expect, it } from 'vitest';
import { userAppTabs } from '@flow/suite-bar';
import { appsHomeMenu, appsHomeSelected } from './homeMenu';

const apps = [
  { name: 'taskboard', label: 'Tasks', usable: true, hasScreen: true },
  { name: 'hidden', label: 'Hidden', usable: false, hasScreen: true },
];

describe('the Apps menu sent to Home', () => {
  it('lists the apps the person may open, then Build an app, without the divider', () => {
    expect(appsHomeMenu(userAppTabs(apps, 'taskboard'))).toEqual([
      { id: 'app:taskboard', label: 'Tasks', href: '/apps/taskboard' },
      { id: 'apps-build', label: 'Build an app', href: '/apps/', icon: 'plus' },
    ]);
  });

  it('sends nothing while there is no Apps tab', () => {
    expect(appsHomeMenu([])).toBeNull();
  });

  it('marks the open app, or Build an app on the apps home', () => {
    expect(appsHomeSelected('taskboard')).toBe('app:taskboard');
    expect(appsHomeSelected(null)).toBe('apps-build');
  });
});
