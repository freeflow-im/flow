// How a DM or group DM names itself in a title: the member display names. A meeting's chat (Meet phase 3b) has no name
// either: it is called by its meeting's title.
import type { ChannelDTO } from '@flow/shared';

export function dmTitle(c: ChannelDTO, names: Record<string, string>, me: string): string {
  if (c.kind === 'meeting') return c.meeting?.title || 'Meeting';
  const others = (c.memberIds ?? []).filter((id) => id !== me);
  if (others.length === 0) return `${names[me] ?? 'You'} (you)`; // persistent self-DM
  return others.map((id) => names[id] ?? 'Unknown').sort().join(', ');
}

/** The persistent "notes to self" DM — a `dm` channel whose only member is you.
 * It is the destination behind the Scheduled panel's "🔒 Just me" (#420). */
export function isSelfDm(c: ChannelDTO, me: string): boolean {
  return c.kind === 'dm' && (c.memberIds ?? []).every((id) => id === me);
}
