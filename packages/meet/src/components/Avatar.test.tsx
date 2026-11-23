// A participant's picture on a tile and in People (Room.tsx Avatar): the picture RealtimeKit has for them, else their
// initials, also when the picture fails to load.
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Avatar } from './Room';

const person = (picture?: string) => ({ id: 'p1', name: 'Scott Persinger', customParticipantId: 'u1', ...(picture !== undefined ? { picture } : {}) });

describe('Avatar', () => {
  afterEach(cleanup);

  it('shows the picture when there is one', () => {
    const { container } = render(<Avatar person={person('https://app.test/v1/public/avatars/k.png?s=x')} className="size-20" />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://app.test/v1/public/avatars/k.png?s=x');
    expect(container.textContent).toBe('');
  });

  it('shows initials with no picture, a relative one, or one that fails to load', () => {
    expect(render(<Avatar person={person()} className="size-20" />).container.textContent).toBe('SP');
    cleanup();
    expect(render(<Avatar person={person('')} className="size-20" />).container.textContent).toBe('SP');
    cleanup();
    expect(render(<Avatar person={person('/v1/avatars/k.png')} className="size-20" />).container.querySelector('img')).toBeNull();
    cleanup();
    const { container } = render(<Avatar person={person('https://app.test/broken.png')} className="size-20" />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('SP');
  });
});
