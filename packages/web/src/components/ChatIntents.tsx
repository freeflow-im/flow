// Applies what another page of the suite asked Chat for (lib/chatIntents.ts, platform phase 6.4) once the organization's
// channels are here, and hosts the artifact Share dialog: for `?share=<ref>`, and for a chip's Share in a message
// (SHARE_ARTIFACT_EVENT).
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ChannelDTO } from '@flow/shared';
import { useChannels, useWorkspaces } from '../hooks';
import { useBackend } from '../lib/backend';
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
  const workspaces = useWorkspaces();
  const qc = useQueryClient();
  const backend = useBackend();
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

  // A channel of another of the person's organizations (a link copied there) opens in that organization, so the
  // sidebar and the address (ChatAddress) are its own and not the one that happened to be open.
  async function orgOf(channelId: string): Promise<string | null> {
    if ((channels.data ?? []).some((c) => c.id === channelId)) return sel.workspaceId;
    for (const ws of workspaces.data ?? []) {
      if (ws.id === sel.workspaceId) continue;
      const list = await qc.fetchQuery({
        queryKey: ['channels', ws.id],
        queryFn: async () => ({ channels: (await backend.listConversations(ws.id)) as ChannelDTO[] }),
      }).then((d) => d.channels, () => [] as ChannelDTO[]);
      if (list.some((c) => c.id === channelId)) return ws.id;
    }
    return sel.workspaceId;
  }
  function inItsOrg(channelId: string, then: () => void) {
    void orgOf(channelId).then((wsId) => {
      if (wsId && wsId !== sel.workspaceId) sel.selectWorkspace(wsId);
      then();
    });
  }

  function apply(what: ChatIntent) {
    const ids = (channels.data ?? []).map((c) => c.id);
    void applyChatIntent(what, {
      api: (method, path) => api(method, path),
      channelIds: () => ids,
      openArtifactIn: sel.openArtifactIn,
      selectArtifact: sel.selectArtifact,
      selectChannel: (id) => inItsOrg(id, () => sel.selectChannel(id)),
      jumpToMessage: (channelId, messageId, rootId) => inItsOrg(channelId, () => sel.jumpToMessage(channelId, messageId, rootId)),
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
