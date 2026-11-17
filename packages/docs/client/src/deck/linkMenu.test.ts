import { afterEach, describe, expect, it, vi } from 'vitest';
import { caretAt, linkLabel, normalizeLinkUrl } from './SlideView.tsx';

describe('slide link menu helpers', () => {
  it('normalizes typed URLs', () => {
    expect(normalizeLinkUrl(' example.com ')).toBe('https://example.com');
    expect(normalizeLinkUrl('http://a.b/c')).toBe('http://a.b/c');
    expect(normalizeLinkUrl('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(normalizeLinkUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeLinkUrl('  ')).toBeNull();
  });
  it('writes level 0 and non-bullets out, so an edit does not inherit the indent of the line before', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { createElement } = await import('react');
    const { Paragraphs } = await import('./SlideView.tsx');
    const html = renderToStaticMarkup(createElement(Paragraphs, { paragraphs: [{ text: 'a', bullet: true, level: 1 }, { text: 'b', bullet: true }, { text: 'c' }] }));
    expect(html).toContain('data-bullet="1" data-level="1" data-p="0"');
    expect(html).toContain('data-bullet="1" data-level="0" data-p="1"');
    expect(html).toContain('data-bullet="0" data-level="0" data-p="2"');
  });
  it('renders links as sl-link anchors that open in a new tab', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { createElement } = await import('react');
    const { Paragraphs } = await import('./SlideView.tsx');
    const html = renderToStaticMarkup(createElement(Paragraphs, { paragraphs: [{ text: 'go', runs: [{ text: 'go', link: 'https://example.com/' }] }] }));
    expect(html).toContain('class="sl-link"');
    expect(html).toContain('href="https://example.com/"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
  it('shortens the label', () => {
    expect(linkLabel('https://example.com/x')).toBe('example.com/x');
    expect(linkLabel('mailto:a@b.c')).toBe('a@b.c');
  });
});

describe('caretAt', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('uses caretPositionFromPoint, falling back to caretRangeFromPoint', () => {
    const node = {} as Node;
    const range = { setStart: vi.fn() };
    vi.stubGlobal('document', { createRange: () => range, caretPositionFromPoint: () => ({ offsetNode: node, offset: 3 }) });
    expect(caretAt(1, 2)).toBe(range);
    expect(range.setStart).toHaveBeenCalledWith(node, 3);
    const other = {} as Range;
    vi.stubGlobal('document', { caretRangeFromPoint: () => other });
    expect(caretAt(1, 2)).toBe(other);
    vi.stubGlobal('document', {});
    expect(caretAt(1, 2)).toBeNull();
  });
});
