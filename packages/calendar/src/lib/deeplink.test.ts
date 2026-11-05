import { describe, expect, it } from 'vitest';
import { parseNewEvent, withoutNewEvent } from './deeplink';

describe('?new= from Mail', () => {
  it('reads the title and the guests, named or not, each once; nothing without ?new', () => {
    expect(parseNewEvent('?new=Plan%20for%20Q3&guests=Bob%20Martin%20%3Cbob%40acme.test%3E%2Cchen%40acme.test%2CBOB%40acme.test%2Cnot-an-address')).toEqual({
      summary: 'Plan for Q3', attendees: [{ email: 'bob@acme.test', name: 'Bob Martin' }, { email: 'chen@acme.test' }],
    });
    expect(parseNewEvent('?new=')).toEqual({ summary: '', attendees: [] });
    expect(parseNewEvent('?event=x')).toBeNull();
  });

  it('is taken off the address afterwards, leaving the rest', () => {
    expect(withoutNewEvent('?new=Hi&guests=a%40b.co')).toBe('');
    expect(withoutNewEvent('?new=Hi&event=c1%3Au')).toBe('?event=c1%3Au');
  });
});
