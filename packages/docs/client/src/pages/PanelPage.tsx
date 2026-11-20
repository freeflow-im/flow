// Docs as a panel in another app's side panel (docs/specs/side-panel.md §5): /docs/panel, in a frame there. Three places
// to look, as Docs' own left panel has them: Recent, Organization files and My files, the last two with their folders
// to open and a path back up. A search box finds files by name and by the words in them, as Docs' ⌘P does. A file opens
// in Docs itself: the app around the panel is asked to open it (in Home, Home does).
//
// The page has no suite bar, which is what sets the organization in Docs' other pages (DocsSuiteBar): it takes the one
// the suite last selected (readActiveOrganization), and follows a change made in another page.
import { useEffect, useState } from 'react';
import { appUrl } from '../basePath.ts';
import type { SheetMeta, StoredFile } from '../../../shared/types.ts';
import { api, type ContentHit, type FolderInfo, type Place, type RecentFile } from '../api.ts';
import { FolderIcon, kindIcon, type LibraryItem } from '../components/FileLibrary.tsx';
import { pathOfFile } from '../components/WebCopyDialogs.tsx';
import { organizationSnapshot, readActiveOrganization, setOrganizationState } from '../suite.ts';
import { endFlowRefDrag, startFlowRefDrag, type DocsFileRef } from '@flow/suite-bar';

type FileRow = Pick<LibraryItem, 'id' | 'kind' | 'title'> & { where?: string; shared?: boolean; format?: string; type?: string; size?: number };

/** Where the panel looks: Recent, or a folder of one of the organization's two roots ('' the root's top). */
type Spot = { list: 'recent' } | { root: 'org' | 'me'; path: string };

const ROOT_LABEL = { org: 'Organization files', me: 'My files' } as const;
const SPOT_KEY = 'docs.panel.spot';

function readSpot(): Spot {
  try {
    const v = JSON.parse(localStorage.getItem(SPOT_KEY) ?? 'null') as Spot | null;
    if (v && 'root' in v && (v.root === 'org' || v.root === 'me') && typeof v.path === 'string') return v;
  } catch {
    // Nothing remembered.
  }
  return { list: 'recent' };
}

function writeSpot(spot: Spot): void {
  try {
    localStorage.setItem(SPOT_KEY, JSON.stringify(spot));
  } catch {
    // Not remembered, that's all.
  }
}

/** The organization the suite selected, for the API's `workspace`; again when another page changes it. */
export function useSuiteOrganization(): string | null {
  const [id, setId] = useState(() => readActiveOrganization());
  useEffect(() => {
    const onStorage = () => setId(readActiveOrganization());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  // api's placeFields reads it from here. This runs before the page's own effects, which make the requests.
  useEffect(() => {
    if (organizationSnapshot().active?.id !== (id ?? undefined)) setOrganizationState({ active: id ? { id, name: '' } : null, organizations: [], ready: false });
  }, [id]);
  return id;
}

/** Asks the app around the panel to open an address (SidePanel.tsx follows it); a page of its own opens it here. */
function openInHost(href: string): void {
  if (window.parent !== window) window.parent.postMessage({ type: 'flow:open', href }, window.location.origin);
  else window.location.assign(href);
}

const fileOfDoc = (d: SheetMeta): FileRow => ({ id: d.id, kind: d.kind, title: d.title, where: d.folder ?? '', shared: !!d.shared, ...(d.format ? { format: d.format } : {}) });
const fileOfStored = (f: StoredFile): FileRow => ({ id: f.id, kind: 'file', title: f.filename, where: f.folder ?? '', shared: !!f.shared, type: f.type, size: f.size });

/** A file dragged out of the panel (onto an email in Mail, side-panel.md §7): what it is, and its address for anything else. */
const refOf = (r: FileRow): DocsFileRef => ({
  app: 'docs',
  kind: r.kind as DocsFileRef['kind'],
  id: r.id,
  name: r.title,
  folder: r.where ?? '',
  shared: !!r.shared,
  ...(r.format ? { format: r.format } : {}),
  ...(r.type ? { type: r.type } : {}),
  ...(r.size !== undefined ? { size: r.size } : {}),
});
const placeOfSpot = (spot: Extract<Spot, { root: string }>, org: string | null): Place => (spot.root === 'org' && org ? { folder: spot.path, shared: true, workspace: org } : spot.path);

export function PanelPage() {
  const org = useSuiteOrganization();
  const [spot, setSpotState] = useState<Spot>(() => readSpot());
  const setSpot = (next: Spot) => {
    setSpotState(next);
    writeSpot(next);
  };
  const [q, setQ] = useState('');
  const [listing, setListing] = useState<{ key: string; folders: FolderInfo[]; files: FileRow[] } | null>(null);
  const [found, setFound] = useState<{ q: string; files: FileRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const spotKey = `${org}:${JSON.stringify(spot)}`;

  // The place shown: Recent, or a folder's subfolders and files. Again when the panel comes back into view.
  useEffect(() => {
    let live = true;
    const read = () => {
      const done = (folders: FolderInfo[], files: FileRow[]) => {
        if (!live) return;
        setError(null);
        setListing({ key: spotKey, folders, files });
      };
      const fail = (e: Error) => live && setError(e.message);
      if ('list' in spot) api.recents().then((r) => done([], r.files.flatMap((f: RecentFile) => (f.id ? [{ id: f.id, kind: f.kind, title: f.name, where: f.folder ?? '', shared: !!f.shared, ...(f.format ? { format: f.format } : {}), ...(f.size !== undefined ? { size: f.size } : {}) }] : []))), fail);
      else api.library(placeOfSpot(spot, org)).then((r) => done(r.folders, [...r.docs.map(fileOfDoc), ...r.files.map(fileOfStored)]), fail);
    };
    read();
    const onVisible = () => document.visibilityState === 'visible' && read();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', onVisible);
    };
    // spotKey names spot and org.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spotKey]);

  // Asked a moment after typing stops: names, then documents found by their words; an answer for words since changed is dropped.
  useEffect(() => {
    const text = q.trim();
    if (!text) return setFound(null);
    let live = true;
    const timer = setTimeout(() => {
      // Names in both roots (a search names one root: My files unless asked for Organization files).
      const empty = { docs: [] as SheetMeta[], files: [] as StoredFile[] };
      const shared = org ? api.searchLibrary(text, { folder: '', shared: true, workspace: org }).catch(() => empty) : Promise.resolve(empty);
      Promise.all([api.searchLibrary(text), shared, api.searchContent(text, '').catch(() => ({ hits: [] as ContentHit[] }))]).then(
        ([mine, ours, words]) => {
          if (!live) return;
          const files = [...ours.docs.map(fileOfDoc), ...ours.files.map(fileOfStored)];
          for (const f of [...mine.docs.map(fileOfDoc), ...mine.files.map(fileOfStored)]) if (!files.some((x) => x.id === f.id)) files.push(f);
          const listed = new Set(files.map((f) => f.id));
          for (const h of words.hits) if (!listed.has(h.id)) files.push({ id: h.id, kind: h.kind, title: h.title, where: h.container ?? '' });
          setError(null);
          setFound({ q: text, files });
        },
        (e: Error) => live && setError(e.message),
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, org]);

  const searching = !!q.trim();
  const shown = searching ? (found ? { folders: [] as FolderInfo[], files: found.files } : null) : listing?.key === spotKey ? listing : null;
  const crumbs = 'root' in spot ? spot.path.split('/').filter(Boolean) : [];

  return (
    <div className="docs-panel">
      <input className="docs-panel-search" type="search" placeholder="Search files" aria-label="Search files" value={q} onChange={(e) => setQ(e.target.value)} />
      {!searching && (
        <>
          <div className="docs-panel-places" role="tablist" aria-label="Where">
            <button type="button" role="tab" aria-selected={'list' in spot} onClick={() => setSpot({ list: 'recent' })}>Recent</button>
            {org && <button type="button" role="tab" aria-selected={'root' in spot && spot.root === 'org'} onClick={() => setSpot({ root: 'org', path: '' })}>Organization</button>}
            <button type="button" role="tab" aria-selected={'root' in spot && spot.root === 'me'} onClick={() => setSpot({ root: 'me', path: '' })}>My files</button>
          </div>
          {'root' in spot && (
            <nav className="docs-panel-crumbs" aria-label="Folder">
              <button type="button" onClick={() => setSpot({ root: spot.root, path: '' })} disabled={!crumbs.length}>{ROOT_LABEL[spot.root]}</button>
              {crumbs.map((name, i) => (
                <span key={i}>
                  <span aria-hidden> › </span>
                  <button type="button" onClick={() => setSpot({ root: spot.root, path: crumbs.slice(0, i + 1).join('/') })} disabled={i === crumbs.length - 1}>{name}</button>
                </span>
              ))}
            </nav>
          )}
        </>
      )}
      {error ? (
        <div className="docs-panel-empty">{error}</div>
      ) : !shown ? (
        <div className="docs-panel-empty">Loading…</div>
      ) : !shown.folders.length && !shown.files.length ? (
        <div className="docs-panel-empty">{searching ? 'No files match.' : 'list' in spot ? 'Files you open in Docs show here.' : 'This folder is empty.'}</div>
      ) : (
        <ul className="docs-panel-list">
          {shown.folders.map((f) => (
            <li key={`folder:${f.path}`}>
              <button type="button" className="docs-panel-row" onClick={() => 'root' in spot && setSpot({ root: spot.root, path: f.path })} title={`Open ${f.name}`}>
                <span className="docs-panel-icon"><FolderIcon size={18} /></span>
                <span className="docs-panel-name">{f.name}</span>
              </button>
            </li>
          ))}
          {shown.files.map((r) => (
            <li key={`${r.kind}:${r.id}`}>
              <button
                type="button"
                className="docs-panel-row"
                draggable
                onDragStart={(e) => startFlowRefDrag(e, refOf(r), new URL(appUrl(pathOfFile(r.kind, r.id)), window.location.origin).href)}
                onDragEnd={endFlowRefDrag}
                onClick={() => openInHost(appUrl(pathOfFile(r.kind, r.id)))}
                title={`Open ${r.title} in Docs, or drag it onto an email`}
              >
                <span className="docs-panel-icon">{kindIcon({ kind: r.kind, title: r.title }, 18)}</span>
                <span className="docs-panel-name">{r.title}</span>
                {(searching || 'list' in spot) && r.where && <span className="docs-panel-where">{r.where}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
