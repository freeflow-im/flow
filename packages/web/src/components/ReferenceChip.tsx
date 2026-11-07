// A chip for a reference in a message (lib/references.ts, platform phase 6.4): its icon, title and kind, resolved for the
// reader, with Open (and Share, for someone who may share it). What the reader may not see says only what kind of thing it
// is; one not resolved yet (or by a server without /v1/references) is the plain link.
import { parseReference, type ResolvedReference } from '@flow/shared';
import { iconOf, intent, kindLabelOf } from '@flow/suite-bar';
import { useChannels } from '../hooks';
import { applyChatIntent, type ChatIntent } from '../lib/chatIntents';
import type { FoundReference } from '../lib/references';
import { useBoundApi } from '../lib/useBoundApi';
import { useSelection } from '../state';
import { SHARE_ARTIFACT_EVENT } from './ChatIntents';

const article = (word: string) => (/^[aeiou]/i.test(word) ? 'an' : 'a');

export function ReferenceChip({ found, resolved }: { found: FoundReference; resolved: ResolvedReference | undefined }) {
  const sel = useSelection();
  const { api, serverOrigin } = useBoundApi();
  const channels = useChannels(sel.workspaceId);
  const r = found.reference;
  const kind = kindLabelOf(r.app, r.kind, r.fileKind);
  const navigate = (url: string) => window.location.assign(new URL(url, serverOrigin).href);

  if (!resolved) {
    return (
      <a data-testid="reference-chip" data-state="pending" href={found.url} className="mt-1.5 inline-flex max-w-[520px] items-center gap-1.5 truncate text-sm text-accent-deep underline">
        {iconOf(r.app, r.kind, r.fileKind)} {found.url}
      </a>
    );
  }
  if (resolved.denied) {
    return (
      <div data-testid="reference-chip" data-state="denied" className="mt-1.5 flex w-fit max-w-[520px] items-center gap-2 rounded-lg border border-hairline bg-white/60 px-3 py-1.5 text-sm text-faint">
        <span aria-hidden>🔒</span>
        <span>{`${article(kind)} ${kind.toLowerCase()} you cannot see`}</span>
      </div>
    );
  }

  const open = () => {
    // Chat's own objects open here, without leaving the page; anything else goes to its app.
    if (r.app === 'chat' && (r.kind === 'artifact' || r.kind === 'channel' || r.kind === 'message')) {
      const ids = (channels.data ?? []).map((c) => c.id);
      void applyChatIntent({ kind: r.kind, id: r.id } as ChatIntent, {
        api: (m, p) => api(m, p), channelIds: () => ids, openArtifactIn: sel.openArtifactIn, selectArtifact: sel.selectArtifact, selectChannel: sel.selectChannel,
        jumpToMessage: sel.jumpToMessage, setDraft: () => {}, shareArtifact: () => {}, notice: () => {},
      });
    } else intent.open(r, { navigate });
  };
  const share = () => {
    if (r.app === 'chat' && r.kind === 'artifact') window.dispatchEvent(new CustomEvent(SHARE_ARTIFACT_EVENT, { detail: r.id }));
    else intent.share(parseReference(resolved.ref) ?? r, { navigate });
  };
  const canShare = (resolved.role === 'manager' || resolved.role === 'owner') && (r.app !== 'chat' || r.kind === 'artifact');
  const canOpen = !!resolved.url || r.app === 'chat';

  return (
    <div data-testid="reference-chip" data-state="resolved" data-ref={resolved.ref}
      className="group/ref relative mt-1.5 flex w-fit max-w-[520px] items-center gap-2.5 rounded-lg border border-hairline bg-white/60 py-1.5 pr-2 pl-3">
      <span aria-hidden className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-accent/35" />
      <span aria-hidden className="text-base leading-none">{resolved.icon}</span>
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-ink" data-testid="reference-title">{resolved.title}</div>
        <div className="truncate text-xs text-muted">{kind}{resolved.summary ? ` · ${resolved.summary}` : ''}</div>
      </div>
      {canOpen && (
        <button type="button" data-testid="reference-open" onClick={open}
          className="ml-1 shrink-0 rounded-[20px] border border-hairline bg-white px-[9px] py-[2px] text-xs font-[650] text-ink-soft hover:border-hairline2 hover:text-ink">Open</button>
      )}
      {canShare && (
        <button type="button" data-testid="reference-share" onClick={share}
          className="shrink-0 rounded-[20px] border border-hairline bg-white px-[9px] py-[2px] text-xs font-[650] text-ink-soft hover:border-hairline2 hover:text-ink">Share</button>
      )}
    </div>
  );
}
