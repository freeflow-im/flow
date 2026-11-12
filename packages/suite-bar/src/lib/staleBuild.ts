// A page from before a deploy (docs/specs/home.md §2: Home keeps apps loaded for hours). Each deploy names the build's
// files anew, so a part the page loads only when needed (the composer, an editor) is gone once a new version is out, and
// the import fails (the Worker answers 404). Vite reports that as `vite:preloadError`; the page then loads again, once,
// so it is the new version. Not again within a minute: a part missing from the new version too shows its error.

const KEY = 'flow.staleBuildReload';
const QUIET_MS = 60_000;

/** Call once, at the app's start. Returns the uninstall (tests). */
export function reloadOnStaleBuild(reload: () => void = () => window.location.reload()): () => void {
  const onError = (e: Event) => {
    let last = 0;
    try {
      last = Number(sessionStorage.getItem(KEY) ?? 0);
    } catch {
      // No storage: still reload once for this page.
    }
    if (Date.now() - last < QUIET_MS) return;
    try {
      sessionStorage.setItem(KEY, String(Date.now()));
    } catch {
      // As above.
    }
    e.preventDefault();
    reload();
  };
  window.addEventListener('vite:preloadError', onError);
  return () => window.removeEventListener('vite:preloadError', onError);
}
