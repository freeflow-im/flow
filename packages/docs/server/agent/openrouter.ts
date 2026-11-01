// Runs the assistant's model calls on OpenRouter with a user's own API key. OpenRouter speaks OpenAI's Chat
// Completions API for every model it carries, so this translates each request from the Claude message format
// the loop keeps to chat messages, and the reply back, as openai.ts does for the Responses API.
import type Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { ModelCall } from './agent.ts';
import { SettingsError } from './settings.ts';

const BASE_URL = 'https://openrouter.ai/api/v1';
/** How OpenRouter knows the app (its attribution header). */
const APP_HEADERS = { 'X-Title': 'MCP Docs' };

type Params = Parameters<ModelCall>[0];
type Message = Anthropic.Beta.BetaMessage;
type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;
type Request = OpenAI.Chat.ChatCompletionCreateParamsStreaming;

export function openrouterModel(apiKey: string, model: string): ModelCall {
  const client = new OpenAI({ apiKey, baseURL: BASE_URL, defaultHeaders: APP_HEADERS });
  return async (params, { onText, signal }) => {
    try {
      const stream = client.chat.completions.stream(toChatRequest(params, model), { signal });
      stream.on('content.delta', (e) => onText(e.delta));
      return fromChatCompletion(await stream.finalChatCompletion());
    } catch (e) {
      throw new OpenRouterError(e);
    }
  };
}

export function toChatRequest(params: Params, model: string): Request {
  const system = typeof params.system === 'string' ? params.system : (params.system ?? []).map((b) => b.text).join('\n\n');
  const tools = (params.tools ?? []).flatMap((t) =>
    'input_schema' in t ? [{ type: 'function' as const, function: { name: t.name, description: t.description ?? '', parameters: t.input_schema as Record<string, unknown> } }] : [],
  );
  return {
    model,
    stream: true,
    messages: [{ role: 'system', content: system }, ...toChatMessages(params.messages)],
    ...(tools.length ? { tools } : {}),
  };
}

export function toChatMessages(messages: Params['messages']): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push(m.role === 'user' ? { role: 'user', content: m.content } : { role: 'assistant', content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const text = m.content.flatMap((b) => (b.type === 'text' && b.text ? [b.text] : [])).join('');
      const calls = m.content.flatMap((b) => (b.type === 'tool_use' ? [{ id: b.id, type: 'function' as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }] : []));
      // Thinking blocks belong to the model that wrote them and are left out.
      if (text || calls.length) out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // Tool results become tool messages; the text and images around them stay together as one user message.
    let parts: OpenAI.Chat.ChatCompletionContentPart[] = [];
    const flush = () => {
      if (parts.length) out.push({ role: 'user', content: parts });
      parts = [];
    };
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        flush();
        const text = typeof b.content === 'string' ? b.content : (b.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('');
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? `Error: ${text}` : text });
      } else if (b.type === 'text') {
        parts.push({ type: 'text', text: b.text });
      } else if (b.type === 'image' && b.source.type === 'base64') {
        parts.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
      }
    }
    flush();
  }
  return out;
}

export function fromChatCompletion(res: OpenAI.Chat.ChatCompletion): Message {
  const choice = res.choices[0];
  if (!choice) throw new Error('OpenRouter returned no answer.');
  const content: unknown[] = [];
  if (choice.message.content) content.push({ type: 'text', text: choice.message.content, citations: null });
  for (const call of choice.message.tool_calls ?? []) {
    if (call.type === 'function') content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: parseArguments(call.function.arguments) });
  }
  const called = content.some((b) => (b as { type: string }).type === 'tool_use');
  const reason = choice.finish_reason;
  const stop_reason: Anthropic.Beta.BetaStopReason = reason === 'content_filter' || choice.message.refusal ? 'refusal' : reason === 'length' ? 'max_tokens' : called ? 'tool_use' : 'end_turn';
  return {
    id: res.id,
    type: 'message',
    role: 'assistant',
    model: res.model,
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: res.usage?.prompt_tokens ?? 0, output_tokens: res.usage?.completion_tokens ?? 0 },
  } as unknown as Message;
}

/** Arguments that are not a JSON object become an empty input, which input validation then reports to the model. */
function parseArguments(json: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A failed OpenRouter call, with what to tell the user (agentErrorMessage in server/app.ts shows `message`). */
export class OpenRouterError extends Error {
  constructor(cause: unknown) {
    super(openrouterErrorMessage(cause), { cause });
  }
}

function openrouterErrorMessage(e: unknown): string {
  if (e instanceof OpenAI.AuthenticationError) return 'OpenRouter did not accept your API key. Check it in Settings.';
  if (e instanceof OpenAI.APIError && e.status === 402) return 'Your OpenRouter account is out of credit.';
  if (e instanceof OpenAI.RateLimitError) return 'OpenRouter is rate limiting your API key right now. Try again in a minute.';
  if (e instanceof OpenAI.NotFoundError || e instanceof OpenAI.BadRequestError) return `OpenRouter could not run the model chosen in Settings${e.message ? `: ${e.message}` : '.'}`;
  if (e instanceof OpenAI.APIError && e.status && e.status >= 500) return 'OpenRouter or the model provider had a problem. Try again in a moment.';
  return 'Something went wrong while the assistant was working with OpenRouter. Try again.';
}

/**
 * Check a key and model before they are saved: OpenRouter must accept the key, and carry the model with tool
 * calling, which the assistant needs.
 */
export async function checkOpenRouterKey(apiKey: string, model: string, fetcher: typeof fetch = fetch): Promise<void> {
  let res: Response;
  try {
    res = await fetcher(`${BASE_URL}/key`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new SettingsError('The key could not be checked with OpenRouter. Try again in a moment.');
  }
  if (res.status === 401 || res.status === 403) throw new SettingsError('OpenRouter did not accept that API key.');
  if (!res.ok) throw new SettingsError('The key could not be checked with OpenRouter. Try again in a moment.');
  let models: { id: string; supported_parameters?: string[] }[];
  try {
    const list = await fetcher(`${BASE_URL}/models`, { signal: AbortSignal.timeout(15_000) });
    models = ((await list.json()) as { data: typeof models }).data;
  } catch {
    // The key is good; the model is checked when the assistant first runs on it.
    return;
  }
  const found = models.find((m) => m.id === model);
  if (!found) throw new SettingsError(`OpenRouter has no model "${model}". Check the id on openrouter.ai/models.`);
  if (found.supported_parameters && !found.supported_parameters.includes('tools')) throw new SettingsError(`${model} cannot call tools on OpenRouter, which the assistant needs. Choose another model.`);
}
