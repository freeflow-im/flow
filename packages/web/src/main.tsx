import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import VisitorApp from './components/VisitorApp';
import { parseVisitPath } from './lib/visitor';
import './index.css';
import { reloadOnStaleBuild } from '@flow/suite-bar';

// A page from before a deploy loads again when a part of its old version is gone (lib/staleBuild.ts).
reloadOnStaleBuild();

// A channel visitor's link (docs/specs/chat-visitors.md): a page of its own, outside the signed-in app and its sessions.
const visitToken = parseVisitPath(location.pathname);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 5_000, refetchOnWindowFocus: false },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      {visitToken ? <VisitorApp token={visitToken} /> : <App />}
    </QueryClientProvider>
  </React.StrictMode>,
);
