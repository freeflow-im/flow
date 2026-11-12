import { describe, expect, it } from 'vitest';
import { cleanPrompts, MAX_PROMPTS, MAX_PROMPT_LENGTH } from './assistant';

describe('cleanPrompts', () => {
  it('keeps known pages, trims, drops empty and repeated prompts', () => {
    expect(cleanPrompts({ home: ['  Hi ', '', 'Hi', 3, 'Other'], nope: ['x'], chat: 'not a list' })).toEqual({ home: ['Hi', 'Other'] });
  });

  it('keeps an emptied page (no prompts there) and holds the limits', () => {
    const long = 'x'.repeat(MAX_PROMPT_LENGTH + 50);
    const many = Array.from({ length: MAX_PROMPTS + 3 }, (_, i) => `p${i}`);
    const out = cleanPrompts({ admin: [], calendar: [long], home: many });
    expect(out.admin).toEqual([]);
    expect(out.calendar![0]).toHaveLength(MAX_PROMPT_LENGTH);
    expect(out.home).toHaveLength(MAX_PROMPTS);
  });

  it('reads anything else as nothing saved', () => {
    expect(cleanPrompts(null)).toEqual({});
    expect(cleanPrompts('x')).toEqual({});
  });
});
