// Message search (docs/specs/search.md): the suite bar's search on Chat opens this view, the same "sentinel channel id"
// shape as the Activity feed. It asks the server (GET /v1/workspaces/:id/search) for the messages that match, in every
// channel the user is in, every public channel, and their direct messages, and lists them with the matched words
// marked. A row opens its message where it is (its thread too), as an Activity row does.
//
// The query language is the suite's: words, "phrases", word*, OR, -word, and from: in: after: before: has:.
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ChannelDTO } from '@flow/shared';
import { displayTime } from '../lib/format';
import { dmTitle } from '../lib/channelTitle';
import { setMessageSearch, setMessageSearchSort, useMessageSearch, useMessageSearchSort, type SearchSort } from '../lib/messageSearch';
import { useBoundApi } from '../lib/useBoundApi';
import { useAuth, useSelection } from '../state';
import { useChannels, useMemberMap, useNameMap } from '../hooks';
import { Avatar } from './Avatar';
import { MobileMenuButton } from './MobileMenuButton';

/** One message the server found (its `MessageSearchHit`). */
export interface MessageHit {
  id: string;
  /** The text around the matched words, which sit between \u0002 and \u0003. */
  snippet: string;
  author?: string;
  authorName: string;
  at: string;
  channelId: string;
  channelName: string | null;
  channelKind: 'standard' | 'dm' | 'group_dm';
  threadRootId: string | null;
}

export type { SearchSort };

/** The snippet with its matched words marked; line breaks read as spaces in a one-line row. */
export function Snippet({ text }: { text: string }) {
  const parts = text.replace(/\s+/g, ' ').split(/(\u0002[^\u0003]*\u0003)/);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('\u0002') ? (
          <mark key={i} className="search-mark">
            {p.slice(1, -1)}
          </mark>
        ) : (
          p
        ),
      )}
    </>
  );
}

/** The presentational half, prop-driven so it renders in a test without a query client. */
export function SearchResults({
  hits,
  loading,
  error,
  query,
  where,
  avatarOf,
  onOpen,
}: {
  hits: MessageHit[];
  loading: boolean;
  error: string | null;
  query: string;
  /** Where a hit is: `#name`, or the people of a direct message. */
  where(hit: MessageHit): string;
  avatarOf(userId: string): string | null | undefined;
  onOpen(hit: MessageHit): void;
}) {
  if (!query.trim()) return <p className="py-16 text-center text-sm text-faint">Type in the search bar to find messages.</p>;
  if (error) return <p className="py-16 text-center text-sm text-danger">{error}</p>;
  if (loading) return <p className="py-16 text-center text-sm text-faint">Searching…</p>;
  if (!hits.length) return <p className="py-16 text-center text-sm text-faint">No messages match “{query}”.</p>;
  return (
    <>
      {hits.map((h) => (
        <button
          key={h.id}
          data-testid={`search-hit-${h.id}`}
          className="flex w-full items-start gap-3 border-b border-hairline3 px-[22px] py-3 text-left hover:bg-daypill/50 max-md:px-3"
          onClick={() => onOpen(h)}
        >
          <Avatar userId={h.author ?? h.id} name={h.authorName} avatarUrl={h.author ? avatarOf(h.author) : null} size={34} radius={9} />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-2">
              <span className="truncate text-sm font-semibold">{h.authorName}</span>
              <span className="truncate text-xs text-muted">
                {where(h)}
                {h.threadRootId ? ' · in a thread' : ''}
              </span>
              <span className="ml-auto shrink-0 text-xs text-faint">{displayTime(h.at)}</span>
            </span>
            <span className="mt-0.5 line-clamp-2 block text-sm text-muted">
              <Snippet text={h.snippet} />
            </span>
          </span>
        </button>
      ))}
    </>
  );
}

export default function SearchView() {
  const { api } = useBoundApi();
  const sel = useSelection();
  const auth = useAuth();
  const query = useMessageSearch();
  const [draft, setDraft] = useState(query);
  // Kept beside the text (lib/messageSearch.ts), so Back from a result comes back to the same order.
  const sort = useMessageSearchSort();
  useEffect(() => setDraft(query), [query]);
  const workspaceId = sel.workspaceId;
  const names = useNameMap(workspaceId);
  const members = useMemberMap(workspaceId);
  const channels = useChannels(workspaceId);
  const byId = new Map<string, ChannelDTO>((channels.data ?? []).map((c) => [c.id, c]));

  const text = query.trim();
  const found = useQuery({
    queryKey: ['message-search', workspaceId, text, sort],
    enabled: !!workspaceId && !!text,
    staleTime: 15_000,
    queryFn: () => api('GET', `/v1/workspaces/${workspaceId}/search?q=${encodeURIComponent(text)}&sort=${sort}&limit=50`) as Promise<{ hits: MessageHit[] }>,
  });

  const where = (h: MessageHit) => {
    if (h.channelKind === 'standard') return `#${h.channelName ?? ''}`;
    const c = byId.get(h.channelId);
    return c && auth.user ? dmTitle(c, names, auth.user.id) : 'Direct message';
  };

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-base">
      <header className="flex h-[60px] shrink-0 items-center gap-3 border-b border-hairline px-[22px] max-md:px-3">
        <MobileMenuButton />
        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            setMessageSearch(draft.trim());
          }}
        >
          <input
            data-testid="search-input"
            className="w-full rounded-md border border-hairline bg-base px-3 py-1.5 text-sm outline-none focus:border-accent"
            value={draft}
            placeholder="Search messages: words, from:name, in:#channel, after:30d"
            aria-label="Search messages"
            onChange={(e) => setDraft(e.target.value)}
          />
        </form>
        <div className="flex shrink-0 overflow-hidden rounded-md border border-hairline text-xs" role="group" aria-label="Sort">
          {(['relevance', 'recent'] as const).map((s) => (
            <button key={s} className={`px-2.5 py-1.5 ${sort === s ? 'bg-daypill font-semibold' : 'text-muted'}`} aria-pressed={sort === s} onClick={() => setMessageSearchSort(s)}>
              {s === 'relevance' ? 'Best match' : 'Newest'}
            </button>
          ))}
        </div>
      </header>
      <div className="mc-scroll min-h-0 flex-1 overflow-y-auto" data-testid="search-results">
        <SearchResults
          hits={found.data?.hits ?? []}
          loading={found.isLoading}
          error={found.error ? (found.error as Error).message : null}
          query={text}
          where={where}
          avatarOf={(id) => members[id]?.avatarUrl}
          onOpen={(h) => sel.jumpToMessage(h.channelId, h.id, h.threadRootId)}
        />
      </div>
    </section>
  );
}
