import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { closePdfReaders } from './pdfMarkdown.ts';
import type { StoredFile } from '../shared/types.ts';
import { htmlToText, NoTextError, storedFileText, textBlocks, textOutline } from './storedText.ts';

const meta = (filename: string, type: string): StoredFile => ({ id: 'f', filename, type, size: 0, createdAt: '', url: '', downloadUrl: '' });

describe('stored file text', () => {
  afterAll(closePdfReaders);

  it('reads a web page as what a reader sees', () => {
    const html =
      '<html><head><title>Multi-TMC &amp; you</title><style>p{color:red}</style><script>alert(1)</script></head><body>' +
      '<h1>Plan</h1><p>First   para&nbsp;with <a href="x">a link</a>.</p><!-- hidden --><ul><li>One</li><li>Two &#8211; 2</li></ul>' +
      '<table><tr><td>a</td><td>b</td></tr></table></body></html>';
    const text = htmlToText(html);
    expect(text).toBe('# Multi-TMC & you\n\n# Plan\n\nFirst para with a link.\n\n- One\n- Two – 2\n\na | b |');
    expect(text).not.toMatch(/alert|color|hidden/);
  });

  it('reads a PDF, a text file and nothing from a picture or video', async () => {
    const pdf = readFileSync(path.join(import.meta.dirname, 'fixtures', 'report.pdf'));
    expect(await storedFileText(meta('a.pdf', 'application/pdf'), pdf)).toMatch(/^# Quarterly Report\n/);
    await expect(storedFileText(meta('bad.pdf', 'application/pdf'), Buffer.from('%PDF-1.7\n%%EOF'))).rejects.toThrow(NoTextError);
    expect(await storedFileText(meta('a.json', 'application/json'), Buffer.from('\uFEFF{"a":1}'))).toBe('{"a":1}');
    await expect(storedFileText(meta('p.png', 'image/png'), Buffer.from('x'))).rejects.toThrow(/view_image/);
    await expect(storedFileText(meta('v.mp4', 'video/mp4'), Buffer.from('x'))).rejects.toThrow(NoTextError);
  });

  it('splits text into blocks of a bounded size and reads them in parts', () => {
    const long = Array.from({ length: 300 }, (_, k) => `line ${k} ${'x'.repeat(30)}`).join('\n');
    const blocks = textBlocks(`Intro\n\n\n${long}\n\nEnd`);
    expect(blocks[0]).toBe('Intro');
    expect(blocks.at(-1)).toBe('End');
    expect(blocks.every((b) => b.length <= 4000)).toBe(true);
    expect(blocks.slice(1, -1).join('\n')).toBe(long);

    const big = Array.from({ length: 30 }, (_, k) => `${k}`.padEnd(3000, '.')).join('\n\n');
    const first = textOutline(big);
    expect(first.block_count).toBe(30);
    expect(first.showing_blocks).toBe('1-13');
    expect(textOutline(big, 29).blocks.map((b) => b.n)).toEqual([29, 30]);
    expect(textOutline(big, 2, 3).blocks.map((b) => b.n)).toEqual([2, 3]);
  });
});
