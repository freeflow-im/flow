import { describe, expect, it } from 'vitest';
import { codeFrom, meetingRefOf, meetingUrl } from './api';

const CODE = 'kqd-wmzt-fra';
const ID = '0196f2a1-0c3e-7b4d-9a51-2f6e8d1c4b7a';
const BASE = import.meta.env.BASE_URL; // '/meet/' in the build

describe('a meeting link', () => {
  it('names the room by its short code, or by its id from before codes; Meet’s home names none', () => {
    expect(meetingRefOf(`${BASE}${CODE}`)).toBe(CODE);
    expect(meetingRefOf(`${BASE}${CODE}/`)).toBe(CODE);
    expect(meetingRefOf(`${BASE}${ID}`)).toBe(ID);
    expect(meetingRefOf(BASE)).toBeNull();
    expect(meetingRefOf(`${BASE}not-a-room`)).toBeNull();
    expect(meetingRefOf(`/chat/${CODE}`)).toBeNull();
  });

  it('is an absolute address on this origin, by the code', () => {
    expect(meetingUrl(CODE)).toBe(`${window.location.origin}${BASE}${CODE}`);
  });
});

describe('joining by a code or link', () => {
  it('finds the code in a pasted code or Meet link', () => {
    expect(codeFrom(CODE)).toBe(CODE);
    expect(codeFrom(' KQD-WMZT-FRA ')).toBe(CODE);
    expect(codeFrom('kqdwmztfra')).toBe(CODE);
    expect(codeFrom(`https://app.freeflow.im/meet/${CODE}`)).toBe(CODE);
    expect(codeFrom(`Join with FreeFlow Meet: https://app.freeflow.im/meet/${CODE}?x=1`)).toBe(CODE);
    expect(codeFrom('https://meet.google.com/abc-defg-hij')).toBeNull();
    expect(codeFrom('hello')).toBeNull();
  });
});
