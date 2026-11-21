// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { DOT, DOTTED_ICON, iconHref, setChatFavicon, setFaviconDot, withDot } from './favicon';

describe('Chat favicon', () => {
  it('maps the suite icons to Chat’s and back', () => {
    expect(iconHref('/favicon.svg', true)).toBe('/chat-favicon.svg');
    expect(iconHref('/favicon-32.png', true)).toBe('/chat-favicon-32.png');
    expect(iconHref('/apple-touch-icon.png', true)).toBe('/chat-apple-touch-icon.png');
    expect(iconHref('/chat-favicon.ico', true)).toBe('/chat-favicon.ico');
    expect(iconHref('/chat-favicon.ico', false)).toBe('/favicon.ico');
    expect(iconHref('/favicon.ico', false)).toBe('/favicon.ico');
  });

  it('swaps every icon link in the page', () => {
    document.head.innerHTML = '<link rel="icon" href="/favicon.svg"><link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="author" href="/favicon.txt">';
    setChatFavicon(true);
    const hrefs = () => [...document.head.querySelectorAll('link')].map((l) => l.getAttribute('href'));
    expect(hrefs()).toEqual(['/chat-favicon.svg', '/chat-favicon.ico', '/chat-apple-touch-icon.png', '/favicon.txt']);
    setChatFavicon(false);
    expect(hrefs()).toEqual(['/favicon.svg', '/favicon.ico', '/apple-touch-icon.png', '/favicon.txt']);
  });
});

describe('Favicon unread dot', () => {
  const ICONS = '<link rel="icon" type="image/svg+xml" href="/chat-favicon.svg"><link rel="icon" href="/chat-favicon.ico" sizes="48x48"><link rel="icon" type="image/png" href="/chat-favicon-32.png"><link rel="apple-touch-icon" href="/chat-apple-touch-icon.png">';
  const state = () => [...document.head.querySelectorAll('link')].map((l) => [l.getAttribute('href'), l.getAttribute('type')]);

  it('draws the dot over the icon, before the closing tag', () => {
    expect(withDot('<svg><rect/></svg>\n')).toBe(`<svg><rect/>${DOT}</svg>`);
    expect(decodeURIComponent(DOTTED_ICON)).toContain('<circle cx="24.5"');
  });

  it('points every tab icon at the dotted SVG, then restores each one exactly', () => {
    document.head.innerHTML = ICONS;
    const before = state();
    setFaviconDot(true);
    expect(state()).toEqual([
      [DOTTED_ICON, 'image/svg+xml'], [DOTTED_ICON, 'image/svg+xml'], [DOTTED_ICON, 'image/svg+xml'],
      ['/chat-apple-touch-icon.png', null], // the home-screen icon is not a live signal
    ]);
    setFaviconDot(true); // idempotent: the plain address is not overwritten by the data URL
    setFaviconDot(false);
    expect(state()).toEqual(before);
  });

  it('leaves the suite mark alone, and survives the Chat/suite swap', () => {
    document.head.innerHTML = '<link rel="icon" href="/favicon.svg">';
    setFaviconDot(true);
    expect(state()).toEqual([['/favicon.svg', null]]);
    document.head.innerHTML = ICONS;
    setFaviconDot(true);
    setChatFavicon(false); // signed out while dotted: the remembered address follows
    setFaviconDot(false);
    expect(state().map(([h]) => h)).toEqual(['/favicon.svg', '/favicon.ico', '/favicon-32.png', '/apple-touch-icon.png']);
  });
});
