// Chat's address (lib/chatPath.ts): opens what a `/chat/<org-slug>/<channel>` address names, and keeps the address
// following what is open after that — including the channel's current name, so a rename shows up in the address.
import { useEffect, useState } from 'react';
import { CHANNEL_NAME_RE, CHAT_PATH, type ChannelDTO } from '@flow/shared';
import { useQueryClient } from '@tanstack/react-query';
import { onOpenFromHome } from '@flow/suite-bar';
import { useChannels, useWorkspaces } from '../hooks';
import { chatPathFor, parseChatPath, resolveChannelRef, type ChatPathTarget } from '../lib/chatPath';
import { useBackend } from '../lib/backend';
import { useBoundApi } from '../lib/useBoundApi';
import { useSelection } from '../state';

const VIEW_PREFIX = '__';

export default function ChatAddress({ target, onNotice }: { target: ChatPathTarget | null; onNotice: (text: string) => void }) {
  const sel = useSelection();
  const { api } = useBoundApi();
  const qc = useQueryClient();
  const backend = useBackend();
  const workspaces = useWorkspaces();
  const channels = useChannels(sel.workspaceId);
  // The address still to be opened. Until it is, the address is left as it was typed.
  const [pending, setPending] = useState<ChatPathTarget | null>(target);

  // Inside Home, a link to an address of this form opens here rather than reloading the frame.
  useEffect(() => onOpenFromHome((href) => {
    const next = parseChatPath(new URL(href, window.location.origin).pathname);
    if (next) setPending(next);
  }), []);

  // Opening an address: its organization's channels are fetched first, so the switch and the channel happen in one
  // step — a workspace opened with nothing selected would otherwise land on #general (Sidebar) over it.
  useEffect(() => {
    if (!pending || !workspaces.isSuccess) return;
    setPending(null);
    const target = pending;
    const ws = workspaces.data.find((w) => w.slug.toLowerCase() === target.slug);
    if (!ws) return onNotice('That organization is not one of yours.');
    const switching = ws.id !== sel.workspaceId;
    const want = target.channel;
    if (!want) {
      if (switching) sel.selectWorkspace(ws.id);
      return;
    }
    if ('view' in want) {
      if (switching) sel.selectWorkspace(ws.id);
      if (switching || sel.channelId !== want.view) sel.selectChannel(want.view);
      return;
    }
    void (async () => {
      const list = await qc.fetchQuery({
        queryKey: ['channels', ws.id],
        queryFn: async () => ({ channels: (await backend.listConversations(ws.id)) as ChannelDTO[] }),
      }).then((d) => d.channels, () => [] as ChannelDTO[]);
      let id = resolveChannelRef(want.ref, list)?.id ?? null;
      // Not in the sidebar: by id, a channel the person may still open (an archived or unjoined public one).
      if (!id && await api('GET', `/v1/channels/${encodeURIComponent(want.ref)}/messages?limit=1`).then(() => true, () => false)) {
        id = want.ref;
      }
      if (switching) sel.selectWorkspace(ws.id);
      if (!id) {
        onNotice(CHANNEL_NAME_RE.test(want.ref) && want.ref.length < 36
          ? `There is no #${want.ref} here that you can open. It may have been renamed.`
          : 'That conversation is not available to you.');
        return;
      }
      if (target.threadRootId) sel.jumpToMessage(id, target.threadRootId, target.threadRootId);
      else if (switching || sel.channelId !== id) sel.selectChannel(id);
    })();
  }, [pending, workspaces.isSuccess, workspaces.data, sel, api, qc, backend, onNotice]);

  // The address follows what is open.
  const ws = workspaces.data?.find((w) => w.id === sel.workspaceId);
  const channel = channels.data?.find((c) => c.id === sel.channelId);
  const waiting = !!sel.channelId && !sel.channelId.startsWith(VIEW_PREFIX) && !channels.isSuccess;
  const path = !sel.workspaceId
    ? CHAT_PATH
    : ws && !waiting
      ? chatPathFor(ws.slug, { channelId: sel.channelId, name: channel?.name ?? null, threadRootId: sel.threadRootId })
      : null;
  useEffect(() => {
    if (pending || !path || !workspaces.isSuccess) return;
    // Only Chat's own address: a sign-in page (/login) is App's, which goes on from there once signed in.
    const here = window.location.pathname;
    if (here === path || (here !== CHAT_PATH && !here.startsWith(`${CHAT_PATH}/`))) return;
    window.history.replaceState(window.history.state, '', `${path}${window.location.search}${window.location.hash}`);
  }, [pending, path, workspaces.isSuccess]);

  return null;
}
