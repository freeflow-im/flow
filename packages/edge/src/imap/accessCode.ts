// Access codes in new mail (task 21): a one-time sign-in, verification or confirmation code, shown above the message with
// a Copy button. Two OpenAI calls on the organization's key: the Decisions API (POST /v1/decisions) answers "is there a
// code?" (it only decides: it cannot return the code), and only when it says yes, one Responses call with a JSON schema
// reads the code out. The code is kept only when it is really in the mail. Pure apart from `fetch`, so
// accessCode.test.ts can check each step; the Mail object (object.ts `scanAccessCode`) decides which mail is asked about.
import { bodyText } from './mailText';
import type { MessageDetail } from './convert';

const API = 'https://api.openai.com/v1';
/** The one model the Decisions API runs on, and a cheap one for the extraction. */
export const DECISIONS_MODEL = 'gpt-6-luna';
export const EXTRACT_MODEL = 'gpt-6-luna';
/** How sure the Decisions answer must be before the code is read out. */
export const CODE_THRESHOLD = 0.7;
/** The most of a message sent: codes sit near the top, and a long newsletter is not worth the tokens. */
const MAX_INPUT = 6000;
const TIMEOUT_MS = 15_000;

/** A code found in a message, as the reader shows it. */
export interface AccessCode { code: string }

const QUESTION =
  'The email gives the reader a one-time code to type or paste somewhere: a sign-in, login, verification, security, ' +
  'confirmation or access code, or a one-time password. Order numbers, tracking numbers, invoice or reference ids, ' +
  'phone numbers, prices and dates are not such codes.';

/** The key a message's scan is kept under: its Message-ID (the same in every folder it is copied to), else where it is. */
export const accessCodeKey = (m: Pick<MessageDetail, 'messageId' | 'folder' | 'uid'>): string => (m.messageId ? `id:${m.messageId}` : `uid:${m.folder}/${m.uid}`);

/** The message as the models read it: who sent it, the subject and the text, cut to MAX_INPUT. */
export function codeInput(m: Pick<MessageDetail, 'from' | 'subject' | 'html' | 'text'>): string {
  const from = m.from ? `${m.from.name ? `${m.from.name} ` : ''}<${m.from.address}>` : '';
  return `From: ${from}\nSubject: ${m.subject}\n\n${bodyText(m)}`.slice(0, MAX_INPUT);
}

/**
 * Whether the text could hold a code at all, before any call: a run of 4 to 10 letters and digits with at least one digit
 * (or digits in groups, "482 913", "482-913"), other than a year. Most mail has one, so this only spares the call for
 * mail with no digits worth asking about.
 */
export function mayHaveCode(text: string): boolean {
  for (const m of text.matchAll(/(?<![A-Za-z0-9])(?:\d{3}[ -]\d{3}|[A-Za-z0-9]{4,10})(?![A-Za-z0-9])/g)) {
    const t = m[0];
    if (!/\d/.test(t)) continue;
    if (/^(19|20)\d\d$/.test(t)) continue;
    return true;
  }
  return false;
}

const squash = (s: string) => s.replace(/[\s\-–]/g, '').toUpperCase();

/**
 * The model's answer as a code worth showing: 3 to 12 letters and digits (spaces and dashes allowed between), at least
 * one digit unless it is all capitals, and found in the message itself (spaces and dashes aside). Anything else is null.
 */
export function checkCode(code: unknown, text: string): string | null {
  if (typeof code !== 'string') return null;
  const c = code.trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9 \-]*[A-Za-z0-9])?$/.test(c)) return null;
  const bare = squash(c);
  if (bare.length < 3 || bare.length > 12) return null;
  if (!/\d/.test(bare) && !/^[A-Z]+$/.test(c.replace(/[ -]/g, ''))) return null;
  return squash(text).includes(bare) ? c : null;
}

async function post(path: string, apiKey: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message = (json.error as { message?: string } | undefined)?.message ?? res.statusText;
    throw new Error(`OpenAI ${path} ${res.status}: ${message}`);
  }
  return json;
}

/** The Decisions API's probability that the message holds a code (0 when it refused the question). */
export async function codeProbability(apiKey: string, input: string): Promise<number> {
  const out = await post('/decisions', apiKey, {
    model: DECISIONS_MODEL,
    input,
    questions: [{ type: 'predicate', name: 'has_access_code', instructions: QUESTION }],
  });
  const answer = (out.answers as { type?: string; probability?: number }[] | undefined)?.[0];
  return answer?.type === 'predicate' && typeof answer.probability === 'number' ? answer.probability : 0;
}

/** The code, read out by one Responses call with a JSON schema (`{ code: string | null }`), unchecked. */
export async function extractCode(apiKey: string, input: string): Promise<unknown> {
  const out = await post('/responses', apiKey, {
    model: EXTRACT_MODEL,
    store: false,
    instructions: `${QUESTION}\nReturn that code exactly as the email writes it, or null when there is none.`,
    input,
    text: {
      format: {
        type: 'json_schema', name: 'access_code', strict: true,
        schema: { type: 'object', properties: { code: { type: ['string', 'null'] } }, required: ['code'], additionalProperties: false },
      },
    },
  });
  const parts = (out.output as { type?: string; content?: { type?: string; text?: string }[] }[] | undefined) ?? [];
  const text = parts.flatMap((o) => (o.type === 'message' ? o.content ?? [] : [])).find((c) => c.type === 'output_text')?.text;
  if (!text) return null;
  try {
    return (JSON.parse(text) as { code?: unknown }).code ?? null;
  } catch {
    return null;
  }
}

/** The access code of a message, or null: the cheap check, then Decisions, then the extraction, then `checkCode`. */
export async function findAccessCode(apiKey: string, m: Pick<MessageDetail, 'from' | 'subject' | 'html' | 'text'>): Promise<AccessCode | null> {
  const input = codeInput(m);
  if (!mayHaveCode(input)) return null;
  if ((await codeProbability(apiKey, input)) < CODE_THRESHOLD) return null;
  const code = checkCode(await extractCode(apiKey, input), input);
  return code ? { code } : null;
}
