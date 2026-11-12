import { describe, expect, it } from 'vitest';
import { routeOf } from './api';
import { addMonths, dateIn, googleLink, icsOf, monthCells } from './time';

describe('the guest page', () => {
  it('reads a page link and a booking link from the address, and nothing else', () => {
    expect(routeOf('/calendar/book/k7mq-x3vd-p9tr')).toEqual({ kind: 'page', base: '/v1/book/k7mq-x3vd-p9tr' });
    expect(routeOf('/calendar/book/m/AbCdEfGhIjKlMnOpQrSt_-')).toEqual({ kind: 'manage', base: '/v1/book/m/AbCdEfGhIjKlMnOpQrSt_-' });
    expect(routeOf('/calendar/book/')).toBeNull();
    expect(routeOf('/calendar/book/a/b/c')).toBeNull();
    expect(routeOf('/calendar/book/..%2Fv1')).toBeNull();
  });

  it('lays a month out Sunday first and steps months across the year', () => {
    const cells = monthCells('2026-11');
    expect(cells[0]).toBe('2026-11-01'); // 1 November 2026 is a Sunday
    expect(cells).toHaveLength(30);
    expect(monthCells('2026-12').slice(0, 3)).toEqual([null, null, '2026-12-01']);
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2027-01', -1)).toBe('2026-12');
    expect(dateIn(Date.parse('2026-11-17T07:30:00Z'), 'America/Los_Angeles')).toBe('2026-11-16');
  });

  it('makes an .ics and a Google link for the meeting', () => {
    const b = { id: 'b1', title: 'Chat, quick', ownerName: 'Ann', start: '2026-11-16T17:00:00.000Z', end: '2026-11-16T17:30:00.000Z', location: null };
    expect(icsOf(b)).toContain('DTSTART:20261116T170000Z\r\nDTEND:20261116T173000Z\r\nSUMMARY:Chat\\, quick with Ann');
    expect(googleLink(b)).toContain('dates=20261116T170000Z%2F20261116T173000Z');
  });
});
