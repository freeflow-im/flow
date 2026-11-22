// Chat's address (task #24): the page says which organization and channel is open, so it can be reloaded, bookmarked
// and shared.
//
//   /chat/<org-slug>                              the organization, on wherever it was left
//   /chat/<org-slug>/<channel-name>               a channel (`general`)
//   /chat/<org-slug>/<channel-id>                 a DM or group DM, which has no name (and any channel, by id)
//   /chat/<org-slug>/<channel>/thread/<root-id>   with a thread open
//   /chat/<org-slug>/~activity                    a view of its own (`~search`, `~scheduled`, …)
//
// An organization's slug is unique, and a channel's name unique in it. A channel name never starts with `~`
// (CHANNEL_NAME_RE), so a view cannot be mistaken for one. The older addresses (`/chat/?open=channel:<id>`) still work:
// they are lib/chatIntents.ts', and once one is applied the address is rewritten to this form.
import { CHAT_PATH } from '@flow/shared';
import {
  ACTIVITY_VIEW_ID,
  CHANNEL_BROWSER_VIEW_ID,
  DIRECTORY_VIEW_ID,
  MEETINGS_VIEW_ID,
  SCHEDULED_VIEW_ID,
  SEARCH_VIEW_ID,
} from '../state';

/** Each view's segment, by its sentinel channel id. */
const VIEWS: Record<string, string> = {
  [ACTIVITY_VIEW_ID]: '~activity',
  [SEARCH_VIEW_ID]: '~search',
  [SCHEDULED_VIEW_ID]: '~scheduled',
  [DIRECTORY_VIEW_ID]: '~people',
  [CHANNEL_BROWSER_VIEW_ID]: '~channels',
  [MEETINGS_VIEW_ID]: '~meetings',
};
const VIEW_IDS: Record<string, string> = Object.fromEntries(Object.entries(VIEWS).map(([id, seg]) => [seg, id]));

/** Pages of Chat's own under its path, which are not an organization's (lib/visitor.ts, shared/meetingChat.ts). */
const OWN_PAGES = new Set(['visit', 'meeting']);

const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/i;
const SEGMENT = /^[A-Za-z0-9~_-]{1,80}$/;

export interface ChatPathTarget {
  /** The organization's slug, lowercased. */
  slug: string;
  /** A view's sentinel id (`__activity__`), a channel's name or its id; null for the organization alone. */
  channel: { view: string } | { ref: string } | null;
  threadRootId: string | null;
}

const base = () => CHAT_PATH.replace(/\/$/, '');

/** What an address asks Chat to open, or null when it is not an organization's (`/chat`, `/chat/visit/…`, other apps). */
export function parseChatPath(pathname: string): ChatPathTarget | null {
  const prefix = `${base()}/`;
  if (!pathname.startsWith(prefix)) return null;
  let parts: string[];
  try {
    parts = pathname.slice(prefix.length).split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  const [slug, channel, keyword, rootId, ...rest] = parts;
  if (!slug || !SLUG.test(slug) || OWN_PAGES.has(slug.toLowerCase()) || rest.length) return null;
  if (channel === undefined) return { slug: slug.toLowerCase(), channel: null, threadRootId: null };
  if (!SEGMENT.test(channel)) return null;
  if (channel.startsWith('~')) {
    const view = VIEW_IDS[channel.toLowerCase()];
    return view && keyword === undefined ? { slug: slug.toLowerCase(), channel: { view }, threadRootId: null } : null;
  }
  if (keyword !== undefined && (keyword !== 'thread' || !rootId || !SEGMENT.test(rootId))) return null;
  return { slug: slug.toLowerCase(), channel: { ref: channel }, threadRootId: rootId ?? null };
}

/** The address of what is open: a channel by its name (a nameless one by id), a view by its segment. */
export function chatPathFor(
  slug: string,
  open: { channelId: string | null; name?: string | null; threadRootId?: string | null },
): string {
  const org = `${base()}/${encodeURIComponent(slug)}`;
  const id = open.channelId;
  if (!id) return org;
  const view = VIEWS[id];
  if (view) return `${org}/${view}`;
  const channel = `${org}/${encodeURIComponent(open.name || id)}`;
  return open.threadRootId ? `${channel}/thread/${encodeURIComponent(open.threadRootId)}` : channel;
}

/** The channel a path's segment names: by name (as the server compares them, case-blind), else by id. */
export function resolveChannelRef<C extends { id: string; name: string | null }>(ref: string, channels: readonly C[]): C | null {
  const name = ref.toLowerCase();
  return channels.find((c) => c.name !== null && c.name.toLowerCase() === name) ?? channels.find((c) => c.id === ref) ?? null;
}
