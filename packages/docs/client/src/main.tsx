import { StrictMode, type ReactElement, useMemo, type ReactNode } from 'react';
import { BASE } from './basePath.ts';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, matchPath, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AgentDock } from './agent/AgentPanel.tsx';
import { AgentProvider } from './agent/AgentProvider.tsx';
import { AuthProvider, useAuth } from './auth.tsx';
import { DocsNav } from './components/DocsNav.tsx';
import { DocsSuiteBar } from './components/DocsSuiteBar.tsx';
import { AuthPage } from './pages/AuthPage.tsx';
import { ChangesPage } from './pages/ChangesPage.tsx';
import { PublicPage } from './pages/PublicPage.tsx';
import { PreviewPage } from './pages/PreviewPage.tsx';
import { ConnectorsPage } from './pages/ConnectorsPage.tsx';
import { DeckPage } from './pages/DeckPage.tsx';
import { DocPage } from './pages/DocPage.tsx';
import { FilePage } from './pages/FilePage.tsx';
import { ForgotPasswordPage, ResetPasswordPage } from './pages/PasswordResetPages.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { LandingPage } from './pages/LandingPage.tsx';
import { OpenLocalFile } from './pages/OpenLocalFile.tsx';
import { MarkdownPage } from './pages/MarkdownPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { SpreadsheetPage } from './pages/SpreadsheetPage.tsx';
import { VerifyEmailPage } from './pages/VerifyEmailPage.tsx';
import './styles.css';
import { isPreview } from './components/FilePreviewFrame.tsx';
import { useHistoryKeys } from './historyKeys.ts';
import { desktopHost, useDesktopBridge, useRecentOpens } from './desktopBridge.ts';
import { HostProvider, type Host } from './host.tsx';
import { reloadOnStaleBuild } from '@flow/suite-bar';

// A page from before a deploy loads again when a part of its old version is gone (lib/staleBuild.ts).
reloadOnStaleBuild();

// A file's preview in the file list: the same page with only the file showing (styles.css, .file-preview-page).
const PREVIEW = isPreview();
if (PREVIEW) document.documentElement.classList.add('file-preview-page');

/** In the suite, the sign-in is the suite's own page at /, which comes back here (?next=) once signed in. */
function toSuiteSignIn(): null {
  window.location.assign(`/?next=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`);
  return null;
}

function RequireAuth({ children }: { children: ReactElement }) {
  const { user, loading, suite } = useAuth();
  if (loading) return <div className="page-loading">Loading…</div>;
  if (!user) return suite ? toSuiteSignIn() : <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}

// The server sends visitors the front page already drawn (`landingPrerender.tsx`); it stays while the app asks who is
// signed in, instead of flashing "Loading…".
const PRERENDERED = !!document.getElementById('root')?.firstElementChild;

/** The home page: the files of a user who is signed in, the front page (what the app is) for a visitor. */
function Home() {
  const { user, loading, suite } = useAuth();
  if (loading) return PRERENDERED ? <LandingPage /> : <div className="page-loading">Loading…</div>;
  if (user) return <HomePage />;
  return suite ? toSuiteSignIn() : <LandingPage />;
}

function GuestOnly({ children }: { children: ReactElement }) {
  const { user, loading, suite } = useAuth();
  if (loading) return <div className="page-loading">Loading…</div>;
  if (user) return <Navigate to="/" replace />;
  if (suite) return toSuiteSignIn();
  return children;
}

/** What mounts the editors (host.tsx), from who is signed in where: the desktop app's window, the suite, or neither. */
function Hosted({ children }: { children: ReactNode }) {
  const { local, suite } = useAuth();
  const host = useMemo((): Host => ({ desktop: local ? desktopHost() : null, suite: !!suite }), [local, suite]);
  return <HostProvider host={host}>{children}</HostProvider>;
}

/** The pages, with the assistant floating over them, or docked on the right once anchored (agent/AgentPanel.tsx). */
function AppShell() {
  const { user, local, suite } = useAuth();
  const { pathname } = useLocation();
  useHistoryKeys(!!local && !PREVIEW);
  useDesktopBridge(!!local && !!user && !PREVIEW);
  useRecentOpens(!!user && !PREVIEW);
  // In the FreeFlow suite the suite bar is above every signed-in page (not a public page, nor a file's preview), and
  // the page scrolls under it. Standalone and in the desktop app there is none.
  // A preview (/preview/<id>) sits in a frame in Mail's attachment overlay: the file only, no bar, folders or assistant.
  const framed = !!matchPath('/preview/:id', pathname);
  const bar = !!suite && !!user && !PREVIEW && !framed && !matchPath('/p/:token', pathname);
  const shell = (
    <div className="app-shell">
      {/* In the suite, the folders on the left of every page (components/DocsNav.tsx). */}
      {bar && !local && <DocsNav />}
      <div className="app-main">
        <Routes>
          <Route path="/login" element={<GuestOnly><AuthPage mode="login" /></GuestOnly>} />
          <Route path="/register" element={<GuestOnly><AuthPage mode="register" /></GuestOnly>} />
          <Route path="/forgot" element={<GuestOnly><ForgotPasswordPage /></GuestOnly>} />
          <Route path="/reset" element={<GuestOnly><ResetPasswordPage /></GuestOnly>} />
          <Route path="/verify" element={<GuestOnly><VerifyEmailPage /></GuestOnly>} />
          <Route path="/" element={<Home />} />
          <Route path="/p/:token" element={<PublicPage />} />
          <Route path="/preview/:id" element={<RequireAuth><PreviewPage /></RequireAuth>} />
          <Route path="/s/:id" element={<RequireAuth><SpreadsheetPage /></RequireAuth>} />
          <Route path="/d/:id" element={<RequireAuth><DeckPage /></RequireAuth>} />
          <Route path="/doc/:id" element={<RequireAuth><DocPage /></RequireAuth>} />
          <Route path="/md/:id" element={<RequireAuth><MarkdownPage /></RequireAuth>} />
          <Route path="/f/:id" element={<RequireAuth><FilePage /></RequireAuth>} />
          <Route path="/open" element={<RequireAuth><OpenLocalFile /></RequireAuth>} />
          <Route path="/changes" element={<RequireAuth><ChangesPage /></RequireAuth>} />
          <Route path="/connectors" element={<RequireAuth><ConnectorsPage /></RequireAuth>} />
          <Route path="/settings" element={<RequireAuth><SettingsPage /></RequireAuth>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
      {user && !PREVIEW && !framed && <AgentDock />}
    </div>
  );
  if (!bar) return shell;
  return (
    <div className="suite-frame">
      <DocsSuiteBar />
      {shell}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      {/* The base path without its trailing slash: the router matches "/docs" itself only then. */}
      <BrowserRouter basename={BASE || '/'}>
        <Hosted>
          <AgentProvider>
            <AppShell />
          </AgentProvider>
        </Hosted>
      </BrowserRouter>
    </AuthProvider>
  </StrictMode>,
);
