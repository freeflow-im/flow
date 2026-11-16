import { describe, expect, it } from 'vitest';
import { joinLink } from './joinLink';

describe('the Today card’s Join button', () => {
  it('joins the invitation’s call, a FreeFlow Meet line, or a call link in the location', () => {
    expect(joinLink({ conference: { url: 'https://meet.google.com/abc-defg-hij', label: 'Google Meet' } })).toBe('https://meet.google.com/abc-defg-hij');
    expect(joinLink({ description: 'Agenda\n\nJoin with FreeFlow Meet: https://app.freeflow.im/meet/kqd-wmzt-fra' })).toBe('https://app.freeflow.im/meet/kqd-wmzt-fra');
    expect(joinLink({ location: 'https://us06web.zoom.us/j/832?pwd=x' })).toBe('https://us06web.zoom.us/j/832?pwd=x');
    expect(joinLink({ location: 'Room 4', description: 'Lunch' })).toBeNull();
  });
});
