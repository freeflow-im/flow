import { describe, expect, it } from 'vitest';
import type { MessageStructureObject } from 'imapflow';
import PostalMime from 'postal-mime';
import { decodeTransfer, decodedSize, minimalMessage, planBody, prefetch } from './body';
import { toDetail, toSummary } from './convert';

// A small stand-in for the server: splits a raw message into what BODYSTRUCTURE says of it and each part's raw bytes
// (BODY[1.2] and so on), so opening by parts can be checked against postal-mime reading the whole message.
function serve(raw: string): { structure: MessageStructureObject; sections: Map<string, Uint8Array>; headers: string } {
  const sections = new Map<string, Uint8Array>();
  const split = (text: string) => {
    const i = text.search(/\r\n\r\n/);
    return { head: text.slice(0, i), body: text.slice(i + 4) };
  };
  const headerMap = (head: string) => {
    const out = new Map<string, string>();
    for (const line of head.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
      const k = line.indexOf(':');
      if (k > 0) out.set(line.slice(0, k).trim().toLowerCase(), line.slice(k + 1).trim());
    }
    return out;
  };
  const params = (value: string) => {
    const [first, ...rest] = value.split(';');
    const p: Record<string, string> = {};
    for (const r of rest) {
      const m = /^\s*([\w*-]+)\s*=\s*"?([^"]*)"?\s*$/.exec(r);
      if (m) p[m[1].toLowerCase()] = m[2];
    }
    return { value: first.trim().toLowerCase(), params: p };
  };
  const walk = (text: string, part: string, isRoot: boolean): MessageStructureObject => {
    const { head, body } = split(text);
    const h = headerMap(head);
    const ct = params(h.get('content-type') ?? 'text/plain');
    if (ct.value.startsWith('multipart/')) {
      const boundary = ct.params.boundary;
      const pieces = body.split(`--${boundary}`).slice(1, -1).map((p) => p.replace(/^\r\n/, '').replace(/\r\n$/, ''));
      return { type: ct.value, parameters: ct.params, childNodes: pieces.map((p, i) => walk(p, isRoot ? String(i + 1) : `${part}.${i + 1}`, false)) };
    }
    const cd = h.get('content-disposition') ? params(h.get('content-disposition')!) : null;
    sections.set(isRoot ? 'TEXT' : part, new Uint8Array(Buffer.from(body, 'latin1')));
    return {
      ...(isRoot ? {} : { part }), type: ct.value, parameters: ct.params, encoding: (h.get('content-transfer-encoding') ?? '7bit').toLowerCase(),
      size: Buffer.byteLength(body, 'latin1'), ...(h.get('content-id') ? { id: h.get('content-id') } : {}),
      ...(cd ? { disposition: cd.value, dispositionParameters: cd.params } : {}),
    };
  };
  const structure = walk(raw, '', true);
  return { structure, sections, headers: split(raw).head + '\r\n\r\n' };
}

/** What GET .../messages/:uid answers for a message opened by its parts, and for the same message read whole. */
async function both(raw: string) {
  const { structure, sections, headers } = serve(raw);
  const plan = planBody(structure);
  expect(plan.simple).toBe(true);
  const bodies = new Map([...plan.texts.map((l) => l.section)].map((s) => [s, sections.get(s)!]));
  const keep = headers.split(/\r\n(?![ \t])/).filter((l) => /^(from|reply-to|bcc|in-reply-to|references)\s*:/i.test(l)).join('\r\n') + '\r\n\r\n';
  const email = await PostalMime.parse(minimalMessage(keep, plan, bodies), { attachmentEncoding: 'arraybuffer' });
  const whole = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' });
  const summary = toSummary({ seq: 1, uid: 9, envelope: {}, bodyStructure: structure } as never, 'INBOX');
  const parts = new Map([...plan.attachments].map((a) => [a.index, decodeTransfer(sections.get(a.leaf.section)!, a.leaf.encoding)]));
  const attachments = plan.attachments.map((a) => ({ index: a.index, filename: a.filename, mimeType: a.mimeType, size: parts.get(a.index)!.length, contentId: a.contentId, inline: a.inline }));
  return { plan, sections, parts, byParts: toDetail(summary, email, attachments), wholeDetail: toDetail(summary, whole), whole };
}

const ALT_WITH_ATTACHMENT = [
  'From: Bob <bob@acme.test>', 'To: ann@test.local', 'Reply-To: Team <team@acme.test>', 'In-Reply-To: <a1@acme.test>', 'References: <a0@acme.test> <a1@acme.test>',
  'Subject: Q3', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="mix"', '',
  '--mix', 'Content-Type: multipart/related; boundary="rel"', '',
  '--rel', 'Content-Type: multipart/alternative; boundary="alt"', '',
  '--alt', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '',
  'Caf=C3=A9 numbers are attached, see the chart. This line is long enough that it =', 'wraps softly.', '',
  '--alt', 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '',
  Buffer.from('<p>Café numbers are attached, see <img src="cid:chart@acme"></p>').toString('base64'),
  '--alt--', '',
  '--rel', 'Content-Type: image/png; name="chart.png"', 'Content-Transfer-Encoding: base64', 'Content-ID: <chart@acme>', 'Content-Disposition: inline; filename="chart.png"', '',
  Buffer.from('\x89PNG fake image bytes').toString('base64'),
  '--rel--', '',
  '--mix', 'Content-Type: application/pdf; name="q3.pdf"', 'Content-Transfer-Encoding: base64', 'Content-Disposition: attachment; filename="q3.pdf"', '',
  Buffer.alloc(3000, 0x25).toString('base64').replace(/(.{76})/g, '$1\r\n'),
  '--mix--', '',
].join('\r\n');

describe('opening a message by its parts', () => {
  it('multipart/alternative with an inline picture and an attachment: the same as postal-mime reading it whole', async () => {
    const { plan, parts, byParts, wholeDetail, whole } = await both(ALT_WITH_ATTACHMENT);
    expect(plan.texts.map((t) => t.section)).toEqual(['1.1.1', '1.1.2']);
    expect(plan.attachments.map((a) => [a.index, a.leaf.section, a.filename, a.inline, a.contentId])).toEqual([[0, '1.2', 'chart.png', true, 'chart@acme'], [1, '2', 'q3.pdf', false, null]]);
    expect(byParts).toEqual(wholeDetail);
    expect(byParts.html).toContain('Café numbers');
    expect(byParts.text).toContain('long enough that it wraps softly.');
    expect(byParts.replyTo).toEqual([{ name: 'Team', address: 'team@acme.test' }]);
    expect(byParts.inReplyTo).toBe('<a1@acme.test>');
    expect(byParts.references).toEqual(['<a0@acme.test>', '<a1@acme.test>']);
    // The bytes of each attachment, by its index, are postal-mime's.
    for (const a of plan.attachments) expect(Buffer.from(whole.attachments[a.index].content as ArrayBuffer).equals(parts.get(a.index)!)).toBe(true);
  });

  it('a plain-text message (not multipart): its body is BODY[TEXT]', async () => {
    const raw = ['From: a@b.test', 'Subject: hi', 'Content-Type: text/plain; charset=us-ascii', '', 'Just text,', 'two lines.', ''].join('\r\n');
    const { plan, byParts, wholeDetail } = await both(raw);
    expect(plan.texts.map((t) => t.section)).toEqual(['TEXT']);
    expect(plan.attachments).toEqual([]);
    expect(byParts).toEqual(wholeDetail);
    expect(byParts.text).toBe('Just text,\ntwo lines.\n');
    expect(byParts.html).toBeNull();
  });

  it('non-UTF-8 charsets, quoted-printable and base64 bodies', async () => {
    const raw = [
      'From: a@b.test', 'Content-Type: multipart/alternative; boundary="b"', '',
      '--b', 'Content-Type: text/plain; charset=iso-8859-1', 'Content-Transfer-Encoding: quoted-printable', '', 'Gr=FC=DFe aus K=F6ln', '',
      '--b', 'Content-Type: text/html; charset=windows-1251', 'Content-Transfer-Encoding: base64', '',
      Buffer.from([0x3c, 0x70, 0x3e, 0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x3c, 0x2f, 0x70, 0x3e]).toString('base64'), '--b--', '',
    ].join('\r\n');
    const { byParts, wholeDetail } = await both(raw);
    expect(byParts).toEqual(wholeDetail);
    expect(byParts.text).toContain('Grüße aus Köln');
    expect(byParts.html).toBe('<p>Привет</p>');
  });

  it('format=flowed text is unwrapped as postal-mime does', async () => {
    const raw = ['From: a@b.test', 'Content-Type: text/plain; charset=utf-8; format=flowed', '', 'This is one ', 'paragraph.', ''].join('\r\n');
    const { byParts, wholeDetail } = await both(raw);
    expect(byParts).toEqual(wholeDetail);
    expect(byParts.text).toContain('This is one paragraph.');
  });

  it('a message that is one attachment has no text', async () => {
    const raw = ['From: a@b.test', 'Content-Type: application/pdf; name="x.pdf"', 'Content-Transfer-Encoding: base64', '', Buffer.from('%PDF-1.4').toString('base64'), ''].join('\r\n');
    const { plan, byParts, wholeDetail } = await both(raw);
    expect(plan.attachments.map((a) => a.leaf.section)).toEqual(['TEXT']);
    expect(byParts).toEqual(wholeDetail);
  });

  it('an inline forwarded message is read whole instead', () => {
    const plan = planBody({ type: 'multipart/mixed', childNodes: [{ part: '1', type: 'text/plain', size: 5 }, { part: '2', type: 'message/rfc822', size: 900 }] });
    expect(plan.simple).toBe(false);
    expect(planBody({ type: 'multipart/mixed', childNodes: [{ part: '1', type: 'text/plain', size: 5 }, { part: '2', type: 'message/rfc822', disposition: 'attachment', size: 900 }] }).simple).toBe(true);
    expect(planBody(undefined).simple).toBe(false);
  });

  it('fetches inline pictures and small parts with the bodies, within the budget', () => {
    const { structure } = serve(ALT_WITH_ATTACHMENT);
    const plan = planBody(structure);
    expect(prefetch(plan.attachments, { inlineMax: 1000, smallMax: 10, total: 100_000 }).map((a) => a.index)).toEqual([0]);
    expect(prefetch(plan.attachments, { inlineMax: 1000, smallMax: 10_000, total: 100_000 }).map((a) => a.index)).toEqual([0, 1]);
    expect(prefetch(plan.attachments, { inlineMax: 1000, smallMax: 10_000, total: 50 }).map((a) => a.index)).toEqual([0]);
  });

  it('estimates a base64 part\'s decoded size from its encoded one', () => {
    const encoded = Buffer.alloc(300_000, 1).toString('base64').replace(/(.{76})/g, '$1\r\n');
    const size = decodedSize({ section: '2', type: 'application/octet-stream', encoding: 'base64', parameters: {}, disposition: 'attachment', id: null, size: encoded.length });
    expect(Math.abs(size - 300_000)).toBeLessThan(300);
  });

  it('decodes quoted-printable soft breaks and escapes', () => {
    expect(decodeTransfer(Buffer.from('a=3Db=\r\nc =C3=A9=\nd'), 'quoted-printable').toString('utf8')).toBe('a=bc éd');
  });
});
