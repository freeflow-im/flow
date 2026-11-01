import { describe, expect, it } from 'vitest';
import { markdownTitle, newMarkdownDoc, validateMarkdownDoc } from './markdown.ts';

describe('markdown documents', () => {
  it('validates the stored shape', () => {
    expect(validateMarkdownDoc(newMarkdownDoc())).toBeNull();
    expect(validateMarkdownDoc(newMarkdownDoc('# Hi'))).toBeNull();
    expect(validateMarkdownDoc(null)).toMatch(/object/);
    expect(validateMarkdownDoc({ version: 2, text: '' })).toMatch(/version/);
    expect(validateMarkdownDoc({ version: 1, text: 1 })).toMatch(/string/);
    expect(validateMarkdownDoc({ version: 1, text: 'x'.repeat(5 * 1024 * 1024 + 1) })).toMatch(/too long/);
  });

  it('titles an import from its first heading, else the file name', () => {
    expect(markdownTitle('intro\n\n# Release notes ##\n\ntext', 'notes.md')).toBe('Release notes');
    expect(markdownTitle('no heading here\n## only h2', 'My Notes.markdown')).toBe('My Notes');
    expect(markdownTitle('', '.md')).toBe('Imported Markdown');
  });
});
