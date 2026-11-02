import { Link } from 'react-router-dom';
import { folderTrail } from '../../../shared/folders.ts';
import { useAuth } from '../auth.tsx';
import { fromList, listingHref, returnTo } from '../listing.ts';

export { lastListingHref } from '../listing.ts';

/**
 * Breadcrumbs for an open file: the top of the library and each folder down to the one the file is in,
 * each a link back to the file list there. The file's own name follows them in the page header.
 */
export function FolderCrumbs({ folder, onLeave, file }: { folder?: string; onLeave?: () => void; /** The FreeFlow suite: the file's root (SheetMeta's workspaceId and shared), which the first crumb names. */ file?: { workspaceId?: string; shared?: true } }) {
  const { local, suite } = useAuth();
  // A scratch pad leads back to the folder it was opened from: these lists move the window there (HomePage).
  const back = local ? returnTo() : null;
  if (back) folder = back.folder;
  const dir = back?.dir ?? local?.dir;
  const root = dir ? (dir.split(/[\\/]/).filter(Boolean).pop() ?? dir) : suite ? (file?.shared ? 'Organization files' : 'My files') : 'Your files';
  const org = suite && file?.shared ? file.workspaceId : undefined;
  const list = fromList();
  return (
    <nav className="folder-crumbs" aria-label="Folder">
      {/* A file opened from Recents or Favorites leads back there first. */}
      {list && (
        <span>
          <Link to={list.href} onClick={onLeave} title={`Back to ${list.label}`}>
            {list.label}
          </Link>
          <span className="crumb-sep">/</span>
        </span>
      )}
      {[{ name: root, path: '' }, ...folderTrail(folder ?? '')].map((f) => (
        <span key={f.path}>
          <Link to={listingHref(f.path, org)} onClick={onLeave} title={`Back to ${f.name}`}>
            {f.name}
          </Link>
          <span className="crumb-sep">/</span>
        </span>
      ))}
    </nav>
  );
}
