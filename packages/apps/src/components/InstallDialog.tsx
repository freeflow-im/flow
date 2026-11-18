// Installing from the builder (docs/specs/user-apps.md §9.6): an owner or admin installs a published version, or updates
// the installed app to it, without leaving the page. As Admin → Apps' card: what the app may use of FreeFlow and which
// hosts it may reach, its tools with their whole descriptions (an agent reads them as guidance), and who gets it.
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { appsApi, type AppGrants, type InstalledApp, type OrgAccount } from '../api';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Manifest { label?: string; uses?: string[]; egress?: string[]; scopes?: { id: string; label: string }[]; tools?: { name: string; description: string }[] }

/** The grants an installed app has now, as the popup starts with them. */
function grantsOf(app: InstalledApp | undefined): AppGrants {
  if (!app?.grants) return { members: true, accounts: [] };
  const all = Object.values(app.grants).flat();
  return { members: all.includes('members'), accounts: [...new Set(all.filter((g) => g !== 'members'))] };
}

export function InstallDialog({ org, name, version, onClose, onDone }: { org: string; name: string; version: number; onClose(): void; onDone(text: string): void }) {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [installed, setInstalled] = useState<InstalledApp | undefined>(undefined);
  const [accounts, setAccounts] = useState<OrgAccount[]>([]);
  const [grants, setGrants] = useState<AppGrants>({ members: true, accounts: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void appsApi.readFile(org, name, 'freeflow-app.json').then((t) => { try { setManifest(JSON.parse(t) as Manifest); } catch { setManifest({}); } }, (e) => setError(errorText(e)));
    void appsApi.list(org).then((list) => {
      const current = list.find((a) => a.name === name);
      setInstalled(current);
      setGrants(grantsOf(current));
    }, () => undefined);
    void appsApi.accounts(org).then((a) => setAccounts(a.filter((x) => x.state !== 'removed' && x.kind === 'native')), () => undefined);
  }, [org, name]);

  const people = accounts.filter((a) => !a.agentMode);
  const agents = accounts.filter((a) => a.agentMode === 'shared');
  const toggle = (id: string, on: boolean) => setGrants((g) => ({ ...g, accounts: on ? [...new Set([...g.accounts, id])] : g.accounts.filter((x) => x !== id) }));
  const update = !!installed;
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      if (update) await appsApi.updateToVersion(org, name, version, grants);
      else await appsApi.installVersion(org, name, version, grants);
      onDone(update ? `Updated ${manifest?.label ?? name} to version ${version}. Everyone with access now runs it.` : `Installed ${manifest?.label ?? name}. It has a tab now, and agents with access have its tools.`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-label={`Install ${name}`} data-testid="install-dialog">
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col gap-3 overflow-y-auto rounded-xl bg-white p-5 text-sm shadow-xl">
        <div className="flex items-center">
          <h2 className="text-base font-semibold">{update ? `Update ${manifest?.label ?? name} to version ${version}` : `Install ${manifest?.label ?? name}`}</h2>
          <button type="button" className="ml-auto text-muted hover:text-ink" onClick={onClose} aria-label="Close"><X className="size-4" /></button>
        </div>
        {update && <p className="text-xs text-muted">The organization runs version {installed?.version} now. A restore point is kept, so you can go back for 30 days in Organization settings → Apps.</p>}
        <p className="rounded-md border border-hairline bg-panel px-3 py-2 text-xs">
          FreeFlow runs this app and keeps its data in this organization.{' '}
          {manifest?.uses?.length ? `It may use: ${manifest.uses.join(', ')}, and only what the person using it may use too. ` : 'It gets no access to anything else in FreeFlow. '}
          {manifest?.egress?.length ? `It may reach these outside hosts: ${manifest.egress.join(', ')}.` : 'It cannot reach the internet.'}
        </p>
        {manifest?.tools && (
          <details className="text-xs">
            <summary className="cursor-pointer font-semibold">{manifest.tools.length} tools for agents (an agent reads these descriptions as guidance)</summary>
            <ul className="mt-1 flex flex-col gap-1">{manifest.tools.map((t) => <li key={t.name}><code>{t.name}</code>: {t.description}</li>)}</ul>
          </details>
        )}
        <div className="flex flex-col gap-1">
          <span className="font-medium">Who gets it</span>
          <label className="inline-flex items-center gap-2"><input type="radio" checked={grants.members} onChange={() => setGrants((g) => ({ ...g, members: true }))} data-testid="install-members" /> Every member (not guests)</label>
          <label className="inline-flex items-center gap-2"><input type="radio" checked={!grants.members} onChange={() => setGrants((g) => ({ ...g, members: false }))} /> Only these people</label>
          {!grants.members && (
            <div className="ml-6 flex max-h-32 flex-col gap-1 overflow-y-auto">
              {people.map((p) => <label key={p.id} className="inline-flex items-center gap-2"><input type="checkbox" checked={grants.accounts.includes(p.id)} onChange={(e) => toggle(p.id, e.target.checked)} />{p.displayName}</label>)}
            </div>
          )}
          {agents.length > 0 && (
            <>
              <span className="mt-2 font-medium">Also give it to these agents</span>
              {agents.map((a) => <label key={a.id} className="inline-flex items-center gap-2"><input type="checkbox" checked={grants.accounts.includes(a.id)} onChange={(e) => toggle(a.id, e.target.checked)} />{a.displayName} 🤖</label>)}
            </>
          )}
        </div>
        {error && <p className="text-xs whitespace-pre-line text-danger">{error}</p>}
        <div className="flex gap-2">
          <button type="button" className="rounded-md bg-primary px-3 py-1 font-semibold text-white disabled:opacity-50" disabled={busy || !manifest} onClick={() => void go()} data-testid="install-go">{busy ? 'Installing…' : update ? `Update to version ${version}` : 'Install'}</button>
          <button type="button" className="text-primary hover:underline" onClick={onClose}>Not now</button>
        </div>
      </div>
    </div>
  );
}
