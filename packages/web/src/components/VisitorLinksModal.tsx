// Invite a visitor (docs/specs/chat-visitors.md §1.1): a public channel's header menu makes a 24-hour link for someone
// with no account, shows it with Copy and when it stops working, and lists the channel's open links with Turn off.
// Turning a link off also removes everyone who came in by it, so the channel's visitors are refetched with the links.
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ChannelDTO, VisitorLinkDTO } from '@flow/shared';
import { useVisitorLinks } from '../hooks';
import { useBoundApi } from '../lib/useBoundApi';
import { worksUntil } from '../lib/visitor';
import { Modal } from './modals';

export default function VisitorLinksModal({
  channel,
  names,
  onClose,
}: {
  channel: Pick<ChannelDTO, 'id' | 'name'>;
  names: Record<string, string>;
  onClose: () => void;
}) {
  const { api } = useBoundApi();
  const qc = useQueryClient();
  const links = useVisitorLinks(channel.id);
  const [made, setMade] = useState<VisitorLinkDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [turningOff, setTurningOff] = useState<string | null>(null);
  // One link per opening of the dialog, even when React runs the effect twice.
  const asked = useRef(false);

  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: ['visitorLinks', channel.id] }),
    qc.invalidateQueries({ queryKey: ['channelVisitors', channel.id] }),
  ]);

  const makeLink = async () => {
    setError(null);
    setCopied(false);
    try {
      setMade(await api<VisitorLinkDTO>('POST', `/v1/channels/${channel.id}/visitor-links`));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not make a link.');
    }
  };

  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void makeLink();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copy = () => {
    if (!made?.url) return;
    void navigator.clipboard?.writeText(made.url).then(() => setCopied(true)).catch(() => {});
  };

  const turnOff = async (id: string) => {
    setError(null);
    try {
      await api('DELETE', `/v1/visitor-links/${id}`);
      if (made?.id === id) setMade(null);
      setTurningOff(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not turn the link off.');
    }
  };

  const open = links.data ?? [];

  return (
    <Modal onClose={onClose} testid="visitor-links-modal" wide>
      <div className="mb-1 flex items-center justify-between gap-4">
        <h3 className="font-bold">Invite a visitor to #{channel.name}</h3>
        <button className="rounded px-2 text-faint hover:bg-daypill hover:text-ink" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <p className="mb-3 text-sm text-muted">
        Anyone with this link can join this channel with just a name. They see only messages from when they join, and
        nothing else in the organization.
      </p>

      {made?.url ? (
        <div className="mb-4">
          <div className="flex items-center gap-2">
            <input
              data-testid="visitor-link-url"
              readOnly
              value={made.url}
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 rounded-lg border border-hairline bg-daypill/40 px-2.5 py-1.5 font-mono text-xs"
            />
            <button
              type="button"
              data-testid="visitor-link-copy"
              className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white"
              onClick={copy}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p data-testid="visitor-link-expiry" className="mt-1 text-xs text-muted">Works until {worksUntil(made.expiresAt)}</p>
        </div>
      ) : (
        !error && <p className="mb-4 text-sm text-muted">Making a link…</p>
      )}

      {error && <p data-testid="visitor-link-error" className="mb-3 text-sm text-red-600">{error}</p>}

      <p className="mb-1 text-[11px] font-bold tracking-[.05em] text-muted uppercase">Open links</p>
      {links.isLoading ? (
        <p className="py-2 text-sm text-faint">Loading…</p>
      ) : open.length === 0 ? (
        <p className="py-2 text-sm text-faint">No open links.</p>
      ) : (
        <ul className="divide-y divide-hairline" data-testid="visitor-links-list">
          {open.map((l) => (
            <li key={l.id} data-testid={`visitor-link-${l.id}`} className="flex items-center gap-3 py-2 text-sm">
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  Made by {names[l.createdBy] ?? 'a member'} · works until {worksUntil(l.expiresAt)}
                </span>
                <span className="block text-xs text-faint">
                  {l.visitorCount === 0 ? 'Nobody has come in by it yet' : `${l.visitorCount} ${l.visitorCount === 1 ? 'person' : 'people'} came in by it`}
                </span>
              </span>
              <button
                type="button"
                data-testid={`visitor-link-off-${l.id}`}
                title="The link stops working, and everyone who came in by it is removed"
                className={`shrink-0 rounded-[7px] px-2 py-1 text-xs font-semibold ${turningOff === l.id ? 'bg-red-600 text-white hover:bg-red-700' : 'text-faint hover:text-red-600'}`}
                onClick={() => (turningOff === l.id ? void turnOff(l.id) : setTurningOff(l.id))}
              >
                {turningOff === l.id ? (l.visitorCount > 0 ? 'Turn off and remove them?' : 'Turn off?') : 'Turn off'}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex justify-between">
        <button type="button" data-testid="visitor-link-new" className="text-sm font-semibold text-accent-soft hover:underline" onClick={() => void makeLink()}>
          Make another link
        </button>
        <button type="button" className="rounded-lg px-3 py-1.5 text-sm text-ink-soft hover:bg-daypill" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}
