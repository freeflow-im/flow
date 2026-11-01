// The desktop app: /open?file=<path in the open folder> finds the library's file there and shows it. The
// app starts a window here when a file of Recents made it open another folder (desktop/main.js).
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, type RecentFile } from '../api.ts';
import { FAVORITES_PARAM, listHref, RECENTS_PARAM, rememberList, rememberListing, rememberReturn, type OtherListName } from '../listing.ts';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const pathOf = (kind: RecentFile['kind'], id: string) => (kind === 'deck' ? `/d/${id}` : kind === 'doc' ? `/doc/${id}` : kind === 'markdown' ? `/md/${id}` : kind === 'file' ? `/f/${id}` : `/s/${id}`);
/** The address that shows the file at a path inside the open folder, as one opened from Recents (or Favorites). */
export const openFromRecents = (file: string, from: OtherListName = RECENTS_PARAM) => `/open?file=${encodeURIComponent(file)}&from=${from}`;

/**
 * /open?file=<path in the open folder>: finds the library's file there and shows it. `from=recents` (`favorites`) makes
 * Recents (Favorites) the list its breadcrumbs lead back to; `backDir` and `backFolder`, the folder the window showed before (rememberReturn).
 */
export function OpenLocalFile() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const file = params.get('file') ?? '';
  const from = ([RECENTS_PARAM, FAVORITES_PARAM] as const).find((l) => l === params.get('from'));
  const backDir = params.get('backDir');
  const backFolder = params.get('backFolder') ?? '';

  useEffect(() => {
    if (from) rememberList(from);
    rememberReturn(backDir ? { dir: backDir, folder: backFolder } : null);
    // The way back to the list (the logo) is the folder it came from.
    if (backDir) rememberListing(backFolder ? `?folder=${encodeURIComponent(backFolder)}` : '');
    api
      .resolveLocal(file)
      .then((r) => navigate(pathOf(r.kind, r.id), { replace: true }))
      .catch((e: unknown) => setError(message(e)));
  }, [file, from, backDir, backFolder, navigate]);

  return error ? (
    <div className="page-error">
      <div>“{file}” could not be opened: {error}</div>
      <Link className="btn" to={from ? listHref(from) : '/'}>
        Back
      </Link>
    </div>
  ) : (
    <div className="page-loading">Opening…</div>
  );
}
