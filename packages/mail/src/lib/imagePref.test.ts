import { afterEach, describe, expect, it } from 'vitest';
import { setImagePref } from './imagePref';

describe('the remote images choice', () => {
  afterEach(() => localStorage.clear());

  it('is remembered once chosen, and can be turned off again', async () => {
    setImagePref('always');
    expect(localStorage.getItem('mail.remoteImages')).toBe('always');
    setImagePref('ask');
    expect(localStorage.getItem('mail.remoteImages')).toBeNull();
  });
});
