import { useBoundApi } from '../lib/useBoundApi';
import { useEffect, useState } from 'react';
import type { HelpPageDTO, HelpTopicDTO } from '@flow/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { renderBlocks } from '../lib/format';
import { unwrap } from './FeaturesModal';
import { useBackToClose } from '../lib/useBackToClose';

/** The topic every client opens on — the server always ships it (docs/help). */
const HOME = 'home';

export function useHelpTopics() {
  const { api } = useBoundApi();
  return useQuery({
    queryKey: ['help', 'topics'],
    queryFn: () => api<{ topics: HelpTopicDTO[] }>('GET', '/v1/help/topics').then((r) => r.topics),
    staleTime: Infinity, // the content ships with the deploy
  });
}

export function useHelpPage(slug: string) {
  const { api } = useBoundApi();
  return useQuery({
    queryKey: ['help', 'page', slug],
    queryFn: () => api<HelpPageDTO>('GET', `/v1/help/pages/${slug}`),
    staleTime: Infinity,
  });
}

/**
 * The viewer itself, data handed in: topics down the left, the selected page
 * rendered on the right.
 *
 * Markdown goes through the app's own block renderer — the one message bodies
 * and "What's new" use — so docs look like the rest of Flow. The page container
 * is deliberately *not* `whitespace-pre-wrap` (unlike a message row): doc prose
 * is soft-wrapped in the source file and should reflow to the pane width.
 */
export function HelpViewer({
  topics,
  page,
  slug,
  failed,
  onSelect,
  onClose,
}: {
  topics: HelpTopicDTO[];
  page: HelpPageDTO | undefined;
  slug: string;
  failed?: boolean;
  onSelect: (slug: string) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={onClose}
    >
      <div
        data-testid="help-modal"
        role="dialog"
        aria-label="Flow help"
        className="flex h-[min(680px,calc(100dvh-2rem))] w-[min(900px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl bg-white text-ink shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-hairline px-5 py-3">
          {/* NB: not `text-base` — it collides with the `--color-base` theme
              token in Tailwind v4 and paints the heading near-white. */}
          <h2 className="text-[15px] font-bold">Help</h2>
          <button
            className="rounded-md px-2 py-1 text-lg leading-none text-ink/50 hover:bg-daypill"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <nav
            data-testid="help-topics"
            className="w-52 shrink-0 overflow-y-auto border-r border-hairline p-2"
          >
            {topics.map((t) => (
              <button
                key={t.slug}
                data-testid={`help-topic-${t.slug}`}
                aria-current={t.slug === slug ? 'page' : undefined}
                className={`block w-full rounded-md px-2.5 py-1.5 text-left text-sm ${
                  t.slug === slug ? 'bg-daypill font-semibold' : 'text-ink/80 hover:bg-daypill'
                }`}
                onClick={() => onSelect(t.slug)}
              >
                {t.title}
              </button>
            ))}
          </nav>
          <article
            data-testid="help-page"
            className="min-w-0 flex-1 overflow-y-auto px-6 py-4 text-sm leading-relaxed"
          >
            {failed ? (
              <p className="text-ink/40">Help isn&apos;t available right now.</p>
            ) : page === undefined ? (
              <p className="text-ink/40">Loading…</p>
            ) : (
              renderBlocks(unwrap(page.markdown), {}, undefined)
            )}
          </article>
        </div>
      </div>
    </div>
  );
}

/**
 * Built-in help (#383). Topics and pages are markdown files in the repo served
 * by /v1/help, so adding a file adds a topic with no change here. Opens on
 * Home; Esc, ✕ or the backdrop closes it.
 */
export function HelpModal({ onClose }: { onClose: () => void }) {
  const [slug, setSlug] = useState(HOME);
  const topics = useHelpTopics();
  const page = useHelpPage(slug);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  useBackToClose(onClose); // the Android shell's Escape

  return (
    <HelpViewer
      topics={topics.data ?? []}
      page={page.data}
      slug={slug}
      failed={topics.isError || page.isError}
      onSelect={setSlug}
      onClose={onClose}
    />
  );
}
