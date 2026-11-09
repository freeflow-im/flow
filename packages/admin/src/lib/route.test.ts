import { describe, expect, it } from 'vitest';
import { sectionOf, sectionPath } from './route';

describe('the Admin app’s address', () => {
  it('names a section, or the first one', () => {
    const all = ['general', 'members', 'domains', 'agents', 'automations'] as const;
    expect(sectionOf('/admin', all)).toBe('general');
    expect(sectionOf('/admin/', all)).toBe('general');
    expect(sectionOf('/admin/domains', all)).toBe('domains');
    expect(sectionOf('/admin/domains/', all)).toBe('domains');
    expect(sectionOf('/admin/nothing', all)).toBe('general');
  });

  it('falls back to the first section this build has', () => {
    expect(sectionOf('/admin/domains', ['general'])).toBe('general');
    expect(sectionOf('/admin/general', ['general'])).toBe('general');
  });

  it('writes a section’s address', () => {
    expect(sectionPath('members')).toBe('/admin/members');
  });
});
