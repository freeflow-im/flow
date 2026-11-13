// Admin → Changelog: the entries in full, newest first by day, with the search, the platform chips, the Feature filter,
// paging, and the frozen archives at the end; and the generator that makes its data from changelog/.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain .mjs script of the repository, without types.
import { parseEntry } from '../../../../scripts/build-changelog.mjs';
import { byDay, Changelog, filterEntries, PAGE, type ChangelogData, type ChangelogEntry } from './Changelog';

afterEach(cleanup);

const entry = (date: string, slug: string, title: string, body: string, tags: string[], feature = false): ChangelogEntry => ({
  file: `${date}-${slug}.md`, date, slug, title, tags, feature, body: `# ${title}\n\n${body}`,
});
const data: ChangelogData = {
  generatedAt: '2026-11-13T00:00:00Z',
  entries: [
    entry('2026-11-13', 'mail-docs', 'Mail: attach from Docs', '- `[web]` The paperclip offers **From Docs**.\n\n## Feature\n\n- Attach from Docs.', ['web'], true),
    entry('2026-11-13', 'edge-mail', 'Local runs send mail', '- `[server]` Mail to `.test` addresses is logged.', ['server']),
    entry('2026-11-12', 'ios-fix', 'iOS: a crash fixed', '- `[ios]` The keyboard no longer crashes.', ['ios']),
  ],
  archives: [{ name: 'CHANGES_ARCHIVE_PHASE1-11.log', text: 'Phase 1: chat.' }],
};

describe('the Changelog page', () => {
  it('shows every entry in full under its day, with its platforms, and the archives at the end', async () => {
    render(<Changelog load={async () => data} />);
    await screen.findByTestId('changelog');
    expect(screen.getAllByTestId('changelog-entry')).toHaveLength(3);
    expect(screen.getByText('Mail: attach from Docs')).toBeTruthy();
    // The text, Markdown drawn: the bold, and the Feature section's heading.
    expect(screen.getByText('From Docs').tagName).toBe('STRONG');
    expect(screen.getByRole('heading', { name: 'Feature' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toContain('Earlier history');
    expect(screen.getByText('CHANGES_ARCHIVE_PHASE1-11.log')).toBeTruthy();
    expect(screen.getByText('2026-11-13-mail-docs.md').getAttribute('href')).toBe('https://github.com/freeflow-im/flow/blob/main/changelog/2026-11-13-mail-docs.md');
  });

  it('narrows to a search, a platform, or the changes people can see', async () => {
    render(<Changelog load={async () => data} />);
    await screen.findByTestId('changelog');
    fireEvent.change(screen.getByLabelText('Search the changelog'), { target: { value: 'keyboard' } });
    expect(screen.getByTestId('changelog-count').textContent).toBe('1 of 3 entries');
    fireEvent.change(screen.getByLabelText('Search the changelog'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /^server/ }));
    expect(screen.getAllByTestId('changelog-entry').map((a) => a.querySelector('h3')!.textContent)).toEqual(['Local runs send mail']);
    fireEvent.click(screen.getByRole('button', { name: /^server/ }));
    fireEvent.click(screen.getByLabelText('Only changes people can see'));
    expect(screen.getAllByTestId('changelog-entry')).toHaveLength(1);
  });

  it('draws the first entries, and more on asking', async () => {
    const many = { ...data, entries: Array.from({ length: PAGE + 5 }, (_, i) => entry('2026-10-01', `e${String(i).padStart(3, '0')}`, `Entry ${i}`, '- x', ['web'])) };
    render(<Changelog load={async () => many} />);
    await screen.findByTestId('changelog');
    expect(screen.getAllByTestId('changelog-entry')).toHaveLength(PAGE);
    fireEvent.click(screen.getByRole('button', { name: 'Show more (5 left)' }));
    expect(screen.getAllByTestId('changelog-entry')).toHaveLength(PAGE + 5);
  });

  it('says so when the data cannot be loaded', async () => {
    render(<Changelog load={() => Promise.reject(new Error('The changelog could not be loaded (404).'))} />);
    await waitFor(() => expect(screen.getByTestId('changelog-error').textContent).toContain('404'));
  });
});

describe('filtering and grouping', () => {
  it('needs every word and every chosen platform', () => {
    expect(filterEntries(data.entries, 'mail logged', new Set(), false).map((e) => e.slug)).toEqual(['edge-mail']);
    expect(filterEntries(data.entries, '', new Set(['web', 'server']), false)).toEqual([]);
  });
  it('groups by day in order', () => {
    expect(byDay(data.entries).map(([d, l]) => [d, l.length])).toEqual([['2026-11-13', 2], ['2026-11-12', 1]]);
  });
});

describe('the generator', () => {
  it('reads an entry file: its date, title, platforms with or without backticks, and whether it has a Feature section', () => {
    const e = parseEntry('2026-11-13-mail-docs.md', '# Mail: attach from Docs\n\n- `[web]` One.\n- [server] Two, see [the spec](x.md).\n\n## Feature\n\n- Hi.\n');
    expect(e).toMatchObject({ date: '2026-11-13', slug: 'mail-docs', title: 'Mail: attach from Docs', tags: ['server', 'web'], feature: true });
    expect(parseEntry('README.md', '# x')).toBeNull();
  });
});
