// The global scratchpad (/docs/scratchpad), in the suite bar's scratchpad popup in every app (@flow/suite-bar's
// Scratchpad.tsx): the whiteboard named "Global Scratchpad" at the top of the user's My files, made on first use
// (POST /api/whiteboards/scratchpad), shown editable with the toolbar and the board only.
//
// Like the side panel's page it has no suite bar, which is what sets the organization elsewhere: it takes the one the
// suite last selected, and opens that organization's scratchpad again when another page changes it.
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { useSuiteOrganization } from './PanelPage.tsx';
import { WhiteboardPage } from './WhiteboardPage.tsx';

export function ScratchpadPage() {
  const org = useSuiteOrganization();
  const [state, setState] = useState<{ id: string } | { error: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    setState(null);
    api
      .openScratchpad()
      .then(({ board }) => !cancelled && setState({ id: board.id }))
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
  return <WhiteboardPage key={state.id} id={state.id} framed />;
}
