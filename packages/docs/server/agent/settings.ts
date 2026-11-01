// Per-user assistant settings: whether the live assistant runs on the server's model or on the user's own
// Anthropic, OpenAI or OpenRouter API key, and which model. Keys are stored encrypted (the same server key as
// connector credentials) and only ever returned masked. The desktop app has no model of its own: its user
// brings a key, and on the first run one already set in their environment is used (adoptFromEnvironment).
// A user's Brave Search API key, for the assistant's web and image search, is kept the same way.
import {
  ANTHROPIC_MODELS,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  OPENAI_MODELS,
  OPENROUTER_MODEL_RE,
  type AnthropicModelId,
  type AssistantProvider,
  type AssistantSettings,
  type AssistantSettingsUpdate,
  type KeyProvider,
  type OpenAIModelId,
} from '../../shared/agent/protocol.ts';
import { decrypt, encrypt, loadKey, mask } from '../connectors/secrets.ts';
import type { DB } from '../db.ts';

export type { KeyProvider };
const KEY_PROVIDERS: KeyProvider[] = ['anthropic', 'openai', 'openrouter'];
const PROVIDER_NAMES: Record<KeyProvider, string> = { anthropic: 'Anthropic', openai: 'OpenAI', openrouter: 'OpenRouter' };
/** The environment variables a key is looked for in, by provider. */
const ENV_KEYS: Record<KeyProvider, string> = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', openrouter: 'OPENROUTER_API_KEY' };

/** What a user's assistant runs on when it is their own key. */
export interface ModelChoice {
  provider: KeyProvider;
  apiKey: string;
  model: string;
}

/** Checks a key before it is saved: it must be accepted and able to use the model. Throws SettingsError. */
export type KeyCheck = (provider: KeyProvider, apiKey: string, model: string) => Promise<void>;
/** Checks a Brave Search API key before it is saved: what is wrong with it, or null. */
export type SearchKeyCheck = (apiKey: string) => Promise<string | null>;

interface Row {
  provider: string;
  openai_model: string;
  openai_key: string | null;
  openai_key_masked: string | null;
  anthropic_model: string | null;
  anthropic_key: string | null;
  anthropic_key_masked: string | null;
  openrouter_model: string | null;
  openrouter_key: string | null;
  openrouter_key_masked: string | null;
  brave_key: string | null;
  brave_key_masked: string | null;
}

export class SettingsError extends Error {}

const isOpenAIModel = (v: unknown): v is OpenAIModelId => OPENAI_MODELS.some((m) => m.id === v);
const isAnthropicModel = (v: unknown): v is AnthropicModelId => ANTHROPIC_MODELS.some((m) => m.id === v);
const isOpenRouterModel = (v: unknown): v is string => typeof v === 'string' && v.length <= 200 && OPENROUTER_MODEL_RE.test(v);

const modelOf = (row: Row | undefined, p: KeyProvider): string => {
  if (p === 'anthropic') return isAnthropicModel(row?.anthropic_model) ? row.anthropic_model : DEFAULT_ANTHROPIC_MODEL;
  if (p === 'openai') return isOpenAIModel(row?.openai_model) ? row.openai_model : DEFAULT_OPENAI_MODEL;
  return isOpenRouterModel(row?.openrouter_model) ? row.openrouter_model : DEFAULT_OPENROUTER_MODEL;
};
const keyCol = (p: KeyProvider) => `${p}_key` as const;
const maskedCol = (p: KeyProvider) => `${p}_key_masked` as const;

export class AssistantSettingsStore {
  private db: DB;
  private key: Buffer;
  /** Whether this server has a model of its own; without one, the assistant needs the user's key. */
  readonly builtIn: boolean;
  /** Whether the user's own installed agent can run the assistant ('claude-agent'; the desktop app). */
  readonly agents: boolean;

  constructor(db: DB, keyFile: string, opts: { builtIn?: boolean; agents?: boolean } = {}) {
    this.db = db;
    this.key = loadKey(keyFile);
    this.builtIn = opts.builtIn ?? true;
    this.agents = opts.agents ?? false;
  }

  private row(userId: string): Row | undefined {
    return this.db.prepare('SELECT * FROM assistant_settings WHERE user_id = ?').get(userId) as Row | undefined;
  }

  /**
   * The provider in effect: the user's own agent when chosen here, a key provider if its key is saved, else the
   * server's model (or none, without one).
   */
  private provider(row: Row | undefined): AssistantProvider {
    const p = row?.provider as AssistantProvider | undefined;
    if (p === 'claude-agent') return this.agents ? p : 'default';
    return p && p !== 'default' && KEY_PROVIDERS.includes(p) && row?.[keyCol(p)] ? p : 'default';
  }

  /** What runs the user's turns: the assistant's own loop, or their own installed agent. */
  driver(userId: string): 'builtin' | 'claude-agent' {
    return this.provider(this.row(userId)) === 'claude-agent' ? 'claude-agent' : 'builtin';
  }

  get(userId: string): AssistantSettings {
    const row = this.row(userId);
    const masked = (p: KeyProvider) => (row?.[keyCol(p)] ? (row[maskedCol(p)] ?? '••••') : null);
    return {
      provider: this.provider(row),
      builtIn: this.builtIn,
      agents: this.agents,
      anthropicModel: modelOf(row, 'anthropic') as AnthropicModelId,
      openaiModel: modelOf(row, 'openai') as OpenAIModelId,
      openrouterModel: modelOf(row, 'openrouter'),
      anthropicKey: masked('anthropic'),
      openaiKey: masked('openai'),
      openrouterKey: masked('openrouter'),
      braveKey: row?.brave_key ? (row.brave_key_masked ?? '••••') : null,
    };
  }

  /** The key and model to run the user's assistant on, or null when they use the server's model (or have none). */
  choice(userId: string): ModelChoice | null {
    const row = this.row(userId);
    const p = this.provider(row);
    if (p === 'default' || p === 'claude-agent') return null;
    return { provider: p, apiKey: decrypt(this.key, row![keyCol(p)]!).api_key, model: modelOf(row, p) };
  }

  /** The user's stored OpenAI key, whatever the assistant runs on (image editing uses it), or null. */
  openaiKey(userId: string): string | null {
    const row = this.row(userId);
    return row?.openai_key ? decrypt(this.key, row.openai_key).api_key : null;
  }

  /** The user's Brave Search API key for the search tools, or null. */
  braveKey(userId: string): string | null {
    const row = this.row(userId);
    return row?.brave_key ? decrypt(this.key, row.brave_key).api_key : null;
  }

  /**
   * Validate and save. `check` is called with the key and model of the chosen provider, so a wrong key or a
   * model the key cannot use is reported here rather than in the chat; `checkSearch` a new Brave Search key.
   */
  async update(userId: string, body: Partial<AssistantSettingsUpdate>, check: KeyCheck, checkSearch: SearchKeyCheck = async () => null): Promise<AssistantSettings> {
    const provider = body.provider;
    if (provider === 'claude-agent' && !this.agents) throw new SettingsError('Your own agent can only run the assistant in the desktop app.');
    if (provider !== 'default' && provider !== 'claude-agent' && !KEY_PROVIDERS.includes(provider as KeyProvider)) throw new SettingsError('Choose what the assistant runs on.');
    // Without a model of its own, 'default' is no model at all (a key was removed): the assistant asks for one.
    if (body.anthropicModel !== undefined && !isAnthropicModel(body.anthropicModel)) throw new SettingsError('Choose one of the listed Claude models.');
    if (body.openaiModel !== undefined && !isOpenAIModel(body.openaiModel)) throw new SettingsError('Choose one of the listed OpenAI models.');
    if (body.openrouterModel !== undefined && !isOpenRouterModel(typeof body.openrouterModel === 'string' ? body.openrouterModel.trim() : body.openrouterModel)) {
      throw new SettingsError('Enter an OpenRouter model id, such as anthropic/claude-sonnet-5.5.');
    }
    const row = this.row(userId);
    const models = {
      anthropic: body.anthropicModel ?? modelOf(row, 'anthropic'),
      openai: body.openaiModel ?? modelOf(row, 'openai'),
      openrouter: body.openrouterModel?.trim() ?? modelOf(row, 'openrouter'),
    };
    // Each key: a new one replaces the saved one, null removes it, omitted keeps it.
    const keys = {} as Record<KeyProvider, { stored: string | null; masked: string | null; plain: string | null }>;
    for (const p of KEY_PROVIDERS) {
      const stored = row?.[keyCol(p)] ?? null;
      keys[p] = { stored, masked: row?.[maskedCol(p)] ?? null, plain: stored ? decrypt(this.key, stored).api_key : null };
      const entered = body[`${p}Key` as const];
      if (entered === null) keys[p] = { stored: null, masked: null, plain: null };
      else if (entered !== undefined) {
        if (typeof entered !== 'string') throw new SettingsError('The API key is not valid.');
        const k = entered.trim();
        if (k) {
          if (k.length > 400 || /\s/.test(k)) throw new SettingsError('The API key is not valid.');
          keys[p] = { stored: encrypt(this.key, { api_key: k }), masked: mask(k), plain: k };
        }
      }
    }
    // The Brave Search key, the same way: new, removed (null) or kept (omitted).
    let brave = { stored: row?.brave_key ?? null, masked: row?.brave_key_masked ?? null };
    if (body.braveKey === null) brave = { stored: null, masked: null };
    else if (body.braveKey !== undefined) {
      if (typeof body.braveKey !== 'string') throw new SettingsError('The Brave Search API key is not valid.');
      const k = body.braveKey.trim();
      if (k) {
        if (k.length > 400 || /\s/.test(k)) throw new SettingsError('The Brave Search API key is not valid.');
        const problem = await checkSearch(k);
        if (problem) throw new SettingsError(problem);
        brave = { stored: encrypt(this.key, { api_key: k }), masked: mask(k) };
      }
    }
    if (provider !== 'default' && provider !== 'claude-agent') {
      const p = provider as KeyProvider;
      const apiKey = keys[p].plain;
      if (!apiKey) throw new SettingsError(`Enter your ${PROVIDER_NAMES[p]} API key to use ${PROVIDER_NAMES[p]}.`);
      await check(p, apiKey, models[p]);
    }
    this.save(userId, provider as AssistantProvider, models, keys, brave);
    return this.get(userId);
  }

  /**
   * The first run of the desktop app: when the user has no settings yet, use a key already set in their
   * environment (`env`), Anthropic's first, then OpenAI's, then OpenRouter's. Every key found is saved, so
   * switching provider later needs none typed. Returns the provider chosen, or null when there was nothing to do.
   */
  adoptFromEnvironment(userId: string, env: Record<string, string | undefined>): KeyProvider | null {
    if (this.row(userId)) return null;
    const keys = {} as Record<KeyProvider, { stored: string | null; masked: string | null }>;
    let chosen: KeyProvider | null = null;
    for (const p of KEY_PROVIDERS) {
      const k = env[ENV_KEYS[p]]?.trim();
      const usable = !!k && k.length <= 400 && !/\s/.test(k);
      keys[p] = usable ? { stored: encrypt(this.key, { api_key: k }), masked: mask(k) } : { stored: null, masked: null };
      if (usable) chosen ??= p;
    }
    if (!chosen) return null;
    this.save(userId, chosen, { anthropic: DEFAULT_ANTHROPIC_MODEL, openai: DEFAULT_OPENAI_MODEL, openrouter: DEFAULT_OPENROUTER_MODEL }, keys);
    return chosen;
  }

  private save(
    userId: string,
    provider: AssistantProvider,
    models: Record<KeyProvider, string>,
    keys: Record<KeyProvider, { stored: string | null; masked: string | null }>,
    brave: { stored: string | null; masked: string | null } = { stored: null, masked: null },
  ): void {
    this.db
      .prepare(
        `INSERT INTO assistant_settings (user_id, provider, openai_model, openai_key, openai_key_masked, anthropic_model, anthropic_key, anthropic_key_masked,
           openrouter_model, openrouter_key, openrouter_key_masked, brave_key, brave_key_masked, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET provider = excluded.provider, openai_model = excluded.openai_model, openai_key = excluded.openai_key,
           openai_key_masked = excluded.openai_key_masked, anthropic_model = excluded.anthropic_model, anthropic_key = excluded.anthropic_key,
           anthropic_key_masked = excluded.anthropic_key_masked, openrouter_model = excluded.openrouter_model, openrouter_key = excluded.openrouter_key,
           openrouter_key_masked = excluded.openrouter_key_masked, brave_key = excluded.brave_key, brave_key_masked = excluded.brave_key_masked,
           updated_at = excluded.updated_at`,
      )
      .run(
        userId,
        provider,
        models.openai,
        keys.openai.stored,
        keys.openai.masked,
        models.anthropic,
        keys.anthropic.stored,
        keys.anthropic.masked,
        models.openrouter,
        keys.openrouter.stored,
        keys.openrouter.masked,
        brave.stored,
        brave.masked,
        new Date().toISOString(),
      );
  }
}
