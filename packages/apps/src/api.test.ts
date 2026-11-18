import { describe, expect, it } from 'vitest';
import { appNameOf, buildingOf } from './api';

describe('appNameOf', () => {
  it('reads the app from the path', () => {
    expect(appNameOf('/apps/taskboard')).toBe('taskboard');
    expect(appNameOf('/apps/taskboard/')).toBe('taskboard');
    expect(appNameOf('/apps/')).toBeNull();
    expect(appNameOf('/apps/Task_Board')).toBeNull();
    expect(appNameOf('/apps/taskboard/x')).toBeNull();
  });
});

describe('buildingOf', () => {
  it('reads the draft the Build page opens', () => {
    expect(buildingOf('?build=tasks')).toBe('tasks');
    expect(buildingOf('?build=Tasks')).toBeNull();
    expect(buildingOf('')).toBeNull();
  });
});
