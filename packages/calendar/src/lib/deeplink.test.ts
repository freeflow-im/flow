import { describe, expect, it } from 'vitest';
import { createAddress, shareAddressOf } from '@flow/suite-bar/intents';
import { parseCalendarLink, parseNewEvent, parseShareLink, withoutCalendarLink, withoutNewEvent, withoutShareLink } from './deeplink';

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

describe('?calendar= from a share\'s notice', () => {
  it('names the calendar to tick; nothing without one', () => {
    expect(parseCalendarLink('?calendar=n.acct-ann.0123456789ab')).toBe('n.acct-ann.0123456789ab');
    expect(parseCalendarLink('?calendar=')).toBeNull();
    expect(parseCalendarLink('?event=x')).toBeNull();
  });

  it('is taken off the address afterwards, leaving the rest', () => {
    expect(withoutCalendarLink('?calendar=n.a.b')).toBe('');
    expect(withoutCalendarLink('?calendar=n.a.b&event=c1%3Au')).toBe('?event=c1%3Au');
  });
});

describe('the suite\'s intents (platform phase 6.4)', () => {
  it('reads what intent.create writes, the start included', () => {
    const search = new URL(createAddress('calendar', { title: 'Plan', attendees: [{ email: 'a@x.org', name: 'Ann' }], start: '2026-11-09T10:00:00Z' }), 'https://x').search;
    expect(parseNewEvent(search)).toEqual({ summary: 'Plan', attendees: [{ email: 'a@x.org', name: 'Ann' }], start: new Date('2026-11-09T10:00:00Z') });
    expect(parseNewEvent('?new=x&start=not-a-date')).toEqual({ summary: 'x', attendees: [] });
    expect(withoutNewEvent(search)).toBe('');
  });

  it('opens the Share dialog on the calendar intent.share names, or an event\'s calendar', () => {
    const search = (kind: string, id: string) => new URL(shareAddressOf({ organizationId: 'o', app: 'calendar', kind, id })!, 'https://x').search;
    expect(parseShareLink(search('calendar', 'n.acct.r1'))).toBe('n.acct.r1');
    expect(parseShareLink(search('event', 'n.acct.r1:uid%40x'))).toBe('n.acct.r1');
    expect(parseShareLink('?share=o%2Fdocs%2Fsheet%2Fs1')).toBeNull();
    expect(withoutShareLink(`${search('calendar', 'c')}&event=e`)).toBe('?event=e');
  });
});
