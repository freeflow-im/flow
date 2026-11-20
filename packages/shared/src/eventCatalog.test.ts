import { describe, expect, it } from 'vitest';
import { EVENT_LABELS, eventCatalog, findEvent } from './eventCatalog.js';
import { APP_MANIFESTS } from './manifests.js';

describe('eventCatalog', () => {
  it('names every built-in event for people, not by its words', () => {
    // A new built-in event gets a name in eventCatalog.ts's table: its words would read like "Chat message created".
    const unnamed = APP_MANIFESTS.flatMap((m) => m.events).filter((t) => !EVENT_LABELS[t]);
    expect(unnamed).toEqual([]);
  });

  it('groups the suite\'s apps, sharing, and installed apps with their full types', () => {
    const groups = eventCatalog([{ name: 'taskboard', label: 'Taskboard', events: ['task.created'] }, { name: 'quiet', label: 'Quiet', events: [] }]);
    expect(groups.map((g) => g.label)).toEqual(['Chat', 'Docs', 'Mail', 'Calendar', 'Contacts', 'Sharing', 'Agents', 'Taskboard']);
    expect(findEvent(groups, 'app.taskboard.task.created')).toMatchObject({ group: { label: 'Taskboard', installed: true }, event: { label: 'Task created' } });
    expect(findEvent(groups, 'sharing.granted')?.group.label).toBe('Sharing');
    expect(findEvent(groups, 'app.crm.deal.won')).toBeNull();
  });
});
