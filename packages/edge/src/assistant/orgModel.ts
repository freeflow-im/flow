// The organization's model (operator ruling 2026-11-11): one setting per organization, made by its admins, that every
// agent's runtime runs on, people's assistants and hosted shared agents alike. It is kept by the Assistant object named
// `org:<organizationId>` (its own AssistantSettingsStore, user `org`); each runtime asks for it at the start of a turn and
// keeps it a minute, and this store answers the loop from that copy instead of its own rows.
import { AssistantSettingsStore, type ModelChoice } from '@flow/docs/server/agent/settings.ts';
import { ANTHROPIC_MODELS, OPENAI_MODELS, OPENROUTER_MODEL_RE, type AssistantSettings, type ModelEntryProvider } from '@flow/shared/assistant';

/** The organization's settings as the runtimes use them: shown (masked) and in effect (the keys, opened). */
export interface OrgModel {
  shown: AssistantSettings;
  choice: ModelChoice | null;
  braveKey: string | null;
  openaiKey: string | null;
  /** The list entry this runtime runs on (task #26), or null (the built-in model, or none); `pinMissing`: its pin fell back. */
  entryId?: string | null;
  pinMissing?: boolean;
}

/** The id of the object that keeps an organization's model. */
export const orgModelKey = (organizationId: string) => `org:${organizationId}`;
/** Its row in that object's store. */
export const ORG_ROW = 'org';

/** Answers the loop from the organization's model, whoever's turn it is; with none known yet, the built-in model. */
export class OrgModelSettings extends AssistantSettingsStore {
  current: OrgModel | null = null;
  override driver(): 'builtin' | 'claude-agent' {
    return 'builtin';
  }
  override get(userId: string): AssistantSettings {
    return this.current?.shown ?? super.get(userId);
  }
  override choice(): ModelChoice | null {
    return this.current?.choice ?? null;
  }
  override braveKey(): string | null {
    return this.current?.braveKey ?? null;
  }
  override openaiKey(): string | null {
    return this.current?.openaiKey ?? null;
  }
}

// ---- The organization's model list (task #26) ------------------------------------------------------------------------
// Several provider+model entries, one the default; an agent pinned to one (its definition's `modelId`) runs on it while it
// is listed and its provider has a key, and on the default otherwise. The keys stay in the settings row above, one per
// provider; the list is its own table in the same `org:<id>` object. The first read seeds it from the single model the
// organization had before, so nothing changes for anyone until an admin adds a second.

/** The list's table, an Assistant object migration (only the `org:<id>` object writes to it). */
export const ORG_MODELS_DDL = ['CREATE TABLE IF NOT EXISTS org_models (id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, position INTEGER NOT NULL)'];
/** Its `assistant_state` keys: the default entry's id, and that the list was seeded. */
const DEFAULT_KEY = 'org_model_default';
const SEEDED_KEY = 'org_models_seeded';

export interface ModelRow { id: string; provider: ModelEntryProvider; model: string }

interface Sql { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } }

const PROVIDERS: readonly ModelEntryProvider[] = ['default', 'anthropic', 'openai', 'openrouter'];
const isProvider = (v: unknown): v is ModelEntryProvider => PROVIDERS.includes(v as ModelEntryProvider);

/** The model an entry names, checked against the catalogues; null when it is not one an entry may have. */
export function cleanModel(provider: ModelEntryProvider, model: unknown): string | null {
  if (provider === 'default') return '';
  if (typeof model !== 'string') return null;
  const m = model.trim();
  if (provider === 'anthropic') return ANTHROPIC_MODELS.some((x) => x.id === m) ? m : null;
  if (provider === 'openai') return OPENAI_MODELS.some((x) => x.id === m) ? m : null;
  return m.length <= 200 && OPENROUTER_MODEL_RE.test(m) ? m : null;
}

export class OrgModelList {
  constructor(private sql: Sql) {}

  private stateOf(key: string): string | null {
    return (this.sql.exec('SELECT value FROM assistant_state WHERE key = ?', key).toArray()[0]?.value as string | undefined) ?? null;
  }
  private setState(key: string, value: string | null): void {
    if (value === null) this.sql.exec('DELETE FROM assistant_state WHERE key = ?', key);
    else this.sql.exec('INSERT INTO assistant_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
  }

  rows(): ModelRow[] {
    return this.sql
      .exec('SELECT id, provider, model FROM org_models ORDER BY position, id')
      .toArray()
      .filter((r) => isProvider(r.provider))
      .map((r) => ({ id: String(r.id), provider: r.provider as ModelEntryProvider, model: String(r.model) }));
  }

  /** The default entry's id, if it is still listed. */
  defaultId(): string | null {
    const id = this.stateOf(DEFAULT_KEY);
    return id && this.rows().some((r) => r.id === id) ? id : null;
  }

  /** Once: the model the organization ran on before the list, as its first entry and default. */
  seed(shown: AssistantSettings): void {
    if (this.stateOf(SEEDED_KEY)) return;
    this.setState(SEEDED_KEY, '1');
    if (this.rows().length) return;
    const p = shown.provider;
    if (p === 'anthropic' || p === 'openai' || p === 'openrouter') this.add(p, { anthropic: shown.anthropicModel, openai: shown.openaiModel, openrouter: shown.openrouterModel }[p], true);
    else if (shown.builtIn) this.add('default', '', true);
  }

  /** Adds an entry (or finds the same provider+model already listed) and returns its id; the first is the default. */
  add(provider: ModelEntryProvider, model: string, makeDefault = false): string {
    this.setState(SEEDED_KEY, '1');
    const rows = this.rows();
    const same = rows.find((r) => r.provider === provider && r.model === model);
    const id = same?.id ?? crypto.randomUUID();
    if (!same) this.sql.exec('INSERT INTO org_models (id, provider, model, position) VALUES (?, ?, ?, ?)', id, provider, model, rows.length);
    if (makeDefault || !this.defaultId()) this.setState(DEFAULT_KEY, id);
    return id;
  }

  /** Removes an entry; when it was the default, the first one left becomes the default. Agents pinned to it fall back. */
  remove(id: string): boolean {
    if (!this.rows().some((r) => r.id === id)) return false;
    this.sql.exec('DELETE FROM org_models WHERE id = ?', id);
    if (this.stateOf(DEFAULT_KEY) === id) this.setState(DEFAULT_KEY, this.rows()[0]?.id ?? null);
    return true;
  }

  setDefault(id: string): boolean {
    if (!this.rows().some((r) => r.id === id)) return false;
    this.setState(DEFAULT_KEY, id);
    return true;
  }

  /**
   * What an agent pinned to `pin` runs on: the pinned entry while it is listed and `ready`, else the default (when ready),
   * else null (the built-in model if the server has one, else none). `missing`: there was a pin and it could not be used.
   */
  resolve(pin: string | null | undefined, ready: (r: ModelRow) => boolean): { entry: ModelRow | null; missing: boolean } {
    const rows = this.rows();
    const pinned = pin ? rows.find((r) => r.id === pin) : undefined;
    if (pinned && ready(pinned)) return { entry: pinned, missing: false };
    const def = rows.find((r) => r.id === this.defaultId());
    return { entry: def && ready(def) ? def : null, missing: !!pin };
  }
}
