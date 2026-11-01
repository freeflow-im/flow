// Pages on screen. The editor stays one continuous column; this plugin measures where each line and block
// lands, works out where page boundaries fall, and inserts spacer decorations (never document content) that
// push the next line or block to the top of the following page. The page frames, numbers, headers and footers
// are drawn by the editor component from the same result. Nothing here is stored.
import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { pageMetrics, pageSetupOf } from '../../../shared/doc.ts';

/** One measurable piece of content in its natural (spacer-free) position, in column pixels. */
export interface Unit {
  /** Where a spacer goes to push this unit: before its block, or inside the textblock for later lines. */
  pos: number;
  top: number;
  bottom: number;
  kind: 'line' | 'block' | 'page_break';
  /** Index of the top-level block the unit belongs to. */
  block: number;
  /** The unit is the first of its top-level block. */
  blockStart: boolean;
  /** The unit belongs to a heading, title or subtitle (kept with the block that follows). */
  heading: boolean;
}

export interface Layout {
  /** Height of the content box on each page. */
  contentH: number;
  /** Distance from the top of one page to the top of the next (page height plus the gap). */
  stride: number;
  /** Top margin: where content starts on each page. */
  marginTop: number;
}

export interface Spacer {
  pos: number;
  height: number;
}

export interface Pagination {
  spacers: Spacer[];
  pageCount: number;
  /** Page (0-based) each top-level block starts on. */
  blockPages: number[];
}

const EPS = 0.5;

/** Decide where the page boundaries fall. Pure, so it can be tested with made-up measurements. */
export function computePagination(units: Unit[], layout: Layout): Pagination {
  const spacers: Spacer[] = [];
  const blockPages: number[] = [];
  const contentTop = (page: number) => page * layout.stride + layout.marginTop;
  const contentBottom = (page: number) => contentTop(page) + layout.contentH;
  /** The first page after `page` whose content top is at or below y (content may already run past a page). */
  const nextPage = (page: number, y: number) => Math.max(page + 1, Math.ceil((y - layout.marginTop - EPS) / layout.stride));
  let offset = 0;
  let page = 0;
  let forceBreak = false;
  /** First unit of the heading block just above the current unit, while that heading could still move. */
  let headingStart = -1;
  let pulledHeading = -1;
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const top = u.top + offset;
    const bottom = u.bottom + offset;
    const overflows = bottom > contentBottom(page) + EPS && top > contentTop(page) + EPS;
    if (forceBreak || overflows) {
      // Keep a heading with the block after it: break before the heading instead (once).
      const keepWith = !forceBreak && u.blockStart && headingStart >= 0 && units[headingStart].block === u.block - 1 && pulledHeading !== headingStart;
      if (keepWith && units[headingStart].top + offset > contentTop(page) + EPS) {
        pulledHeading = headingStart;
        i = headingStart;
        const h = units[i];
        page = nextPage(page, h.top + offset);
        const height = contentTop(page) - (h.top + offset);
        spacers.push({ pos: h.pos, height });
        offset += height;
        blockPages[h.block] = page;
        continue;
      }
      page = nextPage(page, top);
      const height = contentTop(page) - top;
      spacers.push({ pos: u.pos, height });
      offset += height;
      forceBreak = false;
    }
    if (u.blockStart) blockPages[u.block] = page;
    if (u.kind === 'page_break') forceBreak = true;
    if (u.heading) {
      if (u.blockStart) headingStart = i;
    } else headingStart = -1;
  }
  return { spacers, pageCount: page + 1, blockPages };
}

// --- Measuring the editor DOM -------------------------------------------------------------------------

const SPACER_CLASS = 'doc-page-spacer';
const HEADING_TYPES = new Set(['heading', 'title', 'subtitle']);

interface Rect {
  top: number;
  bottom: number;
  left: number;
}

/** Line boxes of a textblock element, from its text nodes (spacer widgets inside it are skipped). */
function lineRects(el: HTMLElement): Rect[] {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => ((node.parentElement?.closest(`.${SPACER_CLASS}`) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) as number),
  });
  const rects: Rect[] = [];
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    range.selectNodeContents(node);
    for (const r of Array.from(range.getClientRects())) {
      if (r.width === 0 && r.height === 0) continue;
      rects.push({ top: r.top, bottom: r.bottom, left: r.left });
    }
  }
  rects.sort((a, b) => a.top - b.top || a.left - b.left);
  // Merge rects that share a line (their vertical extents overlap).
  const lines: Rect[] = [];
  for (const r of rects) {
    const last = lines[lines.length - 1];
    if (last && r.top < last.bottom - 1) {
      last.top = Math.min(last.top, r.top);
      last.bottom = Math.max(last.bottom, r.bottom);
      last.left = Math.min(last.left, r.left);
    } else lines.push({ ...r });
  }
  return lines;
}

/** Measure every line and leaf block of the document in natural column coordinates. */
export function measureUnits(view: EditorView): Unit[] {
  const dom = view.dom as HTMLElement;
  const outer = dom.getBoundingClientRect();
  const scale = dom.offsetWidth ? outer.width / dom.offsetWidth : 1;
  // Positions are relative to the page column (the padded element around the editor), whose top is page 0's top.
  const originTop = (dom.parentElement ?? dom).getBoundingClientRect().top;
  // Existing spacers shift everything below them; subtract them to get natural positions.
  const spacers = Array.from(dom.querySelectorAll<HTMLElement>(`.${SPACER_CLASS}`)).map((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, height: r.height };
  });
  const natural = (clientY: number) => {
    let shift = 0;
    for (const s of spacers) if (s.top < clientY - 0.5) shift += s.height;
    return (clientY - shift - originTop) / scale;
  };
  /**
   * Where a spacer before this block would start, plus the block's own top margin: a spacer between two blocks
   * stops their margins collapsing, so the block ends up at spacer bottom + its margin, and the previous
   * block's bottom margin sits above the spacer. Measured from the previous sibling so the result is the same
   * whether or not a spacer is already there.
   */
  const blockTop = (el: HTMLElement): number => {
    let prev = el.previousElementSibling as HTMLElement | null;
    while (prev && prev.classList.contains(SPACER_CLASS)) prev = prev.previousElementSibling as HTMLElement | null;
    const mt = Number.parseFloat(getComputedStyle(el).marginTop) || 0;
    if (!prev) return natural(el.getBoundingClientRect().top);
    const mb = Number.parseFloat(getComputedStyle(prev).marginBottom) || 0;
    return natural(prev.getBoundingClientRect().bottom) + mb + mt;
  };
  const units: Unit[] = [];
  const doc = view.state.doc;
  doc.forEach((block, blockPos, blockIndex) => {
    let first = true;
    const heading = HEADING_TYPES.has(block.type.name);
    const addLeaf = (node: PMNode, pos: number) => {
      const el = view.nodeDOM(pos) as HTMLElement | null;
      if (!el || !el.getBoundingClientRect) return;
      const r = el.getBoundingClientRect();
      units.push({ pos, top: blockTop(el), bottom: natural(r.bottom), kind: node.type.name === 'page_break' ? 'page_break' : 'block', block: blockIndex, blockStart: first, heading });
      first = false;
    };
    const addTextblock = (pos: number) => {
      const el = view.nodeDOM(pos) as HTMLElement | null;
      if (!el || !el.getBoundingClientRect) return;
      let lines = lineRects(el);
      if (!lines.length) {
        const r = el.getBoundingClientRect();
        lines = [{ top: r.top, bottom: r.bottom, left: r.left }];
      }
      lines.forEach((line, k) => {
        let linePos = pos;
        let top = natural(line.top);
        if (k > 0) {
          const hit = view.posAtCoords({ left: line.left + 1, top: (line.top + line.bottom) / 2 });
          if (!hit) return;
          linePos = hit.pos;
        } else top = blockTop(el); // the spacer goes before the whole block
        units.push({ pos: linePos, top, bottom: natural(line.bottom), kind: 'line', block: blockIndex, blockStart: first, heading });
        first = false;
      });
    };
    if (block.isTextblock) addTextblock(blockPos);
    else if (block.isLeaf || block.isAtom) addLeaf(block, blockPos);
    else {
      block.descendants((node, rel) => {
        const pos = blockPos + 1 + rel;
        if (node.isTextblock) {
          addTextblock(pos);
          return false;
        }
        if (node.isLeaf || node.isAtom) {
          addLeaf(node, pos);
          return false;
        }
        return true;
      });
    }
  });
  return units;
}

// --- The plugin ------------------------------------------------------------------------------------------

export interface PaginationState extends Pagination {
  decorations: DecorationSet;
  /** Page setup geometry the result was computed for. */
  layout: Layout | null;
}

export const paginationKey = new PluginKey<PaginationState>('pagination');

const EMPTY: PaginationState = { spacers: [], pageCount: 1, blockPages: [], decorations: DecorationSet.empty, layout: null };

function sameSpacers(a: Spacer[], b: Spacer[]): boolean {
  return a.length === b.length && a.every((s, i) => s.pos === b[i].pos && Math.abs(s.height - b[i].height) < EPS);
}

function spacerWidget(view: EditorView, s: Spacer): HTMLElement {
  const inline = view.state.doc.resolve(s.pos).parent.isTextblock;
  const el = document.createElement(inline ? 'span' : 'div');
  el.className = SPACER_CLASS;
  el.style.height = `${s.height}px`;
  el.contentEditable = 'false';
  return el;
}

function buildDecorations(view: EditorView, spacers: Spacer[]): DecorationSet {
  const doc = view.state.doc;
  return DecorationSet.create(
    doc,
    spacers.map((s) => Decoration.widget(s.pos, (v) => spacerWidget(v, s), { side: -1, key: `${s.pos}:${Math.round(s.height)}`, ignoreSelection: true })),
  );
}

/** The current pagination result (from the plugin state). */
export function paginationOf(state: EditorState): PaginationState {
  return paginationKey.getState(state) ?? EMPTY;
}

export function paginationPlugin(): Plugin<PaginationState> {
  return new Plugin<PaginationState>({
    key: paginationKey,
    state: {
      init: () => EMPTY,
      apply(tr, prev) {
        const next = tr.getMeta(paginationKey) as PaginationState | undefined;
        if (next) return next;
        if (!tr.docChanged) return prev;
        // Keep the spacers roughly in place until the next measurement.
        return { ...prev, decorations: prev.decorations.map(tr.mapping, tr.doc) };
      },
    },
    props: {
      decorations: (state) => paginationOf(state).decorations,
    },
    view(view) {
      let frame = 0;
      let disposed = false;
      const schedule = () => {
        if (frame || disposed) return;
        const run = () => {
          frame = 0;
          measure();
        };
        // Animation frames never fire while the tab is hidden; a timer still does (and layout is still valid).
        frame = document.visibilityState === 'visible' ? requestAnimationFrame(run) : window.setTimeout(run, 16);
      };
      const measure = () => {
        if (disposed || !view.dom.isConnected) return;
        const setup = pageSetupOf(view.state.doc);
        const prev = paginationOf(view.state);
        if (setup.mode !== 'pages') {
          if (prev.spacers.length || prev.layout) view.dispatch(view.state.tr.setMeta(paginationKey, EMPTY));
          return;
        }
        const m = pageMetrics(setup);
        const layout: Layout = { contentH: m.contentH, stride: m.stride, marginTop: m.mt };
        const units = measureUnits(view);
        const result = computePagination(units, layout);
        const same = prev.layout && sameSpacers(prev.spacers, result.spacers) && prev.pageCount === result.pageCount && prev.blockPages.join() === result.blockPages.join();
        if (same) return;
        view.dispatch(view.state.tr.setMeta(paginationKey, { ...result, layout, decorations: buildDecorations(view, result.spacers) }));
      };
      const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
      observer?.observe(view.dom);
      const onLoad = (e: Event) => {
        if ((e.target as HTMLElement).tagName === 'IMG') schedule();
      };
      view.dom.addEventListener('load', onLoad, true);
      document.addEventListener('visibilitychange', schedule);
      document.fonts?.ready.then(schedule);
      schedule();
      return {
        update: (v, prevState) => {
          if (v.state.doc !== prevState.doc || pageSetupOf(v.state.doc) !== pageSetupOf(prevState.doc)) schedule();
        },
        destroy: () => {
          disposed = true;
          if (frame) {
            cancelAnimationFrame(frame);
            clearTimeout(frame);
          }
          observer?.disconnect();
          document.removeEventListener('visibilitychange', schedule);
          view.dom.removeEventListener('load', onLoad, true);
        },
      };
    },
  });
}
