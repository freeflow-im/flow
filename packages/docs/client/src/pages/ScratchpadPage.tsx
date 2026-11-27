// The global scratchpad (/docs/scratchpad), in the suite bar's scratchpad popup in every app (@flow/suite-bar's
// Scratchpad.tsx): the whiteboard named "Global Scratchpad" at the top of the user's My files, made on first use
// (POST /api/whiteboards/scratchpad, which answers with the board's content too), shown editable with the toolbar and
// the board only.
//
// The suite bar loads this page ahead of a click (/docs/scratchpad?preload), hidden, so the popup opens on a board
// that is already there. Loaded that way it only finds the scratchpad: when there is none yet it is made once the
// popup is first opened (the bar posts SCRATCHPAD_OPENED to this frame), so nobody gets one without opening it.
//
// Like the side panel's page it has no suite bar, which is what sets the organization elsewhere: it takes the one the
// suite last selected, and opens that organization's scratchpad again when another page changes it.
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { SheetMeta } from '../../../shared/types.ts';
import type { Whiteboard } from '../../../shared/whiteboard.ts';
import { useSuiteOrganization } from './PanelPage.tsx';
import { WhiteboardPage } from './WhiteboardPage.tsx';

/** The message the suite bar posts to this frame when its popup opens (@flow/suite-bar's Scratchpad.tsx). */
export const SCRATCHPAD_OPENED = 'flow.scratchpad.opened';

const preloaded = () => new URLSearchParams(window.location.search).has('preload');

/**
 * Resolves when the suite bar around this frame opens its popup (at once when the page was not preloaded). It listens
 * from the start, so an open that comes while the scratchpad is still being looked for is not missed.
 */
let popupOpened: Promise<void> | null = null;
function opened(): Promise<void> {
  popupOpened ??= preloaded()
    ? new Promise((resolve) => {
        const on = (e: MessageEvent) => {
          if (e.origin !== window.location.origin || e.data !== SCRATCHPAD_OPENED) return;
          window.removeEventListener('message', on);
          resolve();
        };
        window.addEventListener('message', on);
      })
    : Promise.resolve();
  return popupOpened;
}

export function ScratchpadPage() {
  const org = useSuiteOrganization();
  const [state, setState] = useState<{ meta: SheetMeta; board: Whiteboard } | { error: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    setState(null);
    const show = ({ board, content }: { board: SheetMeta | null; content: Whiteboard | null }) => {
      if (!cancelled && board && content) setState({ meta: board, board: content });
      return !!board;
    };
    // Find it first (never made by a preload); make it only once the popup is open.
    void opened();
    api
      .openScratchpad(!preloaded())
      .then(async (found) => {
        if (show(found) || cancelled) return;
        await opened();
        if (!cancelled) show(await api.openScratchpad());
      })
      .catch((e: unknown) => !cancelled && setState({ error: e instanceof Error ? e.message : String(e) }));
    return () => {
      cancelled = true;
    };
  }, [org]);
  // The board takes its pointer presses (no default), so a click in the frame would leave the keyboard with the page
  // around it, and a note started there would not get its typing: the frame takes the focus itself.
  useEffect(() => {
    const take = () => {
      if (!document.hasFocus()) window.focus();
    };
    window.addEventListener('pointerdown', take, true);
    return () => window.removeEventListener('pointerdown', take, true);
  }, []);
  if (!state) return <div className="page-loading">Loading scratchpad…</div>;
  if ('error' in state) return <div className="page-error"><p>{state.error}</p></div>;
  return <WhiteboardPage key={state.meta.id} id={state.meta.id} initial={state} framed />;
}
