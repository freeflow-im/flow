// The page of an app installed in the organization (docs/specs/user-apps.md §6): the suite bar, then the app's screen in a
// sandboxed frame loaded from the app's own origin with a one-use door key (§6.2), minted again for every load. The screen
// never runs on the suite's origin. The person's assistant floats over it, or anchors beside it, offering the agents that
// may use the app. At /apps/ itself: the installed apps the person may open.
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RotateCw } from 'lucide-react';
import { appNameOf, appsApi, buildingOf, type InstalledApp } from './api';
import { AppsHome, Builder, editApp } from './components/Build';
import { AppsSuiteBar } from './components/AppsSuiteBar';
import { Notice } from './components/Notice';
import { useOrganizations } from './hooks/organization';
import { SuiteAssistant } from '@flow/suite-bar/assistant-chat';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function App() {
  const name = appNameOf(window.location.pathname);
  const building = name ? null : buildingOf(window.location.search);
  const { active, ready } = useOrganizations();
  const org = active?.id ?? null;
  const apps = useQuery({ queryKey: ['apps', org], queryFn: () => appsApi.list(org!), enabled: !!org });
  const app = name ? apps.data?.find((a) => a.name === name) : undefined;
  useEffect(() => {
    document.title = app ? `${app.label} · FreeFlow` : building ? `Building ${building} · FreeFlow` : 'FreeFlow Apps';
  }, [app, building]);

  let body;
  if (ready && !org) body = <Notice testid="no-organization">You are not in an organization yet. Apps come with an organization. <a href="/" className="font-semibold text-primary hover:underline">Go to Chat</a></Notice>;
  else if (apps.isError) body = <Notice testid="apps-error">{errorText(apps.error)}</Notice>;
  else if (!apps.data) body = <div className="flex-1 bg-panel" />;
  else if (building) body = <Builder org={org!} name={building} admin={active?.role === 'owner' || active?.role === 'admin'} />;
  else if (!name) body = <AppsHome org={org!} apps={apps.data} admin={active?.role === 'owner' || active?.role === 'admin'} />;
  else if (!app) body = <Notice testid="no-such-app">No app named “{name}” is installed in {active?.name}.</Notice>;
  else if (!app.usable) body = <Notice testid="no-access">{app.label} is installed, but you have no access to it. An owner or admin can give it to you in Organization settings → Apps.</Notice>;
  else if (!app.hasScreen) body = <Notice testid="no-screen">{app.label} has no screen. Agents use it through its tools.</Notice>;
  else
    body = (
      // The screen, and over it the person's assistant: floating at its corner, or anchored beside it (AssistantDock).
      <div className="relative flex min-h-0 flex-1" data-testid="app-page">
        <Screen org={org!} app={app} />
        <SuiteAssistant organizationId={org} page="home" app={{ name: app.name, label: app.label }} />
      </div>
    );

  return (
    <div className="flex h-screen flex-col">
      <AppsSuiteBar app={name} />
      {body}
    </div>
  );
}

/** The app's screen, in a frame on its own origin: the door key is minted for each load, and Reload mints a new one. */
function Screen({ org, app }: { org: string; app: InstalledApp }) {
  const [load, setLoad] = useState(0);
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSrc(null);
    setError(null);
    appsApi.screen(org, app.name).then((s) => live && setSrc(s.url), (e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [org, app.name, load]);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-8 items-center gap-2 border-b border-hairline bg-panel px-3 text-xs text-muted" data-testid="app-notice">
        <span className="truncate">{app.icon ? `${app.icon} ` : ''}{app.label} {app.serverOrigin ? `runs on its author’s server, ${app.serverOrigin}.` : 'is run by FreeFlow.'}</span>
        {/* A hosted app opens in the builder: the person's draft of it (§9.6). */}
        {app.hosted && (
          <button type="button" className="ml-auto rounded px-1.5 py-0.5 font-semibold text-primary hover:bg-hover" onClick={() => void editApp(org, app.name, app.label).then((e) => e && setError(e))} data-testid="edit-app">
            Edit
          </button>
        )}
        <button type="button" className={`${app.hosted ? '' : 'ml-auto '}flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hover`} onClick={() => setLoad((n) => n + 1)} title="Reload the app">
          <RotateCw className="size-3.5" /> Reload
        </button>
      </div>
      {error ? (
        <Notice testid="screen-error">{error}</Notice>
      ) : src ? (
        <iframe
          key={src}
          src={src}
          title={app.label}
          className="min-h-0 flex-1 border-0 bg-white"
          // Its own origin (user-apps.md §6.1): scripts and forms run there, never with the suite's cookies.
          sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          data-testid="app-frame"
        />
      ) : (
        <div className="flex-1 bg-white" />
      )}
    </div>
  );
}
