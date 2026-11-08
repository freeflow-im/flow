import { Link } from 'react-router-dom';
import { folderTrail } from '../../../shared/folders.ts';
import { useAuth } from '../auth.tsx';
import { fromList, last, listingHref, returnTo, sharedFileCrumbs } from '../listing.ts';

export { lastListingHref } from '../listing.ts';

/**
 * Breadcrumbs for an open file: the top of the library and each folder down to the one the file is in,
 * each a link back to the file list there. The file's own name follows them in the page header.
 */
export function FolderCrumbs({ folder, onLeave, file }: { folder?: string; onLeave?: () => void; /** The FreeFlow suite: the file's root (SheetMeta's workspaceId and shared), which the first crumb names. */ file?: { workspaceId?: string; shared?: true; role?: string } }) {
  const { local, suite } = useAuth();
  // A file another member shared with the user (it has a role, and is not the organization's): its crumbs start at
  // Shared with me and name none of the owner's folders above the one shared (listing.ts sharedFileCrumbs).
  if (suite && !local && file?.role && !file.shared) {
    return (
      <nav className="folder-crumbs" aria-label="Folder">
        {sharedFileCrumbs(folder ?? '', last()).map((c) => (
          <span key={c.href}>
            <Link to={c.href} onClick={onLeave} title={`Back to ${c.name}`}>
              {c.name}
            </Link>
            <span className="crumb-sep">/</span>
          </span>
        ))}
      </nav>
    );
  }
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
