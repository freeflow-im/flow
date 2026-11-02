// APNs payload builder (#248, PUSH_APNS.md § "The payload").
//
// Pure functions, no DB: the outbox (#247) hydrates the row and this turns it
// into the bytes APNs carries. Split out of pushOutbox.ts so the shape can be
// tested — and read — without a database.
//
// Two contracts this file is not free to redesign:
//
//  1. The custom keys are the SAME keys the macOS banner already puts in its
//     `userInfo` (Banners.swift): workspaceId, channelId, messageId and
//     threadRootId-when-present. That is what lets iOS tap-routing reuse the
//     existing `AppState.openNotification` path instead of growing a second
//     one. `notificationId` is the one addition — a tap needs to mark exactly
//     this row read. Do not rename any of them for tidiness.
//  2. The alert strings are the same strings the macOS banner builds in
//     SyncEngine's `.notification` case, so a mention that reads one way on
//     the Mac does not read another way on the phone. `alertStringsFor` below
//     is a straight port of that switch; `plainText` is a port of
//     MentionRendering.plainText. When one moves, move the other — #466/#472
//     moved both, since the mistitled `default:` was in each of them.
//     The one place they differ is kind 3's channel name: this builder has the
//     conversation hydrated, the local banner does not and says the generic
//     string instead.
import { GROUP_MENTION_RE, USER_MENTION_RE, type NotificationKind } from '@flow/shared';
import { config } from '../config.js';
import type { ApnsHeaders, ApnsPayload } from './index.js';

/**
 * Body preview cap. A push is a preview, not the message: Apple's ceiling is
 * 4 KB for an alert payload, and this keeps a worst-case 4-bytes-per-character
 * body under 1 KB — an order of magnitude of headroom over a limit whose
 * breach APNs answers with `PayloadTooLarge` and a dropped notification.
 */
export const BODY_MAX_CHARS = 180;

/**
 * Belt to the braces above: whatever else ends up in the payload, the encoded
 * whole stays under Apple's 4096-byte alert cap. Nothing should ever reach
 * this — every other key is a uuid — but a dropped push is silent, so the
 * builder trims rather than trusting the arithmetic.
 */
export const PAYLOAD_MAX_BYTES = 4000;

/**
 * Subtitle cap (#460). A channel name is short by construction, but a group
 * DM's is every other member's display name joined — unbounded, and it sits in
 * the same 4 KB as the body. Capping it here keeps `fitPayload` below trimming
 * only one thing, and a subtitle wider than the banner is truncated by the
 * phone anyway.
 */
export const SUBTITLE_MAX_CHARS = 60;

/**
 * APNs stops retrying after this. An hour-old alert is noise, not news.
 *
 * Re-checked for #251 and kept. The number bounds how stale a push can be when
 * a phone comes back from a tunnel or a flat battery, and an hour is already
 * past the point where a mention is worth interrupting someone for — while
 * being long enough that a normal commute-length gap still delivers. It also
 * has to cover the badge: an expired push is a badge update that never lands,
 * and the next alert or read is then the only thing that corrects it.
 * Shortening it would trade a rare stale banner for a more often wrong badge.
 */
export const EXPIRATION_S = 3_600;

/** What the outbox knows about a notification when it comes time to send. */
export interface PushContext {
  notificationId: string;
  workspaceId: string;
  channelId: string;
  messageId: string;
  threadRootId: string | null;
  kind: NotificationKind;
  /** Display name of the message author, or the reactor for kind 4. */
  actorName: string | null;
  /** The emoji, for kind 4. */
  reactionEmoji: string | null;
  /** Decrypted message body, mention tokens still in it. */
  body: string;
  /** userId → displayName for the mention tokens this body contains. */
  names: Record<string, string>;
  /**
   * What the conversation calls itself (#460): the channel's `name` for a
   * standard channel, and for a dm/group_dm the other members' display names
   * the way the sidebar joins them. Raw — `subtitleFor` below owns the `#`, so
   * the one rule that decides how a conversation reads on the phone stays in
   * this pure file. Null when the hydration could not name it.
   */
  conversationName: string | null;
  /** Which of the two naming rules applies. */
  channelKind: ChannelKind;
  /**
   * A 1:1 DM whose counterpart is the very person the title names — set by
   * identity, not by comparing strings (operator ruling on #460). Its subtitle
   * would only say again what the title just said, so `subtitleFor` drops it.
   */
  soloDmWithActor: boolean;
}

/** Channel kinds, as the `channel_kind` enum spells them. */
export type ChannelKind = 'standard' | 'dm' | 'group_dm';

/**
 * The middle row of the alert (#460): which conversation this came from, so a
 * banner can be judged without opening it.
 *
 * `#name` for a channel and a bare name for a DM — the same distinction the
 * sidebar and the thread header draw (`packages/web/src/lib/channelTitle.ts`),
 * because a `#` in front of a person's name reads as a channel that doesn't
 * exist. A thread reply needs no special case: notifications carry the channel
 * the thread lives in, which is exactly the row to show.
 *
 * The one conversation that gets no row is a **1:1 DM**, because there the
 * counterpart *is* the sender and the title already names them — "Alice /
 * Alice / lunch at 1?" spends a line saying nothing (operator ruling on #460).
 * The test is who the counterpart is, not whether the two strings match, so it
 * holds for the titles that are not a bare name either: "Alice sent you a
 * message" with the preview off, and "Alice reacted 👍". Group DMs keep their
 * row — there the names are the ones the title leaves out.
 */
export function subtitleFor(
  ctx: Pick<PushContext, 'conversationName' | 'channelKind' | 'soloDmWithActor'>,
  titleNamesConversation = false,
): string | undefined {
  if (ctx.channelKind === 'dm' && ctx.soloDmWithActor) return undefined;
  // The second way a row can say nothing new (#472): a kind-3 title *is* the
  // conversation name ("New activity in #general"), so repeating it underneath
  // spends the line twice. Same drop-the-echo rule as `soloDmWithActor` above,
  // decided by the caller that built the title rather than by comparing
  // strings after the fact.
  if (titleNamesConversation) return undefined;
  return conversationLabel(ctx);
}

/**
 * How a conversation names itself in an alert: `#name` for a channel and a
 * bare name for a DM, capped. Undefined when the hydration could not name it.
 *
 * Shared by the subtitle and by the kind-3 title, so the `#` rule is decided
 * once — a title that hard-coded it would put a `#` in front of a person's
 * name the day a DM's channel is followed.
 */
function conversationLabel(ctx: Pick<PushContext, 'conversationName' | 'channelKind'>): string | undefined {
  const name = oneLine(ctx.conversationName ?? '');
  if (!name) return undefined;
  return truncate(ctx.channelKind === 'standard' ? `#${name}` : name, SUBTITLE_MAX_CHARS);
}

/**
 * Token-free plain text — the server-side port of MentionRendering.plainText.
 * Unknown ids render "@someone" exactly as the Mac does, so a mention of a
 * departed user reads the same on both.
 */
export function plainText(body: string, names: Record<string, string> = {}): string {
  return body
    .replace(USER_MENTION_RE, (_m, id: string) => `@${names[id] ?? 'someone'}`)
    .replace(GROUP_MENTION_RE, (_m, group: string) => `@${group}`);
}

/** Collapse the whitespace a multi-line message carries — a banner is one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Truncate to `max` characters, counting by code point so a 4-byte emoji is
 * never sliced in half (which would put a lone surrogate in the JSON).
 */
export function truncate(text: string, max = BODY_MAX_CHARS): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

/**
 * Title and body, ported from SyncEngine's `.notification` case.
 *
 * `bodyPreview` is the operator switch (PUSH_APNS.md § "Open questions", 1):
 * true is option (a), the message text in the push; false is option (b), where
 * nothing the user wrote leaves the server. Option (b) has no body at all —
 * for every kind but a DM the title already says who and what, and a DM's
 * title is a bare name, so it grows the verb instead ("Alice sent you a
 * message").
 *
 * The operator ruled (a) on 2026-09-01 (decision log), so the switch is on and
 * stays on: it is the one-line reversal should a workspace ever need (b), not
 * a knob to tune. Option (c), the Notification Service Extension, is a later
 * phase.
 *
 * The subtitle (#460) is not on that switch: it says *where*, not what anyone
 * wrote, and the title already carries a display name either way. Turning off
 * the preview should still leave a banner you can act on.
 */
export function alertStringsFor(
  ctx: Pick<
    PushContext,
    'kind' | 'actorName' | 'reactionEmoji' | 'body' | 'names' | 'conversationName' | 'channelKind' | 'soloDmWithActor'
  >,
  bodyPreview = config.pushBodyPreview,
): { title: string; subtitle?: string; body?: string } {
  const who = ctx.actorName ?? 'Someone';
  const label = conversationLabel(ctx);
  // Kind 3 is the one title that names the conversation itself; the subtitle
  // then drops its row rather than saying it again (#472).
  const titleNamesConversation = ctx.kind === 3 && label !== undefined;
  const title = (() => {
    switch (ctx.kind) {
      case 0:
        return `${who} mentioned you`;
      case 1:
        return ctx.actorName ?? 'New direct message';
      case 2:
        return `${who} replied in a thread`;
      case 3:
        // Channel activity from a followed channel (notify_level=all) — nobody
        // mentioned anybody, and a banner that says they did trains the reader
        // to distrust the ones that did (#466/#472). Latent today
        // (`suppressAlertFor` never alerts on kind 3) and fixed before that
        // trap springs; whether kind 3 should ever alert is a separate
        // decision this file does not make.
        return label ? `New activity in ${label}` : 'New channel activity';
      case 4:
        return `${who} reacted ${ctx.reactionEmoji ?? ''}`.trim();
      case 5:
        return `${who} added you to a channel`;
      default: {
        // Exhaustive: `NotificationKind` is a closed union, so adding a kind
        // without a case above is a *compile* error here rather than a banner
        // claiming a mention that never happened — which is exactly how kind 3
        // got mistitled for two releases. The runtime string is the neutral
        // fallback for a row that somehow carries a kind this build predates.
        const unhandled: never = ctx.kind;
        void unhandled;
        return 'New activity';
      }
    }
  })();
  const subtitle = subtitleFor(ctx, titleNamesConversation);
  const where = subtitle ? { subtitle } : {};
  if (!bodyPreview) {
    // A DM's title alone is just a name; every other kind's already reads as a
    // sentence, so only this one needs the verb spelling out.
    return ctx.kind === 1 ? { title: `${title} sent you a message`, ...where } : { title, ...where };
  }
  const body = truncate(oneLine(plainText(ctx.body, ctx.names)));
  return body ? { title, ...where, body } : { title, ...where };
}

/**
 * The alert payload: `aps` per Apple, then the routing keys the clients share.
 *
 * `badge` is the server-authoritative unread total the outbox computed once for
 * this notification (#63's `unreadCount`), so a phone that has been asleep
 * still lands on the right number rather than incrementing from a stale one.
 */
export function buildPushPayload(ctx: PushContext, badge: number, sound = true): ApnsPayload {
  const alert = alertStringsFor(ctx);
  const payload: ApnsPayload = {
    aps: {
      alert,
      // #251: the `sound` pref, off = a banner that doesn't make a noise. The
      // key is omitted rather than sent empty — `sound: ''` is not a documented
      // "silent" value, and APNs plays the default for anything it can't
      // resolve.
      ...(sound ? { sound: 'default' } : {}),
      badge,
      'thread-id': ctx.channelId, // groups a channel's pushes in Notification Center
    },
    workspaceId: ctx.workspaceId,
    channelId: ctx.channelId,
    messageId: ctx.messageId,
    ...(ctx.threadRootId ? { threadRootId: ctx.threadRootId } : {}),
    notificationId: ctx.notificationId, // lets the tap mark exactly this row read
  };
  return fitPayload(payload);
}

/**
 * The silent counterpart (PUSH_APNS.md § "Silent pushes keep the badge
 * honest"): no alert, no sound, just the count, so reading a mention on the
 * laptop drops the phone's badge. `content-available` is what gets it to
 * `didReceiveRemoteNotification` without waking the UI.
 */
export function buildBadgeSyncPayload(badge: number): ApnsPayload {
  return { aps: { badge, 'content-available': 1 } };
}

/**
 * The badge-only push a *muted* notification sends instead of an alert (#251).
 *
 * A kind the user has turned off, or any kind while a DND status is on, must
 * not ring — but the row is still unread, and a phone whose badge stops
 * counting it is lying. `aps` with nothing but `badge` displays nothing: iOS
 * applies the number and shows no banner, no sound, no Notification Center row.
 *
 * Deliberately an *alert* push rather than the `content-available` one
 * `buildBadgeSyncPayload` builds. Background pushes are metered per app
 * (§ "Silent pushes keep the badge honest"), and a muted mention is a *new*
 * notification, not a correction to an old one — spending the background budget
 * on the common case would starve the corrections that actually need it.
 */
export function buildMutedBadgePayload(badge: number): ApnsPayload {
  return { aps: { badge } };
}

/** Alert headers.
 *
 * No `collapse-id` (#251). It was wired to kind 3 (channel activity), which
 * `suppressAlertFor` never alerts on and the outbox therefore never sends — so
 * the branch could not fire. Extending it to the kinds that *do* push was
 * considered and rejected: collapsing replaces the previous notification, so a
 * busy channel would show one mention and silently drop the four before it,
 * and a tap could only route to the survivor. `thread-id` already gives a busy
 * channel one stacked group in Notification Center, which is the grouping that
 * was actually wanted. Kept in `ApnsHeaders` for the badge-sync path and any
 * future genuinely-replaceable push.
 *
 * `priority` is 5 for a muted push: nothing is displayed, so there is no reason
 * to wake a sleeping radio for it. */
export function pushHeadersFor(ctx: Pick<PushContext, 'kind' | 'channelId'>, muted = false): ApnsHeaders {
  return {
    pushType: 'alert',
    priority: muted ? 5 : 10,
    expiration: Math.floor(Date.now() / 1000) + EXPIRATION_S,
  };
}

/**
 * Badge-sync headers. Priority 5 is mandatory for a background push — Apple
 * rejects `background` at 10 — and it is also honest: a badge correction can
 * wait for the radio to be up anyway.
 */
export function badgeSyncHeaders(): ApnsHeaders {
  return { pushType: 'background', priority: 5, expiration: Math.floor(Date.now() / 1000) + EXPIRATION_S };
}

/** Shrink the body until the encoded payload fits the alert cap. */
export function fitPayload(payload: ApnsPayload): ApnsPayload {
  let body = payload.aps.alert?.body;
  while (body && Buffer.byteLength(JSON.stringify(payload)) > PAYLOAD_MAX_BYTES) {
    body = truncate(body, Math.floor([...body].length / 2));
    payload.aps.alert = { ...payload.aps.alert, body };
    if ([...body].length <= 1) {
      delete payload.aps.alert.body;
      break;
    }
  }
  return payload;
}
