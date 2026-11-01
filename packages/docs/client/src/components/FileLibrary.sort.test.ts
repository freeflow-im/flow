import { describe, expect, it } from 'vitest';
import { compareItems, kindLabel, typeGroup, type LibraryItem } from './FileLibrary.tsx';

const item = (title: string, kind: LibraryItem['kind'], updatedAt: string, createdAt = updatedAt): LibraryItem => ({ id: title, title, kind, updatedAt, createdAt });

describe('file list sorting', () => {
  const items = [item('beta.pdf', 'file', '2026-10-03'), item('Alpha', 'sheet', '2026-10-05', '2026-10-01'), item('gamma', 'doc', '2026-10-04', '2026-10-02'), item('alpha 10', 'markdown', '2026-10-06', '2026-09-30'), item('alpha 2', 'deck', '2026-10-02')];
  const titles = (key: Parameters<typeof compareItems>[2]['key'], dir: 'asc' | 'desc') => [...items].sort((a, b) => compareItems(a, b, { key, dir })).map((i) => i.title);

  it('sorts by name naturally and case-insensitively', () => {
    expect(titles('title', 'asc')).toEqual(['Alpha', 'alpha 2', 'alpha 10', 'beta.pdf', 'gamma']);
    expect(titles('title', 'desc')).toEqual(['gamma', 'beta.pdf', 'alpha 10', 'alpha 2', 'Alpha']);
  });

  it('sorts by dates', () => {
    expect(titles('updatedAt', 'desc')).toEqual(['alpha 10', 'Alpha', 'gamma', 'beta.pdf', 'alpha 2']);
    expect(titles('createdAt', 'asc')).toEqual(['alpha 10', 'Alpha', 'alpha 2', 'gamma', 'beta.pdf']);
  });

  it('sorts by type, then by name within a type', () => {
    expect(titles('kind', 'asc')).toEqual(['gamma', 'alpha 10', 'beta.pdf', 'alpha 2', 'Alpha']);
    expect(items.map(kindLabel)).toEqual(['PDF', 'Spreadsheet', 'Document', 'Markdown', 'Presentation']);
    expect(kindLabel({ kind: 'file', title: 'noext' })).toBe('File');
  });
});

describe('file type filter', () => {
  it('groups items by what they are', () => {
    const group = (title: string, kind: LibraryItem['kind']) => typeGroup({ title, kind });
    expect(group('Budget', 'sheet')).toBe('sheet');
    expect(group('Pitch', 'deck')).toBe('deck');
    expect(group('Notes', 'doc')).toBe('doc');
    expect(group('README', 'markdown')).toBe('doc');
    expect(group('Report.PDF', 'file')).toBe('pdf');
    expect(group('photo.jpeg', 'file')).toBe('image');
    expect(group('logo.webp', 'file')).toBe('image');
    expect(group('demo.mov', 'file')).toBe('video');
    expect(group('chart.html', 'file')).toBe('other');
    expect(group('archive', 'file')).toBe('other');
    // A document whose title happens to end like a file is still a document.
    expect(group('holiday.png', 'doc')).toBe('doc');
  });
});
