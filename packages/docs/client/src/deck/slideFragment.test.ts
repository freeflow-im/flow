import { describe, expect, it } from 'vitest';
import { initialSlide, slideFromHash, withSlide, writeSlideFragment } from './slideFragment.ts';

function place(hash: string, state: unknown = { usr: null, key: 'k1', idx: 3 }) {
  const calls: { state: unknown; url: string }[] = [];
  const p = {
    location: { hash, pathname: '/docs/d/abc', search: '?x=1' },
    history: {
      state,
      replaceState(s: unknown, _t: string, url: string) {
        calls.push({ state: s, url });
        p.location.hash = url.slice(url.indexOf('#'));
      },
    },
  };
  return { p, calls };
}

describe('slide fragment', () => {
  it('reads the slide named, counted from 1', () => {
    expect(slideFromHash('#slide=3', 5)).toBe(2);
    expect(slideFromHash('slide=1', 5)).toBe(0);
    expect(slideFromHash('#a=b&slide=2', 5)).toBe(1);
  });
  it('keeps a slide past either end within the deck', () => {
    expect(slideFromHash('#slide=99', 5)).toBe(4);
    expect(slideFromHash('#slide=0', 5)).toBe(0);
  });
  it('names no slide for a missing or malformed value, or an empty deck', () => {
    for (const h of ['', '#', '#other=1', '#slide=', '#slide=abc', '#slide=-2', '#slide=2.5', '#slide=1e3']) expect(slideFromHash(h, 5)).toBeNull();
    expect(slideFromHash('#slide=2', 0)).toBeNull();
  });
  it('opens at the slide named, else the first', () => {
    expect(initialSlide(4, { location: { hash: '#slide=4', pathname: '/', search: '' } })).toBe(3);
    expect(initialSlide(4, { location: { hash: '#slide=nope', pathname: '/', search: '' } })).toBe(0);
    expect(initialSlide(4, { location: { hash: '', pathname: '/', search: '' } })).toBe(0);
  });
  it('writes the slide and keeps the rest of the fragment', () => {
    expect(withSlide('', 0)).toBe('#slide=1');
    expect(withSlide('#slide=2', 6)).toBe('#slide=7');
    expect(withSlide('#a=b&slide=2', 3)).toBe('#a=b&slide=4');
  });
  it('replaces the history entry, keeping the path, query and router state', () => {
    const { p, calls } = place('');
    writeSlideFragment(2, p);
    expect(calls).toEqual([{ state: { usr: null, key: 'k1', idx: 3 }, url: '/docs/d/abc?x=1#slide=3' }]);
  });
  it('leaves the address alone when it already names the slide', () => {
    const { p, calls } = place('#slide=3');
    writeSlideFragment(2, p);
    expect(calls).toEqual([]);
  });
});
