import { useEffect, useRef, useState } from 'react';
import { browserSignIn, desktopSignIn, DESKTOP_RETURN_URL } from '../lib/authHandoff';
import { isDesktop } from '../lib/host';
import type { AuthResponse, UserDTO, WorkspaceDTO } from '@flow/shared';
import { useConnectionSync } from '../lib/backgroundSync';
import { connectionManager, type ConnectionRuntime } from '../lib/connectionRuntime';
import { discoverServer } from '../lib/connectServer';
import { originLabel } from '../lib/serverOrigin';
import { buttonDanger, buttonPrimary, buttonSecondary } from './buttonStyles';

export function openServerConnections() {
  window.dispatchEvent(new Event('flow:connections'));
}

export default function ServerConnections({ onSelect, onClose }: {
  onSelect(connectionId: string, workspaceId: string): void;
  onClose(): void;
}) {
  const manager = connectionManager();
  // Live per-connection unread from the background supervisor — every
  // connected server, not just the one on screen, and no extra request here.
  const syncStates = useConnectionSync();
  const syncFor = (connectionId: string) => syncStates.find(s => s.connectionId === connectionId);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), []);
  const [revision, refresh] = useState(0);
  const [address, setAddress] = useState('');
  const [discovery, setDiscovery] = useState<Awaited<ReturnType<typeof discoverServer>> | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [auth, setAuth] = useState<AuthResponse | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceDTO[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Record<string, { user?: UserDTO; workspaces?: WorkspaceDTO[]; offline?: boolean }>>({});

  useEffect(() => {
    let alive = true;
    for (const connection of manager.connections) {
      const runtime = manager.runtime(connection.connectionId)!;
      if (!runtime.getToken()) continue;
      void Promise.all([
        runtime.api<UserDTO>('GET', '/v1/me'),
        runtime.api<{ workspaces: WorkspaceDTO[] }>('GET', '/v1/me/workspaces'),
      ]).then(([user, result]) => {
        if (!alive) return;
        manager.bindIdentity(connection.connectionId, user.id);
        for (const binding of manager.state.bindings.filter(b => b.connectionId === connection.connectionId)) {
          if (!result.workspaces.some(ws => ws.id === binding.workspaceId)) manager.forgetWorkspace(connection.connectionId, binding.workspaceId);
        }
        const hasBindings = manager.state.bindings.some(b => b.connectionId === connection.connectionId);
        for (const ws of result.workspaces) {
          const previous = manager.state.bindings.find(b => b.connectionId === connection.connectionId && b.userId === user.id && b.workspaceId === ws.id);
          if (hasBindings && !previous) continue;
          manager.setBinding({ ...previous, connectionId: connection.connectionId, userId: user.id, workspaceId: ws.id, name: ws.name });
        }
        setAccounts(all => ({ ...all, [connection.connectionId]: { user, workspaces: result.workspaces } }));
      }).catch(() => {
        if (alive) setAccounts(all => ({ ...all, [connection.connectionId]: { offline: true } }));
      });
    }
    return () => { alive = false; };
  }, [manager, revision]);

  const perform = async (action: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await action(); } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const request = async <T,>(path: string, body?: unknown, token?: string): Promise<T> => {
    if (!discovery) throw new Error('Check the server address first.');
    const response = await fetch(`${discovery.origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'omit', redirect: 'error',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message ?? `HTTP ${response.status}`);
    return result as T;
  };

  const loadWorkspaces = async (identity: AuthResponse) => {
    setAuth(identity);
    const result = await request<{ workspaces: WorkspaceDTO[] }>('/v1/me/workspaces', undefined, identity.token);
    setWorkspaces(result.workspaces);
    setSelected([]);
  };

  const connect = () => perform(async () => {
    const found = await discoverServer(address);
    setDiscovery(found); setAuth(null); setPassword(''); setEmail(''); setWorkspaces([]); setSelected([]);
    const existing = manager.connections.find(c => c.origin === found.origin);
    const runtime = existing ? manager.runtime(existing.connectionId) : null;
    if (runtime?.getToken()) {
      const user = await runtime.api<UserDTO>('GET', '/v1/me');
      const result = await runtime.api<{ workspaces: WorkspaceDTO[] }>('GET', '/v1/me/workspaces');
      setAuth({ token: runtime.getToken()!, user }); setWorkspaces(result.workspaces);
    }
  });

  const add = () => perform(async () => {
    if (!auth || !discovery) return;
    let choices = workspaces.filter(w => selected.includes(w.id));
    if (discovery.inviteToken || discovery.joinToken) {
      const joined = await request<WorkspaceDTO>(discovery.inviteToken ? '/v1/invites/accept' : '/v1/join-links/redeem',
        { token: discovery.inviteToken ?? discovery.joinToken }, auth.token);
      choices = [joined];
    }
    if (!choices.length) throw new Error('Select at least one workspace.');
    const runtime = manager.add(discovery.origin, discovery.info.displayName);
    manager.bindIdentity(runtime.connectionId, auth.user.id);
    manager.noteTokenReplaced(runtime.connectionId, runtime.setToken(auth.token));
    for (const ws of choices) manager.setBinding({ connectionId: runtime.connectionId, userId: auth.user.id, workspaceId: ws.id, name: ws.name, hidden: false });
    onSelect(runtime.connectionId, choices[0]!.id);
    onClose();
  });

  const signOut = async (runtime: ConnectionRuntime, remove: boolean) => {
    const label = `${originLabel(runtime.origin)} · ${accounts[runtime.connectionId]?.user?.email ?? runtime.userId ?? "Not signed in"}`;
    if (!window.confirm(`${remove ? 'Remove' : 'Sign out of'} ${label}? This clears this server’s local credentials and private data.`)) return;
    // Start revocation with the captured credential before doing local cleanup.
    const revocation = fetch(runtime.url('/v1/auth/logout'), { method: 'POST', credentials: 'omit', redirect: 'error', headers: { authorization: `Bearer ${runtime.getToken()}` } }).then(result => { if (!result.ok) throw new Error('Revocation unavailable'); });
    manager.signOut(runtime.connectionId, remove);
    window.dispatchEvent(new CustomEvent('flow:registry', { detail: runtime.connectionId }));
    refresh(n => n + 1);
    try { await revocation; }
    catch { setError(`Signed out locally from ${label}. Remote session revocation could not be confirmed.`); }
  };

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Workspaces and servers">
    <div className="max-h-[90vh] w-full max-w-xl overflow-auto rounded-xl bg-white p-6 text-ink shadow-xl">
      <div className="mb-4 flex justify-between"><h2 className="text-lg font-semibold">Workspaces and servers</h2><button className={buttonSecondary} onClick={onClose} disabled={busy}>Close</button></div>
      {/* Every connected server, in the order they were added. */}
      {manager.connections.map(connection => {
        // The live number when the supervisor has one, the sheet's own fetch
        // as the fallback for a connection it has not reached yet.
        const unreadFor = (connectionId: string, workspaceId: string) =>
          syncFor(connectionId)?.unreadByWorkspace[workspaceId]
            ?? accounts[connectionId]?.workspaces?.find(w => w.id === workspaceId)?.unreadCount
            ?? 0;
        const session = manager.state.sessions.find(s => s.connectionId === connection.connectionId);
        const account = accounts[connection.connectionId];
        const bindings = manager.state.bindings.filter(b => b.connectionId === connection.connectionId && !b.hidden);
        const needsSignIn = !manager.runtime(connection.connectionId)?.getToken() || session?.status === 'unauthorized';
        return <section key={connection.connectionId} className="mb-4 rounded border border-hairline2 p-3">
          <h3 className="font-semibold">{originLabel(connection.origin)}{(syncFor(connection.connectionId)?.unread ?? 0) > 0 && <span className="ml-2 rounded bg-violet-100 px-2 text-xs font-normal" aria-label={`${syncFor(connection.connectionId)!.unread} unread on this server`}>{syncFor(connection.connectionId)!.unread}</span>}</h3>
          <p className="text-sm text-faint">{account?.user?.email ?? session?.userId ?? 'Not signed in'}{needsSignIn ? ' · Sign in required' : syncFor(connection.connectionId)?.status === 'offline' || account?.offline ? ' · Offline' : ''}</p>
          {bindings.map(binding => <div className="mt-2 flex items-center justify-between" key={binding.workspaceId}>
            <button className={buttonSecondary} disabled={busy || needsSignIn} onClick={() => { onSelect(connection.connectionId, binding.workspaceId); onClose(); }}>{binding.name}{unreadFor(connection.connectionId, binding.workspaceId) > 0 && <span className="ml-2 rounded bg-violet-100 px-2 text-xs" aria-label="Unread notifications">{unreadFor(connection.connectionId, binding.workspaceId)}</span>}</button>
            <button disabled={busy} className={buttonSecondary} onClick={() => { manager.setBinding({ ...binding, hidden: true }); refresh(n => n + 1); }}>Hide workspace</button>
          </div>)}
          <div className="mt-3 flex flex-wrap gap-2 text-sm">
            <button className={buttonSecondary} disabled={busy} onClick={() => { setSelected([]); setWorkspaces([]); setAddress(connection.origin); setDiscovery(null); setAuth(null); }}>Add workspace{needsSignIn ? ' / Sign in' : ''}</button>
            {!needsSignIn && <button className={buttonSecondary} disabled={busy} onClick={() => void perform(() => signOut(manager.runtime(connection.connectionId)!, false))}>Sign out of {originLabel(connection.origin)}</button>}
            <button className={buttonDanger} disabled={busy} onClick={() => void perform(() => signOut(manager.runtime(connection.connectionId)!, true))}>Remove server</button>
          </div>
        </section>;
      })}
      <h3 className="mb-2 font-semibold">Connect another Flow server</h3>
      <form onSubmit={e => { e.preventDefault(); void connect(); }} className="flex gap-2">
        <input className="min-w-0 flex-1 rounded border p-2" disabled={busy} aria-label="Server or invite URL" placeholder="https://flow.example.com or invite URL" value={address} onChange={e => { setAddress(e.target.value); setDiscovery(null); setAuth(null); setSelected([]); setWorkspaces([]); }} />
        <button className={buttonPrimary} disabled={busy || !address.trim()}>Check server</button>
      </form>
      {discovery && <section className="mt-4 rounded border p-3">
        <p>Sign in to <strong>{originLabel(discovery.origin)}</strong></p>
        {!auth ? <form onSubmit={e => { e.preventDefault(); void perform(async () => loadWorkspaces(await request<AuthResponse>('/v1/auth/login', { email, password }))); }}>
          {discovery.info.authMethods.includes('password') && <>
            <input className="mt-3 w-full rounded border p-2" type="email" autoComplete="off" aria-label="Email on this server" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" required />
            <input className="mt-2 w-full rounded border p-2" type="password" autoComplete="new-password" aria-label="Password on this server" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" required />
            <button className={`mt-3 ${buttonPrimary}`} disabled={busy}>Sign in</button>
          </>}
          {discovery.info.capabilities.authHandoff && <button type="button" className={`mt-3 block ${buttonSecondary}`} disabled={busy} onClick={() => {
            // The desktop shell signs in through the system browser and a
            // flow://signin return, like the macOS app; a browser tab uses a popup.
            const popup = isDesktop() ? null : window.open('about:blank', 'flow-server-signin', 'width=520,height=700');
            if (!popup && !isDesktop()) { setError('Allow a popup to sign in on this server.'); return; }
            operation.current?.abort();
            const controller = new AbortController();
            operation.current = controller;
            void perform(async () => loadWorkspaces(await (popup ? browserSignIn(discovery.origin, popup, controller.signal) : desktopSignIn(discovery.origin, controller.signal))));
          }}>Sign in on {originLabel(discovery.origin)} ({discovery.info.authMethods.join(', ')})</button>}
          {!discovery.info.capabilities.authHandoff && discovery.info.authMethods.some(method => method !== 'password') && <p className="mt-2 text-sm">Browser sign-in requires this server’s operator to allow the return address {isDesktop() ? DESKTOP_RETURN_URL : `${location.origin}/`}.</p>}
        </form> : <>
          <p className="mt-2 text-sm">{auth.user.email}</p>
          {!workspaces.length && <p className="mt-2 text-sm">This account has no workspaces. Ask an administrator on {originLabel(discovery.origin)} for an invite.</p>}
          {workspaces.map(ws => <label className="mt-2 block" key={ws.id}><input type="checkbox" checked={selected.includes(ws.id)} onChange={e => setSelected(ids => e.target.checked ? [...ids, ws.id] : ids.filter(id => id !== ws.id))} /> {ws.name}</label>)}
          <button className={`mt-3 ${buttonPrimary}`} disabled={busy || (!selected.length && !discovery.inviteToken && !discovery.joinToken)} onClick={() => void add()}>{discovery.inviteToken || discovery.joinToken ? 'Join invited workspace' : 'Add selected workspaces'}</button>
        </>}
      </section>}
      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    </div>
  </div>;
}
