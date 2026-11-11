// The Docs app's left panel in the FreeFlow suite (main.tsx): Recents, Favorites, Shared with me and the folder tree of
// the organization selected in the suite bar (Organization files, then My files). Choosing a folder shows its files on
// the home page beside it; a file opened from there takes that place, and the panel stays, with the file's folder
// still selected. The tree reads each folder's subfolders when it is opened (api.library), and again when the home
// page says the folders changed (FOLDERS_CHANGED).
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api, type FolderInfo, type Place } from '../api.ts';
import { cleanFolderPath } from '../../../shared/folders.ts';
import { FAVORITES_PARAM, last as lastListing, RECENTS_PARAM, SHARED_WITH_ME_PARAM } from '../listing.ts';
import { useOrganization } from '../organization.ts';
import { FOLDER_PANEL } from '../panelSize.ts';
import { ResizeHandle, usePanelWidth } from './ResizeHandle.tsx';
import { ORG_PARAM } from './RootSwitch.tsx';

/** The window event the home page sends after it made, deleted, moved or renamed a folder. */
export const FOLDERS_CHANGED = 'docs:folders-changed';
export const foldersChanged = (): void => void window.dispatchEvent(new Event(FOLDERS_CHANGED));

const EXPANDED_KEY = 'docs.nav.expanded';
/** The panel folded to a rail of icons, to give the page its room ('1'); remembered in this browser. */
const COLLAPSED_KEY = 'docs.nav.collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

/** A root of the tree: the organization's shared files, or the user's own. */
type Root = 'org' | 'me';
/** A folder of the tree, named by its root and path (the root's top is ''). */
const keyOf = (root: Root, path: string) => `${root}:${path}`;

function readExpanded(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? 'null') as unknown;
    if (Array.isArray(v)) return new Set(v.filter((x): x is string => typeof x === 'string'));
  } catch {
    // Nothing remembered.
  }
  return new Set([keyOf('org', ''), keyOf('me', '')]);
}

function writeExpanded(set: Set<string>) {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...set]));
  } catch {
    // Not remembered, that's all.
  }
}

/** One of the lists beside the folders. */
type List = 'recents' | 'favorites' | 'withme';
const LIST_PARAM: Record<List, string> = { recents: RECENTS_PARAM, favorites: FAVORITES_PARAM, withme: SHARED_WITH_ME_PARAM };

/** What the panel shows as selected: one of the lists, or a folder. */
type Selected = { list: List } | { root: Root; path: string } | null;

function selectedOf(params: URLSearchParams, hasOrg: boolean): Selected {
  if (params.get(RECENTS_PARAM) === '1') return { list: 'recents' };
  if (params.get(FAVORITES_PARAM) === '1') return { list: 'favorites' };
  if (hasOrg && params.get(SHARED_WITH_ME_PARAM) === '1') return { list: 'withme' };
  const path = cleanFolderPath(params.get('folder') ?? '') ?? '';
  return { root: hasOrg && params.has(ORG_PARAM) ? 'org' : 'me', path };
}

/** The folders above a path and the path itself: 'a/b' → ['', 'a', 'a/b']. */
const lineage = (path: string) => ['', ...path.split('/').filter(Boolean).map((_, i, all) => all.slice(0, i + 1).join('/'))];

export function DocsNav() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const org = useOrganization();
  const orgId = org.active?.id ?? null;
  const onHome = pathname === '/';
  // On the home page the address says; on a file's page, the list it was opened from (listing.ts).
  const selected = selectedOf(onHome ? params : new URLSearchParams(lastListing()), !!orgId);
  const [expanded, setExpanded] = useState(readExpanded);
  const [children, setChildren] = useState<Map<string, FolderInfo[] | 'error'>>(new Map());
  // Its width, dragged on its right edge and remembered; the page beside it keeps its least width.
  const [collapsed, setCollapsedState] = useState(readCollapsed);
  const setCollapsed = (on: boolean) => {
    setCollapsedState(on);
    try {
      if (on) localStorage.setItem(COLLAPSED_KEY, '1');
      else localStorage.removeItem(COLLAPSED_KEY);
    } catch {
      // This page keeps it until it reloads.
    }
  };
  const panel = usePanelWidth(FOLDER_PANEL, () => ({ viewport: window.innerWidth, maxFraction: 0.4 }));
  const asked = useRef(new Set<string>());
  // The selection whose folders were last opened: a folder the user then closes stays closed.
  const opened = useRef('');

  const placeOf = useCallback((root: Root, path: string): Place => (root === 'org' && orgId ? { folder: path, shared: true, workspace: orgId } : path), [orgId]);

  const load = useCallback(
    (root: Root, path: string) => {
      const key = keyOf(root, path);
      asked.current.add(key);
      api.library(placeOf(root, path)).then(
        (r) => setChildren((m) => new Map(m).set(key, r.folders)),
        () => setChildren((m) => new Map(m).set(key, 'error')),
      );
    },
    [placeOf],
  );

  // Another organization: another tree. Not when the organizations' list arrives and names the same one (`org.ready`):
  // the folders read so far are that organization's, and reading them all again made the page's start slower.
  useEffect(() => {
    asked.current = new Set();
    setChildren(new Map());
  }, [orgId]);

  const roots: Root[] = orgId ? ['org', 'me'] : ['me'];
  // Every open folder whose subfolders are not read yet is read. A folder chosen (here or in the list) is opened, with
  // the folders above it, to show the folders in it.
  const selKey = selected && 'root' in selected ? keyOf(selected.root, selected.path) : '';
  useEffect(() => {
    if (!org.ready && !orgId) return;
    if (selected && 'root' in selected && opened.current !== selKey) {
      opened.current = selKey;
      const line = lineage(selected.path).map((p) => keyOf(selected.root, p));
      if (line.some((k) => !expanded.has(k))) {
        const next = new Set(expanded);
        for (const k of line) next.add(k);
        setExpanded(next);
        writeExpanded(next);
        return;
      }
    }
    for (const root of roots) {
      const walk = (path: string) => {
        const key = keyOf(root, path);
        if (!expanded.has(key)) return;
        if (!asked.current.has(key)) load(root, path);
        const kids = children.get(key);
        if (Array.isArray(kids)) for (const k of kids) walk(k.path);
      };
      walk('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, children, selKey, orgId, org.ready, load]);

  // The home page made, moved or deleted a folder: read again every folder read so far.
  useEffect(() => {
    const again = () => {
      for (const key of asked.current) {
        const i = key.indexOf(':');
        load(key.slice(0, i) as Root, key.slice(i + 1));
      }
    };
    window.addEventListener(FOLDERS_CHANGED, again);
    return () => window.removeEventListener(FOLDERS_CHANGED, again);
  }, [load]);

  const toggle = (key: string) => {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setExpanded(next);
    writeExpanded(next);
  };

  const openFolder = (root: Root, path: string) => {
    const q = new URLSearchParams();
    if (root === 'org' && orgId) q.set(ORG_PARAM, orgId);
    if (path) q.set('folder', path);
    const s = q.toString();
    navigate(s ? `/?${s}` : '/');
  };

  const renderFolder = (root: Root, path: string, name: string, depth: number, icon?: ReactNode): ReactNode => {
    const key = keyOf(root, path);
    const kids = children.get(key);
    const open = expanded.has(key);
    const leaf = Array.isArray(kids) && kids.length === 0;
    const active = !!selected && 'root' in selected && selected.root === root && selected.path === path;
    return (
      <li key={key} role="treeitem" aria-expanded={leaf ? undefined : open} aria-selected={active}>
        <div className={`dn-row${active ? ' active' : ''}`} style={{ paddingLeft: 6 + depth * 14 }}>
          {leaf ? (
            <span className="dn-caret" />
          ) : (
            <button className="dn-caret" aria-label={open ? `Close ${name}` : `Open ${name}`} onClick={() => toggle(key)}>
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" style={{ transform: open ? 'rotate(90deg)' : undefined }}>
                <path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
          <button className="dn-label" title={name} onClick={() => openFolder(root, path)} aria-current={active ? 'page' : undefined}>
            {icon ?? <FolderGlyph />}
            <span>{name}</span>
          </button>
        </div>
        {open && Array.isArray(kids) && kids.length > 0 && (
          <ul role="group">{kids.map((k) => renderFolder(root, k.path, k.name, depth + 1))}</ul>
        )}
        {open && kids === 'error' && (
          <div className="dn-note" style={{ paddingLeft: 26 + depth * 14 }}>
            Couldn’t list these folders.
          </div>
        )}
      </li>
    );
  };

  const listRow = (list: List, label: string, icon: ReactNode) => {
    const active = !!selected && 'list' in selected && selected.list === list;
    return (
      <button className={`dn-row dn-item${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined} onClick={() => navigate(`/?${LIST_PARAM[list]}=1`)}>
        {icon}
        <span>{label}</span>
      </button>
    );
  };

  if (collapsed) {
    const rail = (key: string, label: string, icon: ReactNode, active: boolean, go: () => void) => (
      <button key={key} className={`dn-rail-btn${active ? ' active' : ''}`} title={label} aria-label={label} aria-current={active ? 'page' : undefined} onClick={go}>
        {icon}
      </button>
    );
    const isList = (l: List) => !!selected && 'list' in selected && selected.list === l;
    const inRoot = (root: Root) => !!selected && 'root' in selected && selected.root === root;
    return (
      <nav className="docs-nav docs-nav-collapsed" aria-label="Folders">
        <button className="dn-rail-btn" title="Show folders" aria-label="Show folders" aria-expanded={false} onClick={() => setCollapsed(false)}>
          <PanelGlyph open />
        </button>
        <div className="dn-rail-sep" />
        {rail('recents', 'Recents', <ClockGlyph />, isList('recents'), () => navigate(`/?${RECENTS_PARAM}=1`))}
        {rail('favorites', 'Favorites', <StarGlyph />, isList('favorites'), () => navigate(`/?${FAVORITES_PARAM}=1`))}
        {orgId && rail('withme', 'Shared with me', <SharedGlyph />, isList('withme'), () => navigate(`/?${SHARED_WITH_ME_PARAM}=1`))}
        {orgId && rail('org', 'Organization files', <PeopleGlyph />, inRoot('org'), () => openFolder('org', ''))}
        {rail('me', 'My files', <LockGlyph />, inRoot('me'), () => openFolder('me', ''))}
      </nav>
    );
  }

  return (
    <nav className="docs-nav" aria-label="Folders" style={{ width: panel.width }}>
      <button className="dn-collapse" title="Hide folders" aria-label="Hide folders" aria-expanded onClick={() => setCollapsed(true)}>
        <PanelGlyph />
      </button>
      <div className="dn-scroll">
        {listRow('recents', 'Recents', <ClockGlyph />)}
        {listRow('favorites', 'Favorites', <StarGlyph />)}
        {orgId && listRow('withme', 'Shared with me', <SharedGlyph />)}
        <div className="dn-section">Folders</div>
        <ul className="dn-tree" role="tree" aria-label="Folders">
          {orgId && renderFolder('org', '', 'Organization files', 0, <PeopleGlyph />)}
          {renderFolder('me', '', 'My files', 0, <LockGlyph />)}
        </ul>
      </div>
      <ResizeHandle panel={panel} side="left" label="Resize folder panel" className="docs-nav-resize" />
    </nav>
  );
}

const glyph = (d: string) => (
  <svg className="dn-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
    <path d={d} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const FolderGlyph = () => glyph('M3 7.5A1.5 1.5 0 0 1 4.5 6h4.4a1.5 1.5 0 0 1 1.1.5l1.2 1.3h8.3A1.5 1.5 0 0 1 21 9.3v8.2a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z');
const ClockGlyph = () => glyph('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2');
const StarGlyph = () => glyph('M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z');
const PeopleGlyph = () => glyph('M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M22 19v-1a4 4 0 0 0-3-3.9M16 3.1a3.5 3.5 0 0 1 0 6.8');
/** A panel beside a page, with the arrow that folds it away (or, `open`, brings it back). */
const PanelGlyph = ({ open = false }: { open?: boolean }) => glyph(open ? 'M4 5h16v14H4zM9 5v14M13 10l2 2-2 2' : 'M4 5h16v14H4zM9 5v14M16 10l-2 2 2 2');
const SharedGlyph = () => glyph('M15 8a3 3 0 1 0 0-.01M6 15a3 3 0 1 0 0-.01M18 21a3 3 0 1 0 0-.01M8.6 13.5l6.8-4M8.6 16.5l6.8 3.5');
const LockGlyph = () => glyph('M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z');
