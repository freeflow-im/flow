// Runs the assistant's model calls on OpenAI (the Responses API) with a user's own API key. The loop and the
// stored history stay in the Claude message format; this translates each request on the way out and the
// reply on the way back, so the rest of the assistant does not need to know which model answered.
import type Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { OPENAI_MODELS } from '../../shared/agent/protocol.ts';
import type { ModelCall } from './agent.ts';
import { SettingsError } from './settings.ts';
import { TOOL_SEARCH_NAME } from './toolSearch.ts';

type Params = Parameters<ModelCall>[0];
type Message = Anthropic.Beta.BetaMessage;
type InputItem = OpenAI.Responses.ResponseInputItem;
type Request = Omit<OpenAI.Responses.ResponseCreateParamsNonStreaming, 'stream'>;

export function openaiModel(apiKey: string, model: string): ModelCall {
  const client = new OpenAI({ apiKey });
  return async (params, { onText, signal }) => {
    const stream = client.responses.stream(toRequest(params, model), { signal });
    stream.on('response.output_text.delta', (e) => onText(e.delta));
    return toMessage(await stream.finalResponse());
  };
}

export function toRequest(params: Params, model: string): Request {
  const system = typeof params.system === 'string' ? params.system : (params.system ?? []).map((b) => b.text).join('\n\n');
  const effort = params.output_config?.effort;
  return {
    model,
    instructions: system,
    input: toInput(params.messages, params.tools),
    tools: toTools(params.tools),
    max_output_tokens: params.max_tokens,
    ...(effort ? { reasoning: { effort: effort as OpenAI.ReasoningEffort } } : {}),
    // The whole history is sent with every request, as it is to Claude; nothing is kept on OpenAI's side.
    store: false,
  };
}

type FunctionTool = OpenAI.Responses.FunctionTool;

/** A Claude tool definition as an OpenAI function; a deferred one stays deferred. */
const toFunction = (t: Anthropic.Beta.BetaTool): FunctionTool => ({
  type: 'function',
  name: t.name,
  description: t.description ?? '',
  parameters: t.input_schema as Record<string, unknown>,
  strict: false,
  ...(t.defer_loading ? { defer_loading: true } : {}),
});

/** The tools: Claude's tool search becomes OpenAI's own (`tool_search`, run on OpenAI's side), which finds the deferred functions. */
export function toTools(tools: Params['tools']): OpenAI.Responses.Tool[] {
  return (tools ?? []).flatMap((t): OpenAI.Responses.Tool[] => {
    if ('input_schema' in t) return [toFunction(t)];
    if ('name' in t && t.name === TOOL_SEARCH_NAME) return [{ type: 'tool_search' }];
    return [];
  });
}

export function toInput(messages: Params['messages'], tools: Params['tools'] = []): InputItem[] {
  // A search's result is replayed with the definitions it loaded: nothing is kept on OpenAI's side (store: false).
  const defs = new Map((tools ?? []).flatMap((t) => ('input_schema' in t ? [[t.name, t] as const] : [])));
  const items: InputItem[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      items.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      for (const b of m.content) {
        if (b.type === 'text' && b.text) items.push({ role: 'assistant', content: b.text });
        else if (b.type === 'tool_use') items.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
        else if (b.type === 'server_tool_use' && b.name === TOOL_SEARCH_NAME) items.push({ type: 'tool_search_call', call_id: b.id, execution: 'server', status: 'completed', arguments: b.input });
        else if (b.type === 'tool_search_tool_result') {
          const refs = (b.content as { tool_references?: { tool_name: string }[] }).tool_references ?? [];
          const loaded = refs.flatMap((r) => {
            const def = defs.get(r.tool_name);
            return def ? [{ ...toFunction(def), defer_loading: true }] : [];
          });
          items.push({ type: 'tool_search_output', call_id: b.tool_use_id, execution: 'server', status: 'completed', tools: loaded });
        }
        // Thinking blocks belong to the model that wrote them and are left out.
      }
      continue;
    }
    // Tool results become their own items; the text and images around them stay together as one user message.
    let parts: OpenAI.Responses.ResponseInputMessageContentList = [];
    const flush = () => {
      if (parts.length) items.push({ role: 'user', content: parts });
      parts = [];
    };
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        flush();
        const text = typeof b.content === 'string' ? b.content : (b.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('');
        items.push({ type: 'function_call_output', call_id: b.tool_use_id, output: b.is_error ? `Error: ${text}` : text });
      } else if (b.type === 'text') {
        parts.push({ type: 'input_text', text: b.text });
      } else if (b.type === 'image' && b.source.type === 'base64') {
        parts.push({ type: 'input_image', detail: 'auto', image_url: `data:${b.source.media_type};base64,${b.source.data}` });
      }
    }
    flush();
  }
  return items;
}

export function toMessage(res: OpenAI.Responses.Response): Message {
  if (res.status === 'failed') throw new Error(res.error?.message ?? 'The OpenAI request failed.');
  const content: unknown[] = [];
  let refused = false;
  // A search run on OpenAI's side may leave call_id empty: its output then answers the search just before it.
  let searchId = '';
  for (const item of res.output) {
    if (item.type === 'message') {
      for (const part of item.content) {
        if (part.type === 'output_text' && part.text) content.push({ type: 'text', text: part.text, citations: null });
        else if (part.type === 'refusal') refused = true;
      }
    } else if (item.type === 'function_call') {
      content.push({ type: 'tool_use', id: item.call_id, name: item.name, input: parseArguments(item.arguments) });
    } else if (item.type === 'tool_search_call') {
      // Kept as Claude's blocks, as the rest of the history is; toInput turns them back. The pair shares the call's id.
      searchId = item.call_id ?? item.id;
      content.push({ type: 'server_tool_use', id: searchId, name: TOOL_SEARCH_NAME, input: item.arguments ?? {} });
    } else if (item.type === 'tool_search_output') {
      const names = item.tools.flatMap((t) => (t.type === 'function' ? [t.name] : []));
      content.push({ type: 'tool_search_tool_result', tool_use_id: item.call_id ?? searchId, content: { type: 'tool_search_tool_search_result', tool_references: names.map((tool_name) => ({ type: 'tool_reference', tool_name })) } });
    }
  }
  const reason = res.incomplete_details?.reason;
  const called = content.some((b) => (b as { type: string }).type === 'tool_use');
  const stop_reason: Anthropic.Beta.BetaStopReason =
    refused || reason === 'content_filter' ? 'refusal' : reason === 'max_output_tokens' ? 'max_tokens' : called ? 'tool_use' : 'end_turn';
  return {
    id: res.id,
    type: 'message',
    role: 'assistant',
    model: res.model,
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: res.usage?.input_tokens ?? 0, output_tokens: res.usage?.output_tokens ?? 0 },
  } as unknown as Message;
}

/** Arguments that are not a JSON object become an empty input, which input validation then reports to the model. */
function parseArguments(json: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Check a key before it is saved: it must be accepted by OpenAI and able to use the chosen model. */
export async function checkOpenAIKey(apiKey: string, model: string): Promise<void> {
  try {
    await new OpenAI({ apiKey, maxRetries: 0, timeout: 15_000 }).models.retrieve(model);
  } catch (e) {
    const name = OPENAI_MODELS.find((m) => m.id === model)?.name ?? model;
    if (e instanceof OpenAI.AuthenticationError) throw new SettingsError('OpenAI did not accept that API key.');
    if (e instanceof OpenAI.PermissionDeniedError || e instanceof OpenAI.NotFoundError) throw new SettingsError(`That API key cannot use ${name}. Choose another model or check the key's access.`);
    throw new SettingsError('The key could not be checked with OpenAI. Try again in a moment.');
  }
}

/** What to tell the user when a turn fails on their OpenAI key, or null for errors that are not OpenAI's. */
export function openaiErrorMessage(e: unknown): string | null {
  if (!(e instanceof OpenAI.OpenAIError)) return null;
  if (e instanceof OpenAI.AuthenticationError) return 'OpenAI did not accept your API key. Check it in Settings.';
  if (e instanceof OpenAI.RateLimitError) {
    return e.code === 'insufficient_quota' ? 'Your OpenAI account is out of credit or over its spending limit.' : 'OpenAI is rate limiting your API key right now. Try again in a minute.';
  }
  if (e instanceof OpenAI.PermissionDeniedError || e instanceof OpenAI.NotFoundError) return 'Your OpenAI API key cannot use the model chosen in Settings.';
  if (e instanceof OpenAI.APIError && e.status && e.status >= 500) return 'OpenAI had a problem. Try again in a moment.';
  return 'Something went wrong while the assistant was working with OpenAI. Try again.';
}
