// Matches in text drawn as the page shows it (a Markdown preview, the JSON tree, a slide): found in the DOM's text
// and painted with the CSS Custom Highlight API (::highlight(find-hit), ::highlight(find-current) in styles.css),
// which leaves the DOM alone. A browser without it shows no highlights, but the shown match is still scrolled to.
import { findAll } from './find.ts';

/** The elements a match does not run across: text in two of them is two pieces of text. */
const BLOCKS = 'p,div,li,h1,h2,h3,h4,h5,h6,td,th,pre,blockquote,dt,dd,tr,figcaption,summary,section,article';

/** The ranges of `query` in the text inside `root`, in document order, leaving out the text inside `skip`. */
export function rangesIn(root: Node, query: string, matchCase: boolean, skip?: string): Range[] {
  if (!query) return [];
  const out: Range[] = [];
  let block: Element | null = null;
  let text = '';
  let nodes: { node: Text; start: number }[] = [];
  const flush = () => {
    for (const at of findAll(text, query, matchCase)) {
      const end = at + query.length;
      const a = nodes.findLast((n) => n.start <= at)!;
      const b = nodes.findLast((n) => n.start < end)!;
      const range = document.createRange();
      range.setStart(a.node, at - a.start);
      range.setEnd(b.node, end - b.start);
      out.push(range);
    }
    text = '';
    nodes = [];
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (!n.data || (skip && n.parentElement?.closest(skip))) continue;
    const owner = n.parentElement?.closest(BLOCKS) ?? null;
    if (owner !== block) {
      flush();
      block = owner;
    }
    nodes.push({ node: n, start: text.length });
    text += n.data;
  }
  flush();
  return out;
}

type Highlights = { set(name: string, h: unknown): void; delete(name: string): void };
const registry = (): Highlights | null => (typeof CSS !== 'undefined' && 'highlights' in CSS ? (CSS as unknown as { highlights: Highlights }).highlights : null);
const make = (ranges: Range[]): unknown => new (globalThis as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight(...ranges);

/** Paint the matches, `current` among them standing out. */
export function paintMatches(ranges: Range[], current: Range | null): void {
  const reg = registry();
  if (!reg || typeof (globalThis as { Highlight?: unknown }).Highlight !== 'function') return;
  reg.set('find-hit', make(ranges));
  if (current) reg.set('find-current', make([current]));
  else reg.delete('find-current');
}

export function clearMatches(): void {
  const reg = registry();
  reg?.delete('find-hit');
  reg?.delete('find-current');
}

/** Scroll the match into the middle of whatever scrolls it, if it is not in view. */
export function scrollToRange(range: Range): void {
  const el = range.startContainer.parentElement;
  if (!el) return;
  const box = range.getBoundingClientRect();
  if (box.top >= 0 && box.bottom <= window.innerHeight && box.height) {
    // In the window, but maybe outside a scrolled box inside it.
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return;
  }
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
}
