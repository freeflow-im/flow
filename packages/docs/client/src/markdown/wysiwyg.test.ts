import type { ElementContent, Properties } from 'hast';
import { describe, expect, it } from 'vitest';
import { markdownBlocks } from '../../../shared/agent/markdownBlocks.ts';
import { imageIn, imageMarkdown, relativeLink } from './pastedImage.ts';
import { blockKeys, editableBlock, hastToMarkdown, spliceBlock } from './wysiwyg.ts';

const h = (tagName: string, properties: Properties = {}, ...children: (ElementContent | string)[]): ElementContent => ({
  type: 'element',
  tagName,
  properties,
  children: children.map((c) => (typeof c === 'string' ? { type: 'text', value: c } : c)),
});

describe('hastToMarkdown', () => {
  it('writes the dialect of the text editor', () => {
    expect(hastToMarkdown([h('p', {}, 'Some ', h('strong', {}, 'bold'), ' and ', h('em', {}, 'italic'), ' text')])).toBe('Some **bold** and _italic_ text');
    expect(hastToMarkdown([h('h2', {}, 'Title')])).toBe('## Title');
    expect(hastToMarkdown([h('ul', {}, h('li', {}, 'one'), h('li', {}, 'two'))])).toBe('- one\n- two');
  });

  it('turns pictures back into the address written, not the one the preview loads', () => {
    const img = h('img', { src: '/api/files/at?folder=&name=a.png', alt: 'chart', dataMdSrc: 'a.png' });
    expect(hastToMarkdown([h('p', {}, img)])).toBe('![chart](a.png)');
  });

  it('keeps task boxes, tables and code languages', () => {
    const task = h('ul', { className: ['contains-task-list'] }, h('li', { className: ['task-list-item'] }, h('input', { type: 'checkbox', checked: true }), ' done'));
    expect(hastToMarkdown([task])).toBe('- [x] done');
    const table = h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'A'), h('th', {}, 'B'))), h('tbody', {}, h('tr', {}, h('td', {}, '1'), h('td', {}, '2'))));
    expect(hastToMarkdown([table])).toBe('| A | B |\n| - | - |\n| 1 | 2 |');
    expect(hastToMarkdown([h('pre', {}, h('code', { className: ['language-js'] }, 'let a = 1;\n'))])).toBe('```js\nlet a = 1;\n```');
  });

  it('is empty for an emptied block', () => {
    expect(hastToMarkdown([h('br')])).toBe('');
    expect(hastToMarkdown([])).toBe('');
  });
});

describe('spliceBlock', () => {
  const text = '# Title\n\nFirst paragraph.\n\nSecond paragraph.\n';
  const [, first] = markdownBlocks(text);

  it('replaces only the block', () => {
    const r = spliceBlock(text, first.start, first.end, 'First, edited.');
    expect(r.text).toBe('# Title\n\nFirst, edited.\n\nSecond paragraph.\n');
    expect(r.text.slice(r.from, r.to)).toBe('First, edited.');
  });

  it('keeps a block written right under another apart from it', () => {
    const tight = '# Title\ntext under it';
    const [heading] = markdownBlocks(tight);
    const r = spliceBlock(tight, heading.start, heading.end, 'Now a paragraph');
    expect(r.text).toBe('Now a paragraph\n\ntext under it');
    expect(markdownBlocks(r.text)).toHaveLength(2);
  });

  it('takes an emptied block away with its blank line', () => {
    const r = spliceBlock(text, first.start, first.end, '');
    expect(r.text).toBe('# Title\n\nSecond paragraph.\n');
    // Writing into it again puts the block back where it was.
    const again = spliceBlock(r.text, r.from, r.to, 'Back.');
    expect(again.text).toBe('# Title\n\nBack.\n\nSecond paragraph.\n');
    const last = markdownBlocks(text)[2];
    expect(spliceBlock(text, last.start, last.end, '').text).toBe('# Title\n\nFirst paragraph.\n');
  });

  it('adds a block at the end', () => {
    expect(spliceBlock(text, text.length, text.length, 'More.').text).toBe(`${text}\nMore.\n`);
    expect(spliceBlock('', 0, 0, 'Hello').text).toBe('Hello');
  });
});

describe('blocks', () => {
  it('keys repeated blocks apart and keeps the key being edited', () => {
    const blocks = markdownBlocks('Same\n\nSame\n\nOther');
    const keys = blockKeys(blocks);
    expect(new Set(keys).size).toBe(3);
    expect(blockKeys(blocks.slice(1), [keys[0]])[0]).toBe(keys[1]);
  });

  it('leaves front matter and diagrams to the text editor', () => {
    const [fm, diagram, code] = markdownBlocks('---\ntitle: x\n---\n\n```mermaid\ngraph TD\n```\n\n```js\n1\n```');
    expect([editableBlock(fm), editableBlock(diagram), editableBlock(code)]).toEqual([false, false, true]);
  });
});

describe('pasted pictures', () => {
  const data = (files: File[]) => ({ files: files as unknown as FileList, getData: () => '' });

  it('names a copied picture by when it was pasted, and ignores other files', () => {
    const now = new Date(2026, 10, 12, 9, 5, 7);
    expect(imageIn(data([new File(['x'], 'image.png', { type: 'image/png' })]), now)?.name).toBe('Pasted image 2026-11-12 at 09.05.07.png');
    expect(imageIn(data([new File(['x'], 'diagram.jpg', { type: 'image/jpeg' })]), now)?.name).toBe('diagram.jpg');
    expect(imageIn(data([new File(['x'], 'notes.txt', { type: 'text/plain' })]), now)).toBeNull();
  });

  it('links to it by a relative path Markdown reads whole', () => {
    expect(relativeLink('Pasted image (1).png')).toBe('Pasted%20image%20%281%29.png');
    expect(imageMarkdown('Pasted image 2026-11-12 at 09.05.07.png')).toBe('![Pasted image 2026-11-12 at 09.05.07](Pasted%20image%202026-11-12%20at%2009.05.07.png)');
  });
});
