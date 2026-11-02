// The canned statuses the account menu's "Set a status…" offers, shared by Chat and Docs so both set the same ones
// (they were Chat's sidebar status picker's, components/StatusPicker.tsx in packages/web). Each is sent as
// `PATCH /v1/me { statusEmoji, statusText, statusSuppressAlerts }`; `suppresses` marks the do-not-disturb kind, which
// pauses notifications server-side.
export interface StatusOption {
  emoji: string;
  text: string;
  suppresses?: boolean;
}

export const STATUS_OPTIONS: StatusOption[] = [
  { emoji: '🎧', text: 'Focusing', suppresses: true },
  { emoji: '🗓️', text: 'In a meeting', suppresses: true },
  { emoji: '🌴', text: 'Vacationing' },
  { emoji: '🏠', text: 'Working remotely' },
  { emoji: '🤒', text: 'Out sick' },
  { emoji: '🍽️', text: 'At lunch', suppresses: true },
  { emoji: '💬', text: 'Available' },
  { emoji: '🚫', text: 'Do not disturb', suppresses: true },
];

/**
 * Away, as the account menu's presence row sets it. Flow has no presence override (presence is the socket being
 * connected), so "Set away" is this status: the row reads Away while it is the user's status, and "Set active"
 * clears it.
 */
export const AWAY_STATUS: StatusOption = { emoji: '💤', text: 'Away' };

/** Whether a user's status is the away one. */
export function isAway(status: { emoji?: string | null; text?: string | null } | null | undefined): boolean {
  return !!status && status.emoji === AWAY_STATUS.emoji && status.text === AWAY_STATUS.text;
}

/** The `PATCH /v1/me` body that sets a status ('' and '' clear it). */
export function statusPatch(option: StatusOption | null): { statusEmoji: string; statusText: string; statusSuppressAlerts: boolean } {
  return { statusEmoji: option?.emoji ?? '', statusText: option?.text ?? '', statusSuppressAlerts: !!option?.suppresses };
}
