// Applies what another page of the suite asked Chat for (lib/chatIntents.ts, platform phase 6.4) once the organization's
// channels are here, and hosts the artifact Share dialog: for `?share=<ref>`, and for a chip's Share in a message
// (SHARE_ARTIFACT_EVENT).
import { useEffect, useRef, useState } from 'react';
import { useChannels } from '../hooks';
import { onOpenFromHome } from '@flow/suite-bar';
import { applyChatIntent, readChatIntent, type ChatIntent } from '../lib/chatIntents';
import { useBoundApi } from '../lib/useBoundApi';
import { useSelection } from '../state';
import { ArtifactShareDialog } from './ArtifactShareDialog';

/** Dispatched on `window` with the artifact's id: open its Share dialog. */
export const SHARE_ARTIFACT_EVENT = 'flow:share-artifact';

export default function ChatIntents({ intent, onNotice }: { intent: ChatIntent | null; onNotice: (text: string) => void }) {
  const sel = useSelection();
  const { api, scopedStorageKey } = useBoundApi();
  const channels = useChannels(sel.workspaceId);
  const [sharing, setSharing] = useState<string | null>(null);
  const applied = useRef(false);

  // Inside Home, Home asks for a channel, a message or an artifact by its address, without reloading Chat.
  const [fromHome, setFromHome] = useState<ChatIntent | null>(null);
  useEffect(() => onOpenFromHome((href) => {
    const url = new URL(href, window.location.origin);
    const next = readChatIntent(url.search);
    if (next && next.kind !== 'page') setFromHome(next);
  }), []);
  useEffect(() => {
    if (!fromHome || !channels.isSuccess) return;
    setFromHome(null);
    apply(fromHome);
  }, [fromHome, channels.isSuccess]);

  useEffect(() => {
    if (!intent || applied.current || !channels.isSuccess) return;
    applied.current = true;
    apply(intent);
  }, [intent, channels.isSuccess, channels.data, api, sel, scopedStorageKey, onNotice]);

  function apply(what: ChatIntent) {
    const ids = (channels.data ?? []).map((c) => c.id);
    void applyChatIntent(what, {
      api: (method, path) => api(method, path),
      channelIds: () => ids,
      openArtifactIn: sel.openArtifactIn,
      selectArtifact: sel.selectArtifact,
      selectChannel: sel.selectChannel,
      jumpToMessage: sel.jumpToMessage,
      setDraft: (channelId, text) => localStorage.setItem(scopedStorageKey(`draft:${channelId}:`), text),
      shareArtifact: setSharing,
      notice: onNotice,
    });
  }

  useEffect(() => {
    const onShare = (e: Event) => setSharing((e as CustomEvent<string>).detail);
    window.addEventListener(SHARE_ARTIFACT_EVENT, onShare);
    return () => window.removeEventListener(SHARE_ARTIFACT_EVENT, onShare);
  }, []);

  return sharing ? <ArtifactShareDialog artifactId={sharing} onClose={() => setSharing(null)} /> : null;
}
