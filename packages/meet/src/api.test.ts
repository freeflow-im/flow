import { describe, expect, it } from 'vitest';
import { meetingIdOf, meetingUrl } from './api';

const ID = '0196f2a1-0c3e-7b4d-9a51-2f6e8d1c4b7a';
const BASE = import.meta.env.BASE_URL; // '/meet/' in the build

describe('a meeting link', () => {
  it('names the room after Meet’s base path, and Meet’s home names none', () => {
    expect(meetingIdOf(`${BASE}${ID}`)).toBe(ID);
    expect(meetingIdOf(`${BASE}${ID}/`)).toBe(ID);
    expect(meetingIdOf(BASE)).toBeNull();
    expect(meetingIdOf(`${BASE}not-a-room`)).toBeNull();
    expect(meetingIdOf(`/chat/${ID}`)).toBeNull();
  });

  it('is an absolute address on this origin', () => {
    expect(meetingUrl(ID)).toBe(`${window.location.origin}${BASE}${ID}`);
  });
});
