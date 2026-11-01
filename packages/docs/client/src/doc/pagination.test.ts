import { describe, expect, it } from 'vitest';
import { computePagination, type Layout, type Unit } from './pagination.ts';

// A page whose content box is 100px tall, pages 130px apart, content starting 10px down the page.
const layout: Layout = { contentH: 100, stride: 130, marginTop: 10 };

/** Blocks of `lines` lines, 20px each, laid out one after another from the top margin. */
function blocks(spec: { lines: number; kind?: Unit['kind']; heading?: boolean }[]): Unit[] {
  const units: Unit[] = [];
  let y = layout.marginTop;
  let pos = 0;
  spec.forEach((b, block) => {
    pos += 1;
    const n = b.kind === 'line' || !b.kind ? b.lines : 1;
    for (let k = 0; k < n; k++) {
      const h = b.kind && b.kind !== 'line' ? 20 : 20;
      units.push({ pos: pos + k, top: y, bottom: y + h, kind: b.kind ?? 'line', block, blockStart: k === 0, heading: !!b.heading });
      y += h;
    }
    pos += n;
  });
  return units;
}

describe('pagination', () => {
  it('leaves a short document on one page', () => {
    const r = computePagination(blocks([{ lines: 2 }, { lines: 3 }]), layout);
    expect(r).toEqual({ spacers: [], pageCount: 1, blockPages: [0, 0] });
  });

  it('pushes the line that crosses the page bottom to the top of the next page', () => {
    // 7 lines of 20px: lines 1-5 fit (10..110), line 6 (110..130) crosses the content bottom at 110.
    const units = blocks([{ lines: 7 }]);
    const r = computePagination(units, layout);
    expect(r.pageCount).toBe(2);
    expect(r.spacers).toEqual([{ pos: units[5].pos, height: 140 - 110 }]);
    expect(r.blockPages).toEqual([0]);
    // Later lines keep flowing from the new page's content top.
    const long = blocks([{ lines: 12 }]);
    expect(computePagination(long, layout).pageCount).toBe(3);
  });

  it('moves whole blocks that cannot split, and breaks before a block when its first line does not fit', () => {
    const units = blocks([{ lines: 5 }, { lines: 1, kind: 'block' }, { lines: 1 }]);
    const r = computePagination(units, layout);
    expect(r.spacers).toEqual([{ pos: units[5].pos, height: 30 }]);
    expect(r.blockPages).toEqual([0, 1, 1]);
  });

  it('forces a new page after a page break and does not break twice', () => {
    const units = blocks([{ lines: 1 }, { lines: 1, kind: 'page_break' }, { lines: 1 }, { lines: 1 }]);
    const r = computePagination(units, layout);
    expect(r.pageCount).toBe(2);
    expect(r.spacers).toEqual([{ pos: units[2].pos, height: 140 - 50 }]);
    expect(r.blockPages).toEqual([0, 0, 1, 1]);
  });

  it('keeps a heading with the block after it', () => {
    // Four lines, then a one-line heading at 90..110 (fits), then a paragraph whose first line would overflow.
    const units = blocks([{ lines: 4 }, { lines: 1, heading: true }, { lines: 3 }]);
    const r = computePagination(units, layout);
    expect(r.spacers).toEqual([{ pos: units[4].pos, height: 140 - 90 }]);
    expect(r.blockPages).toEqual([0, 1, 1]);
    // But a heading at the top of a page stays, even when the paragraph after it overflows.
    const tall = blocks([{ lines: 1, heading: true }, { lines: 8 }]);
    const r2 = computePagination(tall, layout);
    expect(r2.spacers[0].pos).toBe(tall[5].pos);
  });

  it('lets a unit taller than a page sit at the top and breaks after it', () => {
    const units: Unit[] = [
      { pos: 1, top: 10, bottom: 250, kind: 'block', block: 0, blockStart: true, heading: false },
      { pos: 3, top: 250, bottom: 270, kind: 'line', block: 1, blockStart: true, heading: false },
    ];
    const r = computePagination(units, layout);
    // The next unit lands on the first page whose content box starts below it: page 3 (top 270).
    expect(r.spacers).toEqual([{ pos: 3, height: 270 - 250 }]);
    expect(r.pageCount).toBe(3);
  });
});
