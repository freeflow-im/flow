import { describe, expect, it } from 'vitest';
import { frontMatterAsCode } from './frontMatter.ts';

describe('frontMatterAsCode', () => {
  it('turns a leading yaml node into a code block with its fences', () => {
    const tree = { type: 'root', children: [{ type: 'yaml', value: 'name: x\ndescription: y' }, { type: 'heading' }] };
    frontMatterAsCode()(tree);
    expect(tree.children[0]).toEqual({ type: 'code', lang: 'yaml', value: '---\nname: x\ndescription: y\n---' });
    expect(tree.children[1]).toEqual({ type: 'heading' });
  });

  it('leaves other trees alone', () => {
    const tree = { type: 'root', children: [{ type: 'heading' }] };
    frontMatterAsCode()(tree);
    expect(tree.children).toEqual([{ type: 'heading' }]);
  });
});
