import { describe, expect, it } from 'vitest';
import type { OutgoingMessage } from '../api';
import type { Outgoing } from './compose';
import type { Notice } from './notice';
import { outgoingMessage, sendInBackground } from './outgoing';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const out = (extra: Partial<Outgoing['message']> = {}, files: Outgoing['files'] = []): Outgoing => ({
  accountId: 'acc',
  message: { to: [{ name: 'Bob', address: 'bob@x.test' }], subject: 'Re: Plans', html: `<p>Yes</p><img src="data:image/png;base64,${PNG}">`, text: 'Yes', inReplyTo: '<m1@x>', ...extra },
  files,
  request: { mode: 'reply', draft: { to: [{ name: 'Bob', address: 'bob@x.test' }], cc: [], bcc: [], subject: 'Re: Plans', html: '<p>Yes</p>' }, restored: true },
});

describe('outgoingMessage', () => {
  it('turns pasted pictures into inline parts and files into base64 attachments, files first', async () => {
    const m = await outgoingMessage(out({}, [{ filename: 'a.txt', contentType: 'text/plain', file: new Blob(['hi'], { type: 'text/plain' }) }]), async () => null);
    expect(m.html).toMatch(/^<p>Yes<\/p><img src="cid:img-1-[^"]+@freeflow\.im">$/);
    expect(m.attachments?.map((a) => [a.filename, a.contentType, a.inline ?? false])).toEqual([['a.txt', 'text/plain', false], ['image-1.png', 'image/png', true]]);
    expect(m.attachments?.[0]?.contentBase64).toBe(btoa('hi'));
    expect(m.inReplyTo).toBe('<m1@x>');
  });

  it('refuses a message over 20 MB', async () => {
    const big = new Blob([new Uint8Array(21 * 1024 * 1024)]);
    await expect(outgoingMessage(out({}, [{ filename: 'big.bin', contentType: 'application/octet-stream', file: big }]), async () => null)).rejects.toThrow(/at most 20 MB/);
  });
});

describe('sendInBackground', () => {
  it('says Sending…, then Message sent.', async () => {
    const notices: Notice[] = [];
    const sent: [string, OutgoingMessage][] = [];
    let done = 0;
    const ok = await sendInBackground(out(), { send: async (a, m) => sent.push([a, m]), notice: (n) => notices.push(n), onSent: () => done++, reopen() {}, read: async () => null });
    expect(ok).toBe(true);
    expect(notices).toEqual([{ text: 'Sending…', progress: true }, 'Message sent.']);
    expect(sent[0]![0]).toBe('acc');
    expect(sent[0]![1].subject).toBe('Re: Plans');
    expect(done).toBe(1);
  });

  it('on failure says why, and Open hands the composer back as it was', async () => {
    const notices: Notice[] = [];
    const reopened: Outgoing[] = [];
    const o = out();
    const ok = await sendInBackground(o, { send: async () => { throw new Error('The mail server refused the message.'); }, notice: (n) => notices.push(n), onSent() {}, reopen: (x) => reopened.push(x), read: async () => null });
    expect(ok).toBe(false);
    const last = notices[1] as Exclude<Notice, string>;
    expect(last.text).toBe('Could not send: The mail server refused the message.');
    expect(last.action?.label).toBe('Open');
    last.action!.run();
    expect(reopened).toEqual([o]);
  });
});
