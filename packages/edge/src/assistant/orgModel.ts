// The organization's model (operator ruling 2026-11-11): one setting per organization, made by its admins, that every
// agent's runtime runs on, people's assistants and hosted shared agents alike. It is kept by the Assistant object named
// `org:<organizationId>` (its own AssistantSettingsStore, user `org`); each runtime asks for it at the start of a turn and
// keeps it a minute, and this store answers the loop from that copy instead of its own rows.
import { AssistantSettingsStore, type ModelChoice } from '@flow/docs/server/agent/settings.ts';
import type { AssistantSettings } from '@flow/shared/assistant';

/** The organization's settings as the runtimes use them: shown (masked) and in effect (the keys, opened). */
export interface OrgModel { shown: AssistantSettings; choice: ModelChoice | null; braveKey: string | null; openaiKey: string | null }

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
