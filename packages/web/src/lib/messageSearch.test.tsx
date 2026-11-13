import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { setMessageSearch, setMessageSearchSort, useMessageSearch, useMessageSearchSort } from './messageSearch';

// The search's text and order outlive the Search view, so Back from a result shows the same list in the same order.
function Probe() {
  return <>{`${useMessageSearch()}|${useMessageSearchSort()}`}</>;
}

describe('messageSearch', () => {
  it('keeps the text and the order for the next view that reads them', () => {
    expect(renderToStaticMarkup(<Probe />)).toBe('|relevance');
    setMessageSearch('renewal');
    setMessageSearchSort('recent');
    // A view mounted later (coming back with Back) reads both.
    expect(renderToStaticMarkup(<Probe />)).toBe('renewal|recent');
  });
});
