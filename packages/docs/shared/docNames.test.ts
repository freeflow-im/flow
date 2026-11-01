import { describe, expect, it } from 'vitest';
import { nameWithExt, titleBase } from './docNames.ts';

describe('names made from a title', () => {
  it('drop a document file’s extension, and only that', () => {
    expect(titleBase('Plan.docx')).toBe('Plan');
    expect(titleBase('notes.md')).toBe('notes');
    expect(titleBase('SLACK_APP_DESIGN.md.md')).toBe('SLACK_APP_DESIGN.md');
    expect(titleBase('Budget.FFSHEET')).toBe('Budget');
    expect(titleBase('Plan')).toBe('Plan');
    expect(titleBase('v1.2 release')).toBe('v1.2 release');
    expect(titleBase('.md')).toBe('.md');
    expect(nameWithExt('notes.md', 'md')).toBe('notes.md');
    expect(nameWithExt('Pitch.pptx', 'json')).toBe('Pitch.json');
    expect(nameWithExt('Q3 plan', 'pdf')).toBe('Q3 plan.pdf');
  });
});
