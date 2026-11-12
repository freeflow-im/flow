// The assistant's model catalogue and settings (docs/specs/agents.md §6): which providers and models a person's assistant
// can run on, and the shape of its settings. Platform-level, below the apps: the Admin app's "Your assistant" and Docs'
// own Settings (the desktop app) both read it.

/** OpenAI models a user can run the assistant on with their own API key (Settings page). */
export const OPENAI_MODELS = [
  { id: 'gpt-6-astra', name: 'Astra', hint: 'Most capable, highest cost' },
  { id: 'gpt-6.1-sol', name: 'Sol', hint: 'Balanced' },
  { id: 'gpt-6-luna', name: 'Luna', hint: 'Fastest, lowest cost' },
] as const;
export type OpenAIModelId = (typeof OPENAI_MODELS)[number]['id'];
export const DEFAULT_OPENAI_MODEL: OpenAIModelId = 'gpt-6.1-sol';

/** Claude models a user can run the assistant on with their own Anthropic API key (Settings page). */
export const ANTHROPIC_MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', hint: 'Most capable, highest cost' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', hint: 'Balanced' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', hint: 'Fastest, lowest cost' },
] as const;
export type AnthropicModelId = (typeof ANTHROPIC_MODELS)[number]['id'];
export const DEFAULT_ANTHROPIC_MODEL: AnthropicModelId = 'claude-sonnet-5-5';

/**
 * Suggestions for the OpenRouter model field, which takes any OpenRouter model that can call tools: leading
 * models on OpenRouter as of October 2026 (its benchmark leaders, then the newest of each major lab).
 */
export const OPENROUTER_MODELS = [
  { id: 'anthropic/claude-opus-5.5', name: 'Claude Opus 5.5' },
  { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5' },
  { id: 'anthropic/claude-fable-5.1', name: 'Claude Fable 5.1' },
  { id: 'qwen/qwen3.8-max-0902', name: 'Qwen3.8 Max' },
  { id: 'openai/gpt-6-astra', name: 'GPT-6 Astra' },
  { id: 'google/gemini-4-argon', name: 'Gemini 4 Argon' },
  { id: 'openai/gpt-6.1-sol', name: 'GPT-6.1 Sol' },
  { id: 'anthropic/claude-opus-5', name: 'Claude Opus 5' },
  { id: 'anthropic/claude-fable-5', name: 'Claude Fable 5' },
  { id: 'meta/muse-spark-1.3', name: 'Muse Spark 1.3' },
  { id: 'anthropic/claude-haiku-5.5', name: 'Claude Haiku 5.5' },
  { id: 'x-ai/grok-4.7', name: 'Grok 4.7' },
  { id: 'deepseek/deepseek-v4-pro-0813', name: 'DeepSeek V4 Pro' },
  { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
  { id: 'google/gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
  { id: 'openai/gpt-6-luna', name: 'GPT-6 Luna' },
  { id: 'z-ai/glm-5.3', name: 'GLM 5.3' },
  { id: 'moonshotai/kimi-k3', name: 'Kimi K3' },
  { id: 'mistralai/mistral-large-4-0', name: 'Mistral Large 4' },
  { id: 'qwen/qwen3.8-flash', name: 'Qwen3.8 Flash' },
] as const;
export const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-sonnet-5.5';
/** An OpenRouter model id: author/slug, with an optional :variant. */
export const OPENROUTER_MODEL_RE = /^[a-z0-9][\w.-]*\/[\w.-]+(:[\w.-]+)?$/i;

/**
 * What powers the assistant: 'default' is the model this server is set up with (the hosted app's); the
 * key providers run on the user's own API key. The desktop app has no model of its own, so its user brings a
 * key, or picks 'claude-agent': the Claude Code they have installed and signed in to, run through the Claude
 * Agent SDK (server/agent/claudeAgent.ts).
 */
export type AssistantProvider = 'default' | 'anthropic' | 'openai' | 'openrouter' | 'claude-agent';
/** The providers that run on the user's own API key. */
export type KeyProvider = Exclude<AssistantProvider, 'default' | 'claude-agent'>;

/** A user's choice of what powers the assistant. The keys themselves never leave the server. */
export interface AssistantSettings {
  provider: AssistantProvider;
  /** Whether this server has a model of its own ('default' can be chosen). */
  builtIn: boolean;
  /** Whether the user's own installed agent can run the assistant ('claude-agent'; the desktop app). */
  agents: boolean;
  anthropicModel: AnthropicModelId;
  openaiModel: OpenAIModelId;
  openrouterModel: string;
  /** Each saved key, masked ("••••abcd"), or null when there is none. */
  anthropicKey: string | null;
  openaiKey: string | null;
  openrouterKey: string | null;
  /** The user's Brave Search API key for web and image search, masked, or null (then the provider's own search is used). */
  braveKey: string | null;
}

/**
 * Body of PUT /api/settings/assistant. A new key replaces the saved one, null removes it, omitted keeps it;
 * an omitted model keeps the saved one.
 */
export interface AssistantSettingsUpdate {
  provider: AssistantProvider;
  anthropicModel?: AnthropicModelId;
  openaiModel?: OpenAIModelId;
  openrouterModel?: string;
  anthropicKey?: string | null;
  openaiKey?: string | null;
  openrouterKey?: string | null;
  /** A new Brave Search API key, null to remove the saved one; omitted keeps it. */
  braveKey?: string | null;
}
