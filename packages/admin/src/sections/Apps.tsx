// Apps (docs/specs/user-apps.md, phase 1): the apps installed in the organization. Every member sees them and turns one on
// for their own agents (§5.2). Owners and admins install one from its manifest's URL after reading what it asks for
// (§9.3's card, for an external app: §7.1's notice), choose who gets its scopes, update it, give it a new secret and
// remove it. The secret is shown once, at install and at rotation: the app's server needs it.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccountDTO, InstalledAppDTO, UserAppManifest, WorkspaceDTO } from '@flow/shared';
import { adminApi, appsApi, type AppGrants } from '../api';
import { Button, Card, Confirm, ErrorLine, Row, Toggle } from '../components/ui';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The accounts an app's scopes can be given to by name: people and shared agents, not guests or personal agents. */
const grantable = (accounts: AccountDTO[]) => accounts.filter((a) => a.state !== 'removed' && a.kind === 'native');

/** The grants an installed app has now, as the editor shows them. */
export function grantsOf(app: InstalledAppDTO): AppGrants {
  const all = Object.values(app.grants ?? {}).flat();
  return { members: all.includes('members'), accounts: [...new Set(all.filter((g) => g !== 'members'))] };
}

export function Apps({ org, admin }: { org: WorkspaceDTO; admin: boolean }) {
  const qc = useQueryClient();
  const apps = useQuery({ queryKey: ['apps', org.id], queryFn: () => appsApi.list(org.id) });
  const accounts = useQuery({ queryKey: ['accounts', org.id], queryFn: () => adminApi.accounts(org.id), enabled: admin });
  const refresh = () => qc.invalidateQueries({ queryKey: ['apps', org.id] });
  const list = apps.data ?? [];

  return (
    <>
      {admin && <Install org={org} accounts={grantable(accounts.data ?? [])} onInstalled={refresh} />}
      <Card title="Installed apps" intro="Apps made outside FreeFlow that this organization added. Each has its own tab, and agents use its tools." testid="installed-apps">
        {apps.isLoading && <p className="text-sm text-muted">Loading…</p>}
        <ErrorLine error={apps.error ? errorText(apps.error) : null} />
        {!apps.isLoading && list.length === 0 && <p className="text-sm text-muted">No apps are installed yet.</p>}
        {list.map((a) => (
          <InstalledApp key={a.name} org={org} app={a} admin={admin} accounts={grantable(accounts.data ?? [])} onChanged={refresh} />
        ))}
      </Card>
    </>
  );
}

/** Who gets the app's scopes: every member, or only named people; and shared agents by name (§5.2). */
function GrantEditor({ value, onChange, accounts }: { value: AppGrants; onChange(v: AppGrants): void; accounts: AccountDTO[] }) {
  const people = accounts.filter((a) => !a.agentMode);
  const agents = accounts.filter((a) => a.agentMode === 'shared');
  const toggle = (id: string, on: boolean) => onChange({ ...value, accounts: on ? [...new Set([...value.accounts, id])] : value.accounts.filter((x) => x !== id) });
  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="grant-editor">
      <div className="flex flex-col gap-1">
        <span className="font-medium">People</span>
        <label className="inline-flex items-center gap-2">
          <input type="radio" checked={value.members} onChange={() => onChange({ ...value, members: true })} data-testid="grant-members" /> Every member (not guests)
        </label>
        <label className="inline-flex items-center gap-2">
          <input type="radio" checked={!value.members} onChange={() => onChange({ ...value, members: false })} data-testid="grant-named" /> Only these people
        </label>
        {!value.members && (
          <div className="ml-6 flex max-h-40 flex-col gap-1 overflow-y-auto">
            {people.map((p) => (
              <Toggle key={p.id} checked={value.accounts.includes(p.id)} onChange={(on) => toggle(p.id, on)} label={p.displayName} testid={`grant-person-${p.id}`} />
            ))}
          </div>
        )}
      </div>
      {agents.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="font-medium">Also give it to these agents</span>
          {agents.map((a) => (
            <Toggle key={a.id} checked={value.accounts.includes(a.id)} onChange={(on) => toggle(a.id, on)} label={`${a.displayName} 🤖`} testid={`grant-agent-${a.id}`} />
          ))}
        </div>
      )}
      <p className="text-xs text-muted">People’s own agents (their assistant, Claude Desktop) use the app only after each person turns it on for them below.</p>
    </div>
  );
}

/** What an app asks for, in full (§9.3): its scopes, its tools with their whole descriptions, its events. */
function Asks({ manifest }: { manifest: Pick<UserAppManifest, 'scopes' | 'tools' | 'events'> }) {
  return (
    <div className="flex flex-col gap-2 text-xs" data-testid="app-asks">
      <div>
        <span className="font-semibold">Access it gives: </span>
        {manifest.scopes.map((s) => s.label).join('; ')}
      </div>
      <details>
        <summary className="cursor-pointer font-semibold">{manifest.tools.length} tools for agents (an agent reads these descriptions as guidance)</summary>
        <ul className="mt-1 flex flex-col gap-1">
          {manifest.tools.map((t) => (
            <li key={t.name}>
              <code>{t.name}</code>: {t.description} <span className="text-faint">({t.scopes.join(', ')})</span>
            </li>
          ))}
        </ul>
      </details>
      {(manifest.events ?? []).length > 0 && (
        <div>
          <span className="font-semibold">Events it sends: </span>
          {(manifest.events ?? []).join(', ')}
        </div>
      )}
    </div>
  );
}

/** The external app's notice (§7.1), in plain words. */
const ExternalNotice = ({ origin }: { origin: string }) => (
  <p className="rounded-md border border-warn-border bg-warn-bg px-3 py-2 text-xs" data-testid="external-notice">
    This app runs on its author’s server, {origin}. FreeFlow does not control where its data is kept or sent. It gets no access to anything else in FreeFlow: only what agents send its tools and what people type on its screen.
  </p>
);

/** A hosted app's notice (§7.2): FreeFlow runs it; what of the suite it may use, and which outside hosts it may reach. */
const HostedNotice = ({ uses, egress }: { uses: string[]; egress: string[] }) => (
  <p className="rounded-md border border-hairline bg-panel px-3 py-2 text-xs" data-testid="hosted-notice">
    FreeFlow runs this app and keeps its data in this organization.{' '}
    {uses.length ? `It may use: ${uses.join(', ')}, and only what the person using it may use too. ` : 'It gets no access to anything else in FreeFlow. '}
    {egress.length ? `It may reach these outside hosts: ${egress.join(', ')}.` : 'It cannot reach the internet.'}
  </p>
);

/** The secret, shown once (install and rotation), with where the app sends its events. */
function SecretOnce({ org, name, secret, onDone }: { org: WorkspaceDTO; name: string; secret: string; onDone(): void }) {
  const events = `${window.location.origin}/v1/apps/${org.id}/${name}/events`;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-hairline bg-panel p-3 text-xs" data-testid="app-secret">
      <p className="font-semibold">Give this secret to the app’s server now. It is not shown again.</p>
      <code className="break-all select-all" data-testid="app-secret-value">{secret}</code>
      <p>The server checks every tool call FreeFlow sends with it, and signs the events it sends to <code className="break-all">{events}</code>. Its screen’s guard checks the people who open its tab with it.</p>
      <div>
        <Button onClick={() => void navigator.clipboard?.writeText(secret).catch(() => {})}>Copy</Button> <Button kind="link" onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}

function Install({ org, accounts, onInstalled }: { org: WorkspaceDTO; accounts: AccountDTO[]; onInstalled(): void }) {
  const [url, setUrl] = useState('');
  const [manifest, setManifest] = useState<UserAppManifest | null>(null);
  const [grants, setGrants] = useState<AppGrants>({ members: true, accounts: [] });
  const [secret, setSecret] = useState<{ name: string; secret: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const preview = useMutation({
    mutationFn: () => appsApi.preview(org.id, url.trim()),
    onMutate: () => setError(null),
    onSuccess: (m) => setManifest(m),
    onError: (e) => { setManifest(null); setError(errorText(e)); },
  });
  const install = useMutation({
    mutationFn: () => appsApi.install(org.id, url.trim(), grants),
    onMutate: () => setError(null),
    onSuccess: (r) => {
      setSecret({ name: r.app, secret: r.secret });
      setManifest(null);
      setUrl('');
      onInstalled();
    },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Card title="Install an app" intro="Paste the address of the app’s manifest (freeflow-app.json). You see what it asks for before anything is installed." testid="install-app">
      <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); preview.mutate(); }}>
        <input className="min-w-0 flex-1 rounded-md border border-border px-2 py-1 text-sm" placeholder="https://…/freeflow-app.json" value={url} onChange={(e) => { setUrl(e.target.value); setManifest(null); }} data-testid="manifest-url" />
        <Button type="submit" disabled={!url.trim() || preview.isPending} testid="preview-app">{preview.isPending ? 'Reading…' : 'Read manifest'}</Button>
      </form>
      {error && <p className="text-xs whitespace-pre-line text-danger" data-testid="install-error">{error}</p>}
      {manifest && (
        <div className="flex flex-col gap-3 border-t border-hairline pt-3" data-testid="install-card">
          <div className="text-sm font-semibold">{manifest.icon ? `${manifest.icon} ` : ''}{manifest.label} <span className="font-normal text-muted">({manifest.name})</span></div>
          {manifest.description && <p className="text-xs text-muted">{manifest.description}</p>}
          {'url' in manifest.server ? <ExternalNotice origin={new URL(manifest.server.url).origin} /> : <HostedNotice uses={manifest.uses ?? []} egress={manifest.egress ?? []} />}
          <Asks manifest={manifest} />
          <GrantEditor value={grants} onChange={setGrants} accounts={accounts} />
          <div>
            <Button kind="primary" disabled={install.isPending} onClick={() => install.mutate()} testid="install-confirm">{install.isPending ? 'Installing…' : `Install ${manifest.label}`}</Button>
          </div>
        </div>
      )}
      {secret && <SecretOnce org={org} name={secret.name} secret={secret.secret} onDone={() => setSecret(null)} />}
    </Card>
  );
}

function InstalledApp({ org, app, admin, accounts, onChanged }: { org: WorkspaceDTO; app: InstalledAppDTO; admin: boolean; accounts: AccountDTO[]; onChanged(): void }) {
  const [editing, setEditing] = useState<AppGrants | null>(null);
  const [confirm, setConfirm] = useState<'remove' | 'secret' | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = <T,>(fn: () => Promise<T>, after?: (r: T) => void) => async () => {
    setError(null);
    try {
      const r = await fn();
      after?.(r);
      onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const agents = useMutation({ mutationFn: (on: boolean) => appsApi.setAgents(org.id, app.name, on), onSuccess: onChanged, onError: (e) => setError(errorText(e)) });
  return (
    <div className="flex flex-col gap-3 border-t border-hairline pt-4 first:border-t-0 first:pt-0" data-testid={`app-${app.name}`}>
      <Row
        label={`${app.icon ? `${app.icon} ` : ''}${app.label}`}
        help={<>{app.description ? `${app.description} ` : ''}{app.serverOrigin ? `Runs on ${app.serverOrigin}.` : 'Run by FreeFlow.'}{app.hasScreen && app.usable ? <> <a className="text-primary hover:underline" href={`/apps/${app.name}`}>Open</a></> : null}</>}
      >
        {app.usable ? (
          <Toggle checked={app.agentsOn} disabled={agents.isPending} onChange={(on) => agents.mutate(on)} label="My agents may use it" testid={`agents-on-${app.name}`} />
        ) : (
          <span className="text-xs text-muted">You have no access to it.</span>
        )}
      </Row>
      <Asks manifest={{ scopes: app.scopes, tools: app.tools.map((t) => ({ ...t, input: { type: 'object' } })), events: app.events }} />
      {admin && (
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => setEditing(grantsOf(app))} testid={`edit-grants-${app.name}`}>Who has it</Button>
          <Button onClick={run(() => appsApi.update(org.id, app.name, grantsOf(app)))} testid={`update-${app.name}`}>Update from manifest</Button>
          {confirm === 'secret' ? (
            <Confirm question="The old secret stops at once. Make a new one?" onYes={run(() => appsApi.rotateSecret(org.id, app.name), (r) => { setSecret(r.secret); setConfirm(null); })} onNo={() => setConfirm(null)} testid={`rotate-${app.name}`} />
          ) : (
            <Button onClick={() => setConfirm('secret')}>New secret</Button>
          )}
          {confirm === 'remove' ? (
            <Confirm question={`Remove ${app.label}? Its tab, tools and events go for everyone.`} onYes={run(() => appsApi.remove(org.id, app.name))} onNo={() => setConfirm(null)} testid={`remove-${app.name}`} />
          ) : (
            <Button kind="link" onClick={() => setConfirm('remove')}>Remove</Button>
          )}
        </div>
      )}
      {editing && (
        <div className="flex flex-col gap-2 rounded-md border border-hairline p-3">
          <GrantEditor value={editing} onChange={setEditing} accounts={accounts} />
          <div className="flex gap-2">
            <Button kind="primary" onClick={run(() => appsApi.setGrants(org.id, app.name, editing), () => setEditing(null))} testid={`save-grants-${app.name}`}>Save</Button>
            <Button kind="link" onClick={() => setEditing(null)}>Cancel</Button>
          </div>
        </div>
      )}
      {secret && <SecretOnce org={org} name={app.name} secret={secret} onDone={() => setSecret(null)} />}
      {error && <p className="text-xs whitespace-pre-line text-danger">{error}</p>}
    </div>
  );
}
