import { describe, expect, it } from 'vitest';
import { containers } from './JsonViewer.tsx';

describe('the JSON viewer', () => {
  it('names each object and array below the top by its path, for collapsing them', () => {
    const value = { a: { b: [1, { c: null }] }, 'x/y': [], n: 3 };
    expect(containers(value)).toEqual({ paths: ['/a', '/a/b', '/a/b/1', '/x~1y'], count: 8 });
    // A large file starts open to two levels: only what is deeper is closed.
    expect(containers(value, 2).paths).toEqual(['/a/b/1']);
    expect(containers(5)).toEqual({ paths: [], count: 1 });
  });

});
