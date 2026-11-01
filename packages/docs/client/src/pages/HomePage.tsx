import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { isHtmlName, type DeletedFile, type StoredFile } from '../../../shared/types.ts';
import { AgentButton } from '../agent/AgentPanel.tsx';
import { useAgent } from '../agent/AgentProvider.tsx';
import { api, type FolderInfo, type RecentFile } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { Account } from '../components/Account.tsx';
import { StarButton } from '../components/FavoriteStar.tsx';
import { FileSearchButton } from '../components/FileSearch.tsx';
import { FileLibrary, formatWhen, kindIcon, type LibraryItem } from '../components/FileLibrary.tsx';
import { FileThumb } from '../components/FileThumb.tsx';
import { HomeIcon } from '../components/Logo.tsx';
import { Modal, PromptModal } from '../components/Modal.tsx';
import { MoveModal } from '../components/MoveModal.tsx';
import { fileBrowserName } from '../desktopBridge.ts';
import { useFavicon } from '../favicon.ts';
import { FAVORITES_PARAM, RECENTS_PARAM, rememberListing, rememberReturn, returnTo, useListingScroll } from '../listing.ts';
import { LocalFolderMenu, LocalFolderParent, parentDir } from '../components/LocalFolderMenu.tsx';
import { ScratchPadTile } from '../components/ScratchPadTile.tsx';
import { openFromRecents } from './OpenLocalFile.tsx';
import { FilePreviewFrame } from '../components/FilePreviewFrame.tsx';
import { checkImportFile, imageTypeOf, isKnownImport, isCsvFile, isHtmlFile, isImageFile, isMarkdownFile, isPdfFile, isPowerPointFile, isVideoFile, isWordFile, titleFromFileName } from '../importFile.ts';
import { csvTitle } from '../../../shared/csv.ts';
import { cleanFolderPath, folderTrail } from '../../../shared/folders.ts';
import { markdownTitle } from '../../../shared/markdown.ts';
import { appName } from '../brand.ts';
import { inDesktopApp, PlaceSwitch } from '../components/PlaceSwitch.tsx';
import { downloadLink, DownloadFromWebDialog, pathOfFile, UploadToWebDialog } from '../components/WebCopyDialogs.tsx';
import { downloadPdf } from '../print.ts';

const pathOf = (s: LibraryItem) => (s.kind === 'deck' ? `/d/${s.id}` : s.kind === 'doc' ? `/doc/${s.id}` : s.kind === 'markdown' ? `/md/${s.id}` : s.kind === 'file' ? `/f/${s.id}` : `/s/${s.id}`);

/** The last "Find files" search and its results, kept while the list is unchanged. */
let lastFind: { text: string; result: Promise<{ folders: FolderInfo[]; items: LibraryItem[]; truncated: boolean }> } | null = null;

/** A stored file as a row of the list. */
const fileItem = (x: StoredFile): LibraryItem => ({ id: x.id, title: x.filename, kind: 'file', folder: x.folder, ...(x.text ? { text: true } : {}), createdAt: x.createdAt, updatedAt: x.createdAt });

/** The last part of a directory's path, to name the desktop app's mounted folder. */
const dirName = (dir: string) => dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;

/**
 * The file list. In a window that moved to a scratch pad's folder to show it, a way back to a list (breadcrumbs,
 * the logo, Home) moves the window back to the folder it came from instead (listing.ts' returnTo).
 */
export function HomePage() {
  const [params] = useSearchParams();
  const [back, setBack] = useState(returnTo);
  useEffect(() => {
    if (!back) return;
    rememberReturn(null);
    api.returnToFolder(back.dir, params.get(RECENTS_PARAM) ? '' : (params.get('folder') ?? '')).catch(() => setBack(null));
    // Once, as the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return back ? <div className="page-loading">Opening…</div> : <FileList />;
}

function FileList() {
  const { local, user } = useAuth();
  const navigate = useNavigate();
  useFavicon('home');
  // The folder being shown is part of the address (/?folder=reports/2026), so Back and links work.
  // So is the search (&q=plan, and &find=1 for "Find files"): coming back from a file shows the same results.
  const [params, setParams] = useSearchParams();
  const folder = cleanFolderPath(params.get('folder') ?? '') ?? '';
  const search = { text: params.get('q') ?? '', find: params.get('find') === '1' };
  const query = params.toString();
  useEffect(() => rememberListing(query ? `?${query}` : ''), [query]);
  const setSearch = (text: string, find: boolean) =>
    setParams(
      (cur) => {
        const next = new URLSearchParams(cur);
        if (text) next.set('q', text);
        else next.delete('q');
        if (text && find) next.set('find', '1');
        else next.delete('find');
        return next;
      },
      { replace: true },
    );
  // Recents (&recents=1), listed in place of the folder's: the files last opened in the app, and in the desktop
  // app then the ones last opened on this computer in any app. There a file of Recents is named by its path,
  // and opening one that is in another folder makes that folder the open one.
  const recents = params.get(RECENTS_PARAM) === '1';
  // Favorites (&favorites=1), also in place of the folder's: the folders and files the user keeps at hand. In the
  // desktop app they are named by their paths, as Recents' are, and may be anywhere.
  const favoritesShown = !recents && params.get(FAVORITES_PARAM) === '1';
  // A list other than the folder's is shown: its rows can only be opened, or what its menu offers.
  const otherShown = recents || favoritesShown;
  const elsewhere = otherShown && !!local;
  const showList = (list: typeof RECENTS_PARAM | typeof FAVORITES_PARAM, on: boolean) =>
    setParams((cur) => {
      const next = new URLSearchParams(cur);
      next.delete(RECENTS_PARAM);
      next.delete(FAVORITES_PARAM);
      if (on) next.set(list, '1');
      return next;
    });
  const showRecents = (on: boolean) => showList(RECENTS_PARAM, on);

  const [favorites, setFavorites] = useState<{ items: LibraryItem[]; folders: FolderInfo[]; where: Map<string, string>; keys: Set<string> } | null>(null);
  const [favoritesError, setFavoritesError] = useState<string | null>(null);
  const loadFavorites = () =>
    api.favorites().then(
      (r) => {
        const keyOf = (f: RecentFile) => f.id ?? f.path ?? '';
        const where = new Map<string, string>();
        for (const f of r.files) where.set(keyOf(f), f.where ?? (f.folder || 'Your files'));
        for (const f of r.folders) where.set(`folder:${f.path}`, f.where || (local ? '' : 'Your files'));
        const items = r.files.map(
          (f): LibraryItem => ({
            id: keyOf(f),
            kind: f.kind,
            ...(f.format ? { format: f.format } : /\.csv$/i.test(f.name) && f.path ? { format: 'csv' as const } : {}),
            ...(f.text ? { text: true } : {}),
            ...(f.folder ? { folder: f.folder } : {}),
            title: f.name,
            updatedAt: f.lastUsed,
            createdAt: f.lastUsed,
          }),
        );
        setFavorites({ items, folders: r.folders.map(({ name, path }) => ({ name, path })), where, keys: new Set(r.keys) });
        setFavoritesError(null);
      },
      (e: Error) => setFavoritesError(e.message),
    );
  // Read once (the menus say whether each file is one), and again when the list is shown.
  useEffect(() => {
    if (user) void loadFavorites();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, favoritesShown]);
  const setFavorite = (what: Parameters<typeof api.setFavorite>[0], on: boolean) =>
    api.setFavorite(what, on).then(loadFavorites, (e: Error) => setError(e.message));
  const favoriteAction = (key: string, what: Parameters<typeof api.setFavorite>[0]) => {
    const on = !!favorites?.keys.has(key);
    return { label: on ? 'Remove from Favorites' : 'Add to Favorites', onClick: () => setFavorite(what, !on) };
  };
  // A favorite of the desktop app is opened by its path: in the open folder it is shown here, otherwise the window
  // moves to its folder.
  // The star before the folder's name: whether the folder shown is one of the Favorites (on the web the top of the
  // library is not a folder that can be). Not while another list is shown.
  const folderStar =
    user && !otherShown && (local || folder) ? (
      <StarButton on={favorites ? favorites.keys.has(`folder:${folder}`) : null} onClick={() => void setFavorite({ folder }, !favorites?.keys.has(`folder:${folder}`))} />
    ) : null;
  const openFavorite = async (s: LibraryItem) => {
    if (!local) return navigate(pathOf(s));
    try {
      const res = await api.openLocalPath(s.id);
      if (res.file !== undefined) navigate(openFromRecents(res.file, FAVORITES_PARAM));
    } catch (e) {
      setFavoritesError(e instanceof Error ? e.message : String(e));
    }
  };
  const openFavoriteFolder = async (path: string) => {
    if (!local) return openFolder(path);
    try {
      const res = await api.openLocalPath(path);
      if (res.folder !== undefined) openFolder(res.folder);
    } catch (e) {
      setFavoritesError(e instanceof Error ? e.message : String(e));
    }
  };
  const [recentFiles, setRecentFiles] = useState<{ items: LibraryItem[]; where: Map<string, string>; app: Set<string>; blocked: string[] } | null>(null);
  // The desktop app's files from Spotlight, which can take seconds: the app's own (and Spotlight's last answer) are shown while it looks.
  const [recentsSearching, setRecentsSearching] = useState(false);
  const [recentsError, setRecentsError] = useState<string | null>(null);
  const [openingRecent, setOpeningRecent] = useState<string | null>(null);
  useEffect(() => {
    if (!recents) return;
    let gone = false;
    setRecentsError(null);
    setRecentsSearching(false);
    const fail = (e: unknown) => !gone && (setRecentsError(e instanceof Error ? e.message : String(e)), setRecentsSearching(false));
    // In the desktop app a file of Recents is named by its path: it has no id here until its folder is the open one.
    const keyOf = (f: RecentFile) => f.id ?? f.path ?? '';
    const itemOf = (f: RecentFile): LibraryItem => ({
      id: keyOf(f),
      kind: f.kind,
      ...(f.format ? { format: f.format } : /\.csv$/i.test(f.name) && f.path ? { format: 'csv' as const } : {}),
      ...(f.text ? { text: true } : {}),
      ...(f.folder ? { folder: f.folder } : {}),
      title: f.name,
      updatedAt: f.lastUsed,
      createdAt: f.lastUsed,
    });
    const whereOf = (f: RecentFile) => f.where ?? (f.folder ? f.folder : 'Your files');
    api
      .recents()
      .then((mine) => {
        if (gone) return;
        const app = new Set(mine.files.map(keyOf));
        // The app's own first, then the system's that are not among them.
        const show = (system?: { files: RecentFile[]; blocked: string[] }) => {
          const all = [...mine.files, ...(system?.files ?? []).filter((f) => !app.has(keyOf(f)))];
          setRecentFiles({ items: all.map(itemOf), where: new Map(all.map((f) => [keyOf(f), whereOf(f)])), app, blocked: system?.blocked ?? [] });
        };
        // Spotlight's last answer is shown until the new one comes; without one, a spinner says it is coming.
        show(mine.cached);
        if (!mine.system) return;
        setRecentsSearching(!mine.cached);
        return api.recentsSystem().then((system) => {
          if (gone) return;
          show(system);
          setRecentsSearching(false);
        });
      })
      .catch((e: unknown) => {
        if (!gone) setRecentFiles((cur) => cur ?? { items: [], where: new Map(), app: new Set(), blocked: [] });
        fail(e);
      });
    return () => {
      gone = true;
    };
  }, [recents]);
  const openRecent = async (s: LibraryItem) => {
    if (!local) return navigate(pathOf(s));
    if (openingRecent) return;
    setOpeningRecent(s.title);
    setRecentsError(null);
    try {
      const res = await api.openLocal(s.id);
      // In the open folder already: shown here. Otherwise the app is switching folders and this window is about to be replaced.
      if (res.file) navigate(openFromRecents(res.file));
    } catch (e) {
      setRecentsError(e instanceof Error ? e.message : String(e));
      setOpeningRecent(null);
    }
  };
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  // The folder the rows are of: for a moment after another folder is opened they are still the last one's.
  const [listed, setListed] = useState<string | null>(null);
  const [folders, setFolders] = useState<FolderInfo[]>([]);
  const [moving, setMoving] = useState<LibraryItem | null>(null);
  const [uploading, setUploading] = useState<LibraryItem | null>(null);
  // A web file to download into the folder (desktop app): the app opens the home page with it.
  const webKind = (['doc', 'deck', 'sheet', 'markdown', 'file'] as const).find((k) => k === params.get('kind'));
  const webDownload = local && params.get('webDownload') && webKind ? { id: params.get('webDownload')!, kind: webKind, title: params.get('title') ?? '' } : null;
  const closeWebDownload = () =>
    setParams(
      (cur) => {
        const next = new URLSearchParams(cur);
        for (const k of ['webDownload', 'kind', 'title']) next.delete(k);
        return next;
      },
      { replace: true },
    );
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [branching, setBranching] = useState<LibraryItem | null>(null);

  // The guide is a presentation of the user's own: the first click makes their copy of it (on the server).
  const openingGuide = useRef(false);
  const openGuide = async () => {
    if (openingGuide.current) return;
    openingGuide.current = true;
    try {
      navigate(`/d/${(await api.gettingStarted()).deck.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      openingGuide.current = false;
    }
  };
  // Deleted files kept in the off-box copy for 30 days; null while closed.
  const [trash, setTrash] = useState<{ files: DeletedFile[]; available: boolean } | 'loading' | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  const importFile = async (file: File) => {
    const problem = checkImportFile(file);
    if (problem) return setError(problem);
    setError(null);
    setImporting(file.name);
    try {
      if (isPowerPointFile(file)) {
        const { deck, warnings } = await api.importPptx(file, titleFromFileName(file.name), folder);
        navigate(`/d/${deck.id}`, { state: { importWarnings: warnings } });
        return;
      }
      if (isVideoFile(file)) {
        // Stored as the file it is and played in its own page.
        const stored = await api.uploadFile(file.name, file, folder);
        navigate(`/f/${stored.id}`);
        return;
      }
      if (isImageFile(file)) {
        // Stored as the picture it is and shown in its own page.
        const stored = await api.uploadFile(file.name, new Blob([file], { type: imageTypeOf(file.name)! }), folder);
        navigate(`/f/${stored.id}`);
        return;
      }
      if (isHtmlFile(file)) {
        // Stored as the page it is and shown in a sandboxed frame. Sent as plain bytes: the server names its type.
        const stored = await api.uploadFile(file.name, new Blob([file], { type: 'application/octet-stream' }), folder);
        navigate(`/f/${stored.id}`);
        return;
      }
      if (isPdfFile(file)) {
        const { file: stored } = await api.importPdf(file, folder);
        navigate(`/f/${stored.id}`);
        return;
      }
      if (isWordFile(file)) {
        const { doc, warnings } = await api.importDocx(file, titleFromFileName(file.name), folder);
        navigate(`/doc/${doc.id}`, { state: { importWarnings: warnings } });
        return;
      }
      if (isMarkdownFile(file)) {
        const text = await file.text();
        const { doc } = await api.createMarkdown(markdownTitle(text, file.name), text, folder);
        navigate(`/md/${doc.id}`);
        return;
      }
      if (isCsvFile(file)) {
        // Stored as the CSV file it is, and opened in the spreadsheet editor.
        const { sheet } = await api.importCsv(csvTitle(file.name), await file.text(), folder);
        navigate(`/s/${sheet.id}`);
        return;
      }
      if (!isKnownImport(file)) {
        // Any other file is kept as it is: it is listed here, to download, move or delete, but not opened.
        await api.uploadFile(file.name, new Blob([file], { type: 'application/octet-stream' }), folder);
        setImporting(null);
        await load();
        return;
      }
      const { sheet, warnings } = await api.importXlsx(file, titleFromFileName(file.name), folder);
      navigate(`/s/${sheet.id}`, { state: { importWarnings: warnings } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setImporting(null);
    }
  };

  // The folder's folders, and its spreadsheets, presentations, documents, Markdown documents and stored files in one list.
  const arrived = useRef(false);
  const shown = useRef(folder);
  shown.current = folder;
  const load = (changed = true) => {
    if (changed) lastFind = null;
    return api
      .library(folder)
      .then((r) => {
        if (shown.current !== folder) return; // Another folder was opened meanwhile.
        setFolders(r.folders);
        setItems([...r.docs, ...r.files.map(fileItem)]);
        setListed(folder);
        setError(null);
      })
      .catch((e: Error) => {
        if (shown.current !== folder) return;
        // Nothing to list, and the reason: not a list that looks empty or one still loading.
        setFolders([]);
        setItems([]);
        setListed(folder);
        setError(e.message);
      });
  };
  const openFolder = (path: string) => navigate(path ? `/?folder=${encodeURIComponent(path)}` : '/');

  const openTrash = () => {
    setTrash('loading');
    api.listTrash().then(setTrash, (e: Error) => (setError(e.message), setTrash(null)));
  };
  const restoreFile = async (f: DeletedFile) => {
    setRestoring(f.id);
    try {
      await api.restoreFromTrash(f.id);
      setTrash((t) => (t && t !== 'loading' ? { ...t, files: t.files.filter((x) => x.id !== f.id) } : t));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRestoring(null);
    }
  };

  // Reload after the assistant finishes a request, in case it created a spreadsheet.
  const { running: agentRunning } = useAgent();
  useEffect(() => {
    // Arriving at the list is not a change to it; the assistant finishing may be.
    if (!agentRunning) void load(arrived.current);
    arrived.current = true;
  }, [agentRunning, folder]);
  useEffect(() => setItems(null), [folder]);
  // In the desktop app, other programs add, remove and change files in the folder too: the list follows them.
  useEffect(() => {
    if (!local || otherShown || typeof EventSource === 'undefined') return;
    const events = new EventSource(`/api/local/folder-changes?folder=${encodeURIComponent(folder)}`);
    events.onmessage = () => void load();
    return () => events.close();
  }, [local, otherShown, folder]);
  // Back at a list, it is where it was scrolled to.
  useListingScroll(query, recents ? recentFiles !== null : favoritesShown ? favorites !== null : items !== null && listed === folder);

  useEffect(() => {
    document.title = appName();
  }, []);

  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!moreRef.current?.contains(e.target as Node)) setMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMoreOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [moreOpen]);

  return (
    <FileLibrary
      brand={
        <>
          <HomeIcon />
          <span>{appName()}</span>
          <PlaceSwitch />
        </>
      }
      listTitle={local ? dirName(local.dir) : undefined}
      crumbsShown={local ? 2 : undefined}
      crumbTitle={local ? (p) => (p ? `${local.dir.replace(/[\\/]+$/, '')}/${p}` : local.dir) : undefined}
      listIcon={
        local ? (
          <>
            <LocalFolderMenu folder={folder} onFile={(rel) => navigate(`/open?file=${encodeURIComponent(rel)}`)} onFolder={openFolder} />
            {folderStar}
            {/* At the folder's top the folder above it on disk is the parent crumb; below, the trail has one. */}
            {!folder && <LocalFolderParent dir={local.dir} />}
          </>
        ) : (
          folderStar
        )
      }
      folder={folderTrail(folder)}
      folders={recents ? [] : favoritesShown ? (favorites?.folders ?? []) : folders}
      onOpenFolder={favoritesShown ? (p) => void openFavoriteFolder(p) : openFolder}
      up={
        otherShown
          ? undefined
          : folder
            ? { folder: folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '', onOpen: () => openFolder(folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '') }
            : // At the top of the desktop app's folder: its parent, which the window moves to.
              local && parentDir(local.dir)
              ? { onOpen: () => void api.openLocalPath(parentDir(local.dir)!).catch((e: Error) => setError(e.message)) }
              : undefined
      }
      otherLists={
        user
          ? [{
              label: 'Recents',
              active: recents,
              onSelect: showRecents,
              where: (s) => recentFiles?.where.get(s.id) ?? '',
              // The files opened in this app come first, then the ones Spotlight knows were opened elsewhere.
              first: (s) => !!recentFiles?.app.has(s.id),
              footer: recentsSearching ? (
                <div className="list-more" role="status">
                  <div className="spinner" />
                  Looking for files opened in other apps…
                </div>
              ) : undefined,
              when: 'Last opened',
              empty: local ? 'No file this app can show was opened lately.' : 'The files you open show here.',
              notice: (
                <>
                  {openingRecent && (
                    <div className="import-banner" role="status">
                      Opening “{openingRecent}” and its folder…
                    </div>
                  )}
                  {!!recentFiles?.blocked.length && (
                    <div className="import-banner" role="status">
                      <div>
                        <strong>Files in {recentFiles.blocked.join(', ').replace(/, ([^,]*)$/, ' and $1')} are not listed.</strong> macOS has not let this app read {recentFiles.blocked.length === 1 ? 'that folder' : 'those folders'}. Allow it in System Settings › Privacy &amp; Security › Files and Folders, then open Recents again.
                      </div>
                    </div>
                  )}
                </>
              ),
            },
            {
              label: 'Favorites',
              active: favoritesShown,
              onSelect: (on) => showList(FAVORITES_PARAM, on),
              where: (s) => favorites?.where.get(s.id) ?? '',
              folderWhere: (p) => favorites?.where.get(`folder:${p}`) ?? '',
              when: 'Added',
              empty: 'Add a folder or file with its menu (⋮) › Add to Favorites.',
              notice: favoritesError ? <div className="form-error">{favoritesError}</div> : undefined,
              actions: (s) => [{ label: 'Remove from Favorites', onClick: () => setFavorite(local ? { path: s.id } : { kind: s.kind, id: s.id }, false) }],
              folderActions: (p) => [{ label: 'Remove from Favorites', onClick: () => setFavorite(local ? { path: p } : { folder: p }, false) }],
            }]
          : undefined
      }
      // A file of the desktop app's Recents is somewhere else: no thumbnail, folder or row menu until its folder is open.
      thumbnail={elsewhere ? undefined : (s) => <FileThumb item={s} />}
      // Documents, presentations, spreadsheets and web pages show in their own page, drawn small; a picture,
      // video or PDF is quicker as its thumbnail, which shows it just as well.
      preview={
        elsewhere
          ? undefined
          : (s) => (s.kind === 'file' && !isHtmlName(s.title) && !s.text ? <FileThumb item={s} /> : <FilePreviewFrame href={pathOf(s)} title={s.title} text={s.kind === 'doc' || s.kind === 'markdown' || s.kind === 'sheet' || !!s.text} />)
      }
      onGettingStarted={() => void openGuide()}
      search={search}
      onSearchChange={setSearch}
      onFind={otherShown ? undefined : async (q) => {
        // Coming back to results that were just shown does not search again; a change to the list does.
        if (lastFind?.text !== q) lastFind = { text: q, result: api.searchLibrary(q).then((r) => ({ folders: r.folders, items: [...r.docs, ...r.files.map(fileItem)], truncated: r.truncated })) };
        const mine = lastFind;
        return mine.result.catch((e: unknown) => {
          if (lastFind === mine) lastFind = null;
          throw e;
        });
      }}
      onCreateFolder={otherShown ? undefined : async (name) => {
        await api.createFolder(folder, name);
        await load();
      }}
      onDeleteFolder={async (path) => {
        await api.deleteFolder(path);
        await load();
      }}
      cloud={!local}
      onDownloadFolder={(path) => window.location.assign(`/api/folders/download?folder=${encodeURIComponent(path)}`)}
      onMove={otherShown ? undefined : async (s, to) => {
        await api.moveToFolder(s.kind, s.id, to);
        await load();
      }}
      // The desktop app: a file dragged out of the list is the file itself to other apps (Finder, a video editor).
      onDragOut={local && !otherShown ? (s) => void api.dragOutLocal(s.kind, s.id).catch((e: Error) => setError(e.message)) : undefined}
      folderActions={(path) => [
        ...(user ? [favoriteAction(`folder:${path}`, { folder: path })] : []),
        ...(local ? [{ label: `Open in ${fileBrowserName()}`, onClick: () => void api.revealLocal({ folder: path }).catch((e: Error) => setError(e.message)) }] : []),
      ]}
      headerActions={
        <>
          {/* Find a file (⌘P) in every folder, as in the editors; the search box beside it filters this list. */}
          <FileSearchButton />
          <div className="home-more" ref={moreRef}>
            <button className="btn home-more-btn" aria-label="More" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)}>
              ⋯
            </button>
            {moreOpen && (
              <div className="home-more-menu" role="menu">
                <a role="menuitem" href="/api/export.zip" onClick={() => setMoreOpen(false)} title="Download every document, presentation and spreadsheet as a zip (Markdown, PowerPoint, Excel and JSON)">
                  Export all
                </a>
                {/* The desktop app has no off-box copy to restore from and no app-change jobs. */}
                {!local && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMoreOpen(false);
                      openTrash();
                    }}
                    title="Files deleted in the last 30 days"
                  >
                    Trash
                  </button>
                )}
                <button
                  role="menuitem"
                  onClick={() => {
                    setMoreOpen(false);
                    void openGuide();
                  }}
                  title="A short guide to the app, as a presentation in your files"
                >
                  Getting started
                </button>
                <Link role="menuitem" to="/connectors" title="Connect data sources such as Brex">
                  Connectors
                </Link>
                {!local && (
                  <Link role="menuitem" to="/changes" title="Changes the assistant made to the app">
                    Changes
                  </Link>
                )}
                <Link role="menuitem" to="/settings" title="What the assistant runs on, and connecting your agent">
                  Settings
                </Link>
              </div>
            )}
          </div>
          <AgentButton />
          <Account />
        </>
      }
      items={recents ? (recentFiles?.items ?? null) : favoritesShown ? (favorites?.items ?? null) : items}
      error={recents ? recentsError : error}
      onCreate={async (kind, title) => {
        if (kind === 'sheet') navigate(`/s/${(await api.createSheet(title, folder)).sheet.id}`);
        else if (kind === 'deck') navigate(`/d/${(await api.createDeck(title, undefined, folder)).deck.id}`);
        else if (kind === 'markdown') navigate(`/md/${(await api.createMarkdown(title, '', folder)).doc.id}`);
        else navigate(`/doc/${(await api.createDoc(title, undefined, folder)).doc.id}`);
      }}
      // Any file can be added: the kinds the app knows open in it, the rest are kept to download, move or delete.
      importAccept=""
      importLabel="Import file"
      tiles={
        local || user ? (
          <>
            <div>
              {/* Settings has the MCP address (the desktop app's own, or the hosted one) and the agents connected. */}
              <button className="new-sheet-tile help-tile agent-tile" onClick={() => navigate('/settings#agents')}>
                <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0zM12 16v5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="help-tile-title">Connect your agent</span>
                <span className="help-tile-sub">
                  Claude Code &amp; more <span aria-hidden="true">→</span>
                </span>
              </button>
            </div>
            <div>
              <ScratchPadTile local={!!local} folder={folder} onError={setError} />
            </div>
          </>
        ) : undefined
      }
      importing={importing}
      onImport={(file) => void importFile(file)}
      onOpen={(s) => (recents ? void openRecent(s) : favoritesShown ? void openFavorite(s) : navigate(pathOf(s)))}
      onOpenInNewTab={elsewhere ? undefined : (s) => void window.open(pathOf(s), '_blank')}
      titleLink={elsewhere ? undefined : (s, children) => (
        <Link to={pathOf(s)} className="sheet-title" onClick={(e) => e.stopPropagation()}>
          {children}
        </Link>
      )}
      rowActions={(s) => [
        ...(user ? [favoriteAction(`${s.kind}:${s.id}`, { kind: s.kind, id: s.id })] : []),
        {
          label: s.kind === 'deck' ? 'Download as PowerPoint' : s.kind === 'doc' || s.kind === 'markdown' ? 'Download as Markdown' : s.kind === 'file' ? 'Download' : s.format === 'csv' ? 'Download as CSV' : 'Download as Excel',
          onClick: () => window.location.assign(s.kind === 'file' ? `/api/files/${s.id}/download` : `/api/files/${s.id}/export`),
        },
        ...(s.kind === 'sheet' && s.format !== 'csv' ? [{ label: 'Download as CSV', onClick: () => window.location.assign(`/api/files/${s.id}/export?format=csv`) }] : []),
        ...(s.kind === 'doc' || s.kind === 'deck' || s.kind === 'markdown' || (s.kind === 'file' && /\.html?$/i.test(s.title))
          ? [{ label: 'Download as PDF', onClick: () => void downloadPdf(s.id).catch((e: Error) => setError(e.message)) }]
          : []),
        ...(s.kind === 'sheet' ? [{ label: 'Create branch', onClick: () => setBranching(s) }] : []),
        ...(s.kind === 'file' && /\.pdf$/i.test(s.title)
          ? [{ label: 'Convert to Markdown', onClick: () => api.pdfToMarkdown(s.id).then(({ doc, warnings }) => navigate(`/md/${doc.id}`, { state: { importWarnings: warnings } }), (e: Error) => setError(e.message)) }]
          : []),
        { label: 'Move to…', onClick: () => setMoving(s) },
        ...(local ? [{ label: `Open in ${fileBrowserName()}`, onClick: () => void api.revealLocal({ kind: s.kind, id: s.id }).catch((e: Error) => setError(e.message)) }] : []),
        // Copies between the folder and the web (desktop app): from a folder here, from the web to a folder.
        ...(local
          ? [{ label: 'Upload to Web…', onClick: () => setUploading(s) }]
          : [{ label: inDesktopApp() ? 'Download to Folder…' : 'Download to MCP Docs', onClick: () => void (window.location.href = downloadLink(s)) }]),
      ]}
      onRename={async (s, title) => {
        await (s.kind === 'file' ? api.renameFile(s.id, title) : s.kind === 'deck' ? api.renameDeck(s.id, title) : s.kind === 'doc' ? api.renameDoc(s.id, title) : s.kind === 'markdown' ? api.renameMarkdown(s.id, title) : api.renameSheet(s.id, title));
        await load();
      }}
      onDelete={async (s) => {
        await (s.kind === 'deck' ? api.deleteDeck(s.id) : s.kind === 'doc' ? api.deleteDoc(s.id) : s.kind === 'markdown' ? api.deleteMarkdown(s.id) : s.kind === 'file' ? api.deleteFile(s.id) : api.deleteSheet(s.id));
        await load();
      }}
    >
      {trash && (
        <Modal title="Trash" onClose={() => setTrash(null)}>
          {trash === 'loading' ? (
            <p>Loading…</p>
          ) : !trash.available ? (
            <p>Deleted files cannot be restored on this server: no backup store is configured.</p>
          ) : trash.files.length === 0 ? (
            <p>Nothing has been deleted in the last 30 days.</p>
          ) : (
            <table className="sheet-list trash-list">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Deleted</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {trash.files.map((f) => (
                  <tr key={f.id}>
                    <td>
                      {kindIcon(f)} {f.title}
                    </td>
                    <td>{formatWhen(f.deletedAt)}</td>
                    <td>
                      <button className="btn" disabled={restoring === f.id} onClick={() => void restoreFile(f)}>
                        {restoring === f.id ? 'Restoring…' : 'Restore'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Modal>
      )}
      {moving && (
        <MoveModal
          title={moving.title}
          from={moving.folder ?? ''}
          rootName={local ? dirName(local.dir) : 'Your files'}
          onMove={async (to) => {
            await api.moveToFolder(moving.kind, moving.id, to);
            await load();
          }}
          onClose={() => setMoving(null)}
        />
      )}
      {uploading && <UploadToWebDialog file={uploading} onClose={() => setUploading(null)} />}
      {webDownload && local && (
        <DownloadFromWebDialog
          file={webDownload}
          rootName={dirName(local.dir)}
          startIn={folder}
          onDone={(made) => navigate(pathOfFile(made.kind, made.id))}
          onClose={closeWebDownload}
        />
      )}
      {branching && (
        <PromptModal
          title="Create branch"
          label="Branch name"
          initial={`${branching.title} (branch)`}
          confirmText="Create branch"
          onConfirm={async (title) => {
            const { sheet } = await api.branchSheet(branching.id, title);
            navigate(`/s/${sheet.id}`);
          }}
          onClose={() => setBranching(null)}
        />
      )}
    </FileLibrary>
  );
}
