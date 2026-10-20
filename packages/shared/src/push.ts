// Android notification channels (docs/design/ANDROID.md phase 3), one per
// NotificationKind. The server's FCM driver names a channel on every alert
// push and the app creates the channels at sign-in; Android then lists them
// in the app's system settings as per-kind switches — the "mute UI for free"
// the design counts on. One list, so the two sides cannot drift.
import type { NotificationKind } from './dto.js';

export interface AndroidNotificationChannel {
  id: string;
  /** User-facing, as Android shows it in Settings. */
  name: string;
  description: string;
  /** Android importance: 4 = heads-up banner, 3 = sound, 2 = silent in the shade. */
  importance: 2 | 3 | 4;
}

export const ANDROID_NOTIFICATION_CHANNELS: readonly AndroidNotificationChannel[] = [
  { id: 'dms', name: 'Direct messages', description: 'Messages sent directly to you', importance: 4 },
  { id: 'mentions', name: 'Mentions', description: 'When someone @-mentions you', importance: 4 },
  { id: 'threads', name: 'Thread replies', description: 'Replies in threads you are part of', importance: 3 },
  { id: 'invites', name: 'Channel invites', description: 'When someone adds you to a channel', importance: 3 },
  { id: 'reactions', name: 'Reactions', description: 'Reactions to your messages', importance: 2 },
  { id: 'channels', name: 'Channel activity', description: 'Activity in channels you follow', importance: 2 },
  { id: 'general', name: 'Other', description: 'Everything else', importance: 3 },
];

/** Kind → channel id, the mapping the FCM driver applies. */
const CHANNEL_FOR_KIND: Record<NotificationKind, string> = {
  0: 'mentions',
  1: 'dms',
  2: 'threads',
  3: 'channels',
  4: 'reactions',
  5: 'invites',
};

export const ANDROID_DEFAULT_CHANNEL = 'general';

/** The channel a push of this kind lands in; unknown kinds go to the default. */
export function androidChannelForKind(kind: unknown): string {
  const n = typeof kind === 'number' ? kind : typeof kind === 'string' ? Number(kind) : NaN;
  return Number.isInteger(n) ? (CHANNEL_FOR_KIND[n as NotificationKind] ?? ANDROID_DEFAULT_CHANNEL) : ANDROID_DEFAULT_CHANNEL;
}
