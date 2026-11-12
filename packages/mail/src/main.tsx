import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MailApiError } from './api';
import { App } from './App';
import './index.css';
import { reloadOnStaleBuild } from '@flow/suite-bar';

// A page from before a deploy loads again when a part of its old version is gone (lib/staleBuild.ts).
reloadOnStaleBuild();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A refused login or an unreachable server will not fix itself in a second; the 60 s poll tries again.
      retry: (count, e) => !(e instanceof MailApiError && ['auth_failed', 'connect_failed', 'not_found', 'unauthorized', 'bad_request'].includes(e.code)) && count < 2,
      refetchOnWindowFocus: true,
      refetchIntervalInBackground: false,
    },
  },
});

// When each inbox tab was last opened, kept for the tab counts' "N new", which are gone.
try {
  localStorage.removeItem('mail.tabsOpened');
} catch {
  // Nothing kept.
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
