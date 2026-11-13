import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTestAddress, sendMail } from './mail';

afterEach(() => vi.unstubAllGlobals());

describe('mail to test domains', () => {
  it('knows the reserved test domains', () => {
    for (const a of ['dev@flow.test', 'a@b.example', 'x@nowhere.invalid', 'me@localhost', 'me@app.localhost', 'q@example.com', 'q@mail.example.org']) expect(isTestAddress(a)).toBe(true);
    for (const a of ['scott@gmail.com', 'a@test.com', 'a@examples.com', 'a@freeflow.im']) expect(isTestAddress(a)).toBe(false);
  });

  it('logs mail to a test address instead of sending it, even with a token', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await sendMail({ EMAIL_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'a', EMAIL_FROM: 'noreply@x.im' }, { to: 'dev@flow.test', subject: 'Hi', text: 'link: http://x/?signup=abc' });
    expect(fetch).not.toHaveBeenCalled();
    expect(log.mock.calls[0]![0]).toContain('to=dev@flow.test');
    expect(log.mock.calls[0]![0]).toContain('signup=abc');
    log.mockRestore();
  });
});
