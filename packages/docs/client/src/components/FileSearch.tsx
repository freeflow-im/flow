// Finding a file from an editor or the home page: the search button in the header opens a dialog that looks for
// files by name in every folder (`/api/library/search`, as the file list's search does; text with a slash is the
// end of a path, `backend/.env`); in the desktop app it then looks through the whole home folder too, `/api/local/search`, and
// lists what it finds outside the open folder after the rest, opened as Open file by path… opens them), and before anything is typed lists the
// files last opened in the app (its own Recents, `/api/recents`, not the system's). Clicking a file, or Enter,
// opens it here; its Open button, or ⌘/Ctrl+Enter, opens it in a new tab. ⌘P (Ctrl+P), as in VS Code, opens the
// dialog too, instead of the browser's Print.
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { SheetMeta, StoredFile } from '../../../shared/types.ts';
import { api, type RecentFile } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { openFromRecents } from '../pages/OpenLocalFile.tsx';
import { kindIcon, type LibraryItem } from './FileLibrary.tsx';
import { Modal } from './Modal.tsx';
import { pathOfFile } from './WebCopyDialogs.tsx';

/** A file the dialog lists, and how it opens. */
interface Row {
  key: string;
  item: Pick<LibraryItem, 'kind' | 'title'>;
  where: string;
  open(): Promise<void> | void;
  openInTab(): Promise<void> | void;
}
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** The header's search button and its dialog. */
export function FileSearchButton() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'p' || !(isMac ? e.metaKey : e.ctrlKey) || e.shiftKey || e.altKey) return;
      e.preventDefault();
      setOpen(true);
    };
    // Before the page's own keys (the spreadsheet's grid takes the ones it handles).
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return (
    <>
      <button className="icon-btn file-search-btn" onClick={() => setOpen(true)} title={`Find a file (${isMac ? '⌘P' : 'Ctrl+P'})`} aria-label="Find a file">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="m15 15 5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
      {open && <FileSearch onClose={() => setOpen(false)} />}
    </>
  );
}

export function FileSearch({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const { local } = useAuth();
  const [found, setFound] = useState<{ q: string; rows: Row[]; truncated: boolean } | null>(null);
  // The desktop app: what the home folder has outside the open folder (slower: shown when it comes).
  const [home, setHome] = useState<{ q: string; rows: Row[] } | null>(null);
  const [recent, setRecent] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  const go = (path: string) => {
    onClose();
    navigate(path);
  };
  const libraryRow = (item: LibraryItem): Row => ({
    key: `${item.kind}:${item.id}`,
    item,
    where: item.folder ?? '',
    open: () => go(pathOfFile(item.kind, item.id)),
    openInTab: () => void window.open(pathOfFile(item.kind, item.id), '_blank'),
  });
  // On the web a recent file is named by its id. In the desktop app it is named by its path, and one outside the
  // open folder opens in its own folder (the window moves there, or a new tab is opened on it), as from Recents.
  const recentRow = (f: RecentFile): Row => {
    const where = f.where ?? f.folder ?? '';
    if (f.id) return { ...libraryRow({ id: f.id, kind: f.kind, title: f.name, folder: f.folder, createdAt: f.lastUsed, updatedAt: f.lastUsed }), where };
    const path = f.path!;
    return {
      key: path,
      item: { kind: f.kind, title: f.name },
      where,
      open: async () => {
        const res = await api.openLocal(path);
        if (res.file) go(openFromRecents(res.file));
      },
      openInTab: async () => {
        const res = await api.openLocalPath(path, true);
        if (res.file !== undefined) window.open(`/open?file=${encodeURIComponent(res.file)}`, '_blank');
      },
    };
  };

  // A file elsewhere in the home folder opens as Open file by path… opens one: the window moves to its folder, or a
  // new tab opens on it.
  const homeRow = (f: { path: string; name: string; where: string; kind: RecentFile['kind'] }): Row => ({
    key: f.path,
    item: { kind: f.kind, title: f.name },
    where: f.where,
    open: async () => {
      const res = await api.openLocalPath(f.path);
      if (res.file !== undefined) go(openFromRecents(res.file));
    },
    openInTab: async () => void (await api.openLocalPath(f.path, true)),
  });

  useEffect(() => {
    api.recents().then(
      (r) => setRecent(r.files.map(recentRow)),
      () => setRecent([]),
    );
  }, []);

  // Asked a moment after typing stops; an answer for words since changed is dropped.
  useEffect(() => {
    const text = q.trim();
    setAt(0);
    setHome(null);
    if (!text) return setFound(null);
    let live = true;
    const timer = setTimeout(() => {
      if (local)
        api.searchHome(text).then(
          (r) => live && setHome({ q: text, rows: r.files.map(homeRow) }),
          () => live && setHome({ q: text, rows: [] }),
        );
      api.searchLibrary(text).then(
        (r) => {
          if (!live) return;
          const items: LibraryItem[] = [
            ...r.docs.map((d: SheetMeta) => ({ id: d.id, kind: d.kind, format: d.format, title: d.title, folder: d.folder, createdAt: d.createdAt, updatedAt: d.updatedAt })),
            ...r.files.map((f: StoredFile) => ({ id: f.id, kind: 'file' as const, title: f.filename, folder: f.folder, ...(f.text ? { text: true } : {}), createdAt: f.createdAt, updatedAt: f.createdAt })),
          ];
          setFound({ q: text, rows: items.map(libraryRow), truncated: r.truncated });
          setAt(0);
          setError(null);
        },
        (e: Error) => live && setError(e.message),
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q]);

  const searching = !!q.trim();
  const homeDone = !local || !!home;
  const rows = (searching ? found && [...found.rows, ...(home?.rows ?? [])] : recent) ?? [];
  const act = (fn: () => Promise<void> | void) => {
    setError(null);
    Promise.resolve()
      .then(fn)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  useEffect(() => {
    list.current?.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  }, [at]);

  return (
    <Modal title="Find a file" onClose={onClose} className="file-search">
      <input
        className="file-search-input"
        autoFocus
        value={q}
        placeholder="Type part of a file's name, or folder/name"
        aria-label="File name"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (rows.length) setAt((at + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length);
          } else if (e.key === 'Enter' && rows[at]) {
            e.preventDefault();
            act(e.metaKey || e.ctrlKey ? rows[at].openInTab : rows[at].open);
          }
        }}
      />
      {error && <div className="form-error">{error}</div>}
      {searching && (!found || (!rows.length && !homeDone)) ? (
        <p className="muted file-search-note">Looking…</p>
      ) : searching && !rows.length ? (
        <p className="muted file-search-note">{found!.q.includes('/') ? `No file’s path has “${found!.q}” in it.` : `No file’s name has “${found!.q}” in it.`}</p>
      ) : !searching && !recent ? null : !searching && !rows.length ? (
        <p className="muted file-search-note">Type to look in every folder. The files you open will be listed here.</p>
      ) : (
        <>
          {!searching && <div className="file-search-heading">Recent files</div>}
          <ul className="file-search-list" ref={list} role="listbox" aria-label={searching ? 'Files found' : 'Recent files'}>
            {rows.map((row, i) => (
              <li key={row.key} role="option" aria-selected={i === at} className={i === at ? 'selected' : undefined} onMouseEnter={() => setAt(i)} onClick={() => act(row.open)}>
                {kindIcon(row.item)}
                <span className="file-search-name">{row.item.title}</span>
                {row.where && <span className="file-search-where">{row.where}</span>}
                <button
                  className="btn open-tab-btn"
                  title="Open in a new tab"
                  onClick={(e) => {
                    e.stopPropagation();
                    act(row.openInTab);
                  }}
                >
                  Open <span aria-hidden="true">↗</span>
                </button>
              </li>
            ))}
            {searching && found?.truncated && <li className="muted file-search-more">More files match: type more of the name.</li>}
            {searching && !homeDone && <li className="muted file-search-more">Looking in your home folder…</li>}
          </ul>
        </>
      )}
    </Modal>
  );
}
