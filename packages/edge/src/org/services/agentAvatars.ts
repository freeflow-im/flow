// Preset agent avatars. On Node these were PNG files on disk; until they join the Worker's assets there are no presets,
// and an agent starts with no avatar.
import { badRequest } from '../lib/errors.js';

export function listAgentAvatarPresets(): string[] {
  return [];
}

export function readAgentAvatarPreset(_id: string): Buffer {
  throw badRequest('bad_preset', 'unknown avatar preset');
}
