import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SearchResults, Snippet, type MessageHit } from './SearchView';

// Message search's list (docs/specs/search.md): one row per message, where it is, the matched words marked; and the
// states before, during and after a search that finds nothing.
const hit = (over: Partial<MessageHit> = {}): MessageHit => ({
  id: 'm1', snippet: 'we raise \u0002prices\u0003\nin March', author: 'u-ann', authorName: 'Ann', at: '2026-11-13T10:00:00.000Z',
  channelId: 'c1', channelName: 'launch', channelKind: 'standard', threadRootId: null, ...over,
});
const render = (props: Partial<Parameters<typeof SearchResults>[0]> = {}) =>
  renderToStaticMarkup(
    <SearchResults hits={[]} loading={false} error={null} query="prices" where={(h) => (h.channelKind === 'standard' ? `#${h.channelName}` : 'Bob')} avatarOf={() => null} onOpen={() => {}} {...props} />,
  );

describe('Snippet', () => {
  it('marks the matched words and reads line breaks as spaces; the text is never HTML', () => {
    expect(renderToStaticMarkup(<Snippet text={'a <b>\n\u0002x\u0003 y'} />)).toBe('a &lt;b&gt; <mark class="search-mark">x</mark> y');
  });
});

describe('SearchResults', () => {
  it('lists each message with its author, where it is, its thread and its marked words', () => {
    const html = render({ hits: [hit(), hit({ id: 'm2', channelKind: 'dm', channelName: null, threadRootId: 'm0' })] });
    expect(html).toContain('data-testid="search-hit-m1"');
    expect(html).toContain('#launch');
    expect(html).toContain('Bob · in a thread');
    expect(html).toContain('<mark class="search-mark">prices</mark>');
  });

  it('says what is happening when there is nothing to list', () => {
    expect(render({ query: ' ' })).toContain('Type in the search bar');
    expect(render({ loading: true })).toContain('Searching…');
    expect(render({ error: 'say what to look for' })).toContain('say what to look for');
    expect(render()).toContain('No messages match “prices”.');
  });
});
