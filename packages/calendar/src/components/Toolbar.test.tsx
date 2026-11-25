import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { offsetOf } from '../lib/ranges';
import { Toolbar } from './Toolbar';

afterEach(cleanup);

describe('offsetOf (the toolbar chip)', () => {
  const today = new Date(2026, 10, 25, 15, 30); // Wed Nov 25 2026
  it('is null on the period holding today, and for month and agenda', () => {
    expect(offsetOf('week', new Date(2026, 10, 22), today)).toBeNull();
    expect(offsetOf('week', new Date(2026, 10, 28), today)).toBeNull();
    expect(offsetOf('day', new Date(2026, 10, 25, 1), today)).toBeNull();
    expect(offsetOf('month', new Date(2027, 0, 1), today)).toBeNull();
    expect(offsetOf('agenda', new Date(2027, 0, 1), today)).toBeNull();
  });
  it('counts weeks by their first day', () => {
    expect(offsetOf('week', new Date(2026, 10, 29), today)).toEqual({ dir: 1, label: 'Next week' });
    expect(offsetOf('week', new Date(2026, 11, 12), today)).toEqual({ dir: 1, label: 'In 2 weeks' });
    expect(offsetOf('week', new Date(2026, 10, 21), today)).toEqual({ dir: -1, label: 'Last week' });
    expect(offsetOf('week', new Date(2026, 10, 4), today)).toEqual({ dir: -1, label: '3 weeks ago' });
    // Monday-start weeks: Sun Nov 29 is still this week.
    expect(offsetOf('week', new Date(2026, 10, 29), today, 1)).toBeNull();
  });
  it('counts days', () => {
    expect(offsetOf('day', new Date(2026, 10, 26), today)).toEqual({ dir: 1, label: 'Tomorrow' });
    expect(offsetOf('day', new Date(2026, 10, 24), today)).toEqual({ dir: -1, label: 'Yesterday' });
    expect(offsetOf('day', new Date(2026, 10, 22), today)).toEqual({ dir: -1, label: '3 days ago' });
    expect(offsetOf('day', new Date(2026, 11, 5), today)).toEqual({ dir: 1, label: 'In 10 days' });
  });
});

describe('Toolbar', () => {
  const props = { title: 'Dec 6 – 12, 2026', view: 'week' as const, narrow: false, busy: false, onToday() {}, onStep() {}, onView() {}, onCalendars() {} };
  it('stays quiet on the current period', () => {
    render(<Toolbar {...props} offset={null} />);
    expect(screen.getByRole('button', { name: 'Today' }).getAttribute('title')).toBe('Today (T)');
    expect(screen.queryByText(/weeks?|ago/)).toBeNull();
  });
  it('shows the chip and a back-to-today button off it', () => {
    render(<Toolbar {...props} offset={{ dir: 1, label: 'In 2 weeks' }} />);
    expect(screen.getByText('In 2 weeks')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Today' }).getAttribute('title')).toBe('Back to today (T)');
  });
});
