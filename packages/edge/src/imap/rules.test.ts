import { describe, expect, it } from 'vitest';
import { checkServer, isPrivateHost, parse, providerFor, savesSentCopy, sendSize, SendBody, NewAccount, type ServerSettings } from './rules';

const s = (host: string, port: number, security: ServerSettings['security']): ServerSettings => ({ host, port, security });
const refused = (fn: () => void) => { try { fn(); return null; } catch (err) { return (err as { code: string; statusCode: number }); } };

describe('which mail servers a Worker connects to', () => {
  it('allows the standard ports, each with its own security', () => {
    for (const [kind, settings] of [['imap', s('imap.fastmail.com', 993, 'tls')], ['imap', s('mail.example.com', 143, 'starttls')], ['smtp', s('smtp.gmail.com', 465, 'tls')], ['smtp', s('smtp.example.com', 587, 'starttls')]] as const) {
      expect(refused(() => checkServer(kind, settings, false))).toBeNull();
    }
  });

  it('refuses other ports, and a port with the wrong security', () => {
    expect(refused(() => checkServer('imap', s('imap.example.com', 3143, 'tls'), false))?.code).toBe('bad_request');
    expect(refused(() => checkServer('smtp', s('smtp.example.com', 25, 'starttls'), false))?.code).toBe('bad_request');
    expect(refused(() => checkServer('imap', s('imap.example.com', 993, 'starttls'), false))?.code).toBe('bad_request');
    expect(refused(() => checkServer('smtp', s('smtp.example.com', 587, 'tls'), false))?.code).toBe('bad_request');
  });

  it("refuses security 'none' unless MAIL_ALLOW_INSECURE is on", () => {
    const greenmail = s('127.0.0.1', 3143, 'none');
    const err = refused(() => checkServer('imap', greenmail, false));
    expect(err?.statusCode).toBe(400);
    expect(err?.code).toBe('bad_request');
    expect(refused(() => checkServer('imap', s('imap.example.com', 143, 'none'), false))?.code).toBe('bad_request');
    expect(refused(() => checkServer('imap', greenmail, true))).toBeNull();
    expect(refused(() => checkServer('smtp', s('127.0.0.1', 3025, 'none'), true))).toBeNull();
  });

  it('refuses local and private addresses, unless MAIL_ALLOW_INSECURE is on', () => {
    for (const host of ['localhost', 'mail.localhost', '127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '[::1]', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect(isPrivateHost(host), host).toBe(true);
      expect(refused(() => checkServer('imap', s(host, 993, 'tls'), false))?.code, host).toBe('bad_request');
    }
    for (const host of ['imap.gmail.com', '8.8.8.8', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) expect(isPrivateHost(host), host).toBe(false);
    expect(refused(() => checkServer('imap', s('localhost', 993, 'tls'), true))).toBeNull();
  });

  it('refuses a host that is not a host name', () => {
    expect(refused(() => checkServer('imap', s('imap.example.com/x', 993, 'tls'), false))?.code).toBe('bad_request');
    expect(refused(() => checkServer('imap', s('-bad.example.com', 993, 'tls'), true))?.code).toBe('bad_request');
  });
});

describe('provider presets', () => {
  it('knows the big providers by domain, with the address as the username', () => {
    const gmail = providerFor('Someone@GMail.com');
    expect(gmail?.name).toBe('Gmail');
    expect(gmail?.imap).toEqual({ host: 'imap.gmail.com', port: 993, security: 'tls', username: 'Someone@GMail.com' });
    expect(gmail?.smtp).toEqual({ host: 'smtp.gmail.com', port: 465, security: 'tls', username: 'Someone@GMail.com' });
    expect(gmail?.appPasswordUrl).toMatch(/^https:/);
    expect(providerFor('a@googlemail.com')?.name).toBe('Gmail');
    expect(providerFor('a@me.com')?.imap.host).toBe('imap.mail.me.com');
    expect(providerFor('a@icloud.com')?.smtp).toMatchObject({ port: 587, security: 'starttls' });
    expect(providerFor('a@hotmail.com')?.imap.host).toBe('outlook.office365.com');
    expect(providerFor('a@yahoo.com')?.name).toBe('Yahoo Mail');
    expect(providerFor('a@fastmail.fm')?.smtp.host).toBe('smtp.fastmail.com');
  });

  it('every preset passes the server checks', () => {
    for (const email of ['a@gmail.com', 'a@icloud.com', 'a@outlook.com', 'a@yahoo.com', 'a@fastmail.com']) {
      const p = providerFor(email)!;
      expect(refused(() => checkServer('imap', p.imap, false)), email).toBeNull();
      expect(refused(() => checkServer('smtp', p.smtp, false)), email).toBeNull();
    }
  });

  it('has none for other domains', () => {
    expect(providerFor('me@example.com')).toBeNull();
    expect(providerFor('not an address')).toBeNull();
  });

  it('knows Gmail keeps its own sent copy', () => {
    expect(savesSentCopy(s('imap.gmail.com', 993, 'tls'), s('smtp.gmail.com', 465, 'tls'))).toBe(true);
    expect(savesSentCopy(s('imap.fastmail.com', 993, 'tls'), s('smtp.fastmail.com', 465, 'tls'))).toBe(false);
  });
});

describe('request bodies', () => {
  it('reads a new account and reports the first problem as bad_request', () => {
    const ok = parse(NewAccount, { email: 'ann@test.local', password: 'x', imap: s('127.0.0.1', 3143, 'none'), smtp: s('127.0.0.1', 3025, 'none') });
    expect(ok.displayName).toBe('');
    let err: { code?: string; message?: string } = {};
    try { parse(NewAccount, { email: 'ann@test.local', imap: {}, smtp: {} }); } catch (e) { err = e as never; }
    expect(err.code).toBe('bad_request');
    expect(err.message).toMatch(/^password/);
  });

  it('counts the size of a message to send', () => {
    const body = parse(SendBody, { to: [{ address: 'a@b.co' }], subject: 'x', html: 'abcd', attachments: [{ filename: 'f', contentBase64: Buffer.alloc(300).toString('base64') }] });
    expect(sendSize(body)).toBe(304);
  });
});
