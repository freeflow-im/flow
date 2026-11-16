import { describe, expect, it } from 'vitest';
import { sideFor } from './popover';

describe('sideFor (where an event card opens)', () => {
  it('opens beside the event where there is room, right first', () => {
    expect(sideFor({ left: 300, right: 400 }, 1400, 'right')).toBe('right');
    expect(sideFor({ left: 900, right: 1000 }, 1400, 'right')).toBe('left');
  });
  it('opens below an event with no room on either side (an all-day event across the week)', () => {
    expect(sideFor({ left: 280, right: 1400 }, 1400, 'right')).toBe('bottom');
  });
  it('keeps below when asked (the side panel)', () => {
    expect(sideFor({ left: 0, right: 10 }, 1400, 'bottom')).toBe('bottom');
  });
});
