import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CalendarApiError } from './api';
import { App } from './App';
import { PanelApp } from './PanelApp';
import './index.css';
import { reloadOnStaleBuild } from '@flow/suite-bar';

// A page from before a deploy loads again when a part of its old version is gone (lib/staleBuild.ts).
reloadOnStaleBuild();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A refused login or an unreachable server will not fix itself in a second; the 60 s poll tries again.
      retry: (count, e) => !(e instanceof CalendarApiError && ['auth_failed', 'connect_failed', 'not_found', 'unauthorized', 'bad_request', 'conflict'].includes(e.code)) && count < 2,
      refetchOnWindowFocus: true,
      refetchIntervalInBackground: false,
    },
  },
});

// /calendar/panel is Calendar in another app's side panel (docs/specs/side-panel.md).
const PANEL = window.location.pathname.replace(/\/+$/, '') === `${import.meta.env.BASE_URL}panel`;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {PANEL ? <PanelApp /> : <App />}
    </QueryClientProvider>
  </StrictMode>,
);
