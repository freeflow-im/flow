import { describe, expect, it } from 'vitest';
import { pastedFile } from './pastedFile.ts';

const clip = (files: File[], text = '') => ({ files, getData: (format: string) => (format === 'text/plain' ? text : '') });
const at = new Date(2026, 9, 10, 9, 5, 7);

describe('pasting on the file list', () => {
  it('names a copied picture by when it was pasted, keeping its type', async () => {
    const f = pastedFile(clip([new File(['PNGDATA'], 'image.png', { type: 'image/png' })]), at)!;
    expect(f.name).toBe('Pasted image 2026-10-10 at 09.05.07.png');
    expect(f.type).toBe('image/png');
    expect(await f.text()).toBe('PNGDATA');
    expect(pastedFile(clip([new File(['x'], 'image.jpeg', { type: 'image/jpeg' })]), at)!.name).toBe('Pasted image 2026-10-10 at 09.05.07.jpg');
  });

  it('takes a copied file as it is', () => {
    const report = new File(['%PDF'], 'Q3 report.pdf', { type: 'application/pdf' });
    expect(pastedFile(clip([report], 'ignored when there is a file'), at)).toBe(report);
    const photo = new File(['x'], 'holiday.png', { type: 'image/png' });
    expect(pastedFile(clip([photo]), at)).toBe(photo);
  });

  it('makes a Markdown file of pasted text, named by its first line', async () => {
    const f = pastedFile(clip([], '\r\n## Meeting *notes*\r\n\r\n- one\r\n- two\r\n'), at)!;
    expect(f.name).toBe('Meeting notes.md');
    expect(f.type).toBe('text/markdown');
    expect(await f.text()).toBe('\n## Meeting *notes*\n\n- one\n- two\n');
    expect(pastedFile(clip([], '- buy milk'), at)!.name).toBe('buy milk.md');
    expect(pastedFile(clip([], 'See https://example.com/a/b: it works'), at)!.name).toBe('See https example.com a b it works.md');
    expect(pastedFile(clip([], 'The quick brown fox jumps over the lazy dog and keeps on running far away'), at)!.name).toBe('The quick brown fox jumps over the lazy dog and keeps on….md');
    expect(pastedFile(clip([], '***'), at)!.name).toBe('Pasted text.md');
  });

  it('keeps nothing of an empty clipboard', () => {
    expect(pastedFile(clip([], '  \n '), at)).toBeNull();
    expect(pastedFile(null, at)).toBeNull();
  });
});
