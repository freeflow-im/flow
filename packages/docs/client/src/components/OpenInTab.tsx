// The Open menu at the top of each editor's File menu: in the desktop app Open Folder… and Open file by path…, and
// the user's Favorites and Recents to pick from. Each opens in a new tab, leaving the file being edited where it
// is: on the web a browser tab; in the desktop app a folder or file inside the open folder is a new tab of this folder
// (window.open, which the app makes a tab), one outside it a new tab on its own folder (desktop/main.js).
// After it, the desktop app's Open in Finder shows the file being edited in the system's file browser.
import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { api, FAVORITES_CHANGED, type RecentFile } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { fileAt, fileBrowserName } from '../desktopBridge.ts';
import { FolderIcon, kindIcon } from './FileLibrary.tsx';
import type { MenuItem } from './Menu.tsx';
import { PromptModal } from './Modal.tsx';
import { pathOfFile } from './WebCopyDialogs.tsx';

/** How many of each list the menu shows. */
const LISTED = 15;

/** A file or folder of the lists, as the menu opens it. */
interface Entry {
  name: string;
  icon: ReactNode;
  /** The web: its page. The desktop app: its absolute path. */
  page?: string;
  path?: string;
}

/** The desktop app: a file or folder by its path, in a new tab (one outside the open folder, a tab on its own folder). */
async function openPathInTab(p: string, from?: 'recents' | 'favorites') {
  const res = await api.openLocalPath(p, true);
  if (res.file !== undefined) window.open(`/open?file=${encodeURIComponent(res.file)}${from ? `&from=${from}` : ''}`, '_blank');
  else if (res.folder !== undefined) window.open(res.folder ? `/?folder=${encodeURIComponent(res.folder)}` : '/', '_blank');
}

const fileEntry = (f: RecentFile): Entry => ({ name: f.name, icon: kindIcon({ kind: f.kind, title: f.name }, 16), ...(f.path ? { path: f.path } : { page: pathOfFile(f.kind, f.id!) }) });

/** The user's Favorites and Recents, read as the page opens, when the window comes back, and when a favorite changes. */
function useLists(user: boolean, local: boolean) {
  const [lists, setLists] = useState<{ favorites: Entry[]; recents: Entry[] } | null>(null);
  useEffect(() => {
    if (!user) return;
    let gone = false;
    const read = () =>
      Promise.all([api.favorites(), api.recents()]).then(
        ([fav, rec]) => {
          if (gone) return;
          const folders = fav.folders.map((f): Entry => ({ name: f.name, icon: <FolderIcon size={16} />, ...(local ? { path: f.path } : { page: `/?folder=${encodeURIComponent(f.path)}` }) }));
          setLists({ favorites: [...folders, ...fav.files.map(fileEntry)].slice(0, LISTED), recents: rec.files.map(fileEntry).slice(0, LISTED) });
        },
        () => {},
      );
    void read();
    window.addEventListener('focus', read);
    window.addEventListener(FAVORITES_CHANGED, read);
    return () => {
      gone = true;
      window.removeEventListener('focus', read);
      window.removeEventListener(FAVORITES_CHANGED, read);
    };
  }, [user, local]);
  return lists;
}

/** The File menu's first items, and the dialog Open file by path… asks in. */
export function useOpenInTab(): { items: MenuItem[]; dialog: ReactNode } {
  const { local, user } = useAuth();
  const [asking, setAsking] = useState(false);
  const shown = fileAt(useLocation().pathname);
  const lists = useLists(!!user, !!local);
  const open = (e: Entry, from: 'recents' | 'favorites') => (e.path ? void openPathInTab(e.path, from).catch(() => {}) : void window.open(e.page, '_blank'));
  const listItems = (entries: Entry[] | undefined, from: 'recents' | 'favorites', empty: string): MenuItem[] =>
    entries?.length
      ? entries.map((e) => ({
          label: (
            <span className="menu-file">
              {e.icon} {e.name}
            </span>
          ),
          action: () => open(e, from),
        }))
      : [{ label: entries ? empty : 'Loading…', disabled: true }];
  const openMenu: MenuItem[] = [
    ...(local
      ? ([
          { label: 'Open Folder…', action: () => void api.chooseLocalFolder(true) },
          { label: 'Open file by path…', action: () => setAsking(true) },
          'sep',
        ] as MenuItem[])
      : []),
    { label: 'Open Favorites', submenu: listItems(lists?.favorites, 'favorites', 'No favorites yet') },
    { label: 'Open Recents', submenu: listItems(lists?.recents, 'recents', 'No recent files') },
  ];
  return {
    items: user
      ? [{ label: 'Open', submenu: openMenu }, ...(local && shown ? [{ label: `Open in ${fileBrowserName()}`, action: () => void api.revealLocal(shown).catch(() => {}) }] : []), 'sep']
      : [],
    dialog: local && asking && (
      <PromptModal
        title="Open file by path"
        label="File or folder"
        initial=""
        placeholder="~/Documents/report.docx"
        maxLength={4096}
        confirmText="Open"
        onConfirm={async (p) => {
          const res = await api.openLocalPath(p, true);
          if (res.file !== undefined) window.open(`/open?file=${encodeURIComponent(res.file)}`, '_blank');
          else if (res.folder !== undefined) window.open(res.folder ? `/?folder=${encodeURIComponent(res.folder)}` : '/', '_blank');
        }}
        onClose={() => setAsking(false)}
      />
    ),
  };
}
