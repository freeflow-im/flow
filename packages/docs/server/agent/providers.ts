// The providers a user can run the assistant on with their own key (server/agent/settings.ts): the model call
// for each, and the check a key gets before it is saved.
import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_MODELS } from '../../shared/agent/protocol.ts';
import { claudeModel, type ModelCall } from './agent.ts';
import { checkOpenAIKey, openaiModel } from './openai.ts';
import { checkOpenRouterKey, openrouterModel } from './openrouter.ts';
import { SettingsError, type KeyCheck, type ModelChoice } from './settings.ts';

/** The model call for a user's own key and model. */
export function ownModel(choice: ModelChoice): ModelCall {
  if (choice.provider === 'openai') return openaiModel(choice.apiKey, choice.model);
  if (choice.provider === 'openrouter') return openrouterModel(choice.apiKey, choice.model);
  const call = claudeModel(new Anthropic({ apiKey: choice.apiKey }));
  return async (params, opts) => {
    try {
      return await call(params, opts);
    } catch (e) {
      throw anthropicKeyError(e) ?? e;
    }
  };
}

/** An Anthropic error that is about the user's own key, with what to tell them, or null. */
function anthropicKeyError(e: unknown): Error | null {
  if (e instanceof Anthropic.AuthenticationError) return new OwnKeyError('Anthropic did not accept your API key. Check it in Settings.', e);
  if (e instanceof Anthropic.PermissionDeniedError || e instanceof Anthropic.NotFoundError) return new OwnKeyError('Your Anthropic API key cannot use the model chosen in Settings.', e);
  if (e instanceof Anthropic.RateLimitError) return new OwnKeyError('Anthropic is rate limiting your API key right now. Try again in a minute.', e);
  if (e instanceof Anthropic.APIError && /credit balance/i.test(e.message)) return new OwnKeyError('Your Anthropic account is out of credit.', e);
  return null;
}

/** A failed call on the user's own key, with what to tell them as its message (agentErrorMessage shows it). */
export class OwnKeyError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
  }
}

export async function checkAnthropicKey(apiKey: string, model: string): Promise<void> {
  try {
    await new Anthropic({ apiKey, maxRetries: 0, timeout: 15_000 }).models.retrieve(model);
  } catch (e) {
    const name = ANTHROPIC_MODELS.find((m) => m.id === model)?.name ?? model;
    if (e instanceof Anthropic.AuthenticationError) throw new SettingsError('Anthropic did not accept that API key.');
    if (e instanceof Anthropic.PermissionDeniedError || e instanceof Anthropic.NotFoundError) throw new SettingsError(`That API key cannot use ${name}. Choose another model or check the key's access.`);
    throw new SettingsError('The key could not be checked with Anthropic. Try again in a moment.');
  }
}

/** Check a key and model with their provider before they are saved. */
export const checkAssistantKey: KeyCheck = (provider, apiKey, model) => {
  if (provider === 'anthropic') return checkAnthropicKey(apiKey, model);
  if (provider === 'openai') return checkOpenAIKey(apiKey, model);
  return checkOpenRouterKey(apiKey, model);
};
