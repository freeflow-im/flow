// `flow://` links inside the desktop shell (docs/specs/desktop-electron.md).
//
// The OS hands the shell a `flow://` URL; the preload forwards it through
// `host.links.onDeepLink`. This module is the single dispatcher: a sign-in
// flow that is waiting for its own callback claims the link first, and only a
// link nobody is waiting for reaches the app as a `flow:deeplink` event.
// The rules mirror `AppState.handleDeepLink` on macOS — a PKCE callback
// belongs to its pending operation and is dropped otherwise; a bare sign-in
// code or an invite is the app's to act on.
import { getHost } from './host';

export type DeepLink =
  /** `flow://signin?code=…` — an app-link code minted by the web (the Google
   * handoff, "Open the desktop app"). */
  | { kind: 'signin-code'; code: string }
  /** `flow://signin?code&state&operationId` — the return leg of a PKCE
   * handoff started by this client. */
  | { kind: 'handoff-callback'; code: string; state: string; operationId: string }
  /** `flow://invite/<token>` */
  | { kind: 'invite'; token: string }
  | { kind: 'unknown'; url: string };

export function parseDeepLink(raw: string): DeepLink {
  let url: URL;
  try { url = new URL(raw); } catch { return { kind: 'unknown', url: raw }; }
  if (url.protocol !== 'flow:') return { kind: 'unknown', url: raw };
  // `flow://signin` parses with host "signin" and an empty path; `flow://invite/x`
  // with host "invite" and path "/x".
  const target = url.host.toLowerCase();
  const p = url.searchParams;
  if (target === 'signin' && (url.pathname === '' || url.pathname === '/')) {
    const code = p.get('code');
    if (!code) return { kind: 'unknown', url: raw };
    const state = p.get('state');
    const operationId = p.get('operationId');
    if (state && operationId) return { kind: 'handoff-callback', code, state, operationId };
    return { kind: 'signin-code', code };
  }
  if (target === 'invite') {
    const token = url.pathname.match(/^\/([A-Za-z0-9_-]+)\/?$/)?.[1];
    if (token) return { kind: 'invite', token };
  }
  return { kind: 'unknown', url: raw };
}

type Waiter = (link: DeepLink) => boolean;
const waiters = new Set<Waiter>();
let installed = false;

function dispatch(raw: string): void {
  const link = parseDeepLink(raw);
  for (const waiter of waiters) if (waiter(link)) return;
  // A PKCE callback with no pending operation is not ours to act on.
  if (link.kind === 'handoff-callback' || link.kind === 'unknown') return;
  window.dispatchEvent(new CustomEvent<DeepLink>('flow:deeplink', { detail: link }));
}

/** Start routing the host's deep links. Idempotent; a no-op in a browser,
 * whose host never reports one. */
export function installDeepLinks(): void {
  if (installed) return;
  installed = true;
  getHost().links.onDeepLink(dispatch);
}

/** Test seam: feed a link as if the OS delivered it. */
export function __dispatchDeepLink(raw: string): void {
  dispatch(raw);
}

function waitFor<T>(claim: (link: DeepLink) => T | null, signal: AbortSignal, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const waiter: Waiter = (link) => {
      const value = claim(link);
      if (value === null) return false;
      cleanup();
      resolve(value);
      return true;
    };
    const abort = () => { cleanup(); reject(new Error('Sign-in canceled.')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Sign-in timed out. Try again.')); }, timeoutMs);
    const cleanup = () => { waiters.delete(waiter); clearTimeout(timer); signal.removeEventListener('abort', abort); };
    if (signal.aborted) { abort(); return; }
    waiters.add(waiter);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** The return leg of the PKCE handoff this client started: the callback whose
 * `state` and `operationId` are ours. */
export function awaitHandoffCallback(operationId: string, state: string, signal: AbortSignal): Promise<{ code: string }> {
  return waitFor(
    (link) => link.kind === 'handoff-callback' && link.operationId === operationId && link.state === state ? { code: link.code } : null,
    signal, 10 * 60_000,
  );
}

/** The next bare sign-in code — what the web's native Google handoff sends
 * back. There is no binding token in that contract, so the flow that opened
 * the browser is the one that claims it. */
export function awaitSignInCode(signal: AbortSignal): Promise<{ code: string }> {
  return waitFor((link) => link.kind === 'signin-code' ? { code: link.code } : null, signal, 10 * 60_000);
}
