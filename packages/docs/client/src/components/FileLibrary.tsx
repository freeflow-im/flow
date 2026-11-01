// The file library: the header with search, the "Start something new" tiles, and the files table with a
// per-row menu, plus the create, rename and delete prompts and the import progress. It is the home page
// of the app (client/src/pages/HomePage.tsx) and the library inside ChatGPT (plugin/web/Library.tsx);
// each passes its own data source, actions and header controls, so both look and behave the same.
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { isHtmlName, opensInApp, type SheetMeta } from '../../../shared/types.ts';
import { DeckIcon, DocIcon, FileIcon, Logo, MarkdownIcon } from './Logo.tsx';
import { pastedFile } from '../pastedFile.ts';
import { ConfirmModal, PromptModal } from './Modal.tsx';

/** Whether a row opens in the app: every document does, a stored file only if the app can show it (shared/types.ts). Any other is listed, with its menu, but not opened. */
export const opens = (item: Pick<LibraryItem, 'kind' | 'title' | 'text'>): boolean => item.kind !== 'file' || opensInApp(item.title) || !!item.text;

/** What a row can be: a spreadsheet, presentation, document or Markdown document, or a stored file such as a PDF. */
export type LibraryKind = SheetMeta['kind'] | 'file';

export interface LibraryItem {
  id: string;
  kind: LibraryKind;
  /** A spreadsheet stored as a CSV file. */
  format?: SheetMeta['format'];
  title: string;
  /** The folder the file is in; absent at the top. */
  folder?: string;
  /** A stored file that is plain text, which opens in the text editor. */
  text?: boolean;
  updatedAt: string;
  createdAt: string;
  branch?: SheetMeta['branch'];
}

/** A list beside the folder's (FileLibrary's `otherLists`). */
export interface OtherList {
  label: string;
  active: boolean;
  onSelect(active: boolean): void;
  /** Where a file of it is, for the column that replaces "Created". */
  where(item: LibraryItem): string;
  /** Where a folder of it is. */
  folderWhere?(path: string): string;
  /** The heading of its date column ("Last opened"). */
  when: string;
  /** What to say when it has nothing. */
  empty: string;
  /** Shown over the list (what could not be listed, what is being opened). */
  notice?: ReactNode;
  /** The files listed ahead of the rest whatever the sort (Recents: the ones opened in the app). */
  first?(item: LibraryItem): boolean;
  /** Shown below its files (more of them being looked for). While it is there, no files is not "empty". */
  footer?: ReactNode;
  /** A file's menu in it, after Open (Favorites: Remove from Favorites); without, a file has none. */
  actions?(item: LibraryItem): LibraryAction[];
  /** A folder's menu in it, after Open. */
  folderActions?(path: string): LibraryAction[];
}

export interface LibraryAction {
  label: string;
  onClick(): void | Promise<void>;
  danger?: boolean;
}

export const KIND_NAMES: Record<LibraryKind, string> = { sheet: 'spreadsheet', deck: 'presentation', doc: 'document', markdown: 'Markdown document', file: 'file' };

/** The Type column: a short label per kind (stored files show their file type). */
export function kindLabel(item: Pick<LibraryItem, 'kind' | 'title' | 'format'>): string {
  if (item.format === 'csv') return 'CSV';
  if (item.format === 'xlsx') return 'Excel';
  if (item.format === 'pptx') return 'PowerPoint';
  if (item.format === 'docx') return 'Word';
  if (item.kind === 'file') {
    const ext = /\.([a-z0-9]+)$/i.exec(item.title)?.[1];
    return ext ? ext.toUpperCase() : 'File';
  }
  return { sheet: 'Spreadsheet', deck: 'Presentation', doc: 'Document', markdown: 'Markdown' }[item.kind];
}

/** The groups of the file type filter, in the order the menu lists them. */
export const TYPE_GROUPS = [
  ['sheet', 'Spreadsheets'],
  ['deck', 'Presentations'],
  ['doc', 'Documents'],
  ['pdf', 'PDFs'],
  ['image', 'Images'],
  ['video', 'Videos'],
  ['other', 'Other files'],
] as const;
export type TypeGroup = (typeof TYPE_GROUPS)[number][0];

/** The filter group an item is in: its kind, or for a stored file what its name says it is. */
export function typeGroup(item: Pick<LibraryItem, 'kind' | 'title'>): TypeGroup {
  if (item.kind === 'sheet' || item.kind === 'deck') return item.kind;
  if (item.kind === 'doc' || item.kind === 'markdown') return 'doc';
  const ext = /\.([a-z0-9]+)$/i.exec(item.title)?.[1]?.toLowerCase() ?? '';
  if (ext === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  if (['mp4', 'm4v', 'mov', 'webm', 'ogv'].includes(ext)) return 'video';
  return 'other';
}

export type SortKey = 'title' | 'kind' | 'updatedAt' | 'createdAt';
export interface SortOrder {
  key: SortKey;
  dir: 'asc' | 'desc';
}
const DEFAULT_SORT: SortOrder = { key: 'updatedAt', dir: 'desc' };
const SORT_STORAGE_KEY = 'ui.fileSort';
const VIEW_STORAGE_KEY = 'ui.fileView';
const FOLDERS_OPEN_KEY = 'ui.foldersOpen';
type View = 'list' | 'grid';

function loadFoldersOpen(): boolean {
  try {
    return localStorage.getItem(FOLDERS_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function loadView(): View {
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY) === 'grid' ? 'grid' : 'list';
  } catch {
    return 'list';
  }
}

function loadSort(): SortOrder {
  try {
    const raw = JSON.parse(localStorage.getItem(SORT_STORAGE_KEY) ?? 'null') as Partial<SortOrder> | null;
    if (raw && ['title', 'kind', 'updatedAt', 'createdAt'].includes(raw.key as string) && (raw.dir === 'asc' || raw.dir === 'desc')) return raw as SortOrder;
  } catch {
    // Fall through to the default.
  }
  return DEFAULT_SORT;
}

function saveSort(sort: SortOrder): void {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(sort));
  } catch {
    // Not remembered, that's all.
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Order items by the sort key; ties (same type, same minute) fall back to the title, then to most recent. */
export function compareItems(a: LibraryItem, b: LibraryItem, sort: SortOrder): number {
  const dir = sort.dir === 'asc' ? 1 : -1;
  let c = 0;
  if (sort.key === 'title') c = collator.compare(a.title, b.title);
  else if (sort.key === 'kind') c = collator.compare(kindLabel(a), kindLabel(b));
  else c = a[sort.key] < b[sort.key] ? -1 : a[sort.key] > b[sort.key] ? 1 : 0;
  if (c) return c * dir;
  if (sort.key !== 'title') {
    const t = collator.compare(a.title, b.title);
    if (t) return t;
  }
  return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
}

/** A short icon label for a MIME type (also used by file chips in the chat). */
export function fileIcon(type: string): string {
  if (type === 'application/pdf') return 'PDF';
  if (type.startsWith('image/')) return 'IMG';
  if (type.startsWith('video/')) return 'VID';
  return 'FILE';
}

/** The icon for a row. */
export function kindIcon(item: Pick<LibraryItem, 'kind' | 'title'>, size = 18): ReactNode {
  if (item.kind === 'deck') return <DeckIcon size={size} />;
  if (item.kind === 'doc') return <DocIcon size={size} />;
  if (item.kind === 'markdown') return <MarkdownIcon size={size} />;
  if (item.kind === 'file') return <FileIcon kind={isHtmlName(item.title) ? 'page' : (typeGroup(item) as 'pdf' | 'image' | 'video' | 'other')} size={size} />;
  return <Logo size={size} />;
}

export function formatWhen(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

export interface FileLibraryProps {
  /** Shown top left, e.g. the logo and the app name. */
  brand: ReactNode;
  /** Controls at the right of the header (menus, buttons). */
  headerActions?: ReactNode;
  /** The name of the top of the library, in the heading over the files table. Defaults to "Your files". */
  listTitle?: ReactNode;
  /** Shown left of the top of the library's name (the desktop app's folder menu). */
  listIcon?: ReactNode;
  /** A breadcrumb's tooltip, by the folder's path ('' for the top): the desktop app's full path on disk. */
  crumbTitle?(path: string): string;
  /** Show only the last this many breadcrumbs (the desktop app shows the folder and the one above it). */
  crumbsShown?: number;
  /**
   * Folders. With `folder` set (even to '', the top) the heading becomes breadcrumbs, the folders inside
   * the current one are listed above its files, and "New folder" is offered.
   */
  folder?: { name: string; path: string }[];
  folders?: { name: string; path: string }[];
  onOpenFolder?(path: string): void;
  /**
   * The ".." row over the folders: up one level. `folder` is the library's folder it opens, which files can be
   * dropped on (none at the top of the desktop app's folder, where it opens the folder's parent).
   */
  up?: { folder?: string; onOpen(): void };
  onCreateFolder?(name: string): Promise<void>;
  onDeleteFolder?(path: string): Promise<void>;
  /**
   * Lists beside the folder's, each chosen with a tab next to the folder's name (Recents, Favorites). While one
   * is shown, `items` (and `folders`) are its own: each is listed with where it is and when, and can only be
   * opened, or what its `actions` offer.
   */
  otherLists?: OtherList[];
  /** Download a folder and everything in it. Adds "Download" to a folder's menu. */
  onDownloadFolder?(path: string): void;
  /** The files are stored in the cloud (the web): each file's icon carries a faint cloud. */
  cloud?: boolean;
  /** More items for a folder's menu, after Download (the desktop app's Open in Finder). */
  folderActions?(path: string): LibraryAction[];
  /**
   * Drag a file out of the window as the file itself, to another app (the desktop app: the system runs the
   * drag, so Finder or a video editor gets the real file). The page's own drag of the row is cancelled for it;
   * dropped on a folder of the list, it still moves there.
   */
  onDragOut?(item: LibraryItem): void;
  /** Put a file in another folder. Lets a file be dragged onto a folder in the list or in the breadcrumbs. */
  onMove?(item: LibraryItem, folder: string): Promise<void>;
  /**
   * Look for the search text in every folder, not just the one being shown. Adds a "Find files" button
   * under the filtered list; its results replace the list until the search text changes.
   */
  onFind?(text: string): Promise<{ folders: { name: string; path: string }[]; items: LibraryItem[]; truncated: boolean }>;
  /**
   * The search, when the page keeps it (in its address, so it survives opening a file and coming back):
   * the text in the search box and whether "Find files" is on for it. Without it the library keeps its own.
   */
  search?: { text: string; find: boolean };
  onSearchChange?(text: string, find: boolean): void;
  /**
   * A larger picture of a file, shown by the pointer when it rests on the file's name in the list for a
   * moment; moving it away closes the picture.
   */
  preview?(item: LibraryItem): ReactNode;
  /** The picture of a file for the thumbnail view. Adds the list/thumbnails switch over the files. */
  thumbnail?(item: LibraryItem): ReactNode;
  /** The rows, or null while loading. */
  items: LibraryItem[] | null;
  error?: string | null;
  /** Kinds the "New" tile's menu offers. */
  createKinds?: Exclude<LibraryKind, 'file'>[];
  onCreate(kind: Exclude<LibraryKind, 'file'>, title: string): Promise<void>;
  /** Importing: the picker's accept list, the tile label, the hint under the tiles, and what to do with the file. */
  importAccept: string;
  importLabel: string;
  /** Said under the tiles. */
  importHint?: string;
  /** More tiles, after Import (the desktop app's Connect your agent). */
  tiles?: ReactNode;
  /** Name of the file being imported, shown as progress; null when idle. */
  importing: string | null;
  onImport(file: File): void;
  /** Show the built-in "Getting started" guide. Adds its tile at the start of the "Start something new" row, until the user hides it. */
  onGettingStarted?(): void;
  /** Open the file in place: the page stays inside the folder, with breadcrumbs back to it. */
  onOpen(item: LibraryItem): void;
  /** Open the file in a new tab (a new window tab in the desktop app). Adds an "Open" button to each row. */
  onOpenInNewTab?(item: LibraryItem): void;
  /** Wraps a row's title so the page can make it a real link (middle-click, right-click). Defaults to a span. */
  titleLink?(item: LibraryItem, children: ReactNode): ReactNode;
  /** Whether a row can be renamed; every row can unless this says otherwise. */
  canRename?(item: LibraryItem): boolean;
  onRename(item: LibraryItem, title: string): Promise<void>;
  onDelete(item: LibraryItem): Promise<void>;
  /** Extra entries in a row's menu, between Open and Rename. */
  rowActions?(item: LibraryItem, closeMenu: () => void): LibraryAction[];
  /** Extra modals and overlays rendered by the page. */
  children?: ReactNode;
}

const ALL_KINDS: Exclude<LibraryKind, 'file'>[] = ['sheet', 'deck', 'doc', 'markdown'];
/** The kinds as the "New" tile's menu lists them. */
const KIND_LABELS: Record<Exclude<LibraryKind, 'file'>, string> = { sheet: 'Spreadsheet', deck: 'Presentation', doc: 'Document', markdown: 'Markdown document' };
const KIND_ICONS: Record<Exclude<LibraryKind, 'file'>, ReactNode> = { sheet: <Logo size={18} />, deck: <DeckIcon size={18} />, doc: <DocIcon size={18} />, markdown: <MarkdownIcon size={18} /> };
/** `menuFor` while the "New" tile's menu is open (the other values are row ids). */
const NEW_MENU = 'tile:new';
const HELP_HIDDEN_KEY = 'ui.hideGettingStarted';

function loadHelpHidden(): boolean {
  try {
    return localStorage.getItem(HELP_HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/** How long the pointer rests on a file's name before its preview opens, and how far it may then wobble. */
const PEEK_DELAY_MS = 600;
const PEEK_SLACK = 8;
const PEEK_W = 396;
/** Room kept for the preview's height when placing it (a 4:3 page and the name under it). */
const PEEK_H = PEEK_W * 0.75 + 40;

/** A file's preview by the pointer, kept inside the window. It takes no clicks: the list stays usable under it. */
function FilePeek({ item, x, y, preview }: { item: LibraryItem; x: number; y: number; preview(item: LibraryItem): ReactNode }) {
  const left = Math.max(8, x + 18 + PEEK_W > window.innerWidth - 8 ? x - 18 - PEEK_W : x + 18);
  const top = Math.max(8, y + 18 + PEEK_H > window.innerHeight - 8 ? y - 18 - PEEK_H : y + 18);
  return (
    <div className="file-peek" style={{ left, top, width: PEEK_W }} aria-hidden="true">
      {preview(item)}
      <div className="file-peek-name">{item.title}</div>
    </div>
  );
}

export function FileLibrary(props: FileLibraryProps) {
  const { items, error, importing, onOpen } = props;
  const others = props.otherLists ?? [];
  // The list shown in place of the folder's, if one is.
  const other = others.find((l) => l.active);
  const otherShown = !!other;
  const otherFooter = otherShown ? other?.footer : undefined;
  const createKinds = props.createKinds ?? ALL_KINDS;
  // The box shows what was typed right away; a page that keeps the search hears of each change, and its
  // own changes (another address: Back, a folder opened) replace the text. What the page says back about a
  // change made here is not news, and must not undo the typing that followed it.
  const [filter, setOwnFilter] = useState(props.search?.text ?? '');
  const sent = useRef<string[]>([]);
  const setFilter = (text: string) => {
    setOwnFilter(text);
    if (!props.search) return;
    sent.current.push(text);
    props.onSearchChange?.(text, false);
  };
  const kept = props.search?.text;
  useEffect(() => {
    if (kept === undefined) return;
    const i = sent.current.indexOf(kept);
    if (i >= 0) sent.current.splice(0, i + 1);
    else {
      sent.current = [];
      setOwnFilter(kept);
    }
  }, [kept]);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [creating, setCreating] = useState<Exclude<LibraryKind, 'file'> | null>(null);
  const [helpHidden, setHelpHidden] = useState(loadHelpHidden);
  const hideHelp = () => {
    setHelpHidden(true);
    try {
      localStorage.setItem(HELP_HIDDEN_KEY, '1');
    } catch {
      // Hidden until the page is loaded again, that's all.
    }
  };
  const [renaming, setRenaming] = useState<LibraryItem | null>(null);
  const [deleting, setDeleting] = useState<LibraryItem | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [deletingFolder, setDeletingFolder] = useState<{ name: string; path: string } | null>(null);
  // The result of "Find files" for one search text, or that it is running.
  const [found, setFound] = useState<{ text: string; folders: { name: string; path: string }[]; items: LibraryItem[]; truncated: boolean } | { text: string; searching: true } | null>(null);
  const [findError, setFindError] = useState<string | null>(null);
  // The list changed (a rename, a move, another folder): what was found may no longer be true.
  useEffect(() => setFound(null), [items]);
  // A search the page kept as "Find files" runs again when the page comes back to it, and after the list changes.
  const wantFind = !!props.search?.find;
  useEffect(() => {
    if (wantFind && items !== null && q && !(found && found.text === q)) void find();
  });
  const [dragOver, setDragOver] = useState(false);
  // The preview by the pointer: opened when it has rested on a file's name for a moment, closed when it moves on.
  const [peek, setPeek] = useState<{ item: LibraryItem; x: number; y: number } | null>(null);
  const resting = useRef<number | undefined>(undefined);
  const stopPeek = () => {
    window.clearTimeout(resting.current);
    setPeek(null);
  };
  useEffect(() => {
    if (!peek) return;
    const close = () => setPeek(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('mousedown', close, true);
    window.addEventListener('keydown', close, true);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('mousedown', close, true);
      window.removeEventListener('keydown', close, true);
      window.removeEventListener('blur', close);
    };
  }, [peek]);
  useEffect(() => () => window.clearTimeout(resting.current), []);
  /** What makes a file's name open its preview when the pointer rests on it. */
  const peekOn = (s: LibraryItem) =>
    props.preview && opens(s)
      ? {
          onMouseMove: (e: React.MouseEvent) => {
            const { clientX: x, clientY: y } = e;
            // Open: a small wobble keeps it, a real move closes it (and resting again opens it again).
            if (peek && Math.hypot(x - peek.x, y - peek.y) <= PEEK_SLACK) return;
            if (peek) setPeek(null);
            window.clearTimeout(resting.current);
            resting.current = window.setTimeout(() => setPeek({ item: s, x, y }), PEEK_DELAY_MS);
          },
          onMouseLeave: stopPeek,
        }
      : {};
  useEffect(() => stopPeek(), [items]);
  // A file of the list being dragged, and the folder it is over that would take it.
  const dragged = useRef<LibraryItem | null>(null);
  const [dropFolder, setDropFolder] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  useEffect(() => setMoveError(null), [items]);
  // A file dragged out as the system's drag (onDragOut) ends with no dragend here: it is over once the button is
  // up again, which the first mouse move after it shows (or a drop in the page).
  useEffect(() => {
    if (!props.onDragOut) return;
    const up = (e: MouseEvent) => {
      if (e.buttons || !dragged.current) return;
      dragged.current = null;
      setDropFolder(null);
    };
    window.addEventListener('mousemove', up);
    return () => window.removeEventListener('mousemove', up);
  }, [props.onDragOut]);
  /** What makes a file's row or card something to drag. */
  const dragSource = (s: LibraryItem) =>
    props.onMove || props.onDragOut
      ? {
          draggable: true,
          onDragStart: (e: DragEvent<HTMLElement>) => {
            dragged.current = s;
            setMenuFor(null);
            if (props.onDragOut) {
              e.preventDefault();
              props.onDragOut(s);
              return;
            }
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', s.title);
          },
          onDragEnd: () => {
            dragged.current = null;
            setDropFolder(null);
          },
        }
      : {};
  /** What makes a folder's row, card or breadcrumb take a dragged file (one that is not in it already). */
  const dropTarget = (path: string) => {
    const takes = () => !!dragged.current && (dragged.current.folder ?? '') !== path;
    return props.onMove
      ? {
          onDragOver: (e: DragEvent<HTMLElement>) => {
            if (!takes()) return;
            e.preventDefault();
            // The system's drag of a file dragged out (onDragOut) offers copying it, not moving.
            e.dataTransfer.dropEffect = props.onDragOut ? 'copy' : 'move';
            if (dropFolder !== path) setDropFolder(path);
          },
          onDragLeave: (e: DragEvent<HTMLElement>) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropFolder((f) => (f === path ? null : f));
          },
          onDrop: (e: DragEvent<HTMLElement>) => {
            const item = dragged.current;
            if (!item || !takes()) return;
            e.preventDefault();
            e.stopPropagation();
            dragged.current = null;
            setDropFolder(null);
            setMoveError(null);
            props.onMove!(item, path).catch((err: unknown) => setMoveError(err instanceof Error ? err.message : 'Could not move the file.'));
          },
        }
      : {};
  };
  /** A file's icon in the list, with a faint cloud over it when the files are in the cloud. */
  const fileIcon = (s: LibraryItem, size?: number) =>
    props.cloud ? (
      <span className="cloud-icon" title="Stored in the cloud">
        {kindIcon(s, size)}
        <svg className="cloud-badge" viewBox="0 0 24 16" aria-hidden="true">
          <path d="M6.5 15h11a4.5 4.5 0 0 0 .7-8.95A6.5 6.5 0 0 0 5.6 5.2 5 5 0 0 0 6.5 15z" />
        </svg>
      </span>
    ) : (
      kindIcon(s, size)
    );
  const dropClass = (path: string) => (dropFolder === path ? ' drop-target' : '');
  const [sort, setSortState] = useState<SortOrder>(loadSort);
  /** Show only one type of file (the menu next to the view buttons); folders are not listed while it is on. */
  const [typeFilter, setTypeFilter] = useState<TypeGroup | 'all'>('all');
  const [viewChoice, setViewChoice] = useState<View>(loadView);
  const [foldersOpen, setFoldersOpenState] = useState(loadFoldersOpen);
  const setFoldersOpen = (open: boolean) => {
    setFoldersOpenState(open);
    try {
      localStorage.setItem(FOLDERS_OPEN_KEY, open ? '1' : '0');
    } catch {
      // Not remembered, that's all.
    }
  };
  const view: View = props.thumbnail ? viewChoice : 'list';
  const setView = (v: View) => {
    setViewChoice(v);
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, v);
    } catch {
      // Not remembered, that's all.
    }
  };
  const setSort = (key: SortKey) => {
    // A new column sorts the natural way (names A–Z, dates newest first); the same column again flips it.
    const next: SortOrder = sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'title' || key === 'kind' ? 'asc' : 'desc' };
    setSortState(next);
    saveSort(next);
  };

  const setSortTo = (value: string) => {
    const [key, dir] = value.split(':') as [SortKey, 'asc' | 'desc'];
    setSortState({ key, dir });
    saveSort({ key, dir });
  };

  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menuFor]);

  // Typing anywhere on the page filters the list: the first key moves to the search box, which takes it
  // and the ones after. Not while a field or a dialog has the keyboard.
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (document.querySelector('.modal-backdrop')) return;
      // A key that types a character; a space is left to the button or link that has the focus.
      if (e.key.length !== 1 || e.key === ' ') return;
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Pasting on the page imports what was copied, as dropping a file does: a picture becomes a picture file and
  // text a Markdown document. Not while a field or a dialog has the keyboard: there a paste is typing.
  const onImportRef = useRef(props.onImport);
  onImportRef.current = props.onImport;
  const importingRef = useRef(importing);
  importingRef.current = importing;
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (e.defaultPrevented || importingRef.current) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (document.querySelector('.modal-backdrop')) return;
      const file = pastedFile(e.clipboardData);
      if (!file) return;
      e.preventDefault();
      onImportRef.current(file);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  const q = filter.trim().toLowerCase();
  const results = found && found.text === q && !('searching' in found) && (!props.search || props.search.find) ? found : null;
  const finding = (!!found && found.text === q && 'searching' in found) || (!!props.search?.find && !!q && !results);
  const find = async () => {
    if (!props.onFind || !q) return;
    setFound({ text: q, searching: true });
    setFindError(null);
    try {
      const r = await props.onFind(q);
      setFound((cur) => (cur && cur.text === q ? { text: q, ...r } : cur));
    } catch (e) {
      setFound((cur) => (cur && cur.text === q ? null : cur));
      setFindError(e instanceof Error ? e.message : String(e));
      props.onSearchChange?.(filter, false);
    }
  };
  const top = props.listTitle ?? 'Your files';
  // Show each branch right under its original (recursively), siblings in the chosen order; searching
  // flattens the list.
  const visible: { s: LibraryItem; depth: number }[] = [];
  if (results) for (const s of [...results.items].sort((a, b) => compareItems(a, b, sort))) visible.push({ s, depth: 0 });
  else if (items) {
    const first = otherShown ? other?.first : undefined;
    const sorted = [...items].sort((a, b) => (first ? Number(first(b)) - Number(first(a)) : 0) || compareItems(a, b, sort));
    if (q) for (const s of sorted) s.title.toLowerCase().includes(q) && visible.push({ s, depth: 0 });
    else {
      const ids = new Set(sorted.map((s) => s.id));
      const children = new Map<string, LibraryItem[]>();
      for (const s of sorted) {
        const p = s.branch && ids.has(s.branch.parentId) ? s.branch.parentId : null;
        if (p) children.set(p, [...(children.get(p) ?? []), s]);
      }
      const add = (s: LibraryItem, depth: number) => {
        visible.push({ s, depth });
        for (const c of children.get(s.id) ?? []) add(c, depth + 1);
      };
      for (const s of sorted) if (!(s.branch && ids.has(s.branch.parentId))) add(s, 0);
    }
  }

  // The type menu offers the types that are here (and the one chosen, so it can always be seen and cleared).
  const typesHere = new Set(visible.map((v) => typeGroup(v.s)));
  const typeOptions = TYPE_GROUPS.filter(([g]) => typesHere.has(g) || g === typeFilter);
  if (typeFilter !== 'all') {
    const kept = visible.filter((v) => typeGroup(v.s) === typeFilter);
    visible.length = 0;
    // A branch whose spreadsheet is listed stays under it; nothing else is indented under something hidden.
    visible.push(...kept);
  }

  // Folders come first, by name whatever the files are sorted by.
  const folders = typeFilter !== 'all' ? [] : (results ? results.folders : (props.folders ?? []).filter((f) => !q || f.name.toLowerCase().includes(q))).sort((a, b) => collator.compare(a.name, b.name));
  /** Where a search result is, shown after its name. */
  const whereTag = (folder: string) => <span className="found-in">in {folder || top}</span>;
  const trail = props.folder;
  const up = !results && !otherShown && !q && typeFilter === 'all' ? props.up : undefined;
  const upDrop = up?.folder !== undefined ? dropTarget(up.folder) : {};
  const upClass = up?.folder !== undefined ? dropClass(up.folder) : '';
  // A folder's folders are one row that opens to list them (closed unless the user left it open), so the files are
  // in reach without scrolling past them. A search, a list beside the folder's (Favorites), or a folder with no
  // files lists them as they are.
  const foldersFold = folders.length > 0 && !results && !otherShown && !q && visible.length > 0;
  const foldersShown = foldersFold && !foldersOpen ? [] : folders;
  const foldersLabel = `${folders.length} ${folders.length === 1 ? 'folder' : 'folders'}`;
  // Dragging a file over the closed row opens it, so a folder in it can take the drop.
  const foldersToggle = {
    onClick: () => setFoldersOpen(!foldersOpen),
    onDragEnter: () => !foldersOpen && setFoldersOpen(true),
    title: foldersOpen ? 'Hide the folders' : 'Show the folders',
    'aria-expanded': foldersOpen,
  };
  const openFolder = (path: string) => {
    // A page that keeps the search drops it by going to the folder's own address.
    if (!props.search) setFilter('');
    props.onOpenFolder?.(path);
  };

  // The buttons and menu of a folder and of a file, the same in the list and on a thumbnail card.
  const folderActions = (f: { name: string; path: string }) => (
    <>
      <button
        className="icon-btn"
        aria-label={`Actions for ${f.name}`}
        onClick={(e) => {
          e.stopPropagation();
          setMenuFor(menuFor === `folder:${f.path}` ? null : `folder:${f.path}`);
        }}
      >
        ⋮
      </button>
      {menuFor === `folder:${f.path}` && otherShown && (
        <div className="dropdown">
          <button onClick={() => openFolder(f.path)}>Open</button>
          {(other!.folderActions?.(f.path) ?? []).map((a) => (
            <button key={a.label} className={a.danger ? 'danger' : undefined} onClick={() => (setMenuFor(null), void a.onClick())}>
              {a.label}
            </button>
          ))}
        </div>
      )}
      {menuFor === `folder:${f.path}` && !otherShown && (
        <div className="dropdown">
          <button onClick={() => openFolder(f.path)}>Open</button>
          {props.onDownloadFolder && <button onClick={() => (setMenuFor(null), props.onDownloadFolder!(f.path))}>Download</button>}
          {(props.folderActions?.(f.path) ?? []).map((a) => (
            <button key={a.label} onClick={() => (setMenuFor(null), void a.onClick())}>
              {a.label}
            </button>
          ))}
          {props.onDeleteFolder && (
            <button className="danger" onClick={() => (setMenuFor(null), setDeletingFolder(f))}>
              Delete
            </button>
          )}
        </div>
      )}
    </>
  );
  const itemActions = (s: LibraryItem) =>
    otherShown ? (
      other!.actions && (
        <>
          <button
            className="icon-btn"
            aria-label={`Actions for ${s.title}`}
            onClick={(e) => {
              e.stopPropagation();
              setMenuFor(menuFor === s.id ? null : s.id);
            }}
          >
            ⋮
          </button>
          {menuFor === s.id && (
            <div className="dropdown">
              {opens(s) && <button onClick={() => onOpen(s)}>Open</button>}
              {other!.actions(s).map((a) => (
                <button key={a.label} className={a.danger ? 'danger' : undefined} onClick={() => (setMenuFor(null), void a.onClick())}>
                  {a.label}
                </button>
              ))}
            </div>
          )}
        </>
      )
    ) : (
    <>
      {props.onOpenInNewTab && opens(s) && (
        <button className="btn open-tab-btn" title="Open in a new tab" aria-label={`Open ${s.title} in a new tab`} onClick={() => props.onOpenInNewTab!(s)}>
          Open <span aria-hidden="true">↗</span>
        </button>
      )}
      <button
        className="icon-btn"
        aria-label={`Actions for ${s.title}`}
        onClick={(e) => {
          e.stopPropagation();
          setMenuFor(menuFor === s.id ? null : s.id);
        }}
      >
        ⋮
      </button>
      {menuFor === s.id && (
        <div className="dropdown">
          {opens(s) && <button onClick={() => onOpen(s)}>Open</button>}
          {(props.rowActions?.(s, () => setMenuFor(null)) ?? []).map((a) => (
            <button key={a.label} className={a.danger ? 'danger' : undefined} onClick={() => (setMenuFor(null), void a.onClick())}>
              {a.label}
            </button>
          ))}
          {canRename(s) && <button onClick={() => (setMenuFor(null), setRenaming(s))}>Rename</button>}
          <button className="danger" onClick={() => (setMenuFor(null), setDeleting(s))}>
            Delete
          </button>
        </div>
      )}
    </>
    );

  const titleLink = props.titleLink ?? ((_item: LibraryItem, children: ReactNode) => <span className="sheet-title">{children}</span>);
  const canRename = props.canRename ?? (() => true);

  return (
    <div
      className={`home${dragOver ? ' drag-over' : ''}`}
      onDragOver={(e) => {
        if (dragged.current && props.onDragOut) {
          // A file of the list dragged out (the system's drag) and back: not one to import, nor to open.
          e.preventDefault();
          e.dataTransfer.dropEffect = 'none';
          return;
        }
        if (dragged.current || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (dragged.current) {
          dragged.current = null;
          return;
        }
        const file = e.dataTransfer.files[0];
        if (file && !importing) props.onImport(file);
      }}
    >
      <header className="home-header">
        <div className="home-brand">{props.brand}</div>
        <input
          ref={searchRef}
          className="home-search"
          placeholder="Search spreadsheets, presentations and documents"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            // Escape clears the filter and gives the keyboard back to the page.
            if (e.key !== 'Escape') return;
            setFilter('');
            e.currentTarget.blur();
          }}
        />
        <div className="home-user">{props.headerActions}</div>
      </header>

      <section className="home-new">
        <div className="home-inner">
          <h2>Start something new</h2>
          <div className="tiles">
            {props.onGettingStarted && !helpHidden && (
              <div className="tile-box">
                <button className="new-sheet-tile help-tile" onClick={props.onGettingStarted}>
                  <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2v.1h5V16c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span className="help-tile-title">Getting started</span>
                  <span className="help-tile-sub">
                    Take the tour <span aria-hidden="true">→</span>
                  </span>
                </button>
                <button className="tile-dismiss" onClick={hideHelp} aria-label="Hide the Getting started tile" title="Hide">
                  ×
                </button>
              </div>
            )}
            <div>
              {/* The menu hangs from the tile itself, not from the label under it. */}
              <div className="tile-box">
                <button
                  className="new-sheet-tile"
                  aria-label="Create a new file"
                  aria-haspopup="menu"
                  aria-expanded={menuFor === NEW_MENU}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuFor(menuFor === NEW_MENU ? null : NEW_MENU);
                  }}
                >
                  <span className="plus">+</span>
                </button>
                {menuFor === NEW_MENU && (
                  <div className="dropdown tile-menu" role="menu">
                    {createKinds.map((kind) => (
                      <button key={kind} role="menuitem" onClick={() => (setMenuFor(null), setCreating(kind))}>
                        {KIND_ICONS[kind]}
                        {KIND_LABELS[kind]}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="tile-label">New ▾</div>
            </div>
            <div>
              <button
                className="new-sheet-tile import-tile"
                disabled={!!importing}
                onClick={async () => {
                  const file = await pickFile(props.importAccept);
                  if (file) props.onImport(file);
                }}
                aria-label={props.importLabel}
              >
                <svg width="34" height="34" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 3v12m0 0-4.5-4.5M12 15l4.5-4.5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <div className="tile-label">{props.importLabel}</div>
            </div>
            {props.tiles}
          </div>
          {props.importHint && <div className="tile-hint">{props.importHint}</div>}
        </div>
      </section>

      <section className="home-inner">
        <div className="list-heading">
          <div className={`list-tabs${others.length ? ' has-tabs' : ''}`}>
          {!results && props.listIcon}
          {results ? (
            <h2>
              Found “{filter.trim()}” in all folders
              <button className="crumb found-back" onClick={() => (props.search ? props.onSearchChange?.(filter, false) : setFound(null))}>
                Back to {trail?.length ? trail[trail.length - 1].name : top}
              </button>
            </h2>
          ) : trail ? (
            <h2 className={`breadcrumbs${others.length ? (otherShown ? ' list-tab' : ' list-tab active') : ''}`} aria-label="Folder">
              {[{ name: '', path: '' }, ...trail].map((f, i, all) => i < Math.max(0, all.length - (props.crumbsShown ?? all.length)) ? null : (
                <span key={f.path}>
                  {i > Math.max(0, all.length - (props.crumbsShown ?? all.length)) && <span className="crumb-sep">/</span>}
                  {i === all.length - 1 && !otherShown ? (
                    <span aria-current="page" title={props.crumbTitle?.(f.path)}>
                      {i === 0 ? (props.listTitle ?? 'Your files') : f.name}
                    </span>
                  ) : (
                    // While the other list is shown, the folder's own name leads back to its files.
                    <button className={`crumb${dropClass(f.path)}`} title={props.crumbTitle?.(f.path)} onClick={() => (i === all.length - 1 ? other!.onSelect(false) : openFolder(f.path))} {...dropTarget(f.path)}>
                      {i === 0 ? (props.listTitle ?? 'Your files') : f.name}
                    </button>
                  )}
                </span>
              ))}
            </h2>
          ) : (
            <h2>{props.listTitle ?? 'Your files'}</h2>
          )}
          {!results &&
            others.map((l) => (
              <h2 key={l.label} className={`list-tab${l.active ? ' active' : ''}`}>
                {l.active ? <span aria-current="page">{l.label}</span> : <button className="crumb" onClick={() => l.onSelect(true)}>{l.label}</button>}
              </h2>
            ))}
          </div>
          <div className="list-tools">
            {(typeOptions.length > 1 || typeFilter !== 'all') && (
              <select className="grid-sort" aria-label="File type" title="Show one type of file" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as TypeGroup | 'all')}>
                <option value="all">All types</option>
                {typeOptions.map(([g, label]) => (
                  <option key={g} value={g}>
                    {label}
                  </option>
                ))}
              </select>
            )}
            {props.thumbnail && (
              <div className="view-toggle" role="group" aria-label="View">
                <button className={view === 'list' ? 'active' : undefined} aria-pressed={view === 'list'} title="List" onClick={() => setView('list')}>
                  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M2 3.5h12M2 8h12M2 12.5h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </button>
                <button className={view === 'grid' ? 'active' : undefined} aria-pressed={view === 'grid'} title="Thumbnails" onClick={() => setView('grid')}>
                  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
            )}
            {view === 'grid' && (
              <select className="grid-sort" aria-label="Sort by" value={`${sort.key}:${sort.dir}`} onChange={(e) => setSortTo(e.target.value)}>
                <option value="title:asc">Name</option>
                <option value="updatedAt:desc">Last modified</option>
                <option value="createdAt:desc">Created</option>
                <option value="kind:asc">Type</option>
                {!['title:asc', 'updatedAt:desc', 'createdAt:desc', 'kind:asc'].includes(`${sort.key}:${sort.dir}`) && <option value={`${sort.key}:${sort.dir}`}>Custom</option>}
              </select>
            )}
            {props.onCreateFolder && !results && (
              <button className="btn" onClick={() => setCreatingFolder(true)}>
                New folder
              </button>
            )}
          </div>
        </div>
        {otherShown && other!.notice}
        {error && <div className="form-error">{error}</div>}
        {moveError && <div className="form-error">{moveError}</div>}
        {items === null ? (
          <div className="muted">Loading…</div>
        ) : visible.length === 0 && folders.length === 0 && (error || otherFooter) ? null : visible.length === 0 && folders.length === 0 && !up ? (
          <div className="empty-state">{otherShown && typeFilter === 'all' && !q ? other!.empty : typeFilter !== 'all' ? `No ${TYPE_GROUPS.find(([g]) => g === typeFilter)![1].toLowerCase().replace('pdfs', 'PDFs')} ${results ? 'found' : q ? 'match your search' : 'here'}.` : results ? 'Nothing found in any folder.' : q ? (props.onFind ? 'Nothing here matches your search.' : 'Nothing matches your search.') : trail?.length ? 'This folder is empty.' : 'No files yet. Create a spreadsheet, presentation or document to get started.'}</div>
        ) : view === 'grid' ? (
          <div className="file-grid">
            {up && (
              <div className={`file-card${upClass}`} onClick={up.onOpen} title="Up one folder" {...upDrop}>
                <div className="file-thumb folder">
                  <FolderIcon size={64} />
                </div>
                <div className="file-card-foot">
                  <div className="file-card-name">..</div>
                </div>
              </div>
            )}
            {foldersFold && (
              <button className="folders-toggle grid" {...foldersToggle}>
                <span className={`folders-chevron${foldersOpen ? ' open' : ''}`} aria-hidden="true">
                  <svg viewBox="0 0 12 12" width="12" height="12">
                    <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <FolderIcon /> {foldersLabel}
              </button>
            )}
            {foldersShown.map((f) => (
              <div key={`folder:${f.path}`} className={`file-card${dropClass(f.path)}`} onClick={() => openFolder(f.path)} {...dropTarget(f.path)}>
                <div className="file-thumb folder">
                  <FolderIcon size={64} />
                </div>
                <div className="file-card-foot">
                  <div className="file-card-name" title={f.name}>
                    {f.name}
                  </div>
                  <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                    {folderActions(f)}
                  </div>
                </div>
                <div className="file-card-meta">Folder{results && <> · {whereTag(f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '')}</>}</div>
              </div>
            ))}
            {visible.map(({ s }) => (
              <div key={s.id} className={`file-card${opens(s) ? '' : ' no-open'}`} onClick={() => opens(s) && onOpen(s)} title={opens(s) ? undefined : 'This kind of file does not open here. Its menu (⋮) has what you can do with it.'} {...dragSource(s)}>
                {props.thumbnail!(s)}
                <div className="file-card-foot">
                  <div className="file-card-name" title={s.title}>
                    {opens(s) ? titleLink(s, <>{fileIcon(s, 16)} {s.title}</>) : <span className="sheet-title">{fileIcon(s, 16)} {s.title}</span>}
                  </div>
                  <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                    {itemActions(s)}
                  </div>
                </div>
                <div className="file-card-meta">
                  {formatWhen(s.updatedAt)}
                  {results && <> · {whereTag(s.folder ?? '')}</>}
                  {s.branch && <> · branch</>}
                </div>
              </div>
            ))}
          </div>
        ) : (
          // The other list's columns are fixed, so rows added to it later do not move the ones there.
          <table className={`sheet-list${otherShown ? ' other-list' : ''}`}>
            <thead>
              <tr>
                {(
                  [
                    ['title', 'Name'],
                    ['kind', 'Type'],
                    ['updatedAt', otherShown ? other!.when : 'Last modified'],
                    ...(otherShown ? [] : [['createdAt', 'Created']]),
                  ] as [SortKey, string][]
                ).map(([key, label]) => (
                  <th key={key} className={key === 'kind' ? 'col-type' : undefined} aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                    <button className={`sort-btn${sort.key === key ? ' active' : ''}`} onClick={() => setSort(key)} title={`Sort by ${label.toLowerCase()}`}>
                      {label}
                      <span className="sort-arrow" aria-hidden="true">
                        {sort.key === key ? (sort.dir === 'asc' ? '↑' : '↓') : ''}
                      </span>
                    </button>
                  </th>
                ))}
                {otherShown && <th>Where</th>}
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {up && (
                <tr className={upClass.trim() || undefined} onClick={up.onOpen} title="Up one folder" {...upDrop}>
                  <td>
                    <span className="sheet-title">
                      <FolderIcon /> ..
                    </span>
                  </td>
                  <td className="col-type">Folder</td>
                  <td />
                  <td />
                  <td />
                </tr>
              )}
              {foldersFold && (
                <tr className="folders-toggle-row" onClick={foldersToggle.onClick} onDragEnter={foldersToggle.onDragEnter}>
                  <td colSpan={5}>
                    <button className="folders-toggle" {...foldersToggle} onClick={(e) => (e.stopPropagation(), foldersToggle.onClick())}>
                      <span className={`folders-chevron${foldersOpen ? ' open' : ''}`} aria-hidden="true">
                        <svg viewBox="0 0 12 12" width="12" height="12">
                          <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </span>
                      <FolderIcon /> {foldersLabel}
                    </button>
                  </td>
                </tr>
              )}
              {foldersShown.map((f) => (
                <tr key={`folder:${f.path}`} className={`${foldersFold ? 'in-fold' : ''}${dropClass(f.path)}`.trim() || undefined} onClick={() => openFolder(f.path)} {...dropTarget(f.path)}>
                  <td>
                    <span className="sheet-title">
                      <FolderIcon /> {f.name}
                      {results && whereTag(f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '')}
                    </span>
                  </td>
                  <td className="col-type">Folder</td>
                  <td />
                  <td className={otherShown ? 'list-where' : undefined}>{otherShown ? other!.folderWhere?.(f.path) : null}</td>
                  <td className="row-actions" onClick={(e) => e.stopPropagation()}>
                    {folderActions(f)}
                  </td>
                </tr>
              ))}
              {visible.map(({ s, depth }) => (
                <tr key={s.id} className={opens(s) ? undefined : 'no-open'} onClick={() => opens(s) && onOpen(s)} title={opens(s) ? undefined : 'This kind of file does not open here. Its menu (⋮) has what you can do with it.'} {...dragSource(s)}>
                  <td>
                    <span className="peek-target" {...peekOn(s)}>
                    {(opens(s) ? titleLink : (_s: LibraryItem, children: ReactNode) => <span className="sheet-title">{children}</span>)(
                      s,
                      <>
                        {depth > 0 && <span style={{ width: depth * 22 }} className="tree-indent" />}
                        {depth > 0 ? <span className="tree-elbow">└</span> : null}
                        {fileIcon(s)} {s.title}
                        {results && whereTag(s.folder ?? '')}
                        {s.branch && <span className={`branch-tag${s.branch.detached ? ' detached' : ''}`}>{s.branch.detached ? `branch of deleted “${s.branch.parentTitle}”` : depth ? 'branch' : `branch of ${s.branch.parentTitle}`}</span>}
                      </>,
                    )}
                    </span>
                  </td>
                  <td className="col-type">{kindLabel(s)}</td>
                  <td>{formatWhen(s.updatedAt)}</td>
                  <td className={otherShown ? 'list-where' : undefined}>{otherShown ? other!.where(s) : formatWhen(s.createdAt)}</td>
                  <td className="row-actions" onClick={(e) => e.stopPropagation()}>
                    {itemActions(s)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {otherFooter}
        {items !== null && q && props.onFind && !results && (
          <div className="find-files">
            <button className="btn" disabled={finding} onClick={() => (props.search ? props.onSearchChange?.(filter, true) : void find())}>
              {finding ? 'Searching…' : 'Find files'}
            </button>
            <span className="muted">{finding ? `Looking for “${filter.trim()}” in all folders` : `Look for “${filter.trim()}” in all folders`}</span>
          </div>
        )}
        {results?.truncated && <div className="find-files muted">There is more to search than could be covered. These are the first matches; a longer search text narrows it down.</div>}
        {findError && <div className="form-error">{findError}</div>}
      </section>

      {peek && props.preview && <FilePeek {...peek} preview={props.preview} />}
      {importing && (
        <div className="modal-backdrop">
          <div className="modal import-progress" role="status">
            <div className="spinner" />
            Importing “{importing}”…
          </div>
        </div>
      )}
      {dragOver && !importing && <div className="drop-hint">Drop a file to import it</div>}
      {creating && (
        <PromptModal
          title={`New ${KIND_NAMES[creating]}`}
          label="Name"
          initial={`Untitled ${KIND_NAMES[creating]}`}
          confirmText="Create"
          onConfirm={(title) => props.onCreate(creating, title)}
          onClose={() => setCreating(null)}
        />
      )}
      {renaming && (
        <PromptModal
          title={`Rename ${KIND_NAMES[renaming.kind]}`}
          label="Name"
          // A stored file keeps its extension, so only the name before it is offered for editing.
          initial={renaming.kind === 'file' ? renaming.title.replace(/\.[a-z0-9]+$/i, '') || renaming.title : renaming.title}
          confirmText="Rename"
          onConfirm={(title) => props.onRename(renaming, title)}
          onClose={() => setRenaming(null)}
        />
      )}
      {deleting && (
        <ConfirmModal
          title={`Delete ${KIND_NAMES[deleting.kind]}?`}
          message={<>“{deleting.title}” will be permanently deleted. This cannot be undone.</>}
          confirmText="Delete"
          danger
          onConfirm={() => props.onDelete(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
      {creatingFolder && props.onCreateFolder && (
        <PromptModal title="New folder" label="Name" initial="Untitled folder" confirmText="Create" onConfirm={(name) => props.onCreateFolder!(name)} onClose={() => setCreatingFolder(false)} />
      )}
      {deletingFolder && props.onDeleteFolder && (
        <ConfirmModal
          title="Delete folder?"
          message={<>“{deletingFolder.name}” will be deleted. Only an empty folder can be deleted.</>}
          confirmText="Delete"
          danger
          onConfirm={() => props.onDeleteFolder!(deletingFolder.path)}
          onClose={() => setDeletingFolder(null)}
        />
      )}
      {props.children}
    </div>
  );
}

export function FolderIcon({ size = 18 }: { size?: number }) {
  return (
    <svg className="folder-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.4a1.5 1.5 0 0 1 1.1.5l1.2 1.3h8.3A1.5 1.5 0 0 1 21 8.3v9.2a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" fill="currentColor" />
    </svg>
  );
}
