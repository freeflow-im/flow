// The desktop app's window and its MCP server (server/localMcp.ts): the window tells the server which file
// it shows, so an agent's tools act on it when no id is given, and goes to a file an agent opened
// (desktop/main.js sends a universal-show event with its address).
import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from './api.ts';

const KINDS = { doc: 'doc', d: 'deck', s: 'sheet', md: 'markdown', f: 'file' } as const;

/** This window, to the server: an agent's tool on the file it shows runs here (server/windowTools.ts). */
export const WINDOW_ID = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `w-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** The file at an address of the app (/doc/<id>, /d/<id>, ...), or null for any other page. */
export function fileAt(pathname: string): { kind: (typeof KINDS)[keyof typeof KINDS]; id: string } | null {
  const m = /^\/(doc|d|s|md|f)\/([^/]+)$/.exec(pathname);
  return m ? { kind: KINDS[m[1] as keyof typeof KINDS], id: decodeURIComponent(m[2]) } : null;
}

/** Each file a page shows goes to the top of the user's Recents (server/recents.ts). */
export function useRecentOpens(on: boolean): void {
  const { pathname } = useLocation();
  useEffect(() => {
    const file = on ? fileAt(pathname) : null;
    if (file) api.opened(file.kind, file.id).catch(() => {});
  }, [on, pathname]);
}

export function useDesktopBridge(on: boolean): void {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (on) api.localShowing(fileAt(pathname), WINDOW_ID).catch(() => {});
  }, [on, pathname]);
  // The page reports itself again when it is brought forward: of several windows, the one in front is shown.
  useEffect(() => {
    if (!on) return;
    const report = () => document.visibilityState === 'visible' && document.hasFocus() && api.localShowing(fileAt(location.pathname), WINDOW_ID).catch(() => {});
    window.addEventListener('focus', report);
    return () => window.removeEventListener('focus', report);
  }, [on]);
  useEffect(() => {
    if (!on) return;
    const show = (e: Event) => {
      const page = (e as CustomEvent<unknown>).detail;
      if (typeof page === 'string' && page.startsWith('/') && page !== location.pathname) navigate(page);
    };
    window.addEventListener('universal-show', show);
    return () => window.removeEventListener('universal-show', show);
  }, [on, navigate]);
}

/** The system's file browser, as the desktop app's "Open in …" items name it. */
export function fileBrowserName(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  return /Windows/.test(ua) ? 'File Explorer' : /Macintosh|Mac OS X/.test(ua) ? 'Finder' : 'Files';
}
