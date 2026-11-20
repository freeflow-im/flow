// The slide shown, in the address's fragment (`#slide=3`, counted from 1), so an address passed on opens that
// slide. The editor, the slideshow and a public link write it as the slide changes (replacing the history entry,
// so moving through a deck does not fill Back), and go to the slide it names when it is edited.
import { useEffect, useRef } from 'react';

type Place = { location: Pick<Location, 'hash' | 'pathname' | 'search'>; history: Pick<History, 'state' | 'replaceState'> };

const params = (hash: string) => new URLSearchParams(hash.replace(/^#/, ''));

/** The slide the fragment names (0-based), kept within a deck of `count` slides; null when it names none. */
export function slideFromHash(hash: string, count: number): number | null {
  const raw = params(hash).get('slide');
  if (raw === null || !count || !/^\s*\d+\s*$/.test(raw)) return null;
  return Math.max(0, Math.min(Number(raw) - 1, count - 1));
}

/** The fragment with the slide at `index` (0-based) in it, keeping whatever else it holds. */
export function withSlide(hash: string, index: number): string {
  const p = params(hash);
  p.set('slide', String(index + 1));
  return `#${p.toString()}`;
}

/** Put the slide at `index` in the address, in place of the current history entry (the router's state kept). */
export function writeSlideFragment(index: number, place: Place = window): void {
  const { location, history } = place;
  const hash = withSlide(location.hash, index);
  if (hash !== location.hash) history.replaceState(history.state, '', `${location.pathname}${location.search}${hash}`);
}

/** The slide the address opens at (0-based), else the first. */
export const initialSlide = (count: number, place: Pick<Place, 'location'> = window): number => slideFromHash(place.location.hash, count) ?? 0;

/**
 * Keep the address on the slide shown (`index` of `count`), and go to the slide named when the fragment is edited
 * (a slide past the end is the last; a fragment naming none is put back to the slide shown).
 */
export function useSlideFragment(index: number, count: number, goTo: (index: number) => void): void {
  const latest = useRef({ index, count, goTo });
  latest.current = { index, count, goTo };
  useEffect(() => {
    if (count) writeSlideFragment(index);
  }, [index, count]);
  useEffect(() => {
    const onHash = () => {
      const { index: shown, count: n, goTo: go } = latest.current;
      if (!n) return;
      const i = slideFromHash(window.location.hash, n);
      if (i !== null && i !== shown) go(i);
      writeSlideFragment(i ?? shown);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
}
