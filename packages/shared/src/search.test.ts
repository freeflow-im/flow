import { describe, expect, it } from 'vitest';
import { parseSearch, parseSearchDate, toFtsMatch } from './search';

const now = new Date('2026-11-13T12:00:00Z');

describe('parseSearch', () => {
  it('words, phrases, prefixes and negation', () => {
    const q = parseSearch('budget "q4 plan" plan* -draft', now);
    expect(q.groups).toEqual([[{ text: 'budget' }], [{ text: 'q4 plan', phrase: true }], [{ text: 'plan', prefix: true }]]);
    expect(q.not).toEqual([{ text: 'draft' }]);
  });

  it('OR joins the words on each side into one group', () => {
    expect(parseSearch('pricing OR cost launch', now).groups).toEqual([[{ text: 'pricing' }, { text: 'cost' }], [{ text: 'launch' }]]);
    // A leading OR, or a lower-case one, is a plain word or nothing.
    expect(parseSearch('OR pricing', now).groups).toEqual([[{ text: 'pricing' }]]);
    expect(parseSearch('this or that', now).groups).toHaveLength(3);
  });

  it('filters', () => {
    const q = parseSearch('from:ann,me type:doc,slides after:2026-10-01 before:7d in:"Q4 reports" has:attachment is:unread notes', now);
    expect(q.filters).toEqual({
      from: ['ann', 'me'],
      types: ['doc', 'deck'],
      after: '2026-10-01T00:00:00.000Z',
      before: '2026-11-06T12:00:00.000Z',
      in: 'Q4 reports',
      has: ['attachment'],
      is: ['unread'],
    });
    expect(q.groups).toEqual([[{ text: 'notes' }]]);
  });

  it('unknown keys are words; bad filter values are dropped', () => {
    const q = parseSearch('http://x.com type:nonsense after:soon', now);
    expect(q.groups).toEqual([[{ text: 'http://x.com' }]]);
    expect(q.filters).toEqual({});
  });

  it('drops terms with nothing to index', () => {
    expect(parseSearch('*** "" -', now).groups).toEqual([]);
  });
});

describe('parseSearchDate', () => {
  it('relative and absolute', () => {
    expect(parseSearchDate('3m', now)).toBe('2026-08-13T12:00:00.000Z');
    expect(parseSearchDate('1y', now)).toBe('2025-11-13T12:00:00.000Z');
    expect(parseSearchDate('2026-02-30', now)).toBeUndefined();
    expect(parseSearchDate('yesterday', now)).toBeUndefined();
  });
});

describe('toFtsMatch', () => {
  it('quotes every term, so FTS5 syntax in the box is literal', () => {
    expect(toFtsMatch(parseSearch('NEAR(a b) title:x say"hi'))).toBe('"NEAR(a" AND "b)" AND "title:x" AND "say" AND "hi"');
    expect(toFtsMatch(parseSearch('pricing OR cost "q4 plan" plan* -draft -old'))).toBe('(("pricing" OR "cost") AND "q4 plan" AND "plan"*) NOT ("draft" OR "old")');
  });

  it('prefixLast makes the last word a prefix, never a phrase', () => {
    expect(toFtsMatch(parseSearch('quarterly bud'), { prefixLast: true })).toBe('"quarterly" AND "bud"*');
    expect(toFtsMatch(parseSearch('"q4 plan"'), { prefixLast: true })).toBe('"q4 plan"');
  });

  it('null without words', () => {
    expect(toFtsMatch(parseSearch('type:doc -draft'))).toBeNull();
  });
});
