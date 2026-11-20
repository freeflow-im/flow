// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { iconHref, setChatFavicon } from './favicon';

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
