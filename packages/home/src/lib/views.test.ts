import { describe, expect, it } from 'vitest';
import { channelOf, homeAddress, isFrontPage, openedIn, viewOf } from './views';

const O = 'https://app.freeflow.im';

describe('views', () => {
  it('opens each app’s address in its frame, Home’s in its cards, and nothing else', () => {
    expect(viewOf('/mail/', O)).toBe('mail');
    expect(viewOf('/chat/?open=channel%3Aabc', O)).toBe('chat');
    expect(viewOf('/docs/doc/x1', O)).toBe('docs');
    expect(viewOf('/admin/agents', O)).toBe('admin');
    expect(viewOf('/home/', O)).toBe('home');
    expect(viewOf('https://example.com/mail/', O)).toBeNull();
    expect(viewOf('/privacy', O)).toBeNull();
  });

  it('tells an app’s front page from an address inside it', () => {
    expect(isFrontPage('/mail/', O)).toBe(true);
    expect(isFrontPage('/chat', O)).toBe(true);
    expect(isFrontPage('/mail/?account=a&folder=INBOX&thread=t', O)).toBe(false);
    expect(isFrontPage('/docs/doc/x1', O)).toBe(false);
  });

  it('names what it shows in its own address, and reads it back', () => {
    expect(homeAddress(null)).toBe('/home/');
    const href = '/chat/?open=channel:abc';
    expect(openedIn(new URL(homeAddress(href), O).search)).toBe(href);
    expect(openedIn('?open=//evil.example/x')).toBeNull();
    expect(openedIn('')).toBeNull();
  });

  it('finds the channel a Chat address opens', () => {
    expect(channelOf('/chat/?open=channel%3Aabc', O)).toBe('abc');
    expect(channelOf('/chat/?open=message%3Aabc', O)).toBeNull();
  });
});
