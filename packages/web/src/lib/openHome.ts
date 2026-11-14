// Where a workspace just chosen, made or joined opens: Home, the organization's front page (docs/specs/home.md). The choice
// is only stored, never selected in Chat on the way, which would mount Chat for the moment before Home loads.
import { APP_MANIFESTS, isInHome } from '@flow/suite-bar';
import { HOME_NOTICE_KEY } from '@flow/shared/addresses';
import type { ConnectionRuntime } from './connectionRuntime';
import { isDesktop } from './host';
import { ACTIVE_WS } from '../state';

/** Home's address, when the suite has it. */
const HOME_PATH = APP_MANIFESTS.find((m) => m.name === 'home')?.path ?? null;

/** Whether a workspace opens in Home from here: the suite has Home and this is not the desktop app (Chat only). */
export const opensInHome = (): boolean => !!HOME_PATH && !isDesktop();

/**
 * Keeps `workspaceId` as the one in use and opens Home on it, with `notice` for Home to show once. Inside Home's own
 * frame, the whole page goes. False, having done nothing, where there is no Home to go to: the caller selects it in Chat.
 */
export function openHome(runtime: ConnectionRuntime, workspaceId: string, notice?: string): boolean {
  if (!opensInHome()) return false;
  runtime.write(ACTIVE_WS, workspaceId);
  try {
    if (notice) sessionStorage.setItem(HOME_NOTICE_KEY, notice);
  } catch {
    // No session storage: Home opens without the line.
  }
  (isInHome() ? window.top : window)?.location.assign(`${HOME_PATH}/`);
  return true;
}
