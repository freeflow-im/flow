import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { SetupPage } from './setup/SetupPage';
import { BrowserPanelPage } from './browser/BrowserPanelPage';
import './browser/browser-panel.css';
import './index.css';
import { reloadOnStaleBuild } from '@flow/suite-bar';

// A page from before a deploy loads again when a part of its old version is gone (lib/staleBuild.ts).
reloadOnStaleBuild();

// Home only reads: a card that fails says so and the next minute's refresh tries again.
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 30_000 } } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* Setup (docs/specs/onboarding.md) and FreeFlow Browser's side panel (docs/specs/browser-extension.md) are Home's own pages, with none of Home's frames. */}
      {/^\/home\/setup\/?$/.test(window.location.pathname) ? <SetupPage /> : /^\/home\/browser\/?$/.test(window.location.pathname) ? <BrowserPanelPage /> : <App />}
    </QueryClientProvider>
  </StrictMode>,
);
