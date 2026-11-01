import { parseCellKey } from '../../../shared/cellref.ts';
import { isFormula } from '../../../shared/formula/adjust.ts';
import type { Tab } from '../../../shared/types.ts';

export interface SearchOptions {
  query: string;
  matchCase: boolean;
  /** The whole cell must equal the query (instead of containing it). */
  wholeCell: boolean;
  /** Also match against formula text (e.g. "SUM"), not just displayed values. */
  formulas: boolean;
  allTabs: boolean;
}

export interface SearchHit {
  tabId: string;
  r: number;
  c: number;
}

export interface SearchSource {
  display(tabId: string, r: number, c: number): string;
  hiddenRows(tab: Tab): Set<number>;
}

function matcher(opts: SearchOptions): (text: string) => boolean {
  const q = opts.matchCase ? opts.query : opts.query.toLowerCase();
  return (text) => {
    const t = opts.matchCase ? text : text.toLowerCase();
    return opts.wholeCell ? t === q : t.includes(q);
  };
}

/** All matching cells, in tab order then row-major order. Rows hidden by a filter are skipped. */
export function findMatches(src: SearchSource, tabs: Tab[], opts: SearchOptions): SearchHit[] {
  if (!opts.query) return [];
  const test = matcher(opts);
  const hits: SearchHit[] = [];
  for (const tab of tabs) {
    const hidden = src.hiddenRows(tab);
    const tabHits: SearchHit[] = [];
    for (const key in tab.cells) {
      const cell = tab.cells[key];
      if (!cell.v) continue;
      const p = parseCellKey(key);
      if (!p || hidden.has(p.r)) continue;
      const shown = src.display(tab.id, p.r, p.c);
      if (test(shown) || (opts.formulas && isFormula(cell.v) && test(cell.v))) tabHits.push({ tabId: tab.id, r: p.r, c: p.c });
    }
    tabHits.sort((a, b) => a.r - b.r || a.c - b.c);
    hits.push(...tabHits);
  }
  return hits;
}
