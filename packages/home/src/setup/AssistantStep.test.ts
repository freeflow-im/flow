// The Chief of Staff's script (docs/specs/onboarding.md §1): what it says and asks, as the person picks a name and a picture.
import { describe, expect, it } from 'vitest';
import { scriptFor } from './AssistantStep';

const keys = (p: Parameters<typeof scriptFor>[0]) => scriptFor(p).map((x) => x.key);

describe('the Chief of Staff’s script', () => {
  it('greets the person by name and asks for a name first', () => {
    const parts = scriptFor({ firstName: 'Scott', name: null, picture: false });
    expect(parts[0]).toMatchObject({ text: expect.stringContaining('Hi Scott') });
    expect(keys({ firstName: 'Scott', name: null, picture: false }).slice(-1)).toEqual(['names']);
  });

  it('asks for a picture once named, then offers to go on', () => {
    expect(keys({ firstName: 'Scott', name: 'Ada', picture: false }).slice(-3)).toEqual(['reply', 'look', 'pictures']);
    expect(keys({ firstName: 'Scott', name: 'Ada', picture: true }).slice(-2)).toEqual(['next', 'continue']);
  });
});
