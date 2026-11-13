// Admin → Changelog: every entry of changelog/ in full, newest first, with the frozen CHANGES_ARCHIVE logs of the time
// before them. The data is made at build time (scripts/build-changelog.mjs → public/changelog.json) and fetched when the
// page opens; it is the technical record (platform tags, fixes, internals), not the user-facing "What's new".
import { useEffect, useMemo, useState, type AnchorHTMLAttributes } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export interface ChangelogEntry {
  file: string;
  date: string;
  slug: string;
  title: string;
  tags: string[];
  /** It has a `## Feature` section: a change people can see. */
  feature: boolean;
  body: string;
}
export interface ChangelogData {
  generatedAt: string;
  entries: ChangelogEntry[];
  archives: { name: string; text: string }[];
}

/** Where an entry file is on GitHub. */
const sourceUrl = (file: string) => `https://github.com/freeflow-im/flow/blob/main/changelog/${encodeURIComponent(file)}`;
/** How many entries are drawn at first, and each time "Show more" is pressed. */
export const PAGE = 60;

const longDate = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
/** The entry's text without its title line, which the card shows as its heading. */
const bodyOf = (e: ChangelogEntry) => e.body.replace(/^#\s+.+\n?/, '').trim();

/** The entries that match the search text (in the title, file name or text), every tag chosen, and the Feature filter. */
export function filterEntries(entries: readonly ChangelogEntry[], q: string, tags: ReadonlySet<string>, featuresOnly: boolean): ChangelogEntry[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((e) => {
    if (featuresOnly && !e.feature) return false;
    for (const t of tags) if (!e.tags.includes(t)) return false;
    const hay = `${e.title}\n${e.file}\n${e.body}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Entries grouped by their day, in the order given. */
export function byDay(entries: readonly ChangelogEntry[]): [string, ChangelogEntry[]][] {
  const out: [string, ChangelogEntry[]][] = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    if (last && last[0] === e.date) last[1].push(e);
    else out.push([e.date, [e]]);
  }
  return out;
}

const markdown = {
  a: ({ node: _n, ...p }: { node?: unknown } & AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...p} target="_blank" rel="noreferrer" className="text-primary underline" />,
};

/** The page's data, from the build (public/changelog.json). */
const fetchChangelog = (): Promise<ChangelogData> =>
  fetch(`${import.meta.env.BASE_URL}changelog.json`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`The changelog could not be loaded (${r.status}).`))));

export function Changelog({ load = fetchChangelog }: { load?: () => Promise<ChangelogData> }) {
  const [data, setData] = useState<ChangelogData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [tags, setTags] = useState<Set<string>>(new Set());
  const [featuresOnly, setFeaturesOnly] = useState(false);
  const [shown, setShown] = useState(PAGE);

  useEffect(() => {
    let alive = true;
    load().then(
      (d) => alive && setData(d),
      (e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      alive = false;
    };
  }, [load]);

  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of data?.entries ?? []) for (const t of e.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]);
  }, [data]);
  const matches = useMemo(() => (data ? filterEntries(data.entries, q, tags, featuresOnly) : []), [data, q, tags, featuresOnly]);
  // A new search starts from the top again.
  useEffect(() => setShown(PAGE), [q, tags, featuresOnly]);

  if (error) return <p className="text-sm text-danger" data-testid="changelog-error">{error}</p>;
  if (!data) return <p className="text-sm text-muted">Loading the changelog…</p>;

  const first = data.entries[data.entries.length - 1]?.date;
  const last = data.entries[0]?.date;
  const toggleTag = (t: string) =>
    setTags((cur) => {
      const next = new Set(cur);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });

  return (
    <div className="flex flex-col gap-4" data-testid="changelog">
      <p className="text-sm text-muted">
        Every change merged into the suite, as each pull request recorded it: {data.entries.length} entries
        {first && last ? `, ${longDate(first)} to ${longDate(last)}` : ''}. The earlier history is at the end.
      </p>
      <div className="flex flex-col gap-2 rounded-lg border border-hairline bg-white p-3">
        <input
          type="search"
          aria-label="Search the changelog"
          placeholder="Search titles and text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="h-9 w-full rounded-md border border-border px-3 text-sm outline-none focus:border-primary"
        />
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Platforms">
          {tagCounts.map(([t, n]) => (
            <button
              key={t}
              type="button"
              aria-pressed={tags.has(t)}
              onClick={() => toggleTag(t)}
              className={`rounded-full border px-2 py-0.5 text-xs ${tags.has(t) ? 'border-primary bg-primary text-white' : 'border-border text-ink hover:bg-hover'}`}
            >
              {t} <span className={tags.has(t) ? 'text-white/80' : 'text-muted'}>{n}</span>
            </button>
          ))}
          <label className="ml-auto flex items-center gap-1.5 text-xs text-ink">
            <input type="checkbox" checked={featuresOnly} onChange={(e) => setFeaturesOnly(e.target.checked)} />
            Only changes people can see
          </label>
        </div>
        <p className="text-xs text-muted" data-testid="changelog-count">
          {matches.length === data.entries.length ? `${matches.length} entries` : `${matches.length} of ${data.entries.length} entries`}
        </p>
      </div>

      {byDay(matches.slice(0, shown)).map(([date, list]) => (
        <section key={date} className="flex flex-col gap-2">
          <h2 className="sticky top-0 z-[1] -mx-1 bg-white/95 px-1 py-1 text-sm font-semibold text-ink">{longDate(date)}</h2>
          {list.map((e) => (
            <article key={e.file} className="rounded-lg border border-hairline bg-white p-4" data-testid="changelog-entry">
              <header className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <h3 className="text-[15px] font-semibold">{e.title}</h3>
                {e.tags.map((t) => (
                  <span key={t} className="rounded bg-hover px-1.5 py-px text-[11px] text-ink-soft">
                    {t}
                  </span>
                ))}
                <a href={sourceUrl(e.file)} target="_blank" rel="noreferrer" className="ml-auto text-[11px] text-muted hover:text-primary">
                  {e.file}
                </a>
              </header>
              <div className="changelog-md text-sm leading-relaxed text-ink">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdown}>
                  {bodyOf(e)}
                </ReactMarkdown>
              </div>
            </article>
          ))}
        </section>
      ))}
      {matches.length === 0 && <p className="text-sm text-muted">No entries match.</p>}
      {shown < matches.length && (
        <button type="button" onClick={() => setShown((n) => n + PAGE)} className="self-center rounded-md border border-border px-4 py-1.5 text-sm hover:bg-hover">
          Show more ({matches.length - shown} left)
        </button>
      )}

      {data.archives.length > 0 && (
        <section className="mt-4 flex flex-col gap-2">
          <h2 className="text-sm font-semibold">Earlier history</h2>
          <p className="text-xs text-muted">The changelog as it was kept before the entry files, frozen.</p>
          {data.archives.map((a) => (
            <details key={a.name} className="rounded-lg border border-hairline bg-white">
              <summary className="cursor-pointer px-4 py-2 text-sm">{a.name}</summary>
              <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap border-t border-hairline px-4 py-3 text-xs leading-relaxed">{a.text}</pre>
            </details>
          ))}
        </section>
      )}
    </div>
  );
}
