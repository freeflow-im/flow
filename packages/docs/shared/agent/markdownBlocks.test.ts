import { describe, expect, it } from 'vitest';
import { applyEdit, blockAt, findOccurrences, insertEdit, markdownBlocks, markdownOutline, replaceEdit } from './markdownBlocks.ts';

const TEXT = '---\nname: x\n---\n\n# Title\n\nHello **world**.\nSecond line.\n\n- a\n- b\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\ncode\n```\n';

describe('markdownBlocks', () => {
  it('lists top-level constructs with their types and source text', () => {
    const blocks = markdownBlocks(TEXT);
    expect(blocks.map((b) => [b.n, b.type, b.markdown])).toEqual([
      [1, 'front_matter', '---\nname: x\n---'],
      [2, 'heading1', '# Title'],
      [3, 'paragraph', 'Hello **world**.\nSecond line.'],
      [4, 'bullet_list', '- a\n- b'],
      [5, 'table', '| A | B |\n| - | - |\n| 1 | 2 |'],
      [6, 'code_block', '```js\ncode\n```'],
    ]);
    for (const b of blocks) expect(TEXT.slice(b.start, b.end)).toBe(b.markdown);
    expect(markdownBlocks('')).toEqual([]);
  });

  it('outlines a range and the cursor block', () => {
    const o = markdownOutline(TEXT, { from: 2, to: 3, cursor: TEXT.indexOf('Second') });
    expect(o.block_count).toBe(6);
    expect(o.cursor_block).toBe(3);
    expect(o.showing_blocks).toBe('2-3');
    expect(o.blocks).toEqual([
      { n: 2, type: 'heading1', markdown: '# Title' },
      { n: 3, type: 'paragraph', markdown: 'Hello **world**.\nSecond line.' },
    ]);
    expect(blockAt(markdownBlocks(TEXT), 0)).toBe(1);
    expect(blockAt([], 5)).toBe(0);
  });

  it('inserts at the top, after a block and at the end with blank lines around', () => {
    const text = '# A\n\npara\n';
    const blocks = markdownBlocks(text);
    expect(applyEdit(text, insertEdit(text, blocks, 0, 'top'))).toBe('top\n\n# A\n\npara\n');
    expect(applyEdit(text, insertEdit(text, blocks, 1, '\n## B\n'))).toBe('# A\n\n## B\n\npara\n');
    expect(applyEdit(text, insertEdit(text, blocks, undefined, 'end'))).toBe('# A\n\npara\n\nend\n');
    expect(applyEdit('', insertEdit('', [], undefined, 'only'))).toBe('only\n');
  });

  it('replaces and deletes block ranges without leaving extra blank lines', () => {
    const text = '# A\n\none\n\ntwo\n\nthree\n';
    const blocks = markdownBlocks(text);
    expect(applyEdit(text, replaceEdit(text, blocks, 1, 2, '- x\n- y'))).toBe('# A\n\n- x\n- y\n\nthree\n');
    expect(applyEdit(text, replaceEdit(text, blocks, 1, 1, ''))).toBe('# A\n\ntwo\n\nthree\n');
    expect(applyEdit(text, replaceEdit(text, blocks, 3, 3, ''))).toBe('# A\n\none\n\ntwo\n');
    expect(applyEdit(text, replaceEdit(text, blocks, 0, 3, ''))).toBe('');
  });

  it('finds occurrences, optionally within one block', () => {
    const text = 'cat\n\ncat and cat\n';
    const blocks = markdownBlocks(text);
    expect(findOccurrences(text, blocks, 'cat').map((o) => o.block)).toEqual([1, 2, 2]);
    expect(findOccurrences(text, blocks, 'cat', 2)).toHaveLength(2);
    expect(findOccurrences(text, blocks, 'dog')).toEqual([]);
  });
});
