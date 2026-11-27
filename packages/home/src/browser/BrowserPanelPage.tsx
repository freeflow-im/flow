// FreeFlow Browser's side panel (docs/specs/browser-extension.md): the person's assistant beside the web page they are
// viewing. The extension's panel page frames this page; each message carries the page in front (its address, title,
// selection and text), unless the person takes it off with the chip's ✕. The agent may read that tab and look at it,
// and acts only in its own tabs.
import { useEffect, useMemo, useRef, useState } from 'react';
import { SuiteAssistantColumn } from '@flow/suite-bar/assistant-chat';
import { chooseOrganization, useOrganizations } from '../hooks/organization';
import { panelContext, panelExtensionId, panelMessage, pinBrowserExtension, runPanelCalls, shortAddress, type PanelTab } from './panel';

const PROMPTS = ['Summarize this page', 'What are the key points here?', 'Explain this page simply'];

export function BrowserPanelPage() {
  const extensionId = useMemo(() => panelExtensionId(), []);
  const organizations = useOrganizations();
  const [panel, setPanel] = useState<{ key: string; window: number } | null>(null);
  const [tab, setTab] = useState<PanelTab | null>(null);
  // Off when the person took the page off the next message; on again for the next tab.
  const [withPage, setWithPage] = useState(true);
  const latest = useRef({ panel, tab, withPage });
  latest.current = { panel, tab, withPage };

  useEffect(() => {
    if (!extensionId) return;
    pinBrowserExtension(extensionId);
    const onMessage = (e: MessageEvent) => {
      const m = panelMessage(e, extensionId, window.parent);
      if (m?.type === 'flow-panel') setPanel({ key: m.key, window: m.window });
      else if (m?.type === 'flow-tab') {
        setTab((prev) => {
          if (prev?.id !== m.tab?.id || prev?.url !== m.tab?.url) setWithPage(true);
          return m.tab;
        });
      }
    };
    window.addEventListener('message', onMessage);
    // The panel page answers with its key and window, then the tab in front.
    window.parent.postMessage({ type: 'flow-hello' }, `chrome-extension://${extensionId}`);
    return () => window.removeEventListener('message', onMessage);
  }, [extensionId]);

  const options = useMemo(
    () => ({
      prepare: () => {
        const { panel: p, tab: t, withPage: w } = latest.current;
        return panelContext(p && t?.readable && w ? p : null);
      },
      runClientCalls: runPanelCalls,
    }),
    [],
  );

  if (!extensionId) {
    return (
      <main className="browser-panel-outside" data-testid="browser-panel-outside">
        <p>This page is FreeFlow Browser’s side panel. Click the FreeFlow icon in Chrome’s toolbar to open it next to a web page.</p>
      </main>
    );
  }

  const org = organizations.active?.id ?? null;
  const pageChip = tab ? (
    <div className={`browser-panel-chip${withPage && tab.readable ? '' : ' off'}`} data-testid="browser-panel-chip" title={tab.url}>
      {tab.favIconUrl ? <img src={tab.favIconUrl} alt="" /> : <span className="browser-panel-chip-dot" aria-hidden="true" />}
      <span className="browser-panel-chip-text">
        <strong>{tab.title || shortAddress(tab.url)}</strong>
        <span>{!tab.readable ? 'This page can’t be read' : !withPage ? 'Not sent with your message' : tab.agent ? `Assistant’s tab · ${shortAddress(tab.url)}` : shortAddress(tab.url)}</span>
      </span>
      {tab.readable && (
        <button type="button" onClick={() => setWithPage((w) => !w)} aria-label={withPage ? 'Send without this page' : 'Send with this page'} title={withPage ? 'Send without this page' : 'Send with this page'} data-testid="browser-panel-chip-toggle">
          {withPage ? '✕' : '+'}
        </button>
      )}
    </div>
  ) : null;

  return (
    <div className="browser-panel" data-testid="browser-panel">
      {organizations.list.length > 1 && (
        <div className="browser-panel-org">
          <select value={org ?? ''} onChange={(e) => chooseOrganization(e.target.value)} aria-label="Organization" data-testid="browser-panel-org">
            {organizations.list.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>
      )}
      <SuiteAssistantColumn
        organizationId={org}
        page="home"
        intro="Ask about the page you are on: a summary, the key facts, a reply to draft. Each message sends the page with it; take it off with ✕."
        prompts={PROMPTS}
        options={options}
        composerTop={pageChip}
        placeholder="Ask about this page…"
      />
    </div>
  );
}
