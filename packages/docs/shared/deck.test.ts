import { describe, expect, it } from 'vitest';
import { arcGeometry, arcTightBox, tightArc } from './shapes.ts';
import { buildSlide, deckOutline, fromParagraphs, newDeck, newId, slideContent, slideTitle, toParagraphs, updateSlideContent, validateDeck, withEditedPicture, type Deck, type ImageElement, type TextElement } from './deck.ts';

const titleOf = (slide: ReturnType<typeof buildSlide>) => (slide.elements.find((e) => e.type === 'text' && e.role === 'title') as TextElement).paragraphs[0].text;

describe('deck model', () => {
  it('turns body lines into bullets with indent levels and back', () => {
    const ps = toParagraphs(['Plain', '- Bullet', '  - Nested', '    * Deeper'], false);
    expect(ps).toEqual([{ text: 'Plain' }, { text: 'Bullet', bullet: true }, { text: 'Nested', bullet: true, level: 1 }, { text: 'Deeper', bullet: true, level: 2 }]);
    expect(fromParagraphs(ps)).toEqual(['Plain', '- Bullet', '  - Nested', '    - Deeper']);
    // Body text is bulleted by default; empty lines stay plain.
    expect(toParagraphs(['One', ''], true)).toEqual([{ text: 'One', bullet: true }, { text: '' }]);
    // Markdown links become runs and are written back the same way.
    const linked = toParagraphs(['- See [Fly.io](https://fly.io) or [mail us](mailto:ops@example.com)', 'Plain']);
    expect(linked).toEqual([
      {
        text: 'See Fly.io or mail us',
        runs: [{ text: 'See ' }, { text: 'Fly.io', link: 'https://fly.io' }, { text: ' or ' }, { text: 'mail us', link: 'mailto:ops@example.com' }],
        bullet: true,
      },
      { text: 'Plain' },
    ]);
    expect(fromParagraphs(linked)).toEqual(['- See [Fly.io](https://fly.io) or [mail us](mailto:ops@example.com)', 'Plain']);
  });

  it('validates runs and their links', () => {
    const deckWith = (p: object): Deck => ({ version: 1, theme: 'light', slides: [{ id: 's', elements: [{ id: 't', type: 'text', x: 0, y: 0, w: 100, h: 50, paragraphs: [p as never] }] }] });
    expect(validateDeck(deckWith({ text: 'ab', runs: [{ text: 'a', link: 'https://a.test' }, { text: 'b' }] }))).toBeNull();
    expect(validateDeck(deckWith({ text: 'ab', runs: [{ text: 'a', link: 'javascript:alert(1)' }, { text: 'b' }] }))).toMatch(/invalid link/);
    expect(validateDeck(deckWith({ text: 'ab', runs: [{ text: 'a' }] }))).toMatch(/do not add up/);
  });

  it('builds slides from layouts and reads their content back', () => {
    const slide = buildSlide('two-column', { title: 'Compare', body: ['a', 'b'], body2: ['c'], notes: 'say hi' }, newId);
    expect(slide.layout).toBe('two-column');
    expect(slide.notes).toBe('say hi');
    expect(titleOf(slide)).toBe('Compare');
    expect(slideContent(slide)).toEqual({ title: 'Compare', body: ['- a', '- b'], body2: ['- c'], notes: 'say hi' });

    const image = buildSlide('image', { title: 'Pic', image: 'https://example.com/a.png', caption: 'A picture' }, newId);
    expect(image.elements.map((e) => e.type)).toEqual(['text', 'image', 'text']);
    expect(slideContent(image)).toMatchObject({ title: 'Pic', image: 'https://example.com/a.png', caption: 'A picture' });

    // Missing content gets placeholders; a blank slide has no elements.
    expect(titleOf(buildSlide('title-body', {}, newId))).toBe('Slide title');
    expect(buildSlide('blank', {}, newId).elements).toEqual([]);
  });

  it('updates a slide by role without moving elements, and rebuilds when the layout changes', () => {
    const slide = buildSlide('title-body', { title: 'Old', body: ['x'] }, newId);
    const moved = { ...slide, elements: slide.elements.map((e) => (e.type === 'text' && e.role === 'title' ? { ...e, x: 123 } : e)) };
    const updated = updateSlideContent(moved, { title: 'New', notes: 'n' }, newId);
    expect(titleOf(updated)).toBe('New');
    expect(updated.elements.find((e) => e.type === 'text' && e.role === 'title')!.x).toBe(123);
    expect(updated.elements.map((e) => e.id)).toEqual(moved.elements.map((e) => e.id));
    expect(updated.notes).toBe('n');

    const rebuilt = updateSlideContent(updated, { layout: 'two-column', body2: ['right'] }, newId);
    expect(rebuilt.layout).toBe('two-column');
    expect(slideContent(rebuilt)).toMatchObject({ title: 'New', body: ['- x'], body2: ['- right'] });

    // A role the slide has no element for also rebuilds from the layout (a section header gains its subtitle).
    const withSubtitle = updateSlideContent(buildSlide('section', { title: 'T' }, newId), { subtitle: 's' }, newId);
    expect(slideContent(withSubtitle)).toMatchObject({ title: 'T', subtitle: 's' });
  });

  it('validates decks', () => {
    const deck = newDeck();
    expect(validateDeck(deck)).toBeNull();
    expect(validateDeck({ ...deck, slides: [] })).toMatch(/at least one slide/);
    expect(validateDeck({ ...deck, theme: 'neon' })).toMatch(/theme/);
    const dup: Deck = { ...deck, slides: [deck.slides[0], deck.slides[0]] };
    expect(validateDeck(dup)).toMatch(/duplicate slide id/);
    const badEl: Deck = { ...deck, slides: [{ ...deck.slides[0], elements: [{ id: 'e', type: 'image', x: 0, y: 0, w: 10, h: 10, src: 'javascript:alert(1)' }] }] };
    expect(validateDeck(badEl)).toMatch(/Image must be/);
    const video = (src: string): Deck => ({ ...deck, slides: [{ ...deck.slides[0], elements: [{ id: 'v', type: 'video', x: 0, y: 0, w: 320, h: 180, src }] }] });
    expect(validateDeck(video('https://www.youtube.com/watch?v=dQw4w9WgXcQ'))).toBeNull();
    expect(validateDeck(video('/api/files/wvx2szrxf804'))).toBeNull();
    expect(validateDeck(video('https://example.com/clip.mp4'))).toMatch(/Video must be/);
    expect(deckOutline(video('/api/files/wvx2szrxf804')).slides[0].elements[0]).toMatchObject({ type: 'video', src: '/api/files/wvx2szrxf804' });
    const badBox: Deck = { ...deck, slides: [{ ...deck.slides[0], elements: [{ id: 'e', type: 'shape', shape: 'rect', x: Number.NaN, y: 0, w: 10, h: 10 }] }] };
    expect(validateDeck(badBox)).toMatch(/invalid x/);
  });

  it('outlines a deck compactly for the assistant', () => {
    const deck: Deck = { version: 1, theme: 'dark', slides: [buildSlide('title-body', { title: 'Agenda', body: ['One', 'Two'], notes: 'n' }, newId)] };
    const out = deckOutline(deck, 0);
    expect(out).toMatchObject({ theme: 'dark', slide_count: 1, current_slide: 1 });
    expect(out.slides[0]).toMatchObject({ slide: 1, layout: 'title-body', notes: 'n' });
    expect(out.slides[0].elements.map((e) => (e as { text?: string }).text)).toEqual(['Agenda', '- One\n- Two']);
  });
});

describe('the built-in guide', () => {
  it('copies into a valid presentation, found again by its title', async () => {
    const { findGettingStarted, gettingStartedDeck, GETTING_STARTED_SLIDES, GETTING_STARTED_TITLE } = await import('./gettingStarted.ts');
    const deck = gettingStartedDeck();
    expect(validateDeck(deck)).toBeNull();
    expect(deck.slides).toHaveLength(GETTING_STARTED_SLIDES.length);
    expect(slideTitle(deck.slides[0])).toBe('Getting started with MCP Docs');
    // Each copy is its own file, with its own ids.
    expect(gettingStartedDeck().slides[0].id).not.toBe(deck.slides[0].id);
    expect(findGettingStarted([{ title: 'Plan' }, { title: GETTING_STARTED_TITLE, id: 'd1' }])).toEqual({ title: GETTING_STARTED_TITLE, id: 'd1' });
    expect(findGettingStarted([{ title: 'Plan' }])).toBeUndefined();
  });
});

describe('a picture element after its picture was edited', () => {
  const el: ImageElement = { id: 'p', type: 'image', src: '/api/images/old', x: 100, y: 100, w: 400, h: 300, crop: { l: 0.1, t: 0, r: 0.1, b: 0 }, clip: 'circle(50%)', opacity: 0.8 };
  const size = (width: number, height: number) => ({ width, height });

  it('changes only the address when the picture kept its shape', () => {
    expect(withEditedPicture(el, '/api/images/new', size(2000, 1500), size(2000, 1500))).toEqual({ ...el, src: '/api/images/new' });
    // A resize, or a size that could not be told, is not a change of shape.
    expect(withEditedPicture(el, '/api/images/new', size(2000, 1500), size(1000, 750))).toEqual({ ...el, src: '/api/images/new' });
    expect(withEditedPicture(el, '/api/images/new', null, size(10, 900))).toEqual({ ...el, src: '/api/images/new' });
  });

  it('takes the new shape at the same width and centre, without its old crop, when the picture was cropped or turned', () => {
    const wide = withEditedPicture(el, '/api/images/new', size(2000, 1500), size(2000, 500));
    expect(wide).toEqual({ id: 'p', type: 'image', src: '/api/images/new', x: 100, y: 200, w: 400, h: 100, clip: 'circle(50%)', opacity: 0.8 });
    expect('crop' in wide).toBe(false);
    // Turned on its side it would be taller than the slide: it is made to fit, still centred.
    expect(withEditedPicture({ ...el, w: 800, h: 450 }, '/api/images/new', size(1600, 900), size(900, 1600))).toMatchObject({ w: 304, h: 540, x: 348, y: 55 });
  });
});

describe('tight arcs', () => {
  it('converts a whole-ellipse arc to its tight box and back to the same ellipse', () => {
    const old = { x: 180, y: 187, w: 223, h: 223, startAngle: 310, endAngle: 345, strokeWidth: 3 };
    const t = tightArc(old);
    expect(t.tight).toBe(true);
    expect(t.w).toBeLessThan(100);
    const g = arcGeometry(t);
    expect(g.rx).toBeCloseTo(111.5);
    expect(g.cx).toBeCloseTo(291.5);
    expect(arcTightBox(g, 310, 345, 3).x).toBeCloseTo(t.x);
    // A short arc across an axis is nearly flat one way; its circle still comes back.
    for (const [a, b] of [[355, 5], [85, 95], [170, 190]]) {
      const short = arcGeometry(tightArc({ x: 100, y: 100, w: 200, h: 200, startAngle: a, endAngle: b, strokeWidth: 2 }));
      expect([short.cx, short.cy, short.rx, short.ry].map((n) => Math.round(n * 10) / 10)).toEqual([200, 200, 100, 100]);
    }
  });
});
