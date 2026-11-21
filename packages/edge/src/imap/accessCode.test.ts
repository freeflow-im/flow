import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkCode, codeInput, findAccessCode, mayHaveCode } from './accessCode';

const mail = (text: string, subject = 'Your sign-in code') => ({ from: { name: 'Acme', address: 'no-reply@acme.test' }, subject, html: null, text });

/** A fetch that answers the Decisions call with `probability` and the Responses call with `code`, recording each body. */
function openai(probability: number, code: unknown) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url, body });
    if (url.endsWith('/decisions')) return Response.json({ model: 'gpt-6-luna', answers: [{ type: 'predicate', name: 'has_access_code', probability }] });
    return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ code }) }] }] });
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('mayHaveCode', () => {
  it('finds runs with digits, but not years or plain words', () => {
    expect(mayHaveCode('Your code is 482913')).toBe(true);
    expect(mayHaveCode('Use 482 913 to sign in')).toBe(true);
    expect(mayHaveCode('Code: AB12CD')).toBe(true);
    expect(mayHaveCode('See you in 2026 at the meeting')).toBe(false);
    expect(mayHaveCode('Hello there, how are you?')).toBe(false);
  });
});

describe('checkCode', () => {
  const text = codeInput(mail('Your verification code is 482-913. It expires in 10 minutes.'));
  it('keeps a code that is in the message, spaces and dashes aside', () => {
    expect(checkCode('482-913', text)).toBe('482-913');
    expect(checkCode('482913', text)).toBe('482913');
  });
  it('drops a code not in the message, or not code-shaped', () => {
    expect(checkCode('555123', text)).toBeNull();
    expect(checkCode('verification', text)).toBeNull();
    expect(checkCode('12', text)).toBeNull();
    expect(checkCode(null, text)).toBeNull();
    expect(checkCode('48<913', text)).toBeNull();
  });
});

describe('findAccessCode', () => {
  it('asks Decisions, then reads the code out', async () => {
    const calls = openai(0.97, '482913');
    expect(await findAccessCode('sk-test', mail('Your code is 482913.'))).toEqual({ code: '482913' });
    expect(calls.map((c) => c.url)).toEqual(['https://api.openai.com/v1/decisions', 'https://api.openai.com/v1/responses']);
    expect(calls[0].body).toMatchObject({ model: 'gpt-6-luna', questions: [{ type: 'predicate', name: 'has_access_code' }] });
    expect(String(calls[0].body.input)).toContain('Your code is 482913.');
    expect(calls[1].body).toMatchObject({ store: false, text: { format: { type: 'json_schema', strict: true } } });
  });

  it('stops after Decisions when it says no', async () => {
    const calls = openai(0.1, '482913');
    expect(await findAccessCode('sk-test', mail('Order 482913 has shipped.', 'Shipped'))).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('makes no call for mail with nothing code-shaped', async () => {
    const calls = openai(0.99, 'x');
    expect(await findAccessCode('sk-test', mail('Thanks for joining us!', 'Welcome'))).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('drops a code the model made up', async () => {
    openai(0.95, '999999');
    expect(await findAccessCode('sk-test', mail('Your code is 482913.'))).toBeNull();
  });

  it('throws OpenAI errors (the caller logs them)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { message: 'Incorrect API key' } }, { status: 401 })));
    await expect(findAccessCode('sk-bad', mail('Your code is 482913.'))).rejects.toThrow('OpenAI /decisions 401: Incorrect API key');
  });
});
