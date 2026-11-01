// The desktop app's folder button, left of the open folder's name over the file list: open one of the usual
// folders (home, Documents, Downloads, Desktop), another folder (the app's Open Folder dialog), or a file or folder
// by its path, or show the folder being listed in Finder. The home button beside it, and the open folder's parent,
// the crumb before its name.
import { useEffect, useRef, useState } from 'react';
import { api, type LocalPlace } from '../api.ts';
import { fileBrowserName } from '../desktopBridge.ts';
import { PromptModal } from './Modal.tsx';

export function LocalFolderMenu({ folder, onFile, onFolder }: {
  /** The folder of the open folder being listed ('' for the top), which Open in Finder shows. */
  folder: string;
  /** Show a file of the open folder, by its path there. */
  onFile(rel: string): void;
  /** Show a folder of the open folder, by its path there ('' for the top). */
  onFolder(rel: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const [places, setPlaces] = useState<LocalPlace[]>([]);
  const ref = useRef<HTMLSpanElement>(null);

  // Asked each time the menu opens: the usual folders can come and go.
  useEffect(() => {
    if (!open) return;
    let live = true;
    api.localPlaces().then((r) => live && setPlaces(r.places), () => {});
    return () => {
      live = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span className="local-folder" ref={ref}>
      <button className="local-folder-btn" aria-label="Open a folder or file" title="Open a folder or file" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2.2h8.8A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        </svg>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="home-more-menu local-folder-menu" role="menu">
          {places.map((p) => (
            <button
              key={p.path}
              role="menuitem"
              title={p.path}
              onClick={() => {
                setOpen(false);
                // One inside the open folder is shown here; for any other the window switches to it.
                void api.openLocalPath(p.path).then((res) => res.folder !== undefined && onFolder(res.folder));
              }}
            >
              {p.name}
            </button>
          ))}
          {places.length > 0 && <div className="menu-sep" role="separator" />}
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setAsking(true);
            }}
          >
            Open file by path…
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void api.chooseLocalFolder();
            }}
          >
            Open Folder…
          </button>
          <div className="menu-sep" role="separator" />
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void api.revealLocal({ folder }).catch(() => {});
            }}
          >
            Open in {fileBrowserName()}
          </button>
        </div>
      )}
      {asking && (
        <PromptModal
          title="Open file by path"
          label="File or folder"
          initial=""
          placeholder="~/Documents/report.docx"
          maxLength={4096}
          confirmText="Open"
          onConfirm={async (p) => {
            const res = await api.openLocalPath(p);
            // Otherwise the app is switching folders and this window is about to be replaced.
            if (res.file !== undefined) onFile(res.file);
            else if (res.folder !== undefined) onFolder(res.folder);
          }}
          onClose={() => setAsking(false)}
        />
      )}
    </span>
  );
}

/**
 * Goes to the home folder: shown here when it is the open folder or inside it, else the window moves there. Not shown
 * for now: the folder's Favorites star has its place (HomePage).
 */
export function LocalFolderHome({ onFolder }: { onFolder(rel: string): void }) {
  return (
    <span className="local-folder">
      <button
        className="local-folder-btn"
        aria-label="Home folder"
        title="Home folder"
        onClick={() => void api.openLocalPath('~').then((res) => res.folder !== undefined && onFolder(res.folder))}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3.5 11 12 4l8.5 7M5.5 9.5V20h5v-5.5h3V20h5V9.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </span>
  );
}

/** The directory a directory is in, or null at the top of the disk. */
export function parentDir(dir: string): string | null {
  const trimmed = dir.replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (i < 0) return null;
  const parent = trimmed.slice(0, i);
  // The top of the disk keeps its separator: / or C:\.
  return !parent || parent.endsWith(':') ? trimmed.slice(0, i + 1) : parent;
}

/** The open folder's parent, as the crumb before its name: opens it (the window moves there). */
export function LocalFolderParent({ dir }: { dir: string }) {
  const parent = parentDir(dir);
  if (!parent) return null;
  const name = parent.split(/[\\/]/).filter(Boolean).pop() ?? parent;
  return (
    <h2 className="breadcrumbs local-up" aria-label="Folder above">
      <span>
        <button className="crumb" title={parent} onClick={() => void api.openLocalPath(parent)}>
          {name}
        </button>
        <span className="crumb-sep">/</span>
      </span>
    </h2>
  );
}
