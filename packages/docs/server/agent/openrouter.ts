// Runs the assistant's model calls on OpenRouter with a user's own API key, through OpenRouter's Anthropic Messages API:
// the request the loop builds for Claude goes almost as it is, for every model OpenRouter carries. What changes:
// Anthropic's own options (betas, fallbacks) are left out, Claude's tool search becomes OpenRouter's
// (`openrouter:tool_search`, run by OpenRouter, which finds the deferred tools), and the history is cleaned of what
// another provider wrote (history.ts). OpenRouter's thinking comes back marked, so a chat that moves to Claude drops it.
import Anthropic from '@anthropic-ai/sdk';
import type { ModelCall } from './agent.ts';
import { markOpenRouterThinking, OPENROUTER_SEARCH, portableHistory } from './history.ts';
import { SettingsError } from './settings.ts';
import { TOOL_SEARCH_NAME } from './toolSearch.ts';

/** The Messages API is at <BASE_URL>/v1/messages; the key and model checks are under <BASE_URL>/v1. */
const BASE_URL = 'https://openrouter.ai/api';
/** How OpenRouter knows the app (its attribution header). */
const APP_HEADERS = { 'X-Title': 'MCP Docs' };

type Params = Parameters<ModelCall>[0];
type Message = Anthropic.Beta.BetaMessage;

export function openrouterModel(apiKey: string, model: string): ModelCall {
  const client = new Anthropic({ apiKey: null, authToken: apiKey, baseURL: BASE_URL, defaultHeaders: APP_HEADERS });
  return async (params, { onText, signal }) => {
    try {
      const stream = client.beta.messages.stream(toOpenRouterRequest(params, model), { signal });
      stream.on('text', onText);
      return fromOpenRouter(await stream.finalMessage());
    } catch (e) {
      throw new OpenRouterError(e);
    }
  };
}

/** The loop's request, for OpenRouter: the user's model, without Anthropic's own options, with OpenRouter's tool search. */
export function toOpenRouterRequest(params: Params, model: string): Params {
  const { betas: _betas, fallbacks: _fallbacks, ...rest } = params as Params & { fallbacks?: unknown };
  return {
    ...rest,
    model,
    ...(params.tools ? { tools: params.tools.map((t) => ('name' in t && t.name === TOOL_SEARCH_NAME ? ({ type: OPENROUTER_SEARCH } as unknown as typeof t) : t)) } : {}),
    messages: portableHistory(params.messages, 'openrouter'),
  };
}

/** OpenRouter's reply, kept as it is but for its thinking, marked as OpenRouter's (history.ts). */
export function fromOpenRouter(message: Message): Message {
  return { ...message, content: markOpenRouterThinking(message.content) };
}

/** A failed OpenRouter call, with what to tell the user (agentErrorMessage in server/app.ts shows `message`). */
export class OpenRouterError extends Error {
  constructor(cause: unknown) {
    super(openrouterErrorMessage(cause), { cause });
  }
}

function openrouterErrorMessage(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return 'OpenRouter did not accept your API key. Check it in Settings.';
  if (e instanceof Anthropic.APIError && e.status === 402) return 'Your OpenRouter account is out of credit.';
  if (e instanceof Anthropic.RateLimitError) return 'OpenRouter is rate limiting your API key right now. Try again in a minute.';
  if (e instanceof Anthropic.NotFoundError || e instanceof Anthropic.BadRequestError) return `OpenRouter could not run the model chosen in Settings${e.message ? `: ${e.message}` : '.'}`;
  if (e instanceof Anthropic.APIError && e.status && e.status >= 500) return 'OpenRouter or the model provider had a problem. Try again in a moment.';
  return 'Something went wrong while the assistant was working with OpenRouter. Try again.';
}

/**
 * Check a key and model before they are saved: OpenRouter must accept the key, and carry the model with tool
 * calling, which the assistant needs.
 */
export async function checkOpenRouterKey(apiKey: string, model: string, fetcher: typeof fetch = fetch): Promise<void> {
  let res: Response;
  try {
    res = await fetcher(`${BASE_URL}/v1/key`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new SettingsError('The key could not be checked with OpenRouter. Try again in a moment.');
  }
  if (res.status === 401 || res.status === 403) throw new SettingsError('OpenRouter did not accept that API key.');
  if (!res.ok) throw new SettingsError('The key could not be checked with OpenRouter. Try again in a moment.');
  let models: { id: string; supported_parameters?: string[] }[];
  try {
    const list = await fetcher(`${BASE_URL}/v1/models`, { signal: AbortSignal.timeout(15_000) });
    models = ((await list.json()) as { data: typeof models }).data;
  } catch {
    // The key is good; the model is checked when the assistant first runs on it.
    return;
  }
  const found = models.find((m) => m.id === model);
  if (!found) throw new SettingsError(`OpenRouter has no model "${model}". Check the id on openrouter.ai/models.`);
  if (found.supported_parameters && !found.supported_parameters.includes('tools')) throw new SettingsError(`${model} cannot call tools on OpenRouter, which the assistant needs. Choose another model.`);
}
