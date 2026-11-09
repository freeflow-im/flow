// What mounts the editors (docs/specs/docs-core.md §3.2): the desktop app (a window of MCP Docs over a folder, with the
// machine's file browser to name and this window's id for the local MCP server), the suite (the suite bar above every
// page, organizations), or neither (the hosted app on its own). Components ask `useHost()` instead of reading globals.
import { createContext, useContext, type ReactNode } from 'react';

/** The desktop app's window. */
export interface DesktopHost {
  /** The system's file browser, as "Open in …" names it: Finder, File Explorer, Files. */
  fileBrowser: string;
  /** This window, to the local MCP server: an agent's tool on the file it shows runs here (server/windowTools.ts). */
  windowId: string;
}

export interface Host {
  /** The desktop app, or null in a browser. */
  desktop: DesktopHost | null;
  /** In the FreeFlow suite (the suite bar, organizations, the suite's sign-in). */
  suite: boolean;
}

const HostContext = createContext<Host>({ desktop: null, suite: false });

export function HostProvider({ host, children }: { host: Host; children: ReactNode }) {
  return <HostContext.Provider value={host}>{children}</HostContext.Provider>;
}

export const useHost = (): Host => useContext(HostContext);
