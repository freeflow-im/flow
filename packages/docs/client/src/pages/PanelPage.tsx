// Docs as a panel in another app's side panel (docs/specs/side-panel.md §5): /docs/panel, in a frame there. A search box
// over the files last opened (Recents); typing finds files by name, as the file list's search does. A file opens in
// Docs itself: the app around the panel is asked to open it (in Home, Home does).
import { useEffect, useState } from 'react';
import { appUrl } from '../basePath.ts';
import type { SheetMeta, StoredFile } from '../../../shared/types.ts';
import { api, type RecentFile } from '../api.ts';
import { kindIcon, type LibraryItem } from '../components/FileLibrary.tsx';
import { pathOfFile } from '../components/WebCopyDialogs.tsx';

type Row = Pick<LibraryItem, 'id' | 'kind' | 'title'> & { where: string };

/** Asks the app around the panel to open an address (SidePanel.tsx follows it); a page of its own opens it here. */
function openInHost(href: string): void {
  if (window.parent !== window) window.parent.postMessage({ type: 'flow:open', href }, window.location.origin);
  else window.location.assign(href);
}

const recentRow = (f: RecentFile): Row | null => (f.id ? { id: f.id, kind: f.kind, title: f.name, where: f.folder ?? '' } : null);

export function PanelPage() {
  const [q, setQ] = useState('');
  const [recent, setRecent] = useState<Row[] | null>(null);
  const [found, setFound] = useState<{ q: string; rows: Row[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const read = () =>
      api.recents().then(
        (r) => setRecent(r.files.flatMap((f) => recentRow(f) ?? [])),
        () => setRecent([]),
      );
    void read();
    // Coming back to the panel, the files opened since are at the top.
    const onVisible = () => document.visibilityState === 'visible' && void read();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // Asked a moment after typing stops; an answer for words since changed is dropped.
  useEffect(() => {
    const text = q.trim();
    if (!text) return setFound(null);
    let live = true;
    const timer = setTimeout(() => {
      api.searchLibrary(text).then(
        (r) => {
          if (!live) return;
          setError(null);
          setFound({
            q: text,
            rows: [
              ...r.docs.map((d: SheetMeta): Row => ({ id: d.id, kind: d.kind, title: d.title, where: d.folder ?? '' })),
              ...r.files.map((f: StoredFile): Row => ({ id: f.id, kind: 'file', title: f.filename, where: f.folder ?? '' })),
            ],
          });
        },
        (e: Error) => live && setError(e.message),
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q]);

  const rows = q.trim() ? found?.rows : recent;
  return (
    <div className="docs-panel">
      <input className="docs-panel-search" type="search" placeholder="Search files" aria-label="Search files" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="docs-panel-heading">{q.trim() ? 'Files' : 'Recent'}</div>
      {error ? (
        <div className="docs-panel-empty">{error}</div>
      ) : !rows ? (
        <div className="docs-panel-empty">Loading…</div>
      ) : !rows.length ? (
        <div className="docs-panel-empty">{q.trim() ? 'No files match.' : 'Files you open in Docs show here.'}</div>
      ) : (
        <ul className="docs-panel-list">
          {rows.map((r) => (
            <li key={`${r.kind}:${r.id}`}>
              <button type="button" className="docs-panel-row" onClick={() => openInHost(appUrl(pathOfFile(r.kind, r.id)))} title={`Open ${r.title} in Docs`}>
                <span className="docs-panel-icon">{kindIcon({ kind: r.kind, title: r.title }, 18)}</span>
                <span className="docs-panel-name">{r.title}</span>
                {r.where && <span className="docs-panel-where">{r.where}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
