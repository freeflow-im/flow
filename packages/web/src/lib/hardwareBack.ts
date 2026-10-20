// The hardware back button (docs/design/ANDROID.md phase 1), the one input a
// phone has that a browser tab and a desktop window do not. The shell asks
// the page first — `window.__flowBack()` over evaluateJavascript, installed
// by hostAndroid.ts — and only sends the app to the background when the page
// answers `false`. Views reach it through `host.back.onBack`; this module is
// the handler stack behind that, plus the pure rule for the main pane.
//
// Handlers run newest-first and the first to return `true` wins: a view that
// has something to close registers while it is open and unregisters when it
// is gone, so nothing has to know the whole stack.

export type BackHandler = () => boolean;

const backHandlers: BackHandler[] = [];

/** Register a handler; returns the matching unregister. Idempotent per handler. */
export function registerBackHandler(handler: BackHandler): () => void {
  if (!backHandlers.includes(handler)) backHandlers.push(handler);
  return () => {
    const i = backHandlers.indexOf(handler);
    if (i >= 0) backHandlers.splice(i, 1);
  };
}

/** Run the handlers newest-first. `true` = the page consumed the press. */
export function handleBack(): boolean {
  for (let i = backHandlers.length - 1; i >= 0; i--) {
    if (backHandlers[i]!()) return true;
  }
  return false;
}

/** What the shell calls (BackBridge.java). Installed once, by the Android host. */
export function installBackBridge(target: object = globalThis): void {
  (target as { __flowBack?: () => boolean }).__flowBack = handleBack;
}

/** Test seam. */
export function resetBackHandlersForTests(): void {
  backHandlers.length = 0;
}

// ---- what back should do in the main pane ----------------------------------
//
// Pure so it is testable without React: the order is the design doc's
// "thread → channel → drawer". A side panel (artifact, files) sits between
// the thread and the channel because it is the more recent thing the user
// opened.

export interface BackState {
  threadOpen: boolean;
  panelOpen: boolean;
  isMobile: boolean;
  drawerOpen: boolean;
}

export type BackAction = 'close-thread' | 'close-panel' | 'open-drawer' | 'leave';

export function backAction(s: BackState): BackAction {
  if (s.threadOpen) return 'close-thread';
  if (s.panelOpen) return 'close-panel';
  if (s.isMobile && !s.drawerOpen) return 'open-drawer';
  return 'leave';
}
