// What another page of the suite asks Chat for, read in one place (docs/specs/platform.md §5.3, phase 6.4): the suite
// bars' pages (`?open=chooser|admin|invite|activity|profile`), an object's address (`?open=artifact:<id>`,
// `?open=channel:<id>` with an optional `&text=` for the `chat-message` create intent, `?open=message:<id>`) and the share
// intent (`?share=<ref>`, an artifact's Share dialog). App.tsx reads the address once and applies it once signed in.
import { parseReference, type ArtifactDTO, type MessageDTO, type Reference } from '@flow/shared';
import { CHAT_PAGES, type ChatPage } from '@flow/suite-bar';

export type ChatIntent =
  | { kind: 'page'; page: ChatPage }
  | { kind: 'artifact'; id: string }
  | { kind: 'channel'; id: string; text?: string }
  | { kind: 'message'; id: string }
  | { kind: 'share'; ref: Reference };

/** What the address asks of Chat, or null. */
export function readChatIntent(search: string): ChatIntent | null {
  const q = new URLSearchParams(search);
  const share = q.get('share');
  if (share !== null) {
    const ref = parseReference(share);
    return ref ? { kind: 'share', ref } : null;
  }
  const open = q.get('open');
  if (open === null) return null;
  if ((CHAT_PAGES as readonly string[]).includes(open)) return { kind: 'page', page: open as ChatPage };
  const m = /^(artifact|channel|message):(.+)$/.exec(open);
  if (!m) return null;
  const id = m[2]!;
  if (m[1] === 'channel') {
    const text = q.get('text');
    return { kind: 'channel', id, ...(text ? { text } : {}) };
  }
  return { kind: m[1] as 'artifact' | 'message', id };
}

/** The query string without what `readChatIntent` reads ('' when nothing is left; else with its `?`). */
export function withoutChatIntent(search: string): string {
  const q = new URLSearchParams(search);
  for (const k of ['open', 'share', 'text']) q.delete(k);
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** What applying an intent needs of the app: its API, its selection, and a way to say what went wrong. */
export interface ChatIntentDeps {
  api<T>(method: string, path: string): Promise<T>;
  /** The channels the person can open here (their sidebar's). */
  channelIds: () => string[];
  openArtifactIn(channelId: string, artifactId: string): void;
  selectArtifact(artifactId: string): void;
  selectChannel(channelId: string): void;
  jumpToMessage(channelId: string, messageId: string, threadRootId: string | null): void;
  /** The composer's draft in a channel (the `chat-message` create intent). */
  setDraft(channelId: string, text: string): void;
  /** The artifact Share dialog. */
  shareArtifact(artifactId: string): void;
  notice(text: string): void;
}

/**
 * Applies an object's intent (a page is the suite bar's and App.tsx's own): an artifact opens in the side panel, in its
 * channel when the person is in it (else over the current one, as someone it was shared with by id); a channel opens,
 * with the text in its composer; a message's channel opens on it (its thread, for a reply); a share of an artifact opens
 * its Share dialog. Anything not there for the person is said once.
 */
export async function applyChatIntent(intent: ChatIntent, deps: ChatIntentDeps): Promise<void> {
  if (intent.kind === 'page') return;
  if (intent.kind === 'share') {
    if (intent.ref.app === 'chat' && intent.ref.kind === 'artifact') return deps.shareArtifact(intent.ref.id);
    return deps.notice('That cannot be shared from Chat.');
  }
  if (intent.kind === 'channel') {
    if (!deps.channelIds().includes(intent.id)) {
      // A public channel the person has not joined is still theirs to open; ask before giving up.
      const ok = await deps.api('GET', `/v1/channels/${encodeURIComponent(intent.id)}/messages?limit=1`).then(() => true, () => false);
      if (!ok) return deps.notice('That channel is not available to you.');
    }
    if (intent.text) deps.setDraft(intent.id, intent.text);
    return deps.selectChannel(intent.id);
  }
  if (intent.kind === 'artifact') {
    try {
      const a = await deps.api<ArtifactDTO>('GET', `/v1/artifacts/${encodeURIComponent(intent.id)}`);
      if (deps.channelIds().includes(a.channelId)) deps.openArtifactIn(a.channelId, a.id);
      else deps.selectArtifact(a.id);
    } catch {
      deps.notice('That artifact is not shared with you.');
    }
    return;
  }
  try {
    const m = await deps.api<MessageDTO>('GET', `/v1/messages/${encodeURIComponent(intent.id)}`);
    deps.jumpToMessage(m.channelId, m.id, m.threadRootId);
  } catch {
    deps.notice('That message is not available to you.');
  }
}
