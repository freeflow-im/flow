import { useCallback, useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import ServerConnections from './components/ServerConnections';
import { REGISTRY_KEY } from './lib/connections';
import { OPEN_WORKSPACE_EVENT } from './lib/workspaceSwitcher';
import { consumeHandoffCallback, pendingHandoff } from './lib/authHandoff';
import { installDeepLinks, type DeepLink } from './lib/deepLinks';
import { getHost } from './lib/host';
import { disablePush, enablePush } from './lib/pushAndroid';
import { originLabel } from './lib/serverOrigin';
import { BackendError, type ArtifactDTO, type UserDTO, type AuthResponse, type WorkspaceDTO } from '@flow/shared';
import { backgroundSync } from './lib/backgroundSync';
import { backendFor } from './lib/backend';
import {
  activeRuntime,
  connectionManager,
  type ApiError,
  type ConnectionRuntime,
} from './lib/connectionRuntime';
import { clearJoinToken, parseJoinPath, readJoinToken, stashJoinToken } from './lib/joinLink';
import { createThreadMemory } from './lib/threadMemory';
import {
  backTarget,
  canGoBack,
  canGoForward,
  emptyNavHistory,
  forgetNav,
  forwardTarget,
  pushNav,
  stepNav,
  type NavHistory,
} from './lib/navHistory';
import { ADMIN_VIEW_ID, AuthContext, ConnectionContext, SelectionContext } from './state';
import AuthScreen from './components/AuthScreen';
import JoinScreen from './components/JoinScreen';
import NativeSignIn from './components/NativeSignIn';
import WorkspaceChooser from './components/WorkspaceChooser';
import Main from './components/Main';

// Names, not keys. Every one of these is per connection+identity: the runtime
// turns a name into the storage key its session owns, and the connection the
// pre-multi-server browser was already using resolves them to exactly the
// `flow.*` keys it already has (see lib/connections.ts).
const ACTIVE_WS = 'activeWorkspace';
const ADMIN_PANEL = 'adminPanelOpen';
export const PENDING_INVITE = 'pendingInvite';

/** Pull ?signup= / ?reset= / ?signin= (emailed links) and ?native= (the native
 * Google handoff, phase16 §9) off the URL before rendering. */
function consumeEmailLinkParams(runtime: ConnectionRuntime): {
  signupToken: string | null;
  resetToken: string | null;
  signinToken: string | null;
  nativeHandoff: boolean;
} {
  // /invite/<token> (emailed invite link): stash in localStorage so it
  // survives the full register→confirm-email→sign-in round trip, then accept
  // automatically once a user is signed in (effect in App).
  const invite = location.pathname.match(/^\/invite\/([A-Za-z0-9_-]+)$/);
  if (invite) {
    runtime.write(PENDING_INVITE, invite[1]!);
    history.replaceState(null, '', '/');
  }
  // /join/<workspace-slug>/<token> (issue #85): the persistent join link. Same
  // stash trick as the emailed invite — it has to survive the sign-in round
  // trip — but the token drives a real join page rather than being redeemed
  // in the background. The slug is decoration for the human reading the URL;
  // the token is what the server matches on.
  const joinToken = parseJoinPath(location.pathname);
  if (joinToken) {
    stashJoinToken(joinToken, Date.now(), runtime.key('pendingJoinLink'));
    history.replaceState(null, '', '/');
  }
  const params = new URLSearchParams(location.search);
  const signupToken = params.get('signup');
  const resetToken = params.get('reset');
  const signinToken = params.get('signin');
  // Kept in the URL, unlike the one-shot tokens: a reload of the handoff page
  // should still be the handoff page, not the ordinary app.
  const nativeHandoff = params.get('native') === 'google';
  if (signupToken || resetToken || signinToken) {
    history.replaceState(null, '', location.pathname);
  }
  return { signupToken, resetToken, signinToken, nativeHandoff };
}

export default function App() {
  const [callback] = useState(consumeHandoffCallback);
  const manager = connectionManager();
  const [runtime, selectRuntime] = useState(() => {
    const params = new URLSearchParams(location.search);
    const ownsAuthLink = ['handoff', 'native', 'signup', 'reset', 'signin'].some(key => params.has(key)) ||
      /^\/(invite|join)\//.test(location.pathname);
    // Auth and invite links are issued by the page's origin, regardless of
    // which remote workspace this browser tab previously selected.
    if (ownsAuthLink) {
      const issuing = manager.add(location.origin);
      manager.setActive(issuing.connectionId);
      return issuing;
    }
    return activeRuntime();
  });
  const [showConnections, setShowConnections] = useState(false);
  const [epoch, reset] = useState(0);
  // Foreground a workspace on any connection — from Workspaces & servers, or
  // from the sidebar menu and chooser through `openWorkspace()`.
  const openOn = useCallback((connectionId: string, workspaceId: string) => {
    manager.setActive(connectionId);
    const target = manager.active();
    target.write(ACTIVE_WS, workspaceId);
    selectRuntime(target);
    reset(n => n + 1);
  }, [manager]);
  const [clients] = useState(() => new Map<string, QueryClient>());
  const [clientOwners] = useState(() => new Map<string, string>());
  // Every *other* connected server keeps syncing while this tab runs — a
  // socket and its unread numbers, nothing more (see lib/backgroundSync.ts).
  // The connection on screen is excluded: `Main` already owns a full session
  // for it, and a second socket would double every event it handles.
  const sync = backgroundSync();
  useEffect(() => {
    sync.start();
    return () => sync.stop();
  }, [sync]);
  // Desktop shell only (a browser host reports no links): route `flow://`
  // links, and name the window the way the macOS app does when a profile is
  // set, so two QA fixtures side by side can be told apart.
  useEffect(() => {
    installDeepLinks();
    const host = getHost();
    if (!host.isDesktop) return;
    host.window.setTitle(host.profile ? `Flow — ${host.profile} @ ${originLabel(runtime.origin)}` : 'Flow');
  }, [runtime.origin]);
  useEffect(() => {
    sync.setForeground(runtime.connectionId);
  }, [sync, runtime.connectionId]);

  useEffect(() => {
    const show = () => setShowConnections(true);
    const reload = (event: Event) => {
      const id = (event as CustomEvent<string>).detail || runtime.connectionId;
      clients.get(id)?.clear();
      clients.delete(id);
      if (id !== runtime.connectionId) return;
      selectRuntime(manager.active());
      reset(n => n + 1);
      sync.reconcile();
    };
    const storageChanged = (event: StorageEvent) => {
      if (event.key !== REGISTRY_KEY && event.key !== null) return;
      const invalidated = manager.reloadFromStorage();
      for (const id of invalidated) {
        clients.get(id)?.clear();
        clients.delete(id);
      }
      if (invalidated.includes(runtime.connectionId)) {
        selectRuntime(manager.active());
        reset(n => n + 1);
      }
      // Another tab signed a connection in or out; bring our background set in
      // line with what the registry now says.
      sync.reconcile();
    };
    const open = (event: Event) => {
      const { connectionId, workspaceId } = (event as CustomEvent<{ connectionId: string; workspaceId: string }>).detail;
      openOn(connectionId, workspaceId);
    };
    window.addEventListener('storage', storageChanged);
    window.addEventListener('flow:connections', show);
    window.addEventListener('flow:registry', reload);
    window.addEventListener(OPEN_WORKSPACE_EVENT, open);
    return () => {
      window.removeEventListener('storage', storageChanged);
      window.removeEventListener('flow:connections', show);
      window.removeEventListener('flow:registry', reload);
      window.removeEventListener(OPEN_WORKSPACE_EVENT, open);
    };
  }, [manager, runtime, clients, sync, openOn]);
  const owner = runtime.key('queryCache');
  if (clientOwners.get(runtime.connectionId) !== owner || runtime.isDisposed) {
    clients.get(runtime.connectionId)?.clear();
    clients.delete(runtime.connectionId);
    clientOwners.set(runtime.connectionId, owner);
  }
  let client = clients.get(runtime.connectionId);
  if (!client) {
    client = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 5000, refetchOnWindowFocus: false } } });
    clients.set(runtime.connectionId, client);
  }
  if (callback) return <p>Returning sign-in to the requesting window…</p>;
  return <>
    <ConnectionContext.Provider value={runtime}>
      <QueryClientProvider client={client}>
        <SessionApp key={`${runtime.connectionId}:${epoch}`} runtime={runtime} />
      </QueryClientProvider>
    </ConnectionContext.Provider>
    {/* The dialog still belongs to the root; only the way in moved (#565).
        Every entry point — the sidebar's workspace menu, the sign-in screen,
        the workspace chooser — raises it through `openServerConnections()`,
        which is the `flow:connections` event the effect above listens for. */}
    {showConnections && <ServerConnections onClose={() => setShowConnections(false)} onSelect={openOn} />}
  </>;
}

function SessionApp({ runtime }: { runtime: ConnectionRuntime }) {
  const [handoff] = useState(pendingHandoff);
  const qc = useQueryClient();
  // The connection this window is pointed at. One today (the migrated default);
  // the manager is what phase 3's switcher will drive.
  const [user, setUser] = useState<UserDTO | null>(null);
  const [booting, setBooting] = useState(true);
  const [offline, setOffline] = useState(false);
  const [{ signupToken, resetToken, signinToken, nativeHandoff }] = useState(() =>
    consumeEmailLinkParams(runtime),
  );
  // Active workspace survives reloads/restarts (phase 3.5 fixes), per session.
  const [workspaceId, setWorkspaceId] = useState<string | null>(
    () => runtime.read(ACTIVE_WS),
  );
  // Replacing this connection's bearer bumps its auth generation, so a 401
  // from a request that went out under the previous one is ignored rather than
  // invalidating the session that replaced it.
  const replaceToken = useCallback(
    (token: string | null) => {
      connectionManager().noteTokenReplaced(runtime.connectionId, runtime.setToken(token));
    },
    [runtime],
  );

  // Transient one-line banner (currently only the Google domain auto-join).
  const [notice, setNotice] = useState<string | null>(null);
  const readNavigation = (id: string | null) => {
    if (!id) return null;
    try { return JSON.parse(runtime.read(`navigation:${id}`) ?? 'null') as {
      channelId?: string; artifactId?: string; threadRootId?: string;
    } | null; } catch { return null; }
  };
  const [initialNavigation] = useState(() => readNavigation(workspaceId));
  const [channelId, setChannelId] = useState<string | null>(initialNavigation?.channelId ?? null);
  const [artifactId, setArtifactId] = useState<string | null>(initialNavigation?.artifactId ?? null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [threadRootId, setThreadRootId] = useState<string | null>(initialNavigation?.threadRootId ?? null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [focusMessageId, setFocusMessageId] = useState<string | null>(null);
  // Which thread each channel had open, so switching away and back restores it
  // (issue #89). In state for a stable identity across renders only — it's
  // mutable and never renders anything by itself; `threadRootId` still does.
  const [threadMemory] = useState(createThreadMemory);
  // Browser-style visit history over the main pane (issue #386) — what the
  // header's back/forward buttons walk. Per-session and per-workspace.
  const [nav, setNav] = useState<NavHistory>(emptyNavHistory);
  // Admin panel pinned into the sidebar (per-device, admins only at render).
  const [adminPanelOpen, setAdminPanelOpen] = useState<boolean>(
    () => runtime.read(ADMIN_PANEL) === '1',
  );

  // A 401 on a *current-generation* request means this connection's session is
  // gone server-side. Recorded against the connection rather than acted on: the
  // single-connection experience is unchanged by this ticket, and phase 3's
  // connection list is what surfaces it.
  useEffect(() => {
    runtime.setUnauthorizedHandler(() => {
      connectionManager().markUnauthorized(runtime.connectionId);
      setUser(null);
      qc.clear();
    });
    return () => runtime.setUnauthorizedHandler(null);
  }, [runtime]);

  // Boot this connection's session: the adopted token is only believed once
  // /v1/me answers, and only then is the identity committed to the registry —
  // which is what decides whether the cached state under this namespace is
  // still ours or has to be discarded and refetched.
  useEffect(() => {
    (async () => {
      if (!runtime.getToken()) {
        setBooting(false);
        return;
      }
      try {
        // Whichever provider this connection speaks, its backend answers "who
        // am I" (#545); a Slack team synthesizes the user from its grant.
        const me = await backendFor(runtime).me();
        connectionManager().bindIdentity(runtime.connectionId, me.id);
        setUser(me);
        runtime.write("cachedUser", JSON.stringify(me));
      } catch (err) {
        // Only a *rejected* token is dropped. An unreachable server leaves the
        // session alone: an upgraded client that boots offline must not lose it.
        if ((err as ApiError).status === 401 || (err instanceof BackendError && err.code === 'unauthorized')) {
          replaceToken(null);
          connectionManager().markSignedOut(runtime.connectionId);
        } else {
          setOffline(true);
          const session = connectionManager().state.sessions.find(s => s.connectionId === runtime.connectionId);
          if (session?.status === 'authenticated') {
            try {
              const cached = JSON.parse(runtime.read('cachedUser') ?? 'null') as UserDTO | null;
              if (cached?.id === session.userId) setUser(cached);
            } catch { /* No validated cached identity. */ }
          }
        }
      } finally {
        setBooting(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime]);

  // Warm the blob cache with our own avatar so the first message we send
  // this session doesn't flash the placeholder while it loads.
  useEffect(() => {
    if (user?.avatarUrl) void runtime.blobUrl(user.avatarUrl).catch(() => {});
  }, [runtime, user?.avatarUrl]);

  const [inviteNonce, bumpInvite] = useState(0);
  // Accept a stashed emailed invite as soon as we have a signed-in user
  // (fresh registration or existing account alike), then land in that
  // workspace. Any failure (expired/used/bad token) burns the stash — the
  // invite modal's link remains the manual fallback.
  useEffect(() => {
    if (!user) return;
    const token = runtime.read(PENDING_INVITE);
    if (!token) return;
    void (async () => {
      try {
        const ws = await runtime.api<WorkspaceDTO>('POST', '/v1/invites/accept', { token });
        runtime.write(ACTIVE_WS, ws.id);
        setWorkspaceId(ws.id);
        await qc.invalidateQueries({ queryKey: ['workspaces'] });
      } catch (err) {
        console.warn(`invite accept failed: ${(err as Error).message}`);
      } finally {
        runtime.write(PENDING_INVITE, null);
      }
    })();
  }, [runtime, user, qc, inviteNonce]);


  // A stashed join link (issue #85) takes over the whole screen until it's
  // resolved — see JoinScreen. Read once at boot so the token is picked up
  // both on the first visit and on the way back from a confirmation email.
  const [pendingJoin, setPendingJoin] = useState<string | null>(() =>
    readJoinToken(Date.now(), runtime.key('pendingJoinLink')),
  );
  const resolveJoin = useCallback(() => {
    clearJoinToken(runtime.key('pendingJoinLink'));
    setPendingJoin(null);
  }, [runtime]);

  // Google sign-in can enroll the user into workspaces that opened their doors
  // to their email domain (phase16 §4). Land them in one instead of the empty
  // create-workspace screen, and say what happened — nobody expects to arrive
  // already a member. A pending invite still wins: its effect runs after this.
  const signIn = useCallback((resp: AuthResponse & { autoJoined?: WorkspaceDTO[] }) => {
    // The server issued this session, so the identity is verified: commit it.
    // A different user on this connection rotates the namespace, so the
    // previous one's cached state is dropped rather than inherited.
    if (runtime.userId !== resp.user.id) {
      qc.clear();
      setWorkspaceId(null);
      setChannelId(null);
      setArtifactId(null);
      setThreadRootId(null);
      setFilesOpen(false);
      setEditingMessageId(null);
      setFocusMessageId(null);
      setAdminPanelOpen(false);
      setNav(emptyNavHistory);
      threadMemory.clear();
    }
    connectionManager().bindIdentity(runtime.connectionId, resp.user.id);
    replaceToken(resp.token);
    setUser(resp.user);
    runtime.write("cachedUser", JSON.stringify(resp.user));
    setOffline(false);
    const joined = resp.autoJoined ?? [];
    if (joined.length > 0) {
      const first = joined[0]!;
      runtime.write(ACTIVE_WS, first.id);
      setWorkspaceId(first.id);
      setNotice(
        joined.length === 1
          ? `You've joined ${first.name} — everyone on your email domain is welcome there.`
          : `You've joined ${joined.length} workspaces on your email domain.`,
      );
    }
  }, [replaceToken, runtime, qc, threadMemory]);

  // A `flow://` link nobody was waiting for (see lib/deepLinks.ts): an invite
  // to accept, or a sign-in code minted on the web. The rules follow the
  // macOS app's `handleDeepLink`: a code signs in this connection only when
  // it is the sole Flow server, because the link does not say which server
  // minted it; an invite is stashed and accepted by the effect above once a
  // user is signed in.
  useEffect(() => {
    const onLink = (event: Event) => {
      const link = (event as CustomEvent<DeepLink>).detail;
      if (link.kind === 'invite') {
        runtime.write(PENDING_INVITE, link.token);
        bumpInvite(n => n + 1);
        return;
      }
      if (link.kind !== 'signin-code') return;
      const flowServers = connectionManager().connections.filter(c => c.provider === 'flow');
      if (flowServers.length !== 1) {
        setNotice('This sign-in link does not say which server it is for. Sign in from Workspaces & servers instead.');
        return;
      }
      void runtime.api<AuthResponse>('POST', '/v1/auth/app-link/exchange', { code: link.code })
        .then(signIn, (err: Error) => setNotice(`Sign-in link failed: ${err.message}`));
    };
    window.addEventListener('flow:deeplink', onLink);
    return () => window.removeEventListener('flow:deeplink', onLink);
  }, [runtime, signIn]);

  // Where this connection+identity is parked, so a NavigationTarget survives
  // restart per session rather than as one global "last channel".
  useEffect(() => {
    if (!user || !workspaceId) return;
    runtime.write(`navigation:${workspaceId}`, JSON.stringify({ channelId, artifactId, threadRootId }));
    connectionManager().rememberNavigation({
      connectionId: runtime.connectionId,
      userId: user.id,
      workspaceId,
      ...(channelId ? { channelId } : {}),
      ...(threadRootId ? { threadRootId } : {}),
      ...(artifactId ? { artifactId } : {}),
    });
  }, [runtime, user, workspaceId, channelId, threadRootId, artifactId]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(t);
  }, [notice]);

  // Sign out of *this* connection only: its bearer, its caches and object URLs,
  // its query cache, its stored selection. Any other connection's runtime is
  // untouched, and a late response on this one cannot recreate what went.
  // Push in the Android shell (ANDROID.md phase 3): register this device with
  // the connection once its user is known — re-done on every launch, since
  // tokens rotate silently. A tap on a notification is a bridge click, which
  // the main pane already routes.
  useEffect(() => {
    if (!user || getHost().platform !== 'android') return;
    let off = () => {};
    let alive = true;
    void enablePush(runtime).then((teardown) => { if (alive) off = teardown; else teardown(); });
    return () => { alive = false; off(); };
  }, [user?.id, runtime]); // eslint-disable-line react-hooks/exhaustive-deps

  const signOut = useCallback(() => {
    const finish = () => {
      void backendFor(runtime).signOut().catch(() => {});
      connectionManager().signOut(runtime.connectionId);
      window.dispatchEvent(new Event('flow:registry'));
    };
    qc.clear();
    setUser(null);
    // In the Android shell the device stops being this user's *before* the
    // session goes: the unregister needs the token that logout invalidates,
    // and both need the runtime, which signing out disposes — so the
    // registry cleanup waits for it (bounded; a dead server must not pin
    // the sign-in screen behind a request that never returns).
    if (getHost().platform === 'android') void disablePush(runtime).finally(finish);
    else finish();
  }, [qc, runtime]);

  // Switch the main pane to a view, with all the usual channel-switch
  // side-effects (park/restore the open thread, close the side panel, drop the
  // edit and scroll targets) but WITHOUT recording a visit. `selectChannel`
  // records; back/forward replay, so they must not.
  const showChannel = (id: string | null) => {
    // Deselecting entirely only happens when the active channel goes away
    // (left or archived) — there's nothing to come back to, so drop its thread
    // instead of parking it.
    threadMemory.remember(channelId, id === null ? null : threadRootId);
    setChannelId(id);
    setArtifactId(null);
    // Files are per-channel: the tab doesn't follow you to the next one.
    setFilesOpen(false);
    setThreadRootId(threadMemory.recall(id));
    setEditingMessageId(null);
    setFocusMessageId(null);
  };

  const step = (delta: -1 | 1) => {
    const target = delta === -1 ? backTarget(nav) : forwardTarget(nav);
    if (!target) return;
    setNav((h) => stepNav(h, delta));
    showChannel(target);
  };

  if (booting) {
    return <div className="flex h-full items-center justify-center text-faint">Loading…</div>;
  }

  if (handoff && user) {
    return <div className="mx-auto max-w-md p-8">
      <h1 className="text-lg font-semibold">Continue sign-in</h1>
      <p className="my-3">Use {user.email} on {new URL(runtime.origin).host} to sign in to {handoff.clientOrigin ?? 'the Flow app'}?</p>
      <button onClick={() => void runtime.api<{ callbackUrl: string }>('POST', '/v1/auth/handoff/approve', handoff).then(result => {
        sessionStorage.removeItem('flow.pendingHandoff');
        location.assign(result.callbackUrl);
      }).catch(error => setNotice(error.message))}>Continue</button>
      {notice && <p role="alert">{notice}</p>}
    </div>;
  }

  // The native apps' Google button lands here (phase16 §9): sign in, mint a
  // one-time code, bounce back to flow://signin. Deliberately checked before
  // the signed-in branch — arriving with a live web session offers that
  // account for the handoff rather than dropping into the workspace.
  if (nativeHandoff) {
    return <NativeSignIn user={user} />;
  }

  // A join link owns the screen until it's joined, declined, or found dead —
  // signed out it wraps the auth card so that names the workspace too.
  if (pendingJoin) {
    return (
      <JoinScreen
        token={pendingJoin}
        user={user}
        onSignedIn={signIn}
        signupToken={signupToken}
        resetToken={resetToken}
        signinToken={signinToken}
        onJoined={(ws, alreadyMember) => {
          runtime.write(ACTIVE_WS, ws.id);
          setWorkspaceId(ws.id);
          setNotice(alreadyMember ? `You're already in ${ws.name}.` : `You've joined ${ws.name}.`);
          resolveJoin();
        }}
        onDismiss={resolveJoin}
      />
    );
  }

  if (!user) {
    return (
      <AuthScreen
        onSignedIn={signIn}
        signupToken={signupToken}
        resetToken={resetToken}
        signinToken={signinToken}
      />
    );
  }

  return (
    <ConnectionContext.Provider value={runtime}>
    <AuthContext.Provider value={{ user, setUser, signOut }}>
      {offline && <div role="status" className="fixed top-0 left-0 right-0 z-40 bg-amber-100 p-2 text-center text-sm">{new URL(runtime.origin).host} · Offline — showing cached workspace</div>}
      <SelectionContext.Provider
        value={{
          workspaceId,
          channelId,
          artifactId,
          filesOpen,
          threadRootId,
          editingMessageId,
          focusMessageId,
          adminPanelOpen,
          canGoBack: canGoBack(nav),
          canGoForward: canGoForward(nav),
          goBack: () => step(-1),
          goForward: () => step(1),
          selectWorkspace: (id) => {
            setWorkspaceId(id);
            runtime.write(ACTIVE_WS, id);
            threadMemory.clear();
            // The other workspace's channels aren't reachable from here.
            setNav(emptyNavHistory);
            const saved = readNavigation(id);
            setChannelId(saved?.channelId ?? null);
            setArtifactId(saved?.artifactId ?? null);
            setFilesOpen(false);
            setThreadRootId(saved?.threadRootId ?? null);
            setEditingMessageId(null);
            setFocusMessageId(null);
          },
          // Switching channels parks the open thread rather than closing it: the
          // channel we're leaving remembers it, and the one we're entering gets
          // whatever it had open (issue #89).
          selectChannel: (id) => {
            showChannel(id);
            // A deselection means the channel is gone (left or archived), so it
            // leaves the history too rather than becoming a dead back target.
            if (id) setNav((h) => pushNav(h, id));
            else if (channelId) setNav((h) => forgetNav(h, channelId));
          },
          // Open/activate an artifact tab in the side panel. The thread tab (if
          // any) stays open — they're tabs in the same panel (phase 13).
          selectArtifact: (id) => {
            setArtifactId(id);
            if (id) setFilesOpen(false);
            setEditingMessageId(null);
            setFocusMessageId(null);
            // select the artifact's channel so the conversation shows behind it
            if (id) {
              const cached = qc.getQueryData<{ artifacts: ArtifactDTO[] }>(['artifacts', workspaceId]);
              const a = cached?.artifacts.find((x) => x.id === id);
              // Changing channel this way still swaps the thread tab, or the
              // panel would show one channel's thread over another's messages.
              if (a && a.channelId !== channelId) {
                threadMemory.remember(channelId, threadRootId);
                setChannelId(a.channelId);
                setThreadRootId(threadMemory.recall(a.channelId));
                setNav((h) => pushNav(h, a.channelId));
              }
            }
          },
          // Channel + artifact in one action (#394). Same park-and-restore as an
          // ordinary channel switch; the artifact id is given rather than looked
          // up, because an app opened from the Apps section can live in a channel
          // that only just became visible to this client.
          openArtifactIn: (chanId, id) => {
            if (chanId !== channelId) {
              threadMemory.remember(channelId, threadRootId);
              setChannelId(chanId);
              setThreadRootId(threadMemory.recall(chanId));
            }
            setArtifactId(id);
            setFilesOpen(false);
            setEditingMessageId(null);
            setFocusMessageId(null);
          },
          // Open a thread and make its tab the visible one (artifacts stay as tabs).
          openThread: (id) => {
            setThreadRootId(id);
            threadMemory.remember(channelId, id);
            if (id) {
              setArtifactId(null);
              setFilesOpen(false);
            }
          },
          // The Files tab (#347) takes the panel the way an artifact tab does.
          openFiles: (open) => {
            setFilesOpen(open);
            if (open) setArtifactId(null);
          },
          // Switch the side panel to the Thread tab (thread stays open).
          showThread: () => {
            setArtifactId(null);
            setFilesOpen(false);
          },
          // Close the whole side panel.
          closeSidePanel: () => {
            setThreadRootId(null);
            threadMemory.remember(channelId, null);
            setArtifactId(null);
            setFilesOpen(false);
          },
          setEditingMessage: setEditingMessageId,
          jumpToMessage: (toChannelId, messageId, toThreadRootId) => {
            threadMemory.remember(channelId, threadRootId);
            setArtifactId(null);
            setFilesOpen(false);
            setChannelId(toChannelId);
            // An explicit jump decides what's open in the target channel — a
            // top-level target closes whatever thread it had parked.
            setThreadRootId(toThreadRootId ?? null);
            threadMemory.remember(toChannelId, toThreadRootId ?? null);
            setEditingMessageId(null);
            setFocusMessageId(messageId);
            setNav((h) => pushNav(h, toChannelId));
          },
          clearFocusMessage: () => setFocusMessageId(null),
          openAdminPanel: () => {
            setAdminPanelOpen(true);
            runtime.write(ADMIN_PANEL, '1');
            threadMemory.remember(channelId, threadRootId);
            setChannelId(ADMIN_VIEW_ID);
            setThreadRootId(null);
            setEditingMessageId(null);
            setNav((h) => pushNav(h, ADMIN_VIEW_ID));
          },
          closeAdminPanel: () => {
            setAdminPanelOpen(false);
            runtime.write(ADMIN_PANEL, null);
            // If it's the active view, fall back to a channel (effect picks #general).
            setChannelId((cur) => (cur === ADMIN_VIEW_ID ? null : cur));
            // Unpinned: back must not walk into a panel that is no longer there.
            setNav((h) => forgetNav(h, ADMIN_VIEW_ID));
          },
        }}
      >
        {notice && (
          <div
            data-testid="app-notice"
            className="fixed inset-x-0 top-3 z-50 mx-auto w-fit max-w-[calc(100vw-2rem)] rounded-full bg-accent px-4 py-2 text-center text-sm font-semibold text-white shadow-lg"
            onClick={() => setNotice(null)}
          >
            {notice}
          </div>
        )}
        {workspaceId ? <Main /> : <WorkspaceChooser />}
      </SelectionContext.Provider>
    </AuthContext.Provider>
    </ConnectionContext.Provider>
  );
}
